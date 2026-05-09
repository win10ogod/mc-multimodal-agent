/**
 * Few-shot for enchanting_table tasks.
 *
 * Slot roles:
 *   enchant_item  — left slot (item to enchant: tool, armor, book)
 *   enchant_lapis — right slot (lapis_lazuli; 1–3 consumed depending on tier)
 *
 * The 3 enchantment offers shown to the right of the item slot are
 * NOT slot-clicks — they are buttons. The runtime exposes them via
 * role names enchant_offer_1 / enchant_offer_2 / enchant_offer_3 and
 * routes a "place_one" on those role indices to a button click.
 *
 * Cost: tier-3 enchantment requires the player to be at level 30+
 * (visible XP) AND surrounded by 15 bookshelves (otherwise only
 * tier-1 / 2 offers are shown).
 */
export const FEW_SHOT_ENCHANTING = `

ENCHANTING MODE (subgoal_directive mentions enchant / enchanting_table). The active GUI is an enchanting_table. Slots-by-role names: enchant_item, enchant_lapis, enchant_offer_1..3.

EXAMPLE — task "enchant diamond_pickaxe with the highest-tier offer". Suppose Known shows diamond_pickaxe at <pick_src>, lapis_lazuli at <lapis_src>; slots-by-role lists <I>=enchant_item, <L>=enchant_lapis, <O3>=enchant_offer_3.

  step1: verify_items_visible { items: ["diamond_pickaxe", "lapis_lazuli"] }
  step2: pickup { sourceSlot: <pick_src>, expectedItem: "diamond_pickaxe" }
  step3: place_all { destSlot: <I>, expectedItem: "diamond_pickaxe" }
  step4: pickup { sourceSlot: <lapis_src>, expectedItem: "lapis_lazuli" }
  step5: place_all { destSlot: <L>, expectedItem: "lapis_lazuli" }
  step6: verify_items_visible { slots: [<O3>] }                                           // confirm offer 3 actually exists (requires level 30+ + bookshelves)
  step7: place_one { destSlot: <O3>, expectedItem: "diamond_pickaxe" }                    // CLICK the offer button — encoded as place_one on the offer slot
  step8: verify_items_visible { slots: [<I>] }                                            // confirm the enchanted item appears back in the item slot (lapis + 3 levels consumed)
  step9: take_result { expectedItem: "diamond_pickaxe" }                                   // pull the enchanted pickaxe out of the item slot
  step10: place_all { destSlot: <empty_inv>, expectedItem: "diamond_pickaxe" }
next_idx: 0

OFFER CLICKS: emit place_one (NOT place_all, NOT pickup) targeting the enchant_offer_N slot. The runtime translates that to a left-click on the offer button without changing cursor state. expectedItem on the offer click should be the BASE item name — the offer does not change the icon visible in the slots, just adds the enchantment.

LOWER-TIER FALLBACK: if Known after step6 shows <O3>=empty (no offer 3 available), retry with <O2> or <O1>. If even <O1> is unavailable the table has no offers — abort and surface "BLOCKED: enchant_table has no offers (player level too low or no bookshelves)".`;
