/**
 * Few-shot for crafting tasks (player 2x2 grid OR placed crafting_table 3x3).
 *
 * The runtime supplies a "Placement plan" block in the user prompt that
 * resolves recipe ingredients to specific craft-grid slot indices —
 * always reference those over hard-coded numbers.
 */
export const FEW_SHOT_CRAFTING = `

ALL slot indices in your output MUST come from the user-prompt blocks (Known slot contents, slots_by_role, Placement plan). Do NOT hard-code or guess slot numbers — the layout differs across GUIs (player_inventory has different indices than crafting_table; 2x2 vs 3x3 grids re-number cells). The examples below use placeholder names like <cobble_src>, <P1>, <empty_inv> to emphasize you must SUBSTITUTE real indices from the prompt.

EXAMPLE — task "craft oak_planks". Recipe: 1x oak_log → 4x oak_planks (shapeless, single cell). Suppose Placement plan resolves to: <P1>=oak_log target cell. Known is empty at episode start.

Optimal first checklist (verify FIRST when Known doesn't already cover the recipe ingredients):
  step1: verify_items_visible { items: ["oak_log"] }                                     // OCR candidate hotbar slots
  step2: pickup { sourceSlot: <oak_log_src>, expectedItem: "oak_log" }                    // <oak_log_src> = the slot Known names as oak_log AFTER verify
  step3: place_all { destSlot: <P1>, expectedItem: "oak_log" }                            // shapeless single-cell → place_all (whole stack)
  step4: verify_items_visible { slots: [<result_slot>, <oak_log_src>] }                   // confirm result slot has oak_planks AND original source is now empty
  step5: take_result { expectedItem: "oak_planks" }                                       // cursor holds 4x oak_planks
  step6: place_all { destSlot: <oak_log_src>, expectedItem: "oak_planks" }                // deposit into the (verified empty) original source slot
next_idx: 0

EXAMPLE — task "craft diorite". Recipe: 2x cobblestone + 2x quartz, shaped inShape=[[cobble,quartz],[quartz,cobble]]. Placement plan resolves to: <P1>=cobble cell, <P2>=quartz cell, <P3>=quartz cell, <P4>=cobble cell.

Optimal first checklist:
  step1: verify_items_visible { items: ["cobblestone", "nether_quartz"] }                 // OCR candidate hotbar slots
  step2: pickup { sourceSlot: <cobble_src>, expectedItem: "cobblestone" }
  step3: place_one { destSlot: <P1>, expectedItem: "cobblestone" }
  step4: place_one { destSlot: <P4>, expectedItem: "cobblestone" }
  step5: place_all { destSlot: <cobble_src>, expectedItem: "cobblestone" }                // return cobble remainder so cursor is empty
  step6: pickup { sourceSlot: <quartz_src>, expectedItem: "nether_quartz" }
  step7: place_one { destSlot: <P2>, expectedItem: "nether_quartz" }
  step8: place_one { destSlot: <P3>, expectedItem: "nether_quartz" }
  step9: place_all { destSlot: <quartz_src>, expectedItem: "nether_quartz" }              // return quartz remainder
  step10: verify_items_visible { slots: [<result_slot>, <empty_inv>] }                    // confirm result has diorite AND <empty_inv> is empty
  step11: take_result { expectedItem: "diorite" }
  step12: place_all { destSlot: <empty_inv>, expectedItem: "diorite" }                    // deposit to a verified-empty inv slot — NOT <cobble_src>/<quartz_src> (still hold ingredients after the return-remainder step)
next_idx: 0

When emitting your actual checklist, replace each <...> placeholder with a CONCRETE slot index drawn from the user prompt's Known / slots_by_role / Placement plan blocks.

NOTE on verify_items_visible:
- Place ONE at the top with items=[...] when Known is missing any recipe ingredient. Action OCRs candidate hotbar slots.
- Place ONE before take_result with slots=[result_slot, deposit_slot] to confirm the crafted item is present AND the deposit target is empty.
- The runtime auto-ticks each verify_items_visible once OCR completes; Re-PLAN reads the refreshed Known and adjusts sourceSlot fields in subsequent pickup/place steps.

DEPOSIT SLOT RULE: any place_all that deposits a held item into "free inventory" MUST target a slot whose role is hotbar or main_inv. NEVER pick offhand, armor, craft cells, the result slot, or gap slots. The Slots-by-role block in the user prompt lists exact ranges per layout — follow it.

GENERAL RULE: for each ingredient with multiple target cells, emit pickup → K×place_one → place_all back to source. For a single-cell shapeless recipe, pickup → place_all into the cell. Always end with take_result followed by place_all into a hotbar/main_inv slot that is NOT in Known and visually empty (and NOT an ingredient source slot — those are filled after the return-remainder place_all).`;
