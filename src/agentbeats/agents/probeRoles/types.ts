/** A discrete step in a crafting subgoal. The Planner agent owns the
 *  list of these; the Action agent receives ONE at a time. The runtime
 *  resolves abstract args (e.g. "ingredient name") into concrete slot
 *  indices via SlotMemory before dispatching to Action. */
export type Subtask =
  | { kind: "verify_ingredients"; candidates: string[] }
  | { kind: "place_step"; ingredient: string; destSlotIndex: number }
  | { kind: "take_result"; targetItem: string }
  | { kind: "swap_to_hotbar"; item: string; toHotbarIndex: number };

/** Subtask augmented with a checkbox state. The Planner ticks `done`
 *  to true based on observation of frame + Known. */
export type ChecklistItem = {
  id: string;       // monotonic "s1", "s2", ...
  text: string;     // human-readable rendering
  task: Subtask;    // the underlying typed subtask
  done: boolean;
};

/** Result of a Planner LLM call. */
export type PlanResult =
  | { kind: "all_done"; checklist: ChecklistItem[] }
  | { kind: "continue"; checklist: ChecklistItem[]; nextIdx: number };
