import type OpenAI from "openai";
import type { EpisodeState, Subgoal } from "./SubAgent";
import { GOAL_PLANNER_SYSTEM_PROMPT } from "../prompts/goal_planner";
import { inspectInventoryTool } from "./plannerTools/InspectInventoryTool";
import { verifySlotsTool } from "./plannerTools/VerifySlotsTool";
import { lookAroundTool } from "./plannerTools/LookAroundTool";
import { addChecklistItemTool, markChecklistItemTool, readChecklistTool } from "./plannerTools/ChecklistTools";

export type PlannerLoopResult =
  | { kind: "dispatch"; subgoal: Subgoal }
  | { kind: "done" }
  | { kind: "error"; reason: string };

const READ_TOOLS = [inspectInventoryTool, verifySlotsTool, lookAroundTool];

const DISPATCH_TOOL_DEF = {
  type: "function" as const,
  function: {
    name: "dispatch_subgoal",
    description:
      "Dispatch ONE specialist sub-agent to perform a side-effecting action. " +
      "After it returns, you will be re-invoked with the summary appended.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ui_inventory", "world_explore", "mining", "combat", "placing"] },
        description: { type: "string" },
        success_criteria: { type: "string" },
        target: {
          type: "string",
          description:
            "Structured target identifier (snake_case Minecraft id, e.g. 'crafting_table'). REQUIRED when kind='placing' so the runtime can verify the equipped hotbar slot. Optional / ignored for other kinds.",
        },
        gui_target: {
          type: "string",
          description:
            "For kind='ui_inventory': which GUI to interact with. Omit or use 'player_inventory' for the default 2x2 inventory (opened with the inventory key). Use a block id (e.g. 'crafting_table', 'furnace', 'chest') when the recipe requires the placed block's GUI — the runtime will align the camera to centre that block on the crosshair and right-click it to open. The placed block MUST already be in front of the agent (a prior placing(<block>) dispatch is the typical setup); if not visible the subagent reports target_ui_not_in_view.",
        },
      },
      required: ["kind", "description", "success_criteria"],
      additionalProperties: false,
    },
  },
};

const FINISH_TOOL_DEF = {
  type: "function" as const,
  function: {
    name: "task_complete",
    description: "Call when the overall task is fully achieved. Sets earlyStop.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export type PlannerLoopDeps = {
  client: OpenAI;
  model: string;
  recordDebug?: (kind: string, payload: unknown) => Promise<void> | void;
};

export async function runPlannerLoop(
  deps: PlannerLoopDeps,
  state: EpisodeState,
  obsBase64: string,
  contextId: string,
): Promise<PlannerLoopResult> {
  const log = async (kind: string, payload: unknown) => {
    try { await deps.recordDebug?.(kind, payload); } catch { /* swallow */ }
  };
  if (state.pendingReflection) {
    const r = state.pendingReflection;
    if (state.plannerMessages.length === 0) {
      state.plannerMessages.push({ role: "system", content: GOAL_PLANNER_SYSTEM_PROMPT });
      state.plannerMessages.push({ role: "user", content: `Task: ${state.taskText}` });
    }
    const reportLine = r.reportFields
      ? `Report fields (structured): ${JSON.stringify(r.reportFields)}\n`
      : "";
    state.plannerMessages.push({
      role: "user",
      content:
        `The sub-agent for "${r.subgoal.description}" returned: ${r.outcome.toUpperCase()}.\n` +
        `Summary: ${r.summary}\n` +
        reportLine +
        `\nREFLECT before your next move:\n` +
        `1. Call read_checklist.\n` +
        `2. If success, VERIFY the result with inspect_inventory or verify_slots BEFORE marking done.\n` +
        `3. If failure starts with "BLOCKED:" or has report fields with a "code", insert prerequisite checklist items, then dispatch the first prerequisite.\n` +
        `4. After the checklist reflects reality, either dispatch the next pending item or call task_complete (only if every item is done).`,
    });
    state.pendingReflection = null;
  } else if (state.plannerMessages.length === 0) {
    state.plannerMessages.push({ role: "system", content: GOAL_PLANNER_SYSTEM_PROMPT });
    state.plannerMessages.push({ role: "user", content: `Task: ${state.taskText}` });
  }

  const stateBoundTools = [
    inspectInventoryTool,
    verifySlotsTool,
    lookAroundTool,
    addChecklistItemTool(state),
    markChecklistItemTool(state),
    readChecklistTool(state),
  ];
  const tools: any[] = [
    ...stateBoundTools.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
    DISPATCH_TOOL_DEF,
    FINISH_TOOL_DEF,
  ];

  await log("planner_turn_start", {
    taskText: state.taskText,
    pendingReflection: state.pendingReflection ?? null,
    checklist: state.checklist.read(),
    messageCount: state.plannerMessages.length,
  });

  const MAX_TOOL_HOPS = 6;
  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const resp = await deps.client.chat.completions.create({
      model: deps.model,
      messages: state.plannerMessages as any,
      tools,
    });
    const msg = resp.choices?.[0]?.message;
    if (!msg) {
      await log("planner_error", { hop, reason: "empty planner response" });
      return { kind: "error", reason: "empty planner response" };
    }
    state.plannerMessages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls as any });
    await log("planner_assistant", { hop, content: msg.content ?? "", tool_calls: msg.tool_calls ?? null });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      await log("planner_error", { hop, reason: "planner produced text instead of tool call" });
      return { kind: "error", reason: "planner produced text instead of tool call" };
    }
    for (const tc of msg.tool_calls as any[]) {
      const fname = tc.function.name as string;
      const fargs = JSON.parse(tc.function.arguments || "{}");

      if (fname === "task_complete") {
        if (!state.checklist.allDone()) {
          const content = `error: cannot complete — checklist still has items not 'done':\n${state.checklist.format()}`;
          state.plannerMessages.push({ role: "tool", tool_call_id: tc.id, content });
          await log("planner_tool", { hop, name: fname, args: fargs, result: content, ok: false });
          continue;
        }
        await log("planner_done", { hop, checklist: state.checklist.read() });
        return { kind: "done" };
      }
      if (fname === "dispatch_subgoal") {
        const sg = fargs as Subgoal;
        // OpenAI's chat API requires every assistant tool_call to be answered
        // by a tool-role message before the next assistant/user turn. Without
        // this synthetic ack, the saved plannerMessages becomes malformed
        // when the next observation pushes the user reflection — and the
        // following chat.completions.create either errors or hangs forever
        // on reasoning models.
        state.plannerMessages.push({
          role: "tool",
          tool_call_id: tc.id as string,
          content: `dispatched ${sg.kind}: ${sg.description}`,
        });
        console.log(`[planner] DISPATCH ${sg.kind} <- "${sg.description}" (success: "${sg.success_criteria}")`);
        await log("planner_dispatch", { hop, subgoal: sg });
        return { kind: "dispatch", subgoal: sg };
      }
      const tool = stateBoundTools.find(t => t.name === fname);
      if (!tool) {
        const content = `error: unknown tool ${fname}`;
        state.plannerMessages.push({ role: "tool", tool_call_id: tc.id as string, content });
        await log("planner_tool", { hop, name: fname, args: fargs, result: content, ok: false });
        continue;
      }
      const result = await tool.run({ obsBase64, contextId, client: deps.client, model: deps.model }, fargs);
      const text = result.ok ? result.text : `error: ${result.error}`;
      state.plannerMessages.push({ role: "tool", tool_call_id: tc.id as string, content: text });
      await log("planner_tool", { hop, name: fname, args: fargs, result: text, ok: result.ok });
    }
  }
  const reason = `planner exceeded ${MAX_TOOL_HOPS} tool hops without dispatching`;
  await log("planner_error", { reason });
  return { kind: "error", reason };
}
