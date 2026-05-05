import type OpenAI from "openai";
import type { EpisodeState, Subgoal } from "./SubAgent";
import { GOAL_PLANNER_SYSTEM_PROMPT } from "../prompts/goal_planner";
import { inspectInventoryTool } from "./plannerTools/InspectInventoryTool";
import { verifySlotsTool } from "./plannerTools/VerifySlotsTool";
import { lookAroundTool } from "./plannerTools/LookAroundTool";

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

export async function runPlannerLoop(
  deps: { client: OpenAI; model: string },
  state: EpisodeState,
  obsBase64: string,
  contextId: string,
): Promise<PlannerLoopResult> {
  if (state.plannerMessages.length === 0) {
    state.plannerMessages.push({ role: "system", content: GOAL_PLANNER_SYSTEM_PROMPT });
    state.plannerMessages.push({ role: "user", content: `Task: ${state.taskText}` });
  } else if (state.completedSummaries.length > 0) {
    const last = state.completedSummaries[state.completedSummaries.length - 1];
    state.plannerMessages.push({ role: "user", content: `Subgoal result: ${last}` });
  }

  const tools: any[] = [
    ...READ_TOOLS.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
    DISPATCH_TOOL_DEF,
    FINISH_TOOL_DEF,
  ];

  const MAX_TOOL_HOPS = 6;
  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const resp = await deps.client.chat.completions.create({
      model: deps.model,
      messages: state.plannerMessages as any,
      tools,
    });
    const msg = resp.choices?.[0]?.message;
    if (!msg) return { kind: "error", reason: "empty planner response" };
    state.plannerMessages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls as any });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { kind: "error", reason: "planner produced text instead of tool call" };
    }
    for (const tc of msg.tool_calls as any[]) {
      const fname = tc.function.name as string;
      const fargs = JSON.parse(tc.function.arguments || "{}");

      if (fname === "task_complete") {
        return { kind: "done" };
      }
      if (fname === "dispatch_subgoal") {
        return { kind: "dispatch", subgoal: fargs as Subgoal };
      }
      const tool = READ_TOOLS.find(t => t.name === fname);
      if (!tool) {
        state.plannerMessages.push({ role: "tool", tool_call_id: tc.id as string, content: `error: unknown tool ${fname}` });
        continue;
      }
      const result = await tool.run({ obsBase64, contextId, client: deps.client, model: deps.model }, fargs);
      const text = result.ok ? result.text : `error: ${result.error}`;
      state.plannerMessages.push({ role: "tool", tool_call_id: tc.id as string, content: text });
    }
  }
  return { kind: "error", reason: `planner exceeded ${MAX_TOOL_HOPS} tool hops without dispatching` };
}
