/**
 * Few-shot for villager / wandering_trader trade GUI.
 *
 * Slot roles:
 *   trade_offer_N — N=1..7 (or however many trades the villager has).
 *                   Clicking selects the trade; trade_payment_1/2 and
 *                   trade_result populate based on selection.
 *   trade_payment_1 — first input (e.g. emerald)
 *   trade_payment_2 — optional second input (e.g. paper for librarian)
 *   trade_result    — output (e.g. enchanted_book)
 *
 * Note: unlike crafting, the runtime expects you to first SELECT a
 * trade offer (place_one on trade_offer_N), then load payments, then
 * take the result. Selecting an offer doesn't consume cursor state.
 */
export const FEW_SHOT_TRADING = `

TRADING MODE (subgoal_directive mentions trade / villager / wandering_trader). The active GUI is a villager-trade window. Slots-by-role names: trade_offer_1..N, trade_payment_1, trade_payment_2, trade_result.

EXAMPLE — task "trade 5 emerald with librarian for an enchanted_book (offer #3)". Suppose Known shows emerald at <emerald_src>; slots-by-role lists <O3>=trade_offer_3, <P1>=trade_payment_1, <R>=trade_result.

  step1: verify_items_visible { items: ["emerald"] }
  step2: place_one { destSlot: <O3>, expectedItem: "" }                                   // SELECT trade #3 — empty cursor, just clicks the offer button
  step3: verify_items_visible { slots: [<P1>] }                                           // confirm payment slot now shows the cost icon (5 emerald)
  step4: pickup { sourceSlot: <emerald_src>, expectedItem: "emerald" }
  step5: place_all { destSlot: <P1>, expectedItem: "emerald" }                             // load the emerald payment
  step6: verify_items_visible { slots: [<R>] }                                            // confirm the trade output appears
  step7: take_result { expectedItem: "enchanted_book" }
  step8: place_all { destSlot: <empty_inv>, expectedItem: "enchanted_book" }
next_idx: 0

OFFER SELECTION: emit place_one (NOT pickup) on the trade_offer_N slot — it's a button click, not a slot transfer. expectedItem can be empty since you're not depositing an item.

LOCKED TRADES: if Known after step3 shows <P1>=empty even after offer-select, the trade is locked (used up its daily quota or villager has no stock). Surface "BLOCKED: trade #N is locked" and try a different offer index.

REPEAT TRADES: villagers usually allow multiple trades of the same offer until daily quota. To trade N times, repeat steps 4–8 N times before re-selecting the offer (the offer stays selected as long as you don't click another).`;
