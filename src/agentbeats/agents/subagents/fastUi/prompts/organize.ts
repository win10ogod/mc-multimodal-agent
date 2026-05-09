/**
 * Few-shot for inventory organize dispatches.
 *
 * Triggered when the GoalPlanner sends a subgoal_directive matching
 * /\borganize\b|\bmove\b\s+\w+\s+(from|to|into)\b/. Moves an existing
 * inventory item from its current slot to a target slot — no recipe.
 */
export const FEW_SHOT_ORGANIZE = `

ORGANIZE MODE (subgoal_directive starts with "organize" / "move"). Move an existing inventory item from its current slot to a target slot. No recipe involved.

  step1: verify_items_visible { items: ["<item>"] }                                       // confirm <item> is somewhere in Known
  step2: pickup { sourceSlot: <slot_with_item>, expectedItem: "<item>" }
  step3: place_all { destSlot: <target_slot>, expectedItem: "<item>" }                    // move the whole stack
  step4: verify_items_visible { slots: [<target_slot>] }                                  // confirm the move landed
next_idx: 0

If the target slot already holds the same item, MC stacks safely. If it holds a different item, pick a different empty target_slot first or insert a place-aside recovery before pickup.`;
