import type { AgentConfig } from "../config";
import type { ItemCatalog } from "../knowledge/ItemCatalog";
import type { MemoryStore } from "../memory/MemoryStore";
import type { TranscriptStore } from "../memory/TranscriptStore";
import type { GoalStore } from "../goals/GoalStore";
import type { SkillLibrary } from "../skills/SkillLibrary";
import type { JsonObject, SessionLoopState, ToolResult } from "../types";
import { listBlueprints } from "../blueprint/Blueprint";
import { listBlueprintLibrary } from "../blueprint/BlueprintLibrary";
import { readTextFile } from "../utils/fs";
import {
  createModelProvider,
  formatModelProviderError,
  isRetryableModelProviderError,
  type ModelProvider,
  type ProviderTurn,
} from "../openai/ModelProvider";
import type { MinecraftToolContext } from "../tools/MinecraftTools";
import type { ToolRegistry } from "../tools/ToolRegistry";
import { compactText, digest, parseJsonObject } from "../utils/misc";
import { buildBaseSystemPrompt, buildTurnInstructions } from "./systemPrompt";
import { runWithSlowOperationWatchdog } from "./slowOperationWatchdog";
import {
  defaultLoopDetectionConfig,
  detectToolCallLoop,
  recordToolCall,
  recordToolOutcome,
} from "./toolLoopDetection";
import type { MinecraftBot, PlayerGuidance } from "../bot/MinecraftBot";
import type { VisualFrame, VisualPerception } from "../vision/VisualPerception";
import type { ImitationObserver } from "../learning/ImitationObserver";
import type { TaskStore } from "../tasks/TaskStore";
import type { SubagentManager } from "../agents/SubagentManager";

export type AgentLoopDeps = {
  config: AgentConfig;
  bot: MinecraftBot;
  vision: VisualPerception;
  tools: ToolRegistry<MinecraftToolContext>;
  catalog: ItemCatalog;
  memory: MemoryStore;
  goals?: GoalStore;
  skills: SkillLibrary;
  transcript: TranscriptStore;
  imitation?: ImitationObserver;
  tasks?: TaskStore;
  subagents?: SubagentManager;
};

type ExecutedToolStep = {
  tool: string;
  arguments: JsonObject;
  ok: boolean;
  result: string;
};

const AUTO_OBSERVE_AFTER_TOOLS = new Set([
  "look_screen",
  "turn",
  "move",
  "stop",
  "wait",
  "follow_player",
  "dig_screen",
  "place_screen",
  "pathfind_screen",
  "pathfind_to_block",
  "navigation_start",
  "navigation_stop",
  "dig_block",
  "harvest_nearby_blocks",
  "activate_block",
  "open_block_window",
  "click_window_slot",
  "transfer_window_item",
  "close_window",
  "select_hotbar_slot",
  "use_held_item",
  "equip_item",
  "equip_best_weapon",
  "eat_best_food",
  "attack_entity",
  "retreat_from_entity",
  "combat_pulse",
  "craft_item",
  "build_blueprint",
  "execute_steps",
  "execute_skill",
]);

export class AgentLoop {
  private readonly provider: ModelProvider;
  private readonly state: SessionLoopState = { toolCallHistory: [] };

  constructor(private readonly deps: AgentLoopDeps) {
    this.provider = createModelProvider(deps.config);
  }

  async runChatGuidance(item: PlayerGuidance): Promise<string> {
    return this.runTask(
      [
        `Minecraft chat guidance from player ${item.username}:`,
        item.message,
        "",
        "Use tools to act in the world. If this is a follow request, call follow_player with that username.",
      ].join("\n"),
    );
  }

  async runTask(task: string): Promise<string> {
    this.deps.bot.ensureConnected();
    const overallStartedAt = Date.now();
    const overallDeadline = overallStartedAt + this.deps.config.loop.overallTaskTimeoutMs;
    const maxSegments = Math.max(1, this.deps.config.loop.maxSegments);
    const guidance = this.deps.bot.drainGuidance();
    const effectiveTask =
      guidance.length > 0
        ? [
            task,
            "",
            "Recent player guidance from Minecraft chat:",
            ...guidance.map((item) => `- ${item.username}: ${item.message}`),
          ].join("\n")
        : task;
    await this.deps.transcript.append({ role: "user", text: effectiveTask });
    await this.deps.goals?.ensureRoot(effectiveTask);
    this.logFlow("task_start", {
      task: compactText(effectiveTask, 1000),
      maxSegments,
      maxToolCallsPerTurn: this.deps.config.loop.maxToolCallsPerTurn,
      taskTimeoutMs: this.deps.config.loop.taskTimeoutMs,
      overallTaskTimeoutMs: this.deps.config.loop.overallTaskTimeoutMs,
    });

    let stopReason = "";
    let finalText = "";
    let checkpoint = "";
    let completed = false;
    let totalToolCallCount = 0;
    let lastCheckpointToolCount = 0;
    const executedSteps: ExecutedToolStep[] = [];

    for (let segment = 1; segment <= maxSegments; segment += 1) {
      if (!this.deps.bot.isConnected()) {
        stopReason = `Stopped: Minecraft bot left the game (${this.deps.bot.connectionSummary()}).`;
        break;
      }
      if (Date.now() >= overallDeadline) {
        stopReason = `Stopped: task exceeded overall timeout ${this.deps.config.loop.overallTaskTimeoutMs}ms without finishing.`;
        break;
      }

      const segmentStartedAt = Date.now();
      const segmentDeadline = Math.min(
        overallDeadline,
        segmentStartedAt + this.deps.config.loop.taskTimeoutMs,
      );
      this.logFlow("segment_start", {
        segment,
        maxSegments,
        checkpoint: checkpoint ? compactText(checkpoint, 800) : "",
      });
      const vision = await this.captureVisionContext();
      let currentResponse: ProviderTurn;
      try {
        currentResponse = await this.runWithSlowOperationLog(
          "model_still_waiting",
          { phase: "start", segment },
          async () =>
            this.provider.start({
              instructions: await this.buildInstructions(effectiveTask),
              tools: this.deps.tools.definitions(),
              imageDataUrls: vision.frames.map((frame) => frame.dataUrl),
              text: this.buildSegmentPrompt({
                task: effectiveTask,
                segment,
                maxSegments,
                checkpoint,
                frameText: vision.text,
                overallStartedAt,
                overallDeadline,
                totalToolCallCount,
              }),
            }),
        );
      } catch (error) {
        stopReason = this.modelProviderStopReason(error, "start");
        this.logFlow("model_provider_error", {
          phase: "start",
          segment,
          retryable: isRetryableModelProviderError(error),
          error: formatModelProviderError(error),
        });
        checkpoint = await this.writeLongTaskCheckpoint({
          task: effectiveTask,
          reason: stopReason,
          segment,
          totalToolCallCount,
          executedSteps,
        });
        lastCheckpointToolCount = totalToolCallCount;
        break;
      }
      let toolCalls = currentResponse.toolCalls;
      let segmentToolCallCount = 0;
      let modelTurnCount = 1;
      let segmentStopReason = "";
      let fatalStopReason = "";
      this.logModelTurn("start", segment, modelTurnCount, currentResponse);

      while (toolCalls.length > 0) {
        if (!this.deps.bot.isConnected()) {
          fatalStopReason = `Stopped: Minecraft bot left the game (${this.deps.bot.connectionSummary()}).`;
          break;
        }
        if (Date.now() >= segmentDeadline) {
          segmentStopReason = `Segment ${segment}: task segment exceeded ${this.deps.config.loop.taskTimeoutMs}ms.`;
          break;
        }
        if (Date.now() >= overallDeadline) {
          stopReason = `Stopped: task exceeded overall timeout ${this.deps.config.loop.overallTaskTimeoutMs}ms without finishing.`;
          break;
        }
        if (modelTurnCount >= this.deps.config.loop.maxModelTurns) {
          segmentStopReason = `Segment ${segment}: model turn limit reached (${this.deps.config.loop.maxModelTurns}).`;
          break;
        }
        if (segmentToolCallCount >= this.deps.config.loop.maxToolCalls) {
          segmentStopReason = `Segment ${segment}: tool call limit reached (${this.deps.config.loop.maxToolCalls}).`;
          break;
        }

        const outputs: Array<{ callId: string; name: string; result: ToolResult }> = [];
        for (const call of toolCalls) {
          if (segmentToolCallCount >= this.deps.config.loop.maxToolCalls) {
            segmentStopReason = `Segment ${segment}: tool call limit reached (${this.deps.config.loop.maxToolCalls}).`;
            break;
          }
          if (Date.now() >= segmentDeadline) {
            segmentStopReason = `Segment ${segment}: task segment exceeded ${this.deps.config.loop.taskTimeoutMs}ms.`;
            break;
          }
          if (Date.now() >= overallDeadline) {
            stopReason = `Stopped: task exceeded overall timeout ${this.deps.config.loop.overallTaskTimeoutMs}ms without finishing.`;
            break;
          }
          if (!this.deps.bot.isConnected()) {
            fatalStopReason = `Stopped: Minecraft bot left the game (${this.deps.bot.connectionSummary()}).`;
            break;
          }
          segmentToolCallCount += 1;
          totalToolCallCount += 1;
          const name = call.name ?? "";
          const callId = call.id ?? `call_${segment}_${segmentToolCallCount}`;
          const args = parseJsonObject(call.arguments);
          const loop = detectToolCallLoop(this.state, name, args, defaultLoopDetectionConfig);
          this.logToolCall(segment, segmentToolCallCount, totalToolCallCount, callId, name, args as JsonObject);
          if (loop.stuck && loop.level === "critical") {
            const result: ToolResult = { ok: false, text: loop.message };
            outputs.push({ callId, name, result });
            await this.deps.transcript.append({ role: "tool", text: loop.message });
            this.logFlow("tool_loop_critical", { tool: name, callId, message: loop.message });
            this.logToolResult(segment, segmentToolCallCount, totalToolCallCount, callId, name, result);
            fatalStopReason = loop.message;
            continue;
          }
          recordToolCall(this.state, name, args, callId, defaultLoopDetectionConfig);
          if (loop.stuck) {
            await this.deps.transcript.append({ role: "system", text: loop.message });
            this.logFlow("tool_loop_warning", { tool: name, callId, message: loop.message });
          }
          const rawResult = await this.runWithSlowOperationLog(
            "tool_still_running",
            { segment, callId, tool: name, totalToolCallCount },
            () => this.deps.tools.execute(name, args as JsonObject, this.toolContext()),
          );
          const result = this.enrichActionToolResult(name, rawResult);
          recordToolOutcome(this.state, name, args, callId, result);
          this.logToolResult(segment, segmentToolCallCount, totalToolCallCount, callId, name, result);
          executedSteps.push(...this.recordedStepsForToolResult(name, args as JsonObject, result));
          outputs.push({ callId, name, result });
          await this.deps.transcript.append({
            role: "tool",
            text: `${name}: ${result.text}`,
            meta: {
              ok: result.ok,
              args: args as JsonObject,
              segment,
              totalToolCallCount,
            },
          });

          const checkpointEvery = this.deps.config.loop.checkpointEveryToolCalls;
          if (checkpointEvery > 0 && totalToolCallCount - lastCheckpointToolCount >= checkpointEvery) {
            checkpoint = await this.writeLongTaskCheckpoint({
              task: effectiveTask,
              reason: `Periodic checkpoint after ${totalToolCallCount} tool calls.`,
              segment,
              totalToolCallCount,
              executedSteps,
            });
            lastCheckpointToolCount = totalToolCallCount;
          }
        }

        if (fatalStopReason || segmentStopReason || stopReason) {
          break;
        }
        if (outputs.length === 0) {
          fatalStopReason = "Stopped: no tool outputs were produced.";
          break;
        }
        if (!this.deps.bot.isConnected()) {
          fatalStopReason = `Stopped: Minecraft bot left the game (${this.deps.bot.connectionSummary()}).`;
          break;
        }
        modelTurnCount += 1;
        try {
          currentResponse = await this.runWithSlowOperationLog(
            "model_still_waiting",
            { phase: "continue", segment, turn: modelTurnCount },
            async () =>
              this.provider.continue({
                instructions: await this.buildInstructions(effectiveTask),
                tools: this.deps.tools.definitions(),
                toolOutputs: outputs,
              }),
          );
        } catch (error) {
          fatalStopReason = this.modelProviderStopReason(error, "continue");
          this.logFlow("model_provider_error", {
            phase: "continue",
            segment,
            turn: modelTurnCount,
            retryable: isRetryableModelProviderError(error),
            error: formatModelProviderError(error),
          });
          break;
        }
        toolCalls = currentResponse.toolCalls;
        this.logModelTurn("continue", segment, modelTurnCount, currentResponse);
      }

      if (stopReason) {
        break;
      }
      if (fatalStopReason) {
        this.logFlow("fatal_stop", { segment, reason: fatalStopReason });
        checkpoint = await this.writeLongTaskCheckpoint({
          task: effectiveTask,
          reason: fatalStopReason,
          segment,
          totalToolCallCount,
          executedSteps,
        });
        lastCheckpointToolCount = totalToolCallCount;
        stopReason = fatalStopReason;
        break;
      }
      if (segmentStopReason) {
        this.logFlow("segment_stop", { segment, reason: segmentStopReason });
        checkpoint = await this.writeLongTaskCheckpoint({
          task: effectiveTask,
          reason: segmentStopReason,
          segment,
          totalToolCallCount,
          executedSteps,
        });
        lastCheckpointToolCount = totalToolCallCount;
        await this.maybeCompact();
        if (segment >= maxSegments) {
          stopReason = `Stopped: long task segment limit reached (${maxSegments}). Last checkpoint:\n${checkpoint}`;
          break;
        }
        continue;
      }

      completed = true;
      finalText = currentResponse.text || "(no final text)";
      break;
    }

    if (!completed && !stopReason) {
      stopReason = `Stopped: task did not finish after ${maxSegments} segments.`;
    }
    if (stopReason) {
      try {
        this.deps.bot.stopMovement();
      } catch {
        // The bot may already be disconnected.
      }
    }
    const answer = stopReason || finalText || "(no final text)";
    this.logFlow(completed && !stopReason ? "task_done" : "task_stop", {
      completed,
      totalToolCallCount,
      answer: compactText(answer, 1600),
    });
    await this.deps.transcript.append({ role: "assistant", text: answer });
    if (completed && !stopReason) {
      await this.maybeRecordSkill(effectiveTask, answer, executedSteps);
    }
    await this.maybeCompact();
    return answer;
  }

  private buildSegmentPrompt(params: {
    task: string;
    segment: number;
    maxSegments: number;
    checkpoint: string;
    frameText: string;
    overallStartedAt: number;
    overallDeadline: number;
    totalToolCallCount: number;
  }): string {
    const elapsedMs = Date.now() - params.overallStartedAt;
    const remainingMs = Math.max(0, params.overallDeadline - Date.now());
    const parts = [
      params.segment === 1
        ? "Start this Minecraft task."
        : "Continue this Minecraft task from the checkpoint. Do not repeat completed actions unless verification shows they failed.",
      "",
      "<task>",
      params.task,
      "</task>",
      "",
      "<long_task_state>",
      `segment=${params.segment}/${params.maxSegments}`,
      `elapsed_ms=${elapsedMs}`,
      `remaining_overall_ms=${remainingMs}`,
      `total_tool_calls_so_far=${params.totalToolCallCount}`,
      "</long_task_state>",
      "",
      "<current_player_status>",
      this.deps.bot.statusSummary(),
      "</current_player_status>",
      "",
      "<current_visual_observation>",
      params.frameText,
      "</current_visual_observation>",
    ];
    if (params.checkpoint.trim()) {
      parts.push("", "<last_checkpoint>", params.checkpoint, "</last_checkpoint>");
    }
    parts.push(
      "",
      "Use tools to make concrete progress. For deterministic short runs of already chosen atomic actions, execute_steps is available; otherwise call one atomic tool, inspect its result, and continue.",
    );
    return parts.join("\n");
  }

  private async captureVisionContext(): Promise<{ frames: VisualFrame[]; text: string }> {
    const requestedFrames = Math.max(1, Math.min(3, Math.floor(this.deps.config.vision.contextFrames)));
    const yaw = Math.max(5, Math.min(75, this.deps.config.vision.contextYawDeg));
    const center = this.deps.vision.capture();
    if (requestedFrames === 1 || !this.deps.config.vision.contextSweep) {
      return {
        frames: [center],
        text: [
          requestedFrames === 1
            ? "Vision context: 1 image. Screen-coordinate tools refer to this current center view."
            : "Vision context: smooth mode uses 1 current image. Multi-image sweep is available by setting VISION_CONTEXT_SWEEP=true, but it physically turns the bot camera.",
          "",
          "<image_1_center_current>",
          center.text,
          "</image_1_center_current>",
        ].join("\n"),
      };
    }

    try {
      await this.deps.bot.lookDelta(-yaw, 0);
      const left = this.deps.vision.capture();
      let right: VisualFrame | undefined;
      if (requestedFrames >= 3) {
        await this.deps.bot.lookDelta(yaw * 2, 0);
        right = this.deps.vision.capture();
        await this.deps.bot.lookDelta(-yaw, 0);
      } else {
        await this.deps.bot.lookDelta(yaw, 0);
      }
      const restoredCenter = this.deps.vision.capture();
      const frames = right ? [restoredCenter, left, right] : [restoredCenter, left];
      const sections = [
        `Vision context: ${frames.length} images. Image 1 is the restored current center view. Screen-coordinate tools refer to image 1/current center view only; side images are for context.`,
        "",
        "<image_1_center_current>",
        restoredCenter.text,
        "</image_1_center_current>",
        "",
        `<image_2_left_${yaw.toFixed(0)}deg>`,
        left.text,
        `</image_2_left_${yaw.toFixed(0)}deg>`,
      ];
      if (right) {
        sections.push("", `<image_3_right_${yaw.toFixed(0)}deg>`, right.text, `</image_3_right_${yaw.toFixed(0)}deg>`);
      }
      return {
        frames,
        text: sections.join("\n"),
      };
    } catch (error) {
      this.logFlow("vision_context_failed", { error: error instanceof Error ? error.message : String(error) });
      const current = this.deps.vision.capture();
      return {
        frames: [current],
        text: [
          "Vision context: sweep failed; using one current center image.",
          "",
          "<image_1_center_current>",
          current.text,
          "</image_1_center_current>",
        ].join("\n"),
      };
    }
  }

  private enrichActionToolResult(toolName: string, result: ToolResult): ToolResult {
    if (!this.deps.config.loop.autoObserveAfterActions || !AUTO_OBSERVE_AFTER_TOOLS.has(toolName)) {
      return result;
    }
    if (!this.deps.bot.isConnected()) {
      return result;
    }
    try {
      const frame = this.deps.vision.capture();
      const status = this.deps.bot.statusSummary();
      const navigation = this.deps.bot.navigationStatus();
      const postStateText = [
        "<post_tool_state>",
        status,
        `navigation=${JSON.stringify(navigation)}`,
        "",
        "<post_tool_visual_observation>",
        frame.text,
        "</post_tool_visual_observation>",
        "</post_tool_state>",
      ].join("\n");
      const existingData =
        result.data && typeof result.data === "object" && !Array.isArray(result.data)
          ? (result.data as JsonObject)
          : undefined;
      return {
        ...result,
        text: [result.text, "", postStateText].join("\n"),
        content: [
          ...(result.content ?? []),
          { type: "text", text: postStateText },
          { type: "image", dataUrl: frame.dataUrl, detail: "low" },
        ],
        data: {
          ...(existingData ?? {}),
          postToolState: {
            status,
            navigation: navigation as unknown as JsonObject,
            visual: {
              width: frame.width,
              height: frame.height,
              capturedAt: frame.capturedAt,
            },
          },
        },
      };
    } catch (error) {
      this.logFlow("post_tool_observe_failed", {
        tool: toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return result;
    }
  }

  private async writeLongTaskCheckpoint(params: {
    task: string;
    reason: string;
    segment: number;
    totalToolCallCount: number;
    executedSteps: ExecutedToolStep[];
  }): Promise<string> {
    let status = "";
    try {
      status = this.deps.bot.statusSummary();
    } catch (error) {
      status = `status unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    const recentSteps = params.executedSteps.slice(-32);
    const checkpoint = compactText(
      [
        `Long task checkpoint: ${params.reason}`,
        `segment=${params.segment}`,
        `total_tool_calls=${params.totalToolCallCount}`,
        "",
        "<task>",
        compactText(params.task, 1200),
        "</task>",
        "",
        "<status>",
        status,
        "</status>",
        "",
        "<recent_tool_steps_json>",
        JSON.stringify(recentSteps, null, 2),
        "</recent_tool_steps_json>",
      ].join("\n"),
      6000,
    );
    await this.deps.transcript.append({
      role: "system",
      text: checkpoint,
      meta: {
        segment: params.segment,
        totalToolCallCount: params.totalToolCallCount,
        checkpoint: true,
      },
    });
    await this.deps.memory.addNote({
      kind: "goal",
      text: checkpoint,
      tags: ["long_task", "checkpoint"],
    });
    this.logFlow("checkpoint", {
      reason: params.reason,
      segment: params.segment,
      totalToolCallCount: params.totalToolCallCount,
      recentStepCount: recentSteps.length,
    });
    return checkpoint;
  }

  private recordedStepsForToolResult(name: string, args: JsonObject, result: ToolResult): ExecutedToolStep[] {
    if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
      const data = result.data as Record<string, unknown>;
      if (Array.isArray(data.executedSteps)) {
        const expanded = data.executedSteps
          .map((entry): ExecutedToolStep | undefined => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return undefined;
            }
            const step = entry as Record<string, unknown>;
            if (typeof step.tool !== "string" || !step.tool.trim()) {
              return undefined;
            }
            return {
              tool: step.tool.trim(),
              arguments:
                step.arguments && typeof step.arguments === "object" && !Array.isArray(step.arguments)
                  ? (step.arguments as JsonObject)
                  : {},
              ok: step.ok === true,
              result: compactText(typeof step.text === "string" ? step.text : "", 600),
            };
          })
          .filter((step): step is ExecutedToolStep => Boolean(step));
        if (expanded.length > 0) {
          return expanded;
        }
      }
    }
    return [
      {
        tool: name,
        arguments: args,
        ok: result.ok,
        result: compactText(result.text, 600),
      },
    ];
  }

  private logModelTurn(phase: "start" | "continue", segment: number, turn: number, response: ProviderTurn): void {
    this.logFlow("model_turn", {
      phase,
      segment,
      turn,
      finalText: response.text ? compactText(response.text, 1200) : "",
      toolCalls: response.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: this.deps.config.observability.logToolArgs ? compactText(call.arguments, 1200) : "[hidden]",
      })),
    });
  }

  private modelProviderStopReason(error: unknown, phase: "start" | "continue"): string {
    const retryable = isRetryableModelProviderError(error);
    const retryText = retryable ? " after configured retries" : "";
    return `Stopped: model provider ${phase} failed${retryText}: ${formatModelProviderError(error)}`;
  }

  private logToolCall(
    segment: number,
    segmentToolCallCount: number,
    totalToolCallCount: number,
    callId: string,
    name: string,
    args: JsonObject,
  ): void {
    this.logFlow("tool_call", {
      segment,
      segmentToolCallCount,
      totalToolCallCount,
      callId,
      tool: name,
      arguments: this.deps.config.observability.logToolArgs ? args : "[hidden]",
    });
  }

  private logToolResult(
    segment: number,
    segmentToolCallCount: number,
    totalToolCallCount: number,
    callId: string,
    name: string,
    result: ToolResult,
  ): void {
    const payload: Record<string, unknown> = {
      segment,
      segmentToolCallCount,
      totalToolCallCount,
      callId,
      tool: name,
      ok: result.ok,
      text: compactText(result.text, 1200),
    };
    if (this.deps.config.observability.logToolResults && result.data !== undefined) {
      payload.data = compactText(JSON.stringify(result.data), 2400);
    }
    const nestedSteps = this.nestedToolStepsForLog(result);
    if (nestedSteps.length > 0) {
      payload.nestedToolSteps = nestedSteps;
    }
    this.logFlow("tool_result", payload);
  }

  private nestedToolStepsForLog(result: ToolResult): Array<Record<string, unknown>> {
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
      return [];
    }
    const data = result.data as Record<string, unknown>;
    const rawSteps = Array.isArray(data.executedSteps)
      ? data.executedSteps
      : Array.isArray(data.results)
        ? data.results
        : [];
    return rawSteps
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      .map((item) => ({
        step: item.step,
        tool: item.tool,
        ok: item.ok,
        text: typeof item.text === "string" ? compactText(item.text, 500) : "",
        arguments:
          this.deps.config.observability.logToolArgs && item.arguments
            ? compactText(JSON.stringify(item.arguments), 800)
            : undefined,
      }));
  }

  private logFlow(event: string, data: Record<string, unknown> = {}): void {
    if (!this.deps.config.observability.logInternalFlow) {
      return;
    }
    const payload = compactText(JSON.stringify(data, null, 2), 5000);
    console.log(`[agent-flow] ${new Date().toISOString()} ${event}${payload === "{}" ? "" : ` ${payload}`}`);
  }

  private async runWithSlowOperationLog<T>(
    event: "model_still_waiting" | "tool_still_running",
    data: Record<string, unknown>,
    action: () => Promise<T>,
  ): Promise<T> {
    const thresholdMs = this.deps.config.observability.logInternalFlow
      ? Math.max(0, this.deps.config.observability.slowOperationLogMs)
      : 0;
    return runWithSlowOperationWatchdog({
      label: event,
      thresholdMs,
      snapshot: () => ({
        ...data,
        connection: this.safeConnectionSummary(),
        navigation: this.safeNavigationStatus(),
      }),
      log: (payload) => this.logFlow(event, payload),
      action,
    });
  }

  private safeConnectionSummary(): string {
    try {
      return this.deps.bot.connectionSummary();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private safeNavigationStatus(): unknown {
    try {
      return this.deps.bot.isConnected() ? this.deps.bot.navigationStatus() : undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private toolContext(): MinecraftToolContext {
    return {
      config: this.deps.config,
      bot: this.deps.bot,
      vision: this.deps.vision,
      catalog: this.deps.catalog,
      memory: this.deps.memory,
      goals: this.deps.goals,
      skills: this.deps.skills,
      imitation: this.deps.imitation,
      tasks: this.deps.tasks,
      subagents: this.deps.subagents,
    };
  }

  private async buildInstructions(focus = ""): Promise<string> {
    const blueprints = await listBlueprints(this.deps.config.paths.blueprints);
    const libraryBlueprints = await listBlueprintLibrary(this.deps.config.paths.blueprintLibrary);
    const recipeStatus = this.deps.bot.recipeCatalog("", 1);
    const localBlueprintSection =
      blueprints.length > 0
        ? blueprints
            .map(
              (item) =>
                `- ${item.name}: ${item.placements} blocks size=${item.size.x}x${item.size.y}x${item.size.z}`,
            )
            .join("\n")
        : "No blueprint files found.";
    const libraryBlueprintSection =
      libraryBlueprints.length > 0
        ? libraryBlueprints
            .map(
              (item) =>
                `- ${item.name}: ${item.placements} blocks size=${item.size.x}x${item.size.y}x${item.size.z}`,
            )
            .join("\n")
        : "No bundled library blueprints found.";
    const blueprintSection = [
      "Local blueprints:",
      localBlueprintSection,
      "",
      "Bundled blueprint library:",
      libraryBlueprintSection,
    ].join("\n");
    return buildTurnInstructions({
      basePrompt: buildBaseSystemPrompt({
        strictVisual: this.deps.config.strictVisual,
        toolNames: this.deps.tools.names(),
        soul: await readTextFile(this.deps.config.paths.soul, ""),
      }),
      environmentSection: [
        `server=${this.deps.config.minecraft.host}:${this.deps.config.minecraft.port}`,
        `mc_version=${this.deps.bot.raw.version}`,
        `auth=${this.deps.config.minecraft.auth}`,
        `modded_tolerant=${this.deps.config.minecraft.moddedTolerant}`,
        `combat_pve_enabled=${this.deps.config.combat.pveEnabled}`,
        `combat_pvp_enabled=${this.deps.config.combat.allowPvp}`,
        `combat_auto_defense=${this.deps.config.combat.autoDefense}`,
        `navigation=${JSON.stringify(this.deps.bot.navigationStatus())}`,
        `recipe_source=${recipeStatus.source}`,
        `server_recipes=${recipeStatus.serverRecipeCount}`,
        `recipe_packets_skipped=${recipeStatus.skippedByConfig}`,
      ].join("\n"),
      memorySection: await this.deps.memory.buildPromptSection(focus),
      skillSection: this.deps.skills.buildPromptSection(12, focus),
      catalogSection: this.deps.catalog.buildPromptSection(),
      transcriptSection: await this.deps.transcript.renderRecent(),
      blueprintSection,
      imitationSection: (await this.deps.imitation?.buildPromptSection()) ?? "",
      scheduledTaskSection: this.deps.tasks?.buildPromptSection() ?? "",
      goalSection: this.deps.goals?.buildPromptSection(focus) ?? "",
    });
  }

  private async maybeCompact(): Promise<void> {
    const count = await this.deps.transcript.countApprox();
    if (count < this.deps.config.loop.compactAfterMessages) {
      return;
    }
    const recent = await this.deps.transcript.renderRecent(80, 30000);
    const contextHash = digest(recent).slice(0, 24);
    const latest = await this.deps.memory.latestCompaction();
    if (latest?.contextHash === contextHash) {
      return;
    }
    await this.flushDurableMemoryBeforeCompaction(recent, contextHash);
    const summary = compactText(
      await this.provider.summarize({
        instructions: [
          "Summarize this Minecraft agent transcript for future autonomous work.",
          "Preserve active goals, current world/task state, failed attempts, learned skills, item facts, and blueprint progress.",
          "Keep exact item, block, blueprint, and skill names.",
        ].join("\n"),
        text: recent,
        maxOutputTokens: 1200,
      }),
      8000,
    );
    if (summary) {
      await this.deps.memory.addCompaction(summary, { contextHash });
    }
  }

  private async flushDurableMemoryBeforeCompaction(recentTranscript: string, contextHash: string): Promise<void> {
    const durable = compactText(
      await this.provider.summarize({
        instructions: [
          "Extract durable Minecraft agent memory before transcript compaction.",
          "Keep only facts, active goals, player preferences, environment/modpack lessons, repeated failures, and learned procedures that should survive context loss.",
          "Do not include ordinary chatter or tool logs unless they change future behavior.",
          "Return a concise bullet list. Return 'none' if there is nothing durable.",
        ].join("\n"),
        text: recentTranscript,
        maxOutputTokens: 900,
      }),
      5000,
    );
    if (!durable || durable.toLowerCase() === "none") {
      return;
    }
    await this.deps.memory.addNote({
      kind: "lesson",
      layer: "semantic",
      source: "flush",
      importance: 0.8,
      text: durable,
      tags: ["pre_compaction", "durable", contextHash],
    });
  }

  private async maybeRecordSkill(
    task: string,
    finalText: string,
    executedSteps: Array<{ tool: string; arguments: JsonObject; ok: boolean; result: string }>,
  ): Promise<void> {
    if (!this.deps.config.skillLearning.autoRecord) {
      return;
    }
    if (executedSteps.length < this.deps.config.skillLearning.minToolCalls) {
      return;
    }
    if (
      executedSteps.some((step) =>
        [
          "execute_steps",
          "record_skill",
          "imitation_to_skill",
          "execute_skill",
          "inspect_skill",
          "mark_skill_attempt",
          "memory_note",
          "memory_query",
          "memory_get",
          "memory_promote",
          "memory_status",
          "goal_plan",
          "goal_list",
          "goal_next",
          "goal_update",
          "goal_checkpoint",
          "environment_profile",
        ].includes(step.tool),
      )
    ) {
      return;
    }
    const actionable = executedSteps.filter(
      (step) =>
        ![
          "observe",
          "inventory",
          "catalog_query",
          "memory_query",
          "memory_get",
          "memory_note",
          "memory_promote",
          "memory_status",
          "goal_plan",
          "goal_list",
          "goal_next",
          "goal_update",
          "goal_checkpoint",
          "environment_profile",
          "query_skills",
          "inspect_skill",
          "execute_skill",
          "mark_skill_attempt",
          "list_tasks",
          "say",
        ].includes(step.tool),
    );
    if (actionable.length === 0) {
      return;
    }
    const skillTrace = executedSteps.slice(-80);

    const instructions = [
      "You are the skill librarian for a Minecraft Mineflayer agent.",
      "Decide whether the completed task trace contains a reusable, repeatable skill.",
      "Record a skill only when the trace has a concrete ordered procedure that can be retried later using atomic tools.",
      "Do not record one-off chat replies, pure observations, failed attempts, or vague intentions.",
      "If recording, produce scoped, concrete steps. Each step should be a JSON object with tool and arguments fields, and optional verification.",
      "Include server/version/modpack scope when behavior may be environment-specific.",
      "Return only the requested JSON object.",
    ].join("\n");
    const text = [
      "<task>",
      task,
      "</task>",
      "",
      "<final_text>",
      finalText,
      "</final_text>",
      "",
      "<environment>",
      `server=${this.deps.config.minecraft.host}:${this.deps.config.minecraft.port}`,
      `version=${this.deps.bot.raw.version}`,
      `auth=${this.deps.config.minecraft.auth}`,
      `modded_tolerant=${this.deps.config.minecraft.moddedTolerant}`,
      "</environment>",
      "",
      "<tool_trace_json>",
      JSON.stringify(skillTrace, null, 2),
      "</tool_trace_json>",
    ].join("\n");

    try {
      const draft = await this.provider.draftSkill({ instructions, text, maxOutputTokens: 1800 });
      if (!draft) {
        return;
      }
      const skill = await this.deps.skills.record({
        name: draft.name,
        description: draft.description,
        trigger: draft.trigger,
        steps: draft.steps,
        tags: Array.from(new Set(["auto", ...draft.tags])),
        scope: {
          server: `${this.deps.config.minecraft.host}:${this.deps.config.minecraft.port}`,
          version: this.deps.bot.raw.version,
          auth: this.deps.config.minecraft.auth,
          moddedTolerant: this.deps.config.minecraft.moddedTolerant,
          ...draft.scope,
        },
        preconditions: draft.preconditions,
        successCriteria: draft.successCriteria,
        failureModes: draft.failureModes,
      });
      await this.deps.transcript.append({
        role: "system",
        text: `auto-recorded skill ${skill.name}`,
        meta: { jsonPath: skill.jsonPath ?? "", mdPath: skill.mdPath ?? "" },
      });
    } catch (error) {
      await this.deps.transcript.append({
        role: "system",
        text: `auto skill recording skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
