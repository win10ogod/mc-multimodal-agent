/**
 * FastUI Planner prompt assembly.
 *
 * The Planner system prompt is BASE_RULES (shared contract) + an
 * optional category-specific few-shot block. Category is detected
 * from the per-dispatch subgoal_directive (preferred) or the
 * episode-level taskText (fallback). Each few-shot lives in its own
 * file under this directory; the barrel below routes by category and
 * concatenates the strings.
 */
import { BASE_RULES } from "./baseRules";
import { FEW_SHOT_CRAFTING } from "./crafting";
import { FEW_SHOT_VERIFY } from "./verify";
import { FEW_SHOT_ORGANIZE } from "./organize";
import { FEW_SHOT_SMELTING } from "./smelting";
import { FEW_SHOT_BREWING } from "./brewing";
import { FEW_SHOT_CHEST } from "./chest";
import { FEW_SHOT_ANVIL } from "./anvil";
import { FEW_SHOT_ENCHANTING } from "./enchanting";
import { FEW_SHOT_TRADING } from "./trading";

export type TaskCategory =
  | "crafting"
  | "verify"
  | "organize"
  | "smelting"
  | "brewing"
  | "chest"
  | "anvil"
  | "enchanting"
  | "trading";

export function buildSystemPrompt(opts: { taskCategory?: TaskCategory }): string {
  switch (opts.taskCategory) {
    case "crafting":   return BASE_RULES + FEW_SHOT_CRAFTING;
    case "verify":     return BASE_RULES + FEW_SHOT_VERIFY;
    case "organize":   return BASE_RULES + FEW_SHOT_ORGANIZE;
    case "smelting":   return BASE_RULES + FEW_SHOT_SMELTING;
    case "brewing":    return BASE_RULES + FEW_SHOT_BREWING;
    case "chest":      return BASE_RULES + FEW_SHOT_CHEST;
    case "anvil":      return BASE_RULES + FEW_SHOT_ANVIL;
    case "enchanting": return BASE_RULES + FEW_SHOT_ENCHANTING;
    case "trading":    return BASE_RULES + FEW_SHOT_TRADING;
    default:           return BASE_RULES;
  }
}

/**
 * Detect a task category from the dispatch text.
 *
 * The per-dispatch subgoalDescription wins when present — it
 * expresses the GoalPlanner's immediate intent, which can differ
 * from the episode-level taskText (e.g. taskText="Craft a furnace",
 * subgoalDescription="verify inventory contains crafting_table"
 * routes to verify mode, not crafting). When no subgoalDescription
 * is present, fall back to taskText. recipePresent forces
 * "crafting" only when nothing more specific matches.
 */
export function detectTaskCategory(
  taskText: string,
  subgoalDescription: string | undefined,
  recipePresent: boolean,
): TaskCategory | undefined {
  const candidates = [subgoalDescription, taskText]
    .filter((s): s is string => !!s)
    .map((s) => s.toLowerCase());

  for (const t of candidates) {
    // Most specific patterns first; fall through to generic crafting.
    if (/\bverify\b/.test(t)) return "verify";
    if (/\borganize\b|\bmove\b\s+\w+\s+(from|to|into)\b/.test(t)) return "organize";
    if (/\bsmelt\b|\bfurnace\b|\bcook\b|\bblast_furnace\b|\bsmoker\b/.test(t)) return "smelting";
    if (/\bbrew\b|\bpotion\b|\bbrewing_stand\b/.test(t)) return "brewing";
    if (/\bchest\b|\bbarrel\b|\bshulker_box\b|\bender_chest\b|\bhopper\b|\bdispenser\b|\bdropper\b|\bdeposit\b|\bwithdraw\b|\bstore\b/.test(t)) return "chest";
    if (/\banvil\b|\brepair\b|\brename\b|\bsmithing_table\b|\bnetherite_upgrade\b/.test(t)) return "anvil";
    if (/\benchant\b|\benchanting_table\b/.test(t)) return "enchanting";
    if (/\btrade\b|\bvillager\b|\bwandering_trader\b/.test(t)) return "trading";
    if (/\bcraft\b|\bcrafting\b/.test(t)) return "crafting";
  }

  if (recipePresent) return "crafting";
  return undefined;
}
