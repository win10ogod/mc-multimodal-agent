/**
 * Few-shot for smelting tasks (furnace / blast_furnace / smoker).
 *
 * Slot roles in a furnace layout:
 *   smelt_input  — top slot (raw ore, raw food, sand, cobble, etc.)
 *   smelt_fuel   — bottom slot (coal, charcoal, wood, lava bucket, etc.)
 *   smelt_result — right slot (cooked output)
 *   main_inv / hotbar — player inventory below
 *
 * Rate: a typical furnace cooks one item per ~10 in-game seconds.
 * wait_for_output should target ~100–200 ticks for a full stack.
 */
export const FEW_SHOT_SMELTING = `

SMELTING MODE (subgoal_directive mentions smelt / furnace / cook). The active GUI is a furnace (or smoker / blast_furnace). Slots-by-role names: smelt_input, smelt_fuel, smelt_result.

EXAMPLE — task "smelt iron_ore into iron_ingot using coal as fuel". Suppose Known shows iron_ore at <ore_src>, coal at <coal_src>; slots_by_role lists <input>=smelt_input, <fuel>=smelt_fuel, <result>=smelt_result; <empty_inv> is a free hotbar slot.

  step1: verify_items_visible { items: ["iron_ore", "coal"] }                             // confirm sources in Known
  step2: pickup { sourceSlot: <coal_src>, expectedItem: "coal" }
  step3: place_all { destSlot: <fuel>, expectedItem: "coal" }                              // load fuel FIRST so the burn can start the moment input lands
  step4: pickup { sourceSlot: <ore_src>, expectedItem: "iron_ore" }
  step5: place_all { destSlot: <input>, expectedItem: "iron_ore" }                         // input slot gets the raw item
  step6: wait_for_output { expectedItem: "iron_ingot" }                                    // sim runs the smelt; runtime ticks done when result slot populates
  step7: verify_items_visible { slots: [<result>, <empty_inv>] }                           // confirm result has iron_ingot AND deposit target is empty
  step8: take_result { expectedItem: "iron_ingot" }
  step9: place_all { destSlot: <empty_inv>, expectedItem: "iron_ingot" }
next_idx: 0

If the input slot already holds the raw item (e.g. a previous attempt left it there) and Known shows the result slot has the cooked output: skip directly to take_result + place_all into a free inv slot. Re-PLAN rule #5 applies — if Known already shows iron_ingot in a regular slot, declare all_done.

FUEL ORDERING: load fuel before input so the furnace fires immediately. Loading input first wastes ticks until fuel arrives.

DEPOSIT RULE: same as crafting — only hotbar/main_inv slots. Never the smelt_input/fuel/result.`;
