/**
 * Set-of-Mark style inventory probes for closed-loop crafting control.
 *
 * - probeHotbar: legacy one-shot probe to map candidate items to hotbar
 *   slots (used by the open-loop macro path).
 * - probeNextCraftAction: closed-loop probe that asks the VLM to decide
 *   the SINGLE next inventory action (pickup / place / take / done) given
 *   the current frame and the recipe target. The agent re-probes after
 *   each action completes -- VLMs are weak at pixel coords but strong at
 *   "which slot has X", so we let it reason in slot indices and translate
 *   to deterministic cursor moves on our side.
 */
import type OpenAI from "openai";
import { markInventoryFrame } from "./SlotMarker";
import type { GuiLayout } from "./SlotDetector";
import { getDebugRecorder } from "./DebugRecorder";
import { lookupRecipe } from "./UiFastControl";

// Hotbar slot pixel centers when the inventory GUI is open at 640x360 obs.
// Mirrors the SLOT.hotbarX0/Dx/Y constants in UiFastControl.
const HOTBAR_X0 = 215;
const HOTBAR_DX = 18;
const HOTBAR_Y = 218;

function buildHotbarOnlyDescription(): string {
  const lines = ["The bottom row inside the inventory window is the HOTBAR with 9 slots numbered 0-8 from LEFT to RIGHT."];
  lines.push("Approximate pixel centers of each hotbar slot in this 640x360 image:");
  for (let i = 0; i < 9; i += 1) {
    lines.push(`  slot ${i}: x=${HOTBAR_X0 + i * HOTBAR_DX}, y=${HOTBAR_Y}`);
  }
  return lines.join("\n");
}

export type HotbarProbeResult = Map<number, string>;

export async function probeHotbar(opts: {
  client: OpenAI;
  model: string;
  obsBase64: string;
  candidates: string[];
}): Promise<HotbarProbeResult> {
  if (opts.candidates.length === 0) return new Map();

  const promptText = [
    "You are looking at an open Minecraft inventory GUI (image is 640x360 px).",
    buildHotbarOnlyDescription(),
    "",
    `For EACH of these candidate items, tell me which hotbar slot index (0..8) currently contains it, or "none" if absent: ${opts.candidates.join(", ")}`,
    "",
    'Respond ONLY with strict JSON, no markdown fences, e.g.:',
    '{"oak_log": 0, "crafting_table": 1, "apple": "none"}',
  ].join("\n");

  const dataUrl = opts.obsBase64.startsWith("data:image/")
    ? opts.obsBase64
    : `data:image/jpeg;base64,${opts.obsBase64}`;

  // gpt-5.x rejects max_tokens; use max_completion_tokens. The SDK types
  // don't always expose it directly, so we build the body as a loose object
  // and cast at the call site.
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    max_completion_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
  };
  type Create = typeof opts.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  const completion = await opts.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
    choices: Array<{ message?: { content?: string | null } }>;
  };

  const raw = completion.choices[0]?.message?.content ?? "";
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract a JSON object with regex
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* give up */ }
    }
  }

  const out = new Map<number, string>();
  for (const [item, slotRaw] of Object.entries(parsed)) {
    const slot = typeof slotRaw === "number"
      ? slotRaw
      : typeof slotRaw === "string" && /^\d+$/.test(slotRaw)
        ? Number(slotRaw)
        : -1;
    if (slot >= 0 && slot <= 8) {
      out.set(slot, item);
    }
  }
  return out;
}

// --- Closed-loop GUI actions --------------------------------------------

/** Build a per-frame slot description from the detected GuiLayout, listing
 *  each visible slot's raster index and (when known) its semantic role.
 *  This replaces the previous hard-coded "0..8 = hotbar" mapping which
 *  only worked for one specific GUI numbering scheme. */
function buildSlotDescription(layout: GuiLayout): string {
  const lines: string[] = [
    `${layout.slots.length} slots are marked on the image with yellow numbered badges (raster order).`,
  ];
  if (layout.matchedLayoutId) {
    lines.push(`Detected GUI: ${layout.matchedLayoutId}.`);
  } else {
    lines.push(`Detected GUI: unknown — slots numbered in raster order.`);
  }
  const byRole = new Map<string, number[]>();
  const anonymous: number[] = [];
  for (const s of layout.slots) {
    if (s.role) {
      const list = byRole.get(s.role) ?? [];
      list.push(s.index);
      byRole.set(s.role, list);
    } else {
      anonymous.push(s.index);
    }
  }
  for (const [role, idxs] of byRole) {
    lines.push(`  role=${role}: indices ${idxs.join(", ")}`);
  }
  if (anonymous.length > 0) {
    lines.push(`  unrecognized slots: indices ${anonymous.join(", ")}`);
  }
  return lines.join("\n");
}

/** Cheap VLM sub-verify: given an obs frame, a target slot pixel, and
 *  the expected post-click state ("should_empty" or "should_fill"),
 *  ask the VLM whether the slot matches. Used as a second-opinion gate
 *  when CV patch sampling reports a mismatch (CV is fooled by rendering
 *  noise around freshly-emptied slots, ambiguous icon variance, etc.).
 *  Returns true iff the VLM agrees the expected state holds. */
export async function vlmVerifySlotState(opts: {
  client: OpenAI;
  model: string;
  obsBase64: string;
  slot: { cx: number; cy: number; name?: string };
  expectAfter: "should_empty" | "should_fill";
  taskTarget: string;
}): Promise<boolean | null> {
  const desc = opts.expectAfter === "should_empty"
    ? `EMPTY (no item icon visible inside it)`
    : `FILLED (an item icon is visible inside it)`;
  const slotLabel = opts.slot.name ? `slot "${opts.slot.name}" near pixel (${opts.slot.cx}, ${opts.slot.cy})` : `the slot at pixel (${opts.slot.cx}, ${opts.slot.cy})`;
  const prompt = [
    `In this 640x360 Minecraft inventory frame, look at ${slotLabel}.`,
    `Is that slot ${desc}?`,
    `Answer with strict JSON only, no commentary: {"empty": true|false, "filled": true|false}`,
  ].join(" ");
  const dataUrl = opts.obsBase64.startsWith("data:image/")
    ? opts.obsBase64
    : `data:image/jpeg;base64,${opts.obsBase64}`;
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    max_completion_tokens: 60,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
      ],
    }],
  };
  type Create = typeof opts.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  try {
    const completion = await opts.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
      choices: Array<{ message?: { content?: string | null } }>;
    };
    const raw = completion.choices[0]?.message?.content ?? "";
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    let parsed: { empty?: boolean; filled?: boolean } = {};
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* give up */ } }
    }
    if (typeof parsed.empty !== "boolean" && typeof parsed.filled !== "boolean") return null;
    const isEmpty = parsed.empty === true || parsed.filled === false;
    const isFilled = parsed.filled === true || parsed.empty === false;
    if (opts.expectAfter === "should_empty") return isEmpty && !isFilled;
    return isFilled && !isEmpty;
  } catch (e) {
    console.warn(`[agentbeats] vlmVerifySlotState failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export type CraftAction =
  // High-level atomic operations the VLM should prefer:
  | { action: "move"; from: number; to: number; count?: "one" | "all"; reason?: string }
  | { action: "put"; slot: number; reason?: string }   // dump whole cursor stack into slot
  /** Batch inventory inspection. Runtime hovers each listed slot in turn,
   *  runs TooltipOCR on each tooltip frame, and writes results to the
   *  per-session SlotMemory keyed by absolute pixel position. The main
   *  probe is NOT called between hovers — one probe LLM call requested
   *  the whole batch; the next probe runs only after every queued slot
   *  has been read, and that probe sees all results in "Known slot
   *  contents". Single-slot hover was removed because it produced one
   *  full-probe round-trip per inspection, which dominated long-horizon
   *  cost. Always batch. */
  | { action: "verify_slots"; slots: number[]; reason?: string }
  | { action: "done"; reason?: string }
  | { action: "fallback_manual"; reason?: string }
  // Low-level operations kept for backwards compatibility / fine-grained
  // control if the VLM still emits them; new prompts steer toward
  // move / put / done.
  | { action: "pickup"; slot: number; reason?: string }
  | { action: "place_one"; slot: number; reason?: string }
  | { action: "place_all"; slot: number; reason?: string }
  | { action: "take"; slot: number; reason?: string };

export type CraftProbeResult = {
  action: CraftAction | null;
  /** The CV-detected slot layout from this probe's frame. McuPolicy passes
   *  it back to the cursor compiler so the click lands at the SAME pixel
   *  position the VLM saw labeled, not a stale hardcoded one. */
  layout: GuiLayout | null;
};

export async function probeNextCraftAction(opts: {
  client: OpenAI;
  model: string;
  obsBase64: string;
  /** Raw task text. Probe is task-agnostic and just reasons over the
   *  marked image + this string. No more crafting-specific
   *  taskTarget/ingredient hints -- the VLM extracts those itself. */
  taskText: string;
  iteration: number;         // for logging / nudging the model
  /** Session-locked layout so marks stay at fixed positions/indices. */
  sessionLayout?: GuiLayout | null;
  recentActions?: string[];
  /** CV-derived cursor state (true = cursor is carrying an item icon). */
  cursorHolding?: boolean | null;
  /** Slot the agent originally picked the ingredient up from, so the VLM
   *  can return leftover items to the same place after place_one. */
  pickupSourceSlot?: { index: number; name?: string } | null;
  /** Captured tooltip frames from a prior verify_slots request. Each entry
   *  is one slot the runtime hovered + the resulting frame (base64 jpeg).
   *  Attached as additional images so the VLM can read tooltip text for
   *  every requested slot in a single call. */
  tooltipFrames?: Array<{ slot: number; obsBase64: string }>;
  /** Known slot contents from the slot-memory store, mapped to current
   *  raster indices. Surfaced as a text line in the prompt so the agent
   *  doesn't re-hover slots whose contents have already been read. */
  knownSlots?: Array<{ index: number; name?: string; item: string; ageIters: number }>;
}): Promise<CraftProbeResult> {
  // Set-of-Mark: render the obs frame with numbered badges drawn at every
  // slot's pixel center so the VLM grounds slot indices visually instead of
  // mentally projecting from a text description.
  let imgBase64: string;
  let imgMime: "image/png" | "image/jpeg";
  let detectedLayout: GuiLayout | null = null;
  try {
    const marked = markInventoryFrame(opts.obsBase64, opts.sessionLayout ?? null);
    imgBase64 = marked.pngBase64;
    imgMime = "image/png";
    detectedLayout = marked.layout;
  } catch (e) {
    console.warn(`[agentbeats] SoM render failed (${e instanceof Error ? e.message : String(e)}); using raw frame`);
    imgBase64 = opts.obsBase64.replace(/^data:image\/[a-z]+;base64,/, "");
    imgMime = "image/jpeg";
  }
  // No inventory window detected -> the GUI isn't actually open. Don't burn
  // a VLM call on a world-view frame; signal "no UI" so the policy can defer
  // to the regular LLM path or re-issue an open-inventory action.
  if (detectedLayout === null) {
    return { action: null, layout: null };
  }

  const historyLines = (opts.recentActions ?? []).slice(0, 3);
  const historyText = historyLines.length === 0
    ? "(none yet)"
    : historyLines.map((a, i) => `  ${i === 0 ? "most recent" : `${i + 1} ago`}: ${a}`).join("\n");

  const cursorState = opts.cursorHolding === true
    ? "CURSOR IS CARRYING AN ITEM (CV-detected)."
    : opts.cursorHolding === false
      ? "CURSOR IS EMPTY (CV-detected)."
      : "CURSOR STATE UNKNOWN.";
  const sourceLine = opts.pickupSourceSlot
    ? `Original ingredient source slot: index ${opts.pickupSourceSlot.index}${opts.pickupSourceSlot.name ? ` (${opts.pickupSourceSlot.name})` : ""}. The tool already returns leftover ingredient back to this slot automatically -- do NOT use it as a destination for the crafted result; pick a DIFFERENT empty slot (look for a "." mark in the slot listing) for the result.`
    : "No pickup source recorded yet.";

  // Recipe-info hint (read-only, derived from minecraft-data). Helps the VLM
  // disambiguate multi-ingredient placement without surfacing live state.
  const recipeInfo = (() => {
    const tokens = opts.taskText.toLowerCase().match(/[a-z_]+/g) ?? [];
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      const tok = tokens[i];
      if (tok === "craft" || tok === "make" || tok === "using" || tok === "and" || tok === "with" || tok === "the" || tok === "a") continue;
      const r = lookupRecipe(tok);
      if (r) return r;
    }
    return null;
  })();

  // Known slot contents from the slot-memory store. Each entry is the
  // result of a prior hover + tooltip OCR, expressed in the current
  // raster index space. Surfaced as a text block so the agent doesn't
  // burn iterations re-hovering identified slots.
  const knownSlotsText = (opts.knownSlots && opts.knownSlots.length > 0)
    ? "Known slot contents (from prior tooltip reads -- TRUST these instead of guessing from image):\n" +
      opts.knownSlots.map((k) => `  slot ${k.index}${k.name ? `(${k.name})` : ""} = ${k.item} (read ${k.ageIters} iters ago)`).join("\n")
    : null;

  // Recipe hint: cross-reference required ingredients with the known
  // slots so we can tell the agent EXACTLY which slot to draw each
  // ingredient from. Without this, agents repeatedly place the first
  // identified ingredient into all four cells of the 2x2 grid.
  const recipeHint = (() => {
    if (!recipeInfo) return null;
    const ing = recipeInfo.ingredients.map((it) => `${it.count}x ${it.name}`).join(" + ");
    const lines = [`RECIPE (from minecraft-data): produces ${recipeInfo.target}. Required ingredients: ${ing}. You MUST place EXACTLY this set into the craft grid -- placing extras of one ingredient and missing another yields nothing.`];
    // For each ingredient, try to point at the source slot from Known.
    if (opts.knownSlots && opts.knownSlots.length > 0) {
      const sourceLines: string[] = [];
      for (const it of recipeInfo.ingredients) {
        const found = opts.knownSlots.find((k) => k.item === it.name);
        if (found) sourceLines.push(`  - ${it.count}x ${it.name}: take from slot ${found.index}${found.name ? `(${found.name})` : ""}`);
        else sourceLines.push(`  - ${it.count}x ${it.name}: NOT yet identified in Known -- you may need to verify_slots more inventory slots`);
      }
      if (sourceLines.length > 0) {
        lines.push("Source slots for each required ingredient:");
        lines.push(...sourceLines);
        lines.push(`Do NOT place ${recipeInfo.ingredients[0]?.name} into all cells. Alternate ingredients per the recipe -- count what you have moved from Recent actions before each placement.`);
      }
    }
    return lines.join("\n");
  })();

  const promptText = [
    `You are operating a Minecraft GUI (640x360 image) to advance the user's task.`,
    `Task: ${opts.taskText}`,
    ...(recipeHint ? ["", recipeHint] : []),
    ...(knownSlotsText ? ["", knownSlotsText] : []),
    "",
    `The image has YELLOW NUMBERED BADGES drawn at the corner of each slot.`,
    `Use the visible numbers to choose a slot. Pick the index of the slot you mean.`,
    buildSlotDescription(detectedLayout),
    "",
    `State:`,
    `  ${cursorState}`,
    `  ${sourceLine}`,
    "",
    `Recent actions you've already executed (do NOT repeat the same one if state hasn't changed):`,
    historyText,
    "",
    "Look at the image and decide the SINGLE NEXT action that best advances the task. The available GUIs include the player inventory's 2x2 craft grid, furnace, brewing stand, chest, anvil, enchanting table, villager trade window, etc. -- the same actions below work in any of them; you just pick the slot indices that match the GUI you see.",
    "",
    "Respond with strict JSON only (no markdown fences, no commentary):",
    `  {"action": "move", "from": A, "to": B, "count": "one"|"all", "reason": "...", "subTask": "..."} -- ATOMIC. Tool picks the stack from A, places into B (one item if count=one, whole stack if count=all), and automatically returns any remainder to A.`,
    `  {"action": "put",  "slot": N, "reason": "...", "subTask": "..."} -- dump whatever the cursor is currently holding into slot N as a whole stack. Use only when the cursor already holds something.`,
    `  {"action": "verify_slots", "slots": [N1, N2, ...], "reason": "..."} -- BATCH slot perception. For each listed slot the runtime crops the slot's bbox (with a small outer margin) from the CURRENT frame and asks a perception sub-agent in parallel: "what item is in this slot?". Results are written to "Known slot contents" and persist across iterations. ONLY include slots whose contents you CANNOT confidently identify from the main SoM image (e.g. similar-looking blocks like cobblestone vs nether quartz, or any slot whose icon you genuinely cannot distinguish). Do NOT inspect: slots that visually look empty, slots already listed in Known, slots whose icon you can clearly see (e.g. a sword, a torch, a recognizable color block). Cap N <= 4. Each unnecessary slot wastes one perception sub-call.`,
    `  {"action": "fallback_manual", "reason": "..."} -- SoM marks do NOT cover the slot you need; hand control back to the manual LLM controller.`,
    `  {"action": "done", "reason": "...", "subTask": "..."} -- ONLY when (a) any recipe result slot in view is empty AND (b) the requested target is visibly stored in a regular inventory slot. Tool may CV-verify before accepting.`,
    "",
    `subTask field (optional but recommended for long-horizon tasks): a SHORT label of the current sub-goal you are advancing (e.g. "place_logs_in_grid", "take_planks_to_inv", "open_furnace", "deposit_diamond_in_chest"). This is echoed back to you on the NEXT probe so you can keep track of where you are across many steps. Keep stable across consecutive iterations of the same sub-goal.`,
    "",
    `Rule: when the cursor is carrying an item, "to" must be either (a) a visually empty slot, OR (b) a slot containing the SAME item as what the cursor holds (will stack). Placing onto a slot with a DIFFERENT item triggers a swap. If you must deposit into a slot occupied by a different item: (1) "put" current held item into an empty side slot, (2) next probe: "move" the blocking item to another empty slot, (3) next probe: "move" the parked item to the now-empty target.`,
    "",
    `Anti-hallucination rule for MULTI-INGREDIENT recipes: do NOT assume an ingredient is already in the grid unless YOU placed it there (count from "Recent actions"). Similar-looking blocks (cobblestone vs nether quartz block, etc.) are NOT distinguishable from the raw image alone. When uncertain about ANY slots' contents, emit ONE verify_slots covering every uncertain slot in a single batch -- do not guess and do not split into multiple iterations.`,
    "",
    `This is iteration ${opts.iteration}. Return ONLY the JSON action.`,
  ].join("\n");
  const dataUrl = `data:${imgMime};base64,${imgBase64}`;

  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    max_completion_tokens: 200,
    messages: [
      {
        role: "user",
        content: (() => {
          const parts: Array<Record<string, unknown>> = [
            { type: "text", text: promptText },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ];
          for (const tf of opts.tooltipFrames ?? []) {
            parts.push({ type: "text", text: `Tooltip capture for slot ${tf.slot} (cursor was hovering over it; read the tooltip text):` });
            const cleaned = tf.obsBase64.startsWith("data:image/")
              ? tf.obsBase64
              : `data:image/jpeg;base64,${tf.obsBase64.replace(/^data:image\/[a-z]+;base64,/, "")}`;
            parts.push({ type: "image_url", image_url: { url: cleaned, detail: "high" } });
          }
          return parts;
        })(),
      },
    ],
  };
  // Debug: record the marked image + prompt the VLM is about to see.
  const dbg = getDebugRecorder();
  if (dbg.isEnabled()) {
    dbg.record({
      type: "probe_input",
      iteration: opts.iteration,
      data: {
        taskText: opts.taskText,
        cursorHolding: opts.cursorHolding,
        pickupSourceSlot: opts.pickupSourceSlot ?? null,
        recentActions: opts.recentActions ?? [],
        layoutId: detectedLayout.matchedLayoutId,
        slots: detectedLayout.slots.map((s) => ({ index: s.index, name: s.name, role: s.role, cx: s.cx, cy: s.cy })),
        // Structured copies of the new context blocks so they're greppable
        // without unescaping the giant prompt string.
        knownSlots: opts.knownSlots ?? [],
        recipeHint: recipeHint ?? null,
        prompt: promptText,
      },
    }, imgBase64, imgMime === "image/png" ? "png" : "jpg");
    // Also dump the full prompt as plain text so it's easy to read:
    // events.jsonl gets a giant escaped string per probe; the .txt
    // companion is line-broken and viewable at a glance.
    try {
      const debugDir = process.env.AGENTBEATS_DEBUG_DIR;
      if (debugDir) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pathMod = require("node:path") as typeof import("node:path");
        const stamp = String(opts.iteration).padStart(4, "0");
        fs.writeFileSync(pathMod.join(debugDir, `probe_${stamp}_prompt.txt`), promptText);
      }
    } catch (e) {
      console.warn(`[probe-debug] prompt dump failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  type Create = typeof opts.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  const completion = await opts.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
    choices: Array<{ message?: { content?: string | null } }>;
  };

  const raw = completion.choices[0]?.message?.content ?? "";
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* give up */ }
    }
  }
  if (dbg.isEnabled()) {
    dbg.record({
      type: "probe_output",
      iteration: opts.iteration,
      data: { raw, parsed },
    });
  }
  if (!parsed || typeof parsed.action !== "string") {
    return { action: null, layout: detectedLayout };
  }

  const action = String(parsed.action);
  const slot = typeof parsed.slot === "number" ? parsed.slot : Number(parsed.slot);
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
  // Slot indices range 0..(layout.slots.length-1). Some inventories
  // have 41+ slots (player_inventory has 49). Old hardcoded "<=40"
  // bound was rejecting valid high-index picks.
  const maxSlot = (detectedLayout?.slots.length ?? 41) - 1;
  if (action === "done") return { action: { action: "done", reason }, layout: detectedLayout };
  if (action === "fallback_manual") return { action: { action: "fallback_manual", reason }, layout: detectedLayout };
  if (action === "move") {
    const fromRaw = parsed.from;
    const toRaw = parsed.to;
    const from = typeof fromRaw === "number" ? fromRaw : Number(fromRaw);
    const to = typeof toRaw === "number" ? toRaw : Number(toRaw);
    if (!Number.isFinite(from) || from < 0 || from > maxSlot) {
      console.warn(`[agentbeats] probe parse: move from=${from} out of range 0..${maxSlot}`);
      return { action: null, layout: detectedLayout };
    }
    if (!Number.isFinite(to) || to < 0 || to > maxSlot) {
      console.warn(`[agentbeats] probe parse: move to=${to} out of range 0..${maxSlot}`);
      return { action: null, layout: detectedLayout };
    }
    const count: "one" | "all" = parsed.count === "all" ? "all" : "one";
    return { action: { action: "move", from, to, count, reason }, layout: detectedLayout };
  }
  if (action === "put") {
    if (!Number.isFinite(slot) || slot < 0 || slot > maxSlot) {
      console.warn(`[agentbeats] probe parse: put slot=${slot} out of range 0..${maxSlot}`);
      return { action: null, layout: detectedLayout };
    }
    return { action: { action: "put", slot, reason }, layout: detectedLayout };
  }
  if (action === "hover") {
    // Backwards compat: convert legacy hover into a single-slot verify_slots.
    if (!Number.isFinite(slot) || slot < 0 || slot > maxSlot) {
      console.warn(`[agentbeats] probe parse: legacy hover slot=${slot} out of range 0..${maxSlot}`);
      return { action: null, layout: detectedLayout };
    }
    console.warn(`[agentbeats] probe parse: legacy hover received; converting to verify_slots [${slot}]`);
    return { action: { action: "verify_slots", slots: [slot], reason }, layout: detectedLayout };
  }
  if (action === "verify_slots") {
    const rawSlots = (parsed as { slots?: unknown }).slots;
    if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
      console.warn(`[agentbeats] probe parse: verify_slots requires a non-empty slots array`);
      return { action: null, layout: detectedLayout };
    }
    const slots: number[] = [];
    for (const raw of rawSlots) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0 && n <= maxSlot) slots.push(n);
    }
    if (slots.length === 0) {
      console.warn(`[agentbeats] probe parse: verify_slots had no valid indices`);
      return { action: null, layout: detectedLayout };
    }
    // Cap to keep parallel-OCR cost bounded.
    const capped = slots.slice(0, 4);
    return { action: { action: "verify_slots", slots: capped, reason }, layout: detectedLayout };
  }
  if (!Number.isFinite(slot) || slot < 0 || slot > maxSlot) {
    console.warn(`[agentbeats] probe parse: ${action} slot=${slot} out of range 0..${maxSlot}`);
    return { action: null, layout: detectedLayout };
  }
  if (action === "pickup" || action === "place_one" || action === "place_all" || action === "take") {
    return { action: { action, slot, reason }, layout: detectedLayout };
  }
  return { action: null, layout: detectedLayout };
}

