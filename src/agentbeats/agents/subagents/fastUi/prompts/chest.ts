/**
 * Few-shot for container interactions (chest, ender_chest, barrel,
 * shulker_box, hopper, dispenser, dropper).
 *
 * Slot roles vary by container:
 *   chest_slot   — single chest holds 27 (slots 0..26); double chest 54
 *   barrel_slot  — same shape as single chest
 *   hopper_slot  — 5 slots in a row
 *   dispenser_slot / dropper_slot — 9-slot 3x3 grid
 *
 * Two intents:
 *   - DEPOSIT: move items from inventory INTO container slots
 *   - WITHDRAW: move items FROM container slots into inventory
 */
export const FEW_SHOT_CHEST = `

CONTAINER MODE (subgoal_directive mentions chest / barrel / shulker / hopper / deposit / withdraw / store / take_from). The active GUI is one of: chest, ender_chest, barrel, shulker_box, hopper, dispenser, dropper. Slots-by-role names container slots as chest_slot / barrel_slot / hopper_slot / etc.

DEPOSIT EXAMPLE — task "deposit all cobblestone into the chest". Suppose Known shows cobblestone at <cobble_inv>; slots_by_role lists <C0>..<C26>=chest slots, <empty_C>=first empty chest slot.

  step1: verify_items_visible { items: ["cobblestone"] }                                  // locate inventory source
  step2: pickup { sourceSlot: <cobble_inv>, expectedItem: "cobblestone" }
  step3: place_all { destSlot: <empty_C>, expectedItem: "cobblestone" }                    // dump whole stack into a free chest slot
  step4: verify_items_visible { slots: [<cobble_inv>, <empty_C>] }                         // confirm inv source emptied AND chest slot now has cobble
next_idx: 0
If multiple cobble stacks exist in inventory, repeat the pickup/place_all/verify triplet for each.

WITHDRAW EXAMPLE — task "take all iron_ingot from the chest into hotbar slot 5". Suppose Known shows iron_ingot at <C7>; <H5>=hotbar slot 5.

  step1: verify_items_visible { items: ["iron_ingot"] }
  step2: pickup { sourceSlot: <C7>, expectedItem: "iron_ingot" }
  step3: place_all { destSlot: <H5>, expectedItem: "iron_ingot" }
  step4: verify_items_visible { slots: [<C7>, <H5>] }
next_idx: 0

If <H5> already holds the same item, MC stacks safely. If it holds a DIFFERENT item, pick a different empty hotbar/main_inv slot — the runtime will swap and corrupt state otherwise.

NEVER deposit into the wrong namespace: when intent is DEPOSIT, destSlot MUST be a chest/container slot. When intent is WITHDRAW, destSlot MUST be a hotbar/main_inv slot. Cross those and the click does the opposite of what was asked.`;
