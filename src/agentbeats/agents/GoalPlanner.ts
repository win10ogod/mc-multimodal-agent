import type OpenAI from "openai";
import type { Subgoal } from "./SubAgent";
import { GOAL_PLANNER_SCHEMA, GOAL_PLANNER_SYSTEM_PROMPT } from "../prompts/goal_planner";

export type PlannerOutput = {
  subgoals: Subgoal[];
  overall_done: boolean;
};

export type PlannerDeps = {
  client: OpenAI;
  model: string;
};

const FALLBACK_SINGLE_UI = (taskText: string): PlannerOutput => ({
  overall_done: false,
  subgoals: [{
    kind: "ui_inventory",
    description: taskText,
    success_criteria: "Result of the task is visible in inventory.",
  }],
});

export async function planGoals(
  deps: PlannerDeps,
  taskText: string,
  completedSummaries: string[],
): Promise<PlannerOutput> {
  const userMsg = JSON.stringify({ task: taskText, completed: completedSummaries });
  try {
    const resp = await deps.client.chat.completions.create({
      model: deps.model,
      messages: [
        { role: "system", content: GOAL_PLANNER_SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "planner_output", schema: GOAL_PLANNER_SCHEMA, strict: true },
      },
    });
    const text = resp.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as PlannerOutput;
    if (!Array.isArray(parsed.subgoals) || parsed.subgoals.length === 0) {
      return FALLBACK_SINGLE_UI(taskText);
    }
    return parsed;
  } catch (e) {
    console.warn(`[goal-planner] fallback after error: ${e instanceof Error ? e.message : String(e)}`);
    return FALLBACK_SINGLE_UI(taskText);
  }
}
