import type OpenAI from "openai";
import type { Subtask } from "./types";
import type { CraftAction } from "../../../tools/InventoryProbe";
import type { RecipeInfo } from "../../../tools/UiFastControl";

export type ActionDeps = {
  client: OpenAI;
  model: string;
  recordDebug?: (kind: string, payload: unknown, imageBase64?: string, imageExt?: "png" | "jpg") => Promise<void> | void;
};

export type ActionInput = {
  /** ONE symbolic subtask the Planner just dispatched. Action
   *  resolves it to concrete slot indices using the live layout. */
  subtask: Subtask;
  /** OCR-confirmed slot contents at this moment (slot index + item name). */
  knownSlots: Array<{ index: number; name?: string; item: string }>;
  /** GUI slot-index → role mapping for the open window. Action uses
   *  this to find craft cells by role, identify the result slot,
   *  pick free hotbar/main_inv slots, and reject non-task-relevant
   *  slots as destinations. */
  layoutSlots: Array<{ index: number; name?: string; role?: string }>;
  /** Active recipe (when in a crafting subtask). Provides target +
   *  ingredients + inShape so Action can pick the right craft cell. */
  recipeInfo: RecipeInfo | null;
  /** Item the cursor currently holds, if any. */
  cursorHolding: string | null;
  obsBase64: string;
};

const SCHEMA = {
  type: "object",
  required: ["action"],
  additionalProperties: true,
  properties: {
    action: { type: "string", enum: ["pickup", "place_one", "place_all", "verify_slots", "wait", "done", "fallback_manual"] },
  },
} as const;

const SYS = `You execute ONE PRIMITIVE subtask in a Minecraft GUI. The subtask already specifies the exact slot and the expected cursor state. Your job is to verify pre-conditions and emit the matching primitive click.

TRUST the "Cursor:" line from the user prompt as authoritative. The runtime tracks cursor identity via verified click outcomes; do NOT second-guess it from the image — the cursor sprite is small and often occluded by held-item icons, image inspection is unreliable at this resolution.

Subtask → action (1:1 mapping):
- verify_items_visible: emit verify_slots on up to 3 candidates from items[] OR the explicit slots[] passed in. If every listed item is already named in Known, emit done.
- pickup { sourceSlot, expectedItem }: emit pickup slot=sourceSlot. (Pre-cond: Cursor: (empty) per prompt. If prompt says holding, that's a planner mistake — emit fallback_manual.)
- place_one { destSlot, expectedItem }: emit place_one slot=destSlot. Trust the prompt's Cursor: line; emit even if the image looks ambiguous.
- place_all { destSlot, expectedItem }: emit place_all slot=destSlot. Trust the prompt's Cursor: line.
- take_result { expectedItem }: emit pickup slot=<the slot whose role==="result">.
- wait_for_output { expectedItem }: emit wait with holdSteps proportional to expected sim ticks (cap 60).
- verify_state { condition }: if condition holds in frame+known, emit done; else fallback_manual.

Rules:
- Slot index = the YELLOW BADGE you read off the frame, validated against layout_slots.role for the expected role.
- Never overwrite a different item in dest.
- After a pickup or place, if the image shows a slot that contradicts Known, emit verify_slots on the affected slots.
- If an expected ingredient is missing from Known, scan hotbar/main_inv visually and emit verify_slots on the 3 most likely slots — do NOT fallback_manual.
- If anything is ambiguous, emit fallback_manual with reason.

Output strict JSON, one action only:
  { "action": "pickup",     "slot": N }   // cursor empty: left-click slot N to grab whole stack
  { "action": "place_one",  "slot": N }   // cursor holding: right-click slot N to drop EXACTLY ONE item; remainder stays on cursor
  { "action": "place_all",  "slot": N }   // cursor holding: left-click slot N to drop the WHOLE held stack
  { "action": "verify_slots", "slots": [N,...] }
  { "action": "wait", "holdSteps": N }
  { "action": "done" }
  { "action": "fallback_manual", "reason": "..." }`;

let ACTION_CALL_SEQ = 0;

function summarizeRange(indices: number[]): string {
  if (indices.length === 0) return "";
  const sorted = [...indices].sort((a, b) => a - b);
  const out: string[] = [];
  let s = sorted[0], e = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === e + 1) { e = sorted[i]; continue; }
    out.push(s === e ? `${s}` : `${s}..${e}`);
    s = sorted[i]; e = sorted[i];
  }
  out.push(s === e ? `${s}` : `${s}..${e}`);
  return out.join(", ");
}

function buildActionUserText(input: ActionInput): string {
  const slotLines = input.knownSlots
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((s) => `  slot ${s.index}${s.name ? `(${s.name})` : ""} -> ${s.item}`);
  const slotBlock = slotLines.length > 0 ? slotLines.join("\n") : "  (none yet)";
  const byRole: Record<string, number[]> = {};
  for (const s of input.layoutSlots) {
    const role = s.role ?? "other";
    (byRole[role] ??= []).push(s.index);
  }
  // Order roles so the most action-relevant ones come first.
  const roleOrder = ["craft_2x2", "craft_3x3", "result", "hotbar", "main_inv", "offhand", "armor", "other"];
  const roleLines = roleOrder
    .filter((r) => byRole[r])
    .map((r) => `  ${r}: ${summarizeRange(byRole[r])}`);
  const cursorBlock = input.cursorHolding ?? "(empty)";
  const subtask = input.subtask;
  const subtaskLine = (() => {
    switch (subtask.kind) {
      case "verify_items_visible": return `verify_items_visible items=[${(subtask.items ?? []).join(", ")}] slots=[${(subtask.slots ?? []).join(", ")}]`;
      case "pickup":               return `pickup sourceSlot=${subtask.sourceSlot} expectedItem=${subtask.expectedItem}`;
      case "place_one":            return `place_one destSlot=${subtask.destSlot} expectedItem=${subtask.expectedItem}`;
      case "place_all":            return `place_all destSlot=${subtask.destSlot} expectedItem=${subtask.expectedItem}`;
      case "take_result":          return `take_result expectedItem=${subtask.expectedItem}`;
      case "wait_for_output":      return `wait_for_output expectedItem=${subtask.expectedItem}`;
      case "verify_state":         return `verify_state condition=${subtask.condition}`;
    }
  })();
  // Build the explicit Placement plan block that baseline 6398f3f's
  // probe surfaced inline. For shaped recipes, walk inShape and map
  // (row, col) → raster slot index using the live layout's craft
  // cells in raster order. For shapeless, round-robin ingredients.
  // This is the single most load-bearing block for placement
  // correctness — without it, Action has to derive slot indices from
  // recipe.inShape geometry alone and routinely picks the wrong cell.
  const craftCells = input.layoutSlots
    .filter((s) => s.role === "craft_2x2" || s.role === "craft_3x3")
    .sort((a, b) => a.index - b.index);
  const gridSize = craftCells.length === 9 ? 3 : (craftCells.length === 4 ? 2 : 0);
  let placementBlock = "";
  if (input.recipeInfo && gridSize > 0) {
    const gridLines: string[] = [`Craft grid: ${gridSize} rows x ${gridSize} cols. Cells are 1-indexed row-major (Row 1 Col 1 is top-left).`];
    for (let r = 0; r < gridSize; r += 1) {
      for (let c = 0; c < gridSize; c += 1) {
        const cell = craftCells[r * gridSize + c];
        if (cell) gridLines.push(`  Row ${r + 1} Col ${c + 1} = slot ${cell.index}${cell.name ? `(${cell.name})` : ""}`);
      }
    }
    const planSteps: string[] = [];
    if (input.recipeInfo.inShape) {
      const rows = input.recipeInfo.inShape;
      let i = 1;
      for (let r = 0; r < rows.length; r += 1) {
        for (let c = 0; c < rows[r].length; c += 1) {
          const ing = rows[r][c];
          if (!ing) continue;
          const cell = craftCells[r * gridSize + c];
          if (cell) planSteps.push(`  ${i}. place ${ing} at slot ${cell.index}${cell.name ? `(${cell.name})` : ""} (Row ${r + 1} Col ${c + 1})`);
          i += 1;
        }
      }
    } else {
      const queues = input.recipeInfo.ingredients.map((it) => ({ ingredient: it.name, remaining: it.count }));
      let cellIdx = 0, i = 1, qi = 0;
      while (queues.some((q) => q.remaining > 0) && cellIdx < gridSize * gridSize) {
        const q = queues[qi % queues.length];
        if (q.remaining > 0) {
          const cell = craftCells[cellIdx];
          if (cell) {
            const r = Math.floor(cellIdx / gridSize) + 1, c = (cellIdx % gridSize) + 1;
            planSteps.push(`  ${i}. place ${q.ingredient} at slot ${cell.index}${cell.name ? `(${cell.name})` : ""} (Row ${r} Col ${c})`);
            i += 1;
          }
          q.remaining -= 1;
          cellIdx += 1;
        }
        qi += 1;
      }
    }
    placementBlock = `${gridLines.join("\n")}\nPlacement plan:\n${planSteps.join("\n")}\n`;
  }
  const recipeBlock = input.recipeInfo
    ? `Recipe: ${input.recipeInfo.target}\n  ingredients: ${input.recipeInfo.ingredients.map((it) => `${it.count}x ${it.name}`).join(" + ")}`
    : "Recipe: (none)";
  return `Subtask: ${subtaskLine}

Known slot contents (if the image contradicts Known, emit verify_slots on the mismatched slot to refresh tracking):
${slotBlock}
Cursor: ${cursorBlock}

Slots by role:
${roleLines.join("\n")}

${recipeBlock}
${placementBlock}`;
}

export async function runAction(deps: ActionDeps, input: ActionInput): Promise<CraftAction> {
  const userText = buildActionUserText(input);

  const seq = String(++ACTION_CALL_SEQ).padStart(5, "0");
  const debugDir = process.env.AGENTBEATS_DEBUG_DIR;
  if (debugDir) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require("node:path") as typeof import("node:path");
      const promptText = `[fastui-action ${seq}]\nSYSTEM:\n${SYS}\n\nUSER:\n${userText}\n`;
      fs.writeFileSync(pathMod.join(debugDir, `fastui_action_${seq}_prompt.txt`), promptText);
      // Image is saved by DebugRecorder via recordDebug() with the
      // global event seq prefix — keeps file ordering consistent
      // with the events.jsonl chronology.
    } catch (e) {
      console.warn(`[fastui-action ${seq}] debug dump failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const dataUrl = input.obsBase64.startsWith("data:image/")
    ? input.obsBase64
    : `data:image/jpeg;base64,${input.obsBase64}`;
  const body: Record<string, unknown> = {
    model: deps.model,
    temperature: 0,
    max_completion_tokens: 200,
    messages: [
      { role: "system", content: SYS },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "fastui_action_out", schema: SCHEMA, strict: false },
    },
  };
  type Create = typeof deps.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  const resp = await deps.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
    choices: Array<{ message?: { content?: string | null } }>;
  };
  const text = resp.choices[0]?.message?.content ?? "";
  let parsed: any;
  try { parsed = JSON.parse(text); } catch {
    console.warn(`[fastui-action] failed to parse JSON: ${text.slice(0, 200)}`);
    return { action: "fallback_manual", reason: "action LLM returned unparseable JSON" } as CraftAction;
  }
  console.log(`[fastui-action] subtask=${input.subtask.kind} -> ${parsed.action}${parsed.from!==undefined?` from=${parsed.from}`:""}${parsed.to!==undefined?` to=${parsed.to}`:""}${parsed.slot!==undefined?` slot=${parsed.slot}`:""}`);
  try {
    // Pass the marked obs through recordDebug so DebugRecorder writes
    // the image with the GLOBAL event seq prefix — files sort
    // chronologically alongside probe/verify/ocr events. The legacy
    // local fastui_action_NNNNN_input.png save is now redundant; the
    // global-seq file is the source of truth.
    const m = input.obsBase64?.match(/^data:image\/([a-z]+);base64,(.+)$/);
    const ext: "png" | "jpg" = m && m[1] === "png" ? "png" : "jpg";
    const raw = m ? m[2] : input.obsBase64;
    await deps.recordDebug?.("fastui_action_call", {
      seq, subtask: input.subtask, output: parsed,
    }, raw, ext);
  } catch { /* swallow */ }
  return parsed as CraftAction;
}
