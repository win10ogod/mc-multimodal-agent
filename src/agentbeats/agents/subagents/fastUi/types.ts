/** Primitive Fast-UI subtask. Each subtask maps to exactly ONE
 *  primitive click (or one OCR pass), so the runtime can auto-tick
 *  the active checklist item from a single confirmed-verify outcome
 *  without asking the Planner LLM to infer progress.
 *
 *  Slots ARE numbered here (deliberate change from earlier symbolic
 *  design). The Planner resolves slot indices using the recipe
 *  Placement plan + Known. The Action subagent translates the
 *  subtask into a click verbatim.
 */
export type Subtask =
  /** OCR slots to learn their contents. Either the planner names
   *  expected items (Action picks candidate slots) or it lists
   *  specific slot indices (Action verifies those exact slots).
   *  When both are empty/missing, Action falls back to OCR'ing up
   *  to 3 visually-suspicious slots. */
  | { kind: "verify_items_visible"; items?: string[]; slots?: number[] }
  /** Pick up (whole stack at) source slot — left-click. Cursor
   *  becomes loaded with `expectedItem` so the runtime can record
   *  cursor identity on confirmed pickup. */
  | { kind: "pickup"; sourceSlot: number; expectedItem: string }
  /** Right-click destination slot to drop EXACTLY ONE item. Cursor
   *  must hold `expectedItem`. */
  | { kind: "place_one"; destSlot: number; expectedItem: string }
  /** Left-click destination slot to drop the WHOLE held stack
   *  (or swap if dest non-empty with a different item). Cursor
   *  must hold `expectedItem`. */
  | { kind: "place_all"; destSlot: number; expectedItem: string }
  /** Take the crafted result from the recipe result slot. Action
   *  picks a free hotbar/main_inv destination. */
  | { kind: "take_result"; expectedItem: string }
  /** Wait for async output (smelting/brewing) to appear. */
  | { kind: "wait_for_output"; expectedItem: string }
  /** Confirm-only step. Action emits done if condition holds in
   *  Known + frame. */
  | { kind: "verify_state"; condition: string };

/** Subtask augmented with checkbox state. Runtime ticks `done` from
 *  primitive verify outcomes; Planner only re-plans on stuck or
 *  unexpected state. */
export type ChecklistItem = {
  id: string;
  text: string;
  task: Subtask;
  done: boolean;
  attempts: number;
};

/** Generic Planner output across all GUI kinds. */
export type PlanResult =
  | { kind: "all_done"; checklist: ChecklistItem[] }
  | { kind: "continue"; checklist: ChecklistItem[]; nextIdx: number };
