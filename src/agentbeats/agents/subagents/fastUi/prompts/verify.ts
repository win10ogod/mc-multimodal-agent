/**
 * Few-shot for verify-only dispatches.
 *
 * Triggered when the GoalPlanner sends a subgoal_directive starting
 * with "verify" — read-only inventory inspection. The Planner emits a
 * verify_items_visible sweep to populate Known, then declares all_done
 * so the runtime surfaces what was observed back to the GoalPlanner.
 */
export const FEW_SHOT_VERIFY = `

VERIFY-ONLY MODE (subgoal_directive starts with "verify"). The GoalPlanner only wants to know what is currently visible in the inventory or specific slots. DO NOT pickup, place, or take_result. Emit only verify_items_visible step(s), then declare all_done so the runtime returns the observed Known to the GoalPlanner.

Two phrasings:
- "verify inventory contains <items>" → step1: verify_items_visible { items: [<items>] }; declare all_done=true ONLY if EVERY listed item is already present in Known. If any are missing-from-Known, keep all_done=false so the runtime OCRs candidate slots — Known will be refreshed and the next post_action call can declare all_done.
- "verify slot <N> is <empty|filled>" → step1: verify_items_visible { slots: [<N>] }; declare all_done after the OCR confirms the state.

When all listed items are in Known on the first call (no OCR needed), return all_done=true with an empty checklist. The runtime will surface those Known entries to the GoalPlanner via the subgoal_done summary's "Items in inventory:" line.

DO NOT inject pickup/place_*/take_result steps in verify mode. Re-PLAN rule #5 (target item already in slot → all_done) is the ONLY exit; do not chain more clicks.`;
