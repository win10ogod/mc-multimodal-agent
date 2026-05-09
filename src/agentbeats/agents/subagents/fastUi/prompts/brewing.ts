/**
 * Few-shot for brewing tasks (brewing_stand).
 *
 * Slot roles in a brewing_stand layout:
 *   brew_ingredient — top centre slot (nether_wart, redstone, glowstone, etc.)
 *   brew_bottle_1   — bottom-left bottle slot
 *   brew_bottle_2   — bottom-centre bottle slot
 *   brew_bottle_3   — bottom-right bottle slot
 *   brew_fuel       — left side slot (blaze_powder; one piece fuels 20 brews)
 *   main_inv / hotbar — player inventory below
 *
 * Rate: a single brew cycle takes ~20 in-game seconds and processes
 * all 3 bottles in parallel. wait_for_output should target ~400 ticks.
 */
export const FEW_SHOT_BREWING = `

BREWING MODE (subgoal_directive mentions brew / potion). The active GUI is a brewing_stand. Slots-by-role names: brew_ingredient, brew_bottle_1, brew_bottle_2, brew_bottle_3, brew_fuel.

EXAMPLE — task "brew awkward_potion from nether_wart using water bottles". Suppose Known shows nether_wart at <wart_src>, water_bottle stacks at <wb1_src>, <wb2_src>, <wb3_src>, blaze_powder at <bp_src>; <empty_inv> is a free hotbar slot.

  step1: verify_items_visible { items: ["nether_wart", "water_bottle", "blaze_powder"] }
  step2: pickup { sourceSlot: <bp_src>, expectedItem: "blaze_powder" }
  step3: place_one { destSlot: <brew_fuel>, expectedItem: "blaze_powder" }                 // one piece fuels 20 brews
  step4: place_all { destSlot: <bp_src>, expectedItem: "blaze_powder" }                    // return remainder
  step5: pickup { sourceSlot: <wb1_src>, expectedItem: "water_bottle" }
  step6: place_one { destSlot: <brew_bottle_1>, expectedItem: "water_bottle" }
  step7: place_all { destSlot: <wb1_src>, expectedItem: "water_bottle" }
  step8..13: pickup/place pairs to seat bottles in <brew_bottle_2> and <brew_bottle_3>
  step14: pickup { sourceSlot: <wart_src>, expectedItem: "nether_wart" }
  step15: place_one { destSlot: <brew_ingredient>, expectedItem: "nether_wart" }           // ingredient lands LAST — brew starts only after all four slots are present
  step16: place_all { destSlot: <wart_src>, expectedItem: "nether_wart" }
  step17: wait_for_output { expectedItem: "awkward_potion" }
  step18: verify_items_visible { slots: [<brew_bottle_1>, <brew_bottle_2>, <brew_bottle_3>] }
  step19..21: pickup each brewed bottle in turn → place_all into <empty_inv>+ free slots
next_idx: 0

ORDERING: fuel first (with one place_one + return-remainder), bottles next, ingredient LAST. The brew cycle starts the tick after all four positional slots (3 bottles + ingredient) are filled, so seating the ingredient last is the trigger.

DEPOSIT RULE: same as crafting — only hotbar/main_inv slots for the finished bottles.`;
