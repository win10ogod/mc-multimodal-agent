import type OpenAI from "openai";
import type { Subgoal } from "./SubAgent";
import { makeEpisodeState } from "./SubAgent";
import { runPlannerLoop } from "./PlannerLoop";

export type PlannerOutput = {
  subgoals: Subgoal[];
  overall_done: boolean;
};

export type PlannerDeps = {
  client: OpenAI;
  model: string;
};

/** Legacy shim. New callers should use runPlannerLoop directly with an EpisodeState. */
export async function planGoals(
  deps: PlannerDeps,
  taskText: string,
  completedSummaries: string[],
): Promise<PlannerOutput> {
  const state = makeEpisodeState(taskText);
  state.completedSummaries = completedSummaries;
  const r = await runPlannerLoop(deps, state, "", "compat");
  if (r.kind === "dispatch") return { overall_done: false, subgoals: [r.subgoal] };
  return { overall_done: true, subgoals: [] };
}
