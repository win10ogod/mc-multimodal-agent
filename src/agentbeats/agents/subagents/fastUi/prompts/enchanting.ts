/**
 * Few-shot for enchanting_table tasks.
 *
 * Slot roles:
 *   enchant_item  — left slot (item to enchant: tool, armor, book)
 *   enchant_lapis — right slot (lapis_lazuli; 1–3 consumed depending on tier)
 *
 * The 3 enchantment offers shown to the right of the item slot are
 * NOT slot-clicks — they are buttons. Click them via place_all with
 * the BUTTON-CLICK SENTINEL: expectedItem set to the empty string "".
 * The runtime detects the sentinel and verifies success by visual
 * change at the button (level text disappears after selection).
 *
 * Cost: tier-3 enchantment requires the player to be at level 30+
 * (visible XP) AND surrounded by 15 bookshelves (otherwise only
 * tier-1 / 2 offers are shown).
 */
export const FEW_SHOT_ENCHANTING = `

ENCHANTING MODE (subgoal_directive mentions enchant / enchanting_table). The active GUI is an enchanting_table. Slots-by-role names: enchant_item, enchant_lapis, enchant_offer_1..3.

SLOT INDEX REASONING (READ BEFORE EMITTING ANY destSlot / sourceSlot). The yellow numbered badges on the image are NOT Minecraft's internal slot ordering — they are RASTER ORDER (top→bottom row band, then left→right within the band) over EVERY clickable cell the runtime detected, including the enchant offer buttons stacked above the item slot. So in an enchanting_table, the very small indices are NOT the item/lapis cells — those buttons sit higher on the screen and get the lower numbers. You MUST identify each role by reading the badge ON THE SLOT in the image, not by guessing "the item is index 0 because it's the first thing in the recipe". Concretely:
  - The enchant_item slot is the LEFT cell in the lower-left pair of the widget area; its badge is whatever number sits ON that cell.
  - The enchant_lapis slot is the RIGHT cell of that same pair; its badge is one above the item's number (since lapis is to the right of item, in the same row).
  - The three enchant_offer buttons are the stacked rectangles to the RIGHT of the item/lapis pair. Their badges are the numbers ON those buttons (not "0/1/2" by default — read each).
  - The 36 main_inv + hotbar slots below the widget area get the remaining contiguous indices.
If the image shows a badge "2" sitting on the LEFT slot of the lower pair and a badge "3" on the right, then enchant_item=2 and enchant_lapis=3 — substitute those literal integers into destSlot. Do not invent indices, do not assume role→index ordering from the few-shot placeholders.

EXAMPLE — task "enchant diamond_pickaxe with the highest-tier offer". Suppose Known shows diamond_pickaxe at <pick_src>, lapis_lazuli at <lapis_src>; slots-by-role lists <I>=enchant_item, <L>=enchant_lapis, <O3>=enchant_offer_3.

  step1: verify_items_visible { items: ["diamond_pickaxe", "lapis_lazuli"] }
  step2: pickup { sourceSlot: <pick_src>, expectedItem: "diamond_pickaxe" }
  step3: place_all { destSlot: <I>, expectedItem: "diamond_pickaxe" }
  step4: pickup { sourceSlot: <lapis_src>, expectedItem: "lapis_lazuli" }
  step5: place_all { destSlot: <L>, expectedItem: "lapis_lazuli" }
  step6: verify_items_visible { slots: [<O3>] }                                           // confirm offer 3 actually exists (requires level 30+ + bookshelves)
  step7: place_all { destSlot: <O3>, expectedItem: "" }                                   // CLICK the offer button (BUTTON-CLICK SENTINEL: expectedItem="" tells the runtime to verify by visual change at the button, not by cursor/slot transition)
  step8: verify_items_visible { slots: [<I>] }                                            // confirm the enchanted item appears back in the item slot (lapis + 3 levels consumed)
  step9: take_result { expectedItem: "diamond_pickaxe" }                                   // pull the enchanted pickaxe out of the item slot
  step10: place_all { destSlot: <empty_inv>, expectedItem: "diamond_pickaxe" }
next_idx: 0

OFFER CLICKS: emit place_all { destSlot: <enchant_offer_N>, expectedItem: "" }. The empty expectedItem is the BUTTON-CLICK SENTINEL — the runtime fires a left-click and verifies by visual change at the button (the level text disappears after selection). DO NOT use place_one (that's right-click and won't activate offers) and DO NOT supply a real item name (that would route through the item-tracking path and falsely claim the slot now holds that item).

LOWER-TIER FALLBACK: if Known after step6 shows <O3>=empty (no offer 3 available), retry with <O2> or <O1>. If even <O1> is unavailable the table has no offers — abort and surface "BLOCKED: enchant_table has no offers (player level too low or no bookshelves)".`;
