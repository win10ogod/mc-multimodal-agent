/** Generic Fast-UI subtask. The Planner (one per GUI kind: crafting,
 *  smelting, brewing, chest, anvil, ...) decomposes the current task
 *  into an ordered list of these. The Action agent receives ONE at a
 *  time and emits a concrete click chain. The runtime resolves the
 *  abstract slot/item references via SlotMemory. */
export type Subtask =
  /** OCR-confirm specific slots before any move. Use when Known is
   *  too sparse to identify which slot holds which item. */
  | { kind: "verify_slots"; slots: number[] }
  /** Move ONE unit of `sourceItem` (resolved via SlotMemory) to a
   *  specific destination slot. Used for placing ingredients into a
   *  craft grid, fuel into a furnace, item into a chest, etc. */
  | { kind: "move_one"; sourceItem: string; destSlotIndex: number }
  /** Move the FULL stack at `sourceSlotIndex` to `destSlotIndex`.
   *  Used for taking outputs (craft result, smelt result), bulk
   *  deposits, etc. */
  | { kind: "move_all"; sourceSlotIndex: number; destSlotIndex: number }
  /** Wait until a specific item appears in any non-input slot.
   *  Used for smelting (output appears after fuel burns) and any
   *  asynchronous-output GUI. */
  | { kind: "wait_for_output"; expectedItem: string }
  /** Click a labelled UI button (anvil "rename", enchant "level 1",
   *  villager trade slot, etc). */
  | { kind: "click_button"; buttonName: string }
  /** Confirm-only step. Planner ticks done when verifying state, no
   *  Action invocation needed. */
  | { kind: "verify_state"; condition: string };

/** Subtask augmented with a checkbox state. The Planner ticks `done`
 *  to true based on observation of frame + Known. `id` is monotonic
 *  ("s1", "s2", ...) so the Planner can preserve identity across
 *  re-judgments and not re-shuffle the list. */
export type ChecklistItem = {
  id: string;
  text: string;       // human-readable rendering
  task: Subtask;
  done: boolean;
};

/** Output of any Planner specialization. Generic across GUI kinds. */
export type PlanResult =
  | { kind: "all_done"; checklist: ChecklistItem[] }
  | { kind: "continue"; checklist: ChecklistItem[]; nextIdx: number };
