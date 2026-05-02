import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import type { AgentConfig } from "../config";
import { McuVirtualBot, type McuActionIntent } from "../bot/McuVirtualBot";
import { McuVisionStub } from "./McuVisionStub";
import { ItemCatalog } from "../knowledge/ItemCatalog";
import { MemoryStore } from "../memory/MemoryStore";
import { GoalStore } from "../goals/GoalStore";
import { SkillLibrary } from "../skills/SkillLibrary";
import { TaskStore } from "../tasks/TaskStore";
import { ToolRegistry } from "../tools/ToolRegistry";
import { createMinecraftToolRegistry, type MinecraftToolContext } from "../tools/MinecraftTools";
import { buildBaseSystemPrompt } from "../agent/systemPrompt";
import {
  formatModelProviderError,
  isRetryableModelProviderError,
  stripReasoningMarkup,
} from "../openai/ModelProvider";
import type { JsonObject, JsonValue } from "../types";
import { sleep } from "../utils/misc";
import {
  defaultMcuAction,
  MCU_ACTION_SCHEMA,
  type McuPolicyDecision,
  type McuEnvAction,
} from "./McuPrompt";
import { parseMcuActionText, normalizeMcuAction } from "./McuPolicy";
import { McuIntentCompiler } from "./McuIntentCompiler";

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

const DEFAULT_MAX_TOOL_CALLS_PER_OBS = 6;

const ACTION_PAYLOAD_PREFIX = { type: "action", action_type: "env" } as const;

export type McuToolDriverOptions = {
  config: AgentConfig;
  contextId: string;
  taskText: string;
  promptText?: string;
};

export class McuToolDriver {
  private readonly client: OpenAI;
  private readonly registry: ToolRegistry<MinecraftToolContext>;
  private readonly bot: McuVirtualBot;
  private readonly vision: McuVisionStub;
  private readonly catalog: ItemCatalog;
  private readonly memory: MemoryStore;
  private readonly goals: GoalStore;
  private readonly skills: SkillLibrary;
  private readonly tasks: TaskStore;
  private toolContext!: MinecraftToolContext;
  private taskText: string;
  private readonly promptText: string;
  private readonly recentIntents: McuActionIntent[] = [];
  private readonly compiler = new McuIntentCompiler();
  private lastDrainedIntents: McuActionIntent[] = [];
  private soul = "";
  private initialized = false;

  constructor(private readonly opts: McuToolDriverOptions) {
    this.client = new OpenAI({
      apiKey: opts.config.openai.apiKey || "missing-key",
      baseURL: opts.config.openai.baseURL,
      timeout: Math.max(1_000, opts.config.openai.requestTimeoutMs),
      maxRetries: 0,
    });
    this.registry = createMinecraftToolRegistry();
    this.bot = new McuVirtualBot({ version: opts.config.minecraft.version ?? "1.20.4" });
    this.vision = new McuVisionStub(this.bot, opts.config);
    this.catalog = new ItemCatalog(opts.config.paths.itemCatalog, opts.config.minecraft.version);
    this.memory = new MemoryStore(opts.config.paths.memory);
    this.goals = new GoalStore(opts.config.paths.goals);
    this.skills = new SkillLibrary(opts.config.paths.skills);
    this.tasks = new TaskStore(opts.config.paths.tasks);
    this.taskText = opts.taskText;
    this.promptText = opts.promptText ?? "";
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.catalog.load();
    await this.memory.init();
    await this.goals.load();
    await this.skills.load();
    await this.tasks.load();
    try {
      this.soul = (await readFile(this.opts.config.paths.soul, "utf8")).trim();
    } catch {
      this.soul = "";
    }
    this.toolContext = {
      config: this.opts.config,
      bot: this.bot,
      vision: this.vision,
      catalog: this.catalog,
      memory: this.memory,
      goals: this.goals,
      skills: this.skills,
      tasks: this.tasks,
    };
    this.initialized = true;
  }

  ingestObservation(frameB64: string): void {
    this.bot.ingestFrame(frameB64);
  }

  setTask(taskText: string): void {
    this.taskText = taskText;
  }

  drainIntents(): McuActionIntent[] {
    return this.lastDrainedIntents;
  }

  pendingButtonCount(): number {
    return this.compiler.pendingCount();
  }

  /**
   * Run the tool-call loop for this MCU step. Returns an MCU action decision.
   * Phase 3 milestone: tool calls execute end-to-end against the virtual bot,
   * the model produces an MCU action JSON in its final message. Phase 4 will
   * also compile drained intents into action queues.
   */
  async step(stepNumber: number): Promise<McuPolicyDecision> {
    await this.ensureInitialized();

    // If button macros are queued from a previous tool-call turn, drain them
    // one frame at a time before invoking the model again.
    if (this.compiler.hasPending()) {
      const next = this.compiler.next()!;
      return { ...ACTION_PAYLOAD_PREFIX, action: next.action, hold_steps: next.holdSteps };
    }

    const frame = this.bot.getLatestFrame();
    if (!frame) {
      return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
    }

    const systemPrompt = buildBaseSystemPrompt({
      strictVisual: this.opts.config.strictVisual,
      toolNames: this.registry.names(),
      soul: this.soul,
    });

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          systemPrompt,
          "",
          "You are running inside the MCU evaluation pipeline.",
          "Each turn you receive ONE first-person frame. Use knowledge tools (recipe_query, plan_craft, search_catalog, memory_query, inventory) to plan; physical action tools (move, dig, craft, ...) queue intents that the wrapper compiles into MCU button presses.",
          "After your tool calls, your final assistant message MUST be ONLY a strict JSON MCU action payload matching the schema:",
          JSON.stringify(MCU_ACTION_SCHEMA),
          this.promptText ? `\nAdditional evaluator prompt:\n${this.promptText}` : "",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Task: ${this.taskText || "(no task)"}` },
          { type: "text", text: `Step: ${stepNumber}` },
          {
            type: "text",
            text: `Recent intents queued so far: ${this.recentIntents.slice(-8).map((i) => i.kind).join(", ") || "(none)"}`,
          },
          { type: "image_url", image_url: { url: frame.startsWith("data:") ? frame : `data:image/jpeg;base64,${frame}`, detail: "high" } },
        ],
      },
    ];

    const tools = this.registry.definitions().map((def) => ({
      type: "function" as const,
      function: {
        name: String(def.name),
        description: String(def.description ?? ""),
        parameters: (def.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
      },
    }));

    const maxLoops = DEFAULT_MAX_TOOL_CALLS_PER_OBS;
    let finalText = "";

    for (let loop = 0; loop < maxLoops; loop += 1) {
      let completion: unknown;
      try {
        completion = await this.callChat(messages, tools);
      } catch (error) {
        if (isRetryableModelProviderError(error)) {
          await sleep(250);
          continue;
        }
        console.warn(`[mcu-tool] chat error: ${formatModelProviderError(error)}`);
        break;
      }

      const choice = (completion as { choices?: Array<{ message?: unknown }> }).choices?.[0]?.message as
        | { content?: unknown; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
        | undefined;
      if (!choice) break;

      const calls = choice.tool_calls ?? [];
      if (calls.length === 0) {
        const content = choice.content;
        finalText = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.flatMap((p) => (typeof (p as { text?: string }).text === "string" ? [(p as { text: string }).text] : [])).join("\n")
            : "";
        break;
      }

      messages.push({ role: "assistant", content: choice.content ?? "", tool_calls: calls });
      for (const call of calls) {
        const args = safeJsonParse(call.function.arguments) ?? {};
        const result = await this.registry.execute(call.function.name, args as JsonObject, this.toolContext);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: result.ok, text: result.text, data: clampJson(result.data) }),
        });
      }
    }

    // Compile any queued intents from action tools called above into MCU
    // button macros, drained one per frame on subsequent step() calls.
    const drained = this.bot.drainIntents();
    this.lastDrainedIntents = drained;
    if (drained.length > 0) {
      this.recentIntents.push(...drained);
      if (this.recentIntents.length > 32) this.recentIntents.splice(0, this.recentIntents.length - 32);
      this.compiler.enqueueIntents(drained);
    }

    if (this.compiler.hasPending()) {
      const next = this.compiler.next()!;
      return { ...ACTION_PAYLOAD_PREFIX, action: next.action, hold_steps: next.holdSteps };
    }

    const decision = parseMcuActionText(stripReasoningMarkup(finalText)) ?? {
      ...ACTION_PAYLOAD_PREFIX,
      action: defaultMcuAction(),
      hold_steps: 1,
    };
    decision.action = normalizeMcuAction(decision.action as unknown as McuEnvAction);
    return decision;
  }

  private async callChat(messages: ChatMessage[], tools: unknown[]): Promise<unknown> {
    const body: Record<string, unknown> = {
      model: this.opts.config.openai.model,
      messages,
      tools,
      tool_choice: "auto",
      max_completion_tokens: 1500,
    };
    return await this.client.chat.completions.create(body as never);
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function clampJson(value: JsonValue | undefined): JsonValue | undefined {
  if (value == null) return undefined;
  const text = JSON.stringify(value);
  if (text.length <= 4000) return value;
  return `${text.slice(0, 4000)}…(truncated)` as unknown as JsonValue;
}
