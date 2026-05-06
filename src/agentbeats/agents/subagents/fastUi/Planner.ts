import type OpenAI from "openai";
import type { ChecklistItem, PlanResult } from "./types";
import type { RecipeInfo } from "../../../tools/UiFastControl";

export type PlannerDeps = {
  client: OpenAI;
  model: string;
  recordDebug?: (kind: string, payload: unknown) => Promise<void> | void;
};

export type PlannerInput = {
  taskText: string;
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

/** Build the Planner system prompt. Static contract + few-shot
 *  examples are domain-specific (crafting now; can extend with
 *  smelting/brewing/chest blocks later). */
function buildSystemPrompt(opts: { taskCategory?: "crafting" | "smelting" | "brewing" | "chest" }): string {
  const category = opts.taskCategory ?? "crafting";
  const baseRules = `You plan a checklist of PRIMITIVE subtasks for a Minecraft GUI subagent. Each subtask maps to ONE primitive click; the runtime executes and auto-ticks done on confirmed verify.

Subtask kinds (with explicit slot indices):
- verify_items_visible { items }: hover & OCR up to 3 candidate slots to confirm named items exist.
- pickup { sourceSlot, expectedItem }: left-click sourceSlot. Cursor MUST be empty before; will hold expectedItem after.
- place_one { destSlot, expectedItem }: right-click destSlot to drop ONE item. Cursor MUST hold expectedItem; cursor still holds (stack-1) after.
- place_all { destSlot, expectedItem }: left-click destSlot to drop the whole stack. Cursor MUST hold expectedItem; cursor empty after.
- take_result { expectedItem }: pickup from the result slot to take the crafted output (runtime resolves the destination).
- wait_for_output { expectedItem }: wait for furnace/brewing output.
- verify_state { condition }: confirm a non-action condition holds.

CURSOR INVARIANT: before pickup, cursor must be empty. Before place_*, cursor must hold the expected item. If state diverges (cursor holds wrong item, slot empty when expected, etc.) insert the recovery primitive (place_all to dump, pickup again, etc.) and re-plan from there.

On post_action calls: runtime has already auto-ticked subtasks whose primitive was confirmed. Read current_checklist for what's done. RE-PLAN only when state diverged. Preserve done flags and attempts; never decrement attempts.

Output strict JSON:
  { "all_done": bool, "next_idx": int (-1 if all_done), "checklist": [...] }
Each item: { id, text, task, done, attempts }.`;

  const fewShotCrafting = `

EXAMPLE — task "craft oak_planks". Recipe: 1x oak_log → 4x oak_planks (shapeless, single cell). Suppose Known says slot 38(hotbar_0)=oak_log; placement plan: 1. oak_log at slot 2.

Optimal first checklist:
  step1: pickup { sourceSlot: 38, expectedItem: "oak_log" }
  step2: place_all { destSlot: 2, expectedItem: "oak_log" }    // shapeless single-cell → place_all (whole stack into the cell, MC consumes 1 per craft cycle and the rest stays as input)
  step3: take_result { expectedItem: "oak_planks" }
next_idx: 0

EXAMPLE — task "craft diorite". Recipe: 2x cobblestone + 2x quartz, shaped inShape=[[cobble,quartz],[quartz,cobble]] → cobble at cell(0,0)=slot 2, quartz at cell(0,1)=slot 3, quartz at cell(1,0)=slot 5, cobble at cell(1,1)=slot 6. Suppose slot 38=cobblestone, slot 39=nether_quartz.

Optimal first checklist:
  step1: pickup { sourceSlot: 38, expectedItem: "cobblestone" }
  step2: place_one { destSlot: 2, expectedItem: "cobblestone" }
  step3: place_one { destSlot: 6, expectedItem: "cobblestone" }
  step4: place_all { destSlot: 38, expectedItem: "cobblestone" }    // return cobble remainder to source so cursor is empty
  step5: pickup { sourceSlot: 39, expectedItem: "nether_quartz" }
  step6: place_one { destSlot: 3, expectedItem: "nether_quartz" }
  step7: place_one { destSlot: 5, expectedItem: "nether_quartz" }
  step8: place_all { destSlot: 39, expectedItem: "nether_quartz" }    // return quartz remainder
  step9: take_result { expectedItem: "diorite" }
next_idx: 0

GENERAL RULE: for each ingredient with multiple target cells, emit pickup → K×place_one → place_all back to source. For a single-cell shapeless recipe, pickup → place_all into the cell. Always end with take_result.`;

  return baseRules + (category === "crafting" ? fewShotCrafting : "");
}

/** Detect task category from the dispatch text. The crafting few-shot
 *  block only loads when the GoalPlanner asked for a crafting subgoal
 *  (taskText starts with "craft" or recipe is provided). Other GUI
 *  categories (smelting/brewing/chest) fall back to the rules-only
 *  prompt — extend buildSystemPrompt with their own examples later. */
function detectTaskCategory(taskText: string, recipePresent: boolean): "crafting" | "smelting" | "brewing" | "chest" | undefined {
  const t = taskText.toLowerCase();
  if (recipePresent || /\bcraft\b|\bcrafting\b/.test(t)) return "crafting";
  if (/\bsmelt\b|\bfurnace\b|\bcook\b/.test(t)) return "smelting";
  if (/\bbrew\b|\bpotion\b/.test(t)) return "brewing";
  if (/\bchest\b|\bdeposit\b|\bwithdraw\b/.test(t)) return "chest";
  return undefined;
}

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
  const sys = buildSystemPrompt({ taskCategory: detectTaskCategory(input.taskText, !!input.recipeInfo) });
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
      if (input.obsBase64) {
        const m = input.obsBase64.match(/^data:image\/([a-z]+);base64,(.+)$/);
        const ext = m ? m[1] : "jpg";
        const raw = m ? m[2] : input.obsBase64;
        fs.writeFileSync(pathMod.join(debugDir, `fastui_planner_${seq}_input.${ext}`), Buffer.from(raw, "base64"));
      }
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
    max_completion_tokens: 800,
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
    await deps.recordDebug?.("fastui_planner_call", {
      seq, trigger: input.trigger,
      input: userPayload,
      output: { all_done: parsed.all_done, next_idx: parsed.next_idx, checklist: parsed.checklist },
    });
  } catch { /* swallow */ }
  if (parsed.all_done) return { kind: "all_done", checklist: parsed.checklist };
  return { kind: "continue", checklist: parsed.checklist, nextIdx: parsed.next_idx };
}
