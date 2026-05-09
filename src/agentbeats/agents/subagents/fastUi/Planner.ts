import type OpenAI from "openai";
import type { ChecklistItem, PlanResult } from "./types";
import type { RecipeInfo } from "../../../tools/UiFastControl";

export type PlannerDeps = {
  client: OpenAI;
  model: string;
  recordDebug?: (kind: string, payload: unknown, imageBase64?: string, imageExt?: "png" | "jpg") => Promise<void> | void;
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

/** Build the Planner system prompt. Static contract + few-shot
 *  examples are domain-specific (crafting now; can extend with
 *  smelting/brewing/chest blocks later). */
function buildSystemPrompt(opts: { taskCategory?: "crafting" | "smelting" | "brewing" | "chest" }): string {
  const category = opts.taskCategory ?? "crafting";
  const baseRules = `You plan a checklist of PRIMITIVE subtasks for a Minecraft GUI subagent. Each subtask maps to ONE primitive click; the runtime executes and auto-ticks done on confirmed verify.

Subtask kinds (with explicit slot indices):
- verify_items_visible { items?, slots? }: OCR slots to refresh Known. Pass items=[...] to have the Action find candidate slots, OR pass slots=[N1, N2, ...] to OCR specific slot indices (use this to confirm the result slot holds the crafted item, or to confirm a deposit target is empty before take_result).
- pickup { sourceSlot, expectedItem }: left-click sourceSlot. Cursor MUST be empty before; will hold expectedItem after. **BOTH fields are REQUIRED. sourceSlot MUST be a concrete integer index from Known/slots_by_role — never omit, never let the Action subagent guess "which cobblestone to pick" by name alone. expectedItem is the name the Action will use to verify it picked the right thing. (sourceSlot may be a craft-grid slot when doing a RECOVERY pickup — e.g. lifting a misplaced item back out — but in that case still emit the concrete slot id.)**
- place_one { destSlot, expectedItem }: right-click destSlot to drop ONE item. Cursor MUST hold expectedItem; cursor still holds (stack-1) after. **BOTH fields are REQUIRED. destSlot MUST be a concrete integer index.**
- place_all { destSlot, expectedItem }: left-click destSlot to drop the whole stack. Cursor MUST hold expectedItem; cursor empty after. **BOTH fields are REQUIRED. destSlot MUST be a concrete integer index.**
- take_result { expectedItem }: left-click the result slot to take the crafted output. Cursor MUST be empty before; will hold expectedItem after. Follow with a place_all to a free hotbar/main_inv slot to deposit it.
- wait_for_output { expectedItem }: wait for furnace/brewing output.
- verify_state { condition }: confirm a non-action condition holds.

CURSOR INVARIANT (HARD): before pickup, cursor must be empty. Before place_*, cursor must hold the expected item. THIS MEANS:

If the user prompt's "Cursor:" line shows the cursor holding ANY item, your output's FIRST not-yet-done subtask CANNOT be a pickup. It MUST be either:
  (a) a place_one or place_all that matches the held item to a recipe-required cell (if the held item still has placements pending in the recipe), OR
  (b) a place_all to a verified-empty inventory slot (to dump the cursor before the next pickup).

If you emit pickup as the first pending step while cursor is non-empty, MC will SWAP — corrupting both the source slot and the cursor. This is the most common plan failure; double-check before returning.

RE-PLAN MANDATE — read this every post_action call. If ANY of the following holds, you MUST modify the checklist (insert / replace / re-order steps); do NOT just preserve the prior list and bump next_idx:
  1. Cursor holds an item that the next pending subtask doesn't expect (e.g. next is pickup but cursor non-empty; next is place_one cobblestone but cursor holds quartz). Insert a recovery primitive (place_all to dump cursor into a known-empty slot, then re-pickup the right item) BEFORE the original next step.
  2. A pending pickup's sourceSlot doesn't actually hold the expected item per Known (drifted, swapped, or never was). Update sourceSlot to a slot that DOES hold the expected item, OR insert a verify_items_visible to find one.
  3. A pending place_*'s destSlot already holds a different item (would swap and corrupt). Pick a different empty destSlot, OR insert a recovery to clear the dest first.
  4. Recent_history shows a primitive failed (no observable change after retries). Replace that step with a verify_items_visible to refresh tracking, or pick a different sourceSlot/destSlot.
  5. Known shows the recipe target item is already in a regular slot (task already complete). Set all_done=true, next_idx=-1.

DONE FLAGS ARE READ-ONLY — the runtime is the SOLE authority for marking primitive subtasks done (it auto-ticks after each confirmed click verify). Your output's done=true count MUST equal current_checklist's done=true count. NEVER promote a pending step to done, no matter what Known or recent_history suggests. If you think a step "should be" done but the runtime hasn't ticked it, leave it pending and verify with OCR or insert a recovery step instead. You may ADD steps, REMOVE pending steps, REORDER, or modify task fields (sourceSlot/destSlot) — just never flip done from false to true.

Preserve or increment attempts; never decrement.

Output strict JSON:
  { "all_done": bool, "next_idx": int (-1 if all_done), "checklist": [...] }
Each item: { id, text, task, done, attempts }.`;

  const fewShotCrafting = `

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
ot re- The runtime auto-ticks each verify_items_visible once OCR completes; Re-PLAN reads the refreshed Known and adjusts sourceSlot fields in subsequent pickup/place steps.

DEPOSIT SLOT RULE: any place_all that deposits a held item into "free inventory" MUST target a slot whose role is hotbar (slot indices 38..46) or main_inv (slot indices 11..37). NEVER pick offhand (slot 10), armor (0, 1, 8, 9), craft cells (2, 3, 5, 6 for 2x2; or 9 craft slots for 3x3), the result slot, or gap slot 4. The Slots-by-role block in the user prompt lists exact ranges per layout — follow it.

GENERAL RULE: for each ingredient with multiple target cells, emit pickup → K×place_one → place_all back to source. For a single-cell shapeless recipe, pickup → place_all into the cell. Always end with take_result followed by place_all into a hotbar/main_inv slot that is NOT in Known and visually empty (and NOT an ingredient source slot — those are filled after the return-remainder place_all).`;

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
