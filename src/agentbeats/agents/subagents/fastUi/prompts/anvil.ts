/**
 * Few-shot for anvil + smithing_table tasks.
 *
 * Anvil slot roles:
 *   anvil_input_1 — left slot (target item: tool, armor, enchanted book)
 *   anvil_input_2 — right slot (sacrifice item or material)
 *   anvil_result  — right output slot (combined / repaired / renamed item)
 *
 * Smithing_table (1.20+) slot roles:
 *   smith_template — leftmost (smithing template)
 *   smith_base     — middle-left (base item, e.g. diamond_chestplate)
 *   smith_addition — middle-right (material, e.g. netherite_ingot)
 *   smith_result   — rightmost (upgraded item)
 *
 * Note: anvil costs XP; result slot only populates when the player
 * has enough experience levels. The runtime treats result-empty as
 * "not ready"; emit a verify_items_visible on the result slot before
 * take_result.
 */
export const FEW_SHOT_ANVIL = `

ANVIL / SMITHING MODE (subgoal_directive mentions anvil / repair / rename / smithing / netherite_upgrade). The active GUI is anvil or smithing_table. Slots-by-role names: anvil_input_1, anvil_input_2, anvil_result OR smith_template, smith_base, smith_addition, smith_result.

ANVIL EXAMPLE — task "combine two iron_pickaxe into one repaired iron_pickaxe". Suppose Known shows iron_pickaxe at <pick_a>, second iron_pickaxe at <pick_b>; slots_by_role lists <I1>=anvil_input_1, <I2>=anvil_input_2, <R>=anvil_result; <empty_inv> is a free hotbar slot.

  step1: verify_items_visible { items: ["iron_pickaxe"] }
  step2: pickup { sourceSlot: <pick_a>, expectedItem: "iron_pickaxe" }
  step3: place_all { destSlot: <I1>, expectedItem: "iron_pickaxe" }
  step4: pickup { sourceSlot: <pick_b>, expectedItem: "iron_pickaxe" }
  step5: place_all { destSlot: <I2>, expectedItem: "iron_pickaxe" }
  step6: verify_items_visible { slots: [<R>] }                                            // confirm result slot populated (depends on XP)
  step7: take_result { expectedItem: "iron_pickaxe" }                                      // takes the combined item; XP is consumed on take
  step8: place_all { destSlot: <empty_inv>, expectedItem: "iron_pickaxe" }
next_idx: 0

SMITHING EXAMPLE — task "upgrade diamond_chestplate to netherite_chestplate using netherite_upgrade_smithing_template + netherite_ingot". Suppose Known shows the template at <T_src>, base at <B_src>, addition at <A_src>; slots-by-role lists <T>=smith_template, <B>=smith_base, <A>=smith_addition, <R>=smith_result.

  step1: verify_items_visible { items: ["netherite_upgrade_smithing_template", "diamond_chestplate", "netherite_ingot"] }
  step2..7: place each input into its dedicated slot via pickup/place_all
  step8: verify_items_visible { slots: [<R>] }
  step9: take_result { expectedItem: "netherite_chestplate" }
  step10: place_all { destSlot: <empty_inv>, expectedItem: "netherite_chestplate" }
next_idx: 0

XP NOTE: anvil result slot is empty when the player can't afford the XP cost. If verify shows <R>=empty after both inputs are seated, the task is BLOCKED on player XP — return all_done=false and surface this via the closed-loop history; the GoalPlanner can fail the subgoal and dispatch a mining/combat detour to gain XP.`;
