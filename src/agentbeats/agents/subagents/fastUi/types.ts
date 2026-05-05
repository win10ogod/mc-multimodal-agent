/** SYMBOLIC Fast-UI subtask. Strictly NUMBER-FREE — no slot indices,
 *  no row/col coordinates, no count fields. The Planner speaks only
 *  in semantic terms; the Action agent + runtime own all numeric
 *  resolution (which slot, which cell, how many) by combining the
 *  symbolic intent with the live layout, recipe, and Known state.
 *
 *  This isolation prevents "number pollution" — once the Planner
 *  emits a number, the Action agent tends to follow it blindly even
 *  when it points to the wrong slot in the current layout. */
export type Subtask =
  /** Confirm by OCR that named items exist in inventory. Action
   *  picks candidate slots itself. Skip when caller already trusts
   *  Known. */
  | { kind: "verify_items_visible"; items: string[] }
  /** Place one unit of `item` into the recipe's craft grid. Action
   *  computes which craft cell to use by looking at recipe.inShape
   *  (for shaped) or row-major order (for shapeless) combined with
   *  what's already been placed. */
  | { kind: "place_in_craft_grid"; item: string }
  /** Take the crafted result from the recipe result slot to a free
   *  regular inventory slot. Action finds role==="result" and a free
   *  hotbar/main_inv slot itself. */
  | { kind: "take_result"; expectedItem: string }
  /** Wait for async output (smelting/brewing) to appear. */
  | { kind: "wait_for_output"; expectedItem: string }
  /** Click any labelled / role-tagged UI element. The Action agent
   *  resolves buttonName to a concrete slot index — either by role
   *  (e.g. "recipe_book_button" anchor surfaced via template match)
   *  or by visual match within the current GUI panel. Used for the
   *  recipe-book toggle, anvil rename button, recipe entries, etc. */
  | { kind: "click_button"; buttonName: string }
  /** Confirm-only step. Action emits done if condition holds in
   *  Known + frame. */
  | { kind: "verify_state"; condition: string };

/** Subtask augmented with checkbox state. Planner ticks `done` based
 *  on observation; `attempts` counts Action dispatches against the
 *  item; Planner uses it to break stuck loops. */
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
