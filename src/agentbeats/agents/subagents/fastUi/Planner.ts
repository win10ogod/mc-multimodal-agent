import type OpenAI from "openai";
import type { ChecklistItem, PlanResult } from "./types";
import type { RecipeInfo } from "../../../tools/UiFastControl";

export type PlannerDeps = {
  client: OpenAI;
  model: string;
  recordDebug?: (kind: string, payload: unknown, imageBase64?: string, imageExt?: "png" | "jpg") => Promise<void> | void;
};

export type PlannerInput = {
  /** Episode-level task text (set once at McuContextState init from the
   *  eval framework). Stable across the whole episode. Use for recipe
   *  lookup and broad context. */
  taskText: string;
  /** Per-dispatch directive from the GoalPlanner, e.g. "craft X",
   *  "verify inventory contains <items>", "fill furnace with <fuel>
   *  and <input>", "move <item> from inventory to hotbar slot 4". The
   *  FastUI Planner branches on this to decide what kind of checklist
   *  to emit (recipe expansion vs verify-only sweep vs organize).
   *  When undefined, falls back to taskText (single-task episodes). */
  subgoalDescription?: string;
  /** Present when this is a crafting task with a known recipe; null
   *  for non-craft GUIs (smelting, chest, etc) where the planner
   *  decomposes from task text + frame alone. */
  recipeInfo: RecipeInfo | null;
  /** OCR-confirmed slot contents. Same shape Action sees — both share
   *  the perception so a slot index in either prompt unambiguously
   *  refers to the same SoM badge in the live frame. */
  knownSlots: Array<{ index: number; name?: string; item: string }>;
  /** All slot indices + roles in the active layout. Used to render an
   *  explicit Placement Plan (recipe cell → slot index) so the Planner
   *  emits primitive subtasks with concrete slot indices. */
  layoutSlots: Array<{ index: number; name?: string; role?: string }>;
  /** What the cursor is currently carrying, if anything. */
  cursorHolding: string | null;
  /** Empty on first invocation; otherwise the in-flight list. */
  currentChecklist: ChecklistItem[];
  /** "first" / "post_action" — drives prompt phrasing. */
  trigger: "first" | "post_action";
  /** Recent closed-loop history lines for context. */
  recentHistory: string[];
  /** Frame for visual observation. */
  obsBase64: string;
};

const SCHEMA = {
  type: "object",
  required: ["all_done", "next_idx", "checklist"],
  additionalProperties: false,
  properties: {
    all_done: { type: "boolean" },
    next_idx: { type: "integer" },
    checklist: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "text", "task", "done", "attempts"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          done: { type: "boolean" },
          attempts: { type: "integer" },
          task: {
            type: "object",
            required: ["kind"],
            additionalProperties: true,
            properties: {
              kind: {
                type: "string",
                enum: [
                  "verify_items_visible",
                  "pickup",
                  "place_one",
                  "place_all",
                  "take_result",
                  "wait_for_output",
                  "verify_state",
                ],
              },
              items: { type: "array", items: { type: "string" } },
              slots: { type: "array", items: { type: "integer" } },
              sourceSlot: { type: "integer" },
              destSlot: { type: "integer" },
              expectedItem: { type: "string" },
              condition: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

// System prompt assembly + category routing live in ./prompts/. Each
// UI category (crafting / verify / organize / smelting / brewing /
// chest / anvil / enchanting / trading) has its own few-shot file
// next to the shared baseRules. Add a new file + register it in the
// barrel index.ts to support a new GUI type.
import { buildSystemPrompt, detectTaskCategory } from "./prompts";

function buildPlacementPlan(input: PlannerInput): string {
  if (!input.recipeInfo) return "";
  const craftCells = input.layoutSlots
    .filter((s) => s.role === "craft_2x2" || s.role === "craft_3x3")
    .sort((a, b) => a.index - b.index);
  const gridSize = craftCells.length === 9 ? 3 : (craftCells.length === 4 ? 2 : 0);
  if (gridSize === 0) return "";
  const planSteps: string[] = [];
  if (input.recipeInfo.inShape) {
    const rows = input.recipeInfo.inShape;
    let i = 1;
    for (let r = 0; r < rows.length; r += 1) {
      for (let c = 0; c < rows[r].length; c += 1) {
        const ing = rows[r][c];
        if (!ing) continue;
        const cell = craftCells[r * gridSize + c];
        if (cell) planSteps.push(`  ${i}. ${ing} at slot ${cell.index}`);
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
        if (cell) planSteps.push(`  ${i}. ${q.ingredient} at slot ${cell.index}`);
        i += 1;
        q.remaining -= 1;
        cellIdx += 1;
      }
      qi += 1;
    }
  }
  return `Placement plan (recipe cell → slot index):\n${planSteps.join("\n")}\n`;
}

function buildUserText(input: PlannerInput, userPayload: Record<string, unknown>): string {
  const lines = input.knownSlots
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((s) => `  slot ${s.index}${s.name ? `(${s.name})` : ""} -> ${s.item}`);
  const slotBlock = lines.length > 0 ? lines.join("\n") : "  (none yet)";
  const cursorBlock = input.cursorHolding ?? "(empty)";
  const placement = buildPlacementPlan(input);
  return `Known slot contents (if the image contradicts Known, dispatch a verify subtask to refresh tracking):
${slotBlock}
Cursor: ${cursorBlock}

${placement}${JSON.stringify(userPayload)}`;
}

let PLANNER_CALL_SEQ = 0;

export async function runPlanner(deps: PlannerDeps, input: PlannerInput): Promise<PlanResult> {
  const userPayload = {
    task: input.taskText,
    // Per-dispatch directive from the GoalPlanner. When present it
    // overrides the episode taskText for category routing — see
    // detectTaskCategory. Surfaced verbatim in the user prompt so the
    // LLM knows what THIS dispatch wants vs the broader episode goal.
    subgoal_directive: input.subgoalDescription ?? null,
    recipe: input.recipeInfo
      ? {
          target: input.recipeInfo.target,
          ingredients: input.recipeInfo.ingredients,
          inShape: input.recipeInfo.inShape,
        }
      : null,
    known_slots: input.knownSlots,
    cursor_holding: input.cursorHolding,
    current_checklist: input.currentChecklist,
    trigger: input.trigger,
    recent_history: input.recentHistory,
  };

  const userText = buildUserText(input, userPayload);
  const sys = buildSystemPrompt({ taskCategory: detectTaskCategory(input.taskText, input.subgoalDescription, !!input.recipeInfo) });
  const seq = String(++PLANNER_CALL_SEQ).padStart(5, "0");
  const debugDir = process.env.AGENTBEATS_DEBUG_DIR;
  if (debugDir) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require("node:path") as typeof import("node:path");
      const promptText = `[fastui-planner ${seq}]\nSYSTEM:\n${sys}\n\nUSER:\n${userText}\n`;
      fs.writeFileSync(pathMod.join(debugDir, `fastui_planner_${seq}_prompt.txt`), promptText);
      // Image saved by DebugRecorder via recordDebug() with global seq.
    } catch (e) {
      console.warn(`[fastui-planner ${seq}] debug dump failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const dataUrl = input.obsBase64.startsWith("data:image/")
    ? input.obsBase64
    : `data:image/jpeg;base64,${input.obsBase64}`;

  const body: Record<string, unknown> = {
    model: deps.model,
    temperature: 0,
    // 800 was truncating mid-checklist on long recipes (run 26 furnace
    // task: 13 step JSON regen got cut off → parser failed → planner
    // stuck regenerating the same truncated response forever). 3000 gives
    // headroom for ~25 step recipes plus the surrounding JSON envelope.
    max_completion_tokens: 3000,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "fastui_planner_out", schema: SCHEMA, strict: false },
    },
  };
  type Create = typeof deps.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  const resp = await deps.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
    choices: Array<{ message?: { content?: string | null } }>;
  };
  const text = resp.choices[0]?.message?.content ?? "";
  let parsed: { all_done: boolean; next_idx: number; checklist: ChecklistItem[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn(`[fastui-planner] failed to parse JSON: ${text.slice(0, 200)}`);
    return { kind: "continue", checklist: input.currentChecklist, nextIdx: input.currentChecklist.findIndex((c) => !c.done) };
  }
  console.log(`[fastui-planner] trigger=${input.trigger} all_done=${parsed.all_done} next_idx=${parsed.next_idx} checklist=[${parsed.checklist.map((c) => `${c.done ? "x" : " "}${c.id} task.kind=${(c.task as any)?.kind ?? "MISSING"}`).join(", ")}]`);
  try {
    // Pass the marked obs through recordDebug for global-seq filename.
    const m = input.obsBase64?.match(/^data:image\/([a-z]+);base64,(.+)$/);
    const ext: "png" | "jpg" = m && m[1] === "png" ? "png" : "jpg";
    const raw = m ? m[2] : input.obsBase64;
    await deps.recordDebug?.("fastui_planner_call", {
      seq, trigger: input.trigger,
      input: userPayload,
      output: { all_done: parsed.all_done, next_idx: parsed.next_idx, checklist: parsed.checklist },
    }, raw, ext);
  } catch { /* swallow */ }
  if (parsed.all_done) return { kind: "all_done", checklist: parsed.checklist };
  return { kind: "continue", checklist: parsed.checklist, nextIdx: parsed.next_idx };
}
