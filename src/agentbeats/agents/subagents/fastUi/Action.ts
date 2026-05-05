import type OpenAI from "openai";
import type { Subtask } from "./types";
import type { CraftAction } from "../../../tools/InventoryProbe";
import type { RecipeInfo } from "../../../tools/UiFastControl";

export type ActionDeps = {
  client: OpenAI;
  model: string;
  recordDebug?: (kind: string, payload: unknown) => Promise<void> | void;
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
    action: { type: "string", enum: ["move", "put", "verify_slots", "wait", "done", "fallback_manual"] },
  },
} as const;

const SYS = `You execute ONE symbolic subtask in a Minecraft GUI. You receive the subtask, tracked_items (slot index → OCR-confirmed item name), slots_by_role (which slot indices belong to each role: craft_2x2, craft_3x3, result, hotbar, main_inv, armor, offhand), recipe (if any), cursor_holding, and the frame with YELLOW NUMBERED BADGES on every slot. Slots NOT in tracked_items are either empty or not yet inspected — use verify_slots to disambiguate.

Subtask → action mapping:
- verify_items_visible { items }: emit verify_slots on up to 3 hotbar/main_inv slots that VISUALLY look like one of the listed items. Do NOT verify slots already named in tracked_items. If you cannot pick a confident candidate visually, emit fallback_manual.
- place_in_craft_grid { item }: (1) pick a craft cell (role starts "craft_2x2_" or "craft_3x3_") matching this item's recipe position. (2) Find the source slot in tracked_items where the named item is recorded. If the item isn't in tracked_items, emit verify_slots on up to 3 unlisted hotbar slots that visually match. Once tracked_items names the item, emit move from=source to=craftCell count="one".
- take_result { expectedItem }: from = slot with role==="result"; to = free slot in known_slots; emit move count="all".
- wait_for_output { expectedItem }: emit wait with holdSteps proportional to expected sim ticks (cap 60).
- verify_state { condition }: if condition holds in frame+known, emit done; else fallback_manual.

Rules:
- Slot index = the YELLOW BADGE you read off the frame, validated against layout_slots.role for the expected role.
- Never overwrite a different item in dest.
- If anything is ambiguous, emit fallback_manual with reason.

Output strict JSON, one action only:
  { "action": "move", "from": A, "to": B, "count": "one"|"all" }
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
      case "verify_items_visible": return `verify_items_visible items=[${subtask.items.join(", ")}]`;
      case "place_in_craft_grid":  return `place_in_craft_grid item=${subtask.item}`;
      case "take_result":          return `take_result expectedItem=${subtask.expectedItem}`;
      case "wait_for_output":      return `wait_for_output expectedItem=${subtask.expectedItem}`;
      case "verify_state":         return `verify_state condition=${subtask.condition}`;
    }
  })();
  const recipeBlock = input.recipeInfo
    ? `Recipe: ${input.recipeInfo.target}\n  ingredients: ${input.recipeInfo.ingredients.map((it) => `${it.count}x ${it.name}`).join(" + ")}\n  inShape: ${JSON.stringify(input.recipeInfo.inShape)}`
    : "Recipe: (none)";
  return `Subtask: ${subtaskLine}

Known slot contents (from prior tooltip reads -- TRUST these instead of guessing from image):
${slotBlock}
Cursor: ${cursorBlock}

Slots by role:
${roleLines.join("\n")}

${recipeBlock}`;
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
      if (input.obsBase64) {
        const m = input.obsBase64.match(/^data:image\/([a-z]+);base64,(.+)$/);
        const ext = m ? m[1] : "jpg";
        const raw = m ? m[2] : input.obsBase64;
        fs.writeFileSync(pathMod.join(debugDir, `fastui_action_${seq}_input.${ext}`), Buffer.from(raw, "base64"));
      }
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
  console.log(`[fastui-action] subtask=${input.subtask.kind} -> ${parsed.action}${parsed.from!==undefined?` from=${parsed.from}`:""}${parsed.to!==undefined?` to=${parsed.to}`:""}`);
  try {
    await deps.recordDebug?.("fastui_action_call", {
      seq, subtask: input.subtask, output: parsed,
    });
  } catch { /* swallow */ }
  return parsed as CraftAction;
}
