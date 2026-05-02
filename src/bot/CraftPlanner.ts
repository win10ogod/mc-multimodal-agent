import type minecraftData from "minecraft-data";

export type IndexedData = ReturnType<typeof minecraftData>;

export type PlanAction = "have" | "craft" | "smelt" | "gather" | "missing";

export type PlanStep = {
  action: PlanAction;
  item: string;
  count: number;
  requiresTable?: boolean;
  requiresFurnace?: boolean;
  hint?: string;
  reason?: string;
};

export type CraftPlanResult = {
  target: string;
  count: number;
  feasible: boolean;
  steps: PlanStep[];
  notes: string[];
};

export type Inventory = Record<string, number>;

export type PlanCraftOptions = {
  data: IndexedData;
  target: string;
  count: number;
  inventory: Inventory;
  maxDepth?: number;
  maxSteps?: number;
};

const SMELT_SOURCES: Record<string, string[]> = {
  iron_ingot: ["raw_iron", "iron_ore", "deepslate_iron_ore"],
  gold_ingot: ["raw_gold", "gold_ore", "deepslate_gold_ore", "nether_gold_ore"],
  copper_ingot: ["raw_copper", "copper_ore", "deepslate_copper_ore"],
  netherite_scrap: ["ancient_debris"],
  stone: ["cobblestone"],
  smooth_stone: ["stone"],
  glass: ["sand", "red_sand"],
  brick: ["clay_ball"],
  nether_brick: ["netherrack"],
  charcoal: [
    "oak_log",
    "spruce_log",
    "birch_log",
    "jungle_log",
    "acacia_log",
    "dark_oak_log",
    "mangrove_log",
    "cherry_log",
  ],
};

function leafHint(name: string): string {
  if (name.endsWith("_log") || name === "wood") return "chop a tree";
  if (name.endsWith("_ore") || name === "ancient_debris") return "mine ore";
  if (name === "raw_iron" || name === "raw_gold" || name === "raw_copper") return "mine the matching ore";
  if (["diamond", "emerald", "redstone", "lapis_lazuli", "coal"].includes(name)) return "mine ore and collect drop";
  if (name === "string") return "kill spiders or break cobwebs";
  if (name === "feather") return "kill chickens";
  if (name === "leather") return "kill cows or horses";
  if (name === "gunpowder") return "kill creepers";
  if (name === "blaze_rod") return "kill blazes in the Nether";
  if (name === "ender_pearl") return "kill endermen or trade";
  if (name === "slime_ball") return "kill slimes in swamps or slime chunks";
  if (["sand", "red_sand", "gravel", "dirt", "cobblestone", "netherrack", "clay_ball"].includes(name)) return "mine the block";
  return "obtain by gathering";
}

function recipeIngredientIds(recipe: unknown): number[] {
  const ids: number[] = [];
  const r = recipe as { ingredients?: unknown; inShape?: unknown };
  if (Array.isArray(r.ingredients)) {
    for (const item of r.ingredients) {
      if (typeof item === "number" && item > 0) ids.push(item);
      else if (Array.isArray(item)) for (const id of item) if (typeof id === "number" && id > 0) ids.push(id);
    }
  }
  if (Array.isArray(r.inShape)) {
    for (const row of r.inShape) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        if (cell == null) continue;
        if (typeof cell === "number") {
          if (cell > 0) ids.push(cell);
        } else if (Array.isArray(cell)) {
          for (const id of cell) if (typeof id === "number" && id > 0) ids.push(id);
        }
      }
    }
  }
  return ids;
}

function recipeIngredientCounts(recipe: unknown, data: IndexedData): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of recipeIngredientIds(recipe)) {
    const name = data.items[id]?.name;
    if (!name) continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function recipeRequiresTable(recipe: unknown): boolean {
  const r = recipe as { inShape?: unknown[]; ingredients?: unknown[] };
  if (Array.isArray(r.inShape)) {
    const rows = r.inShape.length;
    let cols = 0;
    for (const row of r.inShape) if (Array.isArray(row)) cols = Math.max(cols, row.length);
    return rows > 2 || cols > 2;
  }
  if (Array.isArray(r.ingredients)) return r.ingredients.length > 4;
  return false;
}

function recipeResultCount(recipe: unknown): number {
  const r = recipe as { result?: { count?: number } };
  return r.result?.count ?? 1;
}

function pickBestRecipe(recipes: unknown[], data: IndexedData, target: string): unknown | null {
  if (!recipes?.length) return null;
  const targetId = data.itemsByName[target]?.id;
  const noSelfRef = recipes.filter((r) => !recipeIngredientIds(r).includes(targetId ?? -1));
  const pool = noSelfRef.length ? noSelfRef : recipes;
  return [...pool].sort((a, b) => {
    const ai = recipeIngredientIds(a).length;
    const bi = recipeIngredientIds(b).length;
    if (ai !== bi) return ai - bi;
    return recipeResultCount(b) - recipeResultCount(a);
  })[0];
}

function dedupeAdjacent(steps: PlanStep[]): PlanStep[] {
  const out: PlanStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.action === step.action &&
      prev.item === step.item &&
      prev.requiresTable === step.requiresTable &&
      prev.requiresFurnace === step.requiresFurnace &&
      prev.hint === step.hint
    ) {
      prev.count += step.count;
    } else {
      out.push({ ...step });
    }
  }
  return out;
}

export function planCraft(opts: PlanCraftOptions): CraftPlanResult {
  const { data, target, count } = opts;
  const inv: Inventory = { ...opts.inventory };
  const maxDepth = opts.maxDepth ?? 4;
  const maxSteps = opts.maxSteps ?? 40;
  const steps: PlanStep[] = [];
  const notes: string[] = [];
  let feasible = true;

  if (!data.itemsByName[target]) {
    return {
      target,
      count,
      feasible: false,
      steps: [{ action: "missing", item: target, count, reason: "unknown item in minecraft-data" }],
      notes: ["target not found; verify item name (use search_catalog)"],
    };
  }
  if (count <= 0) {
    return { target, count, feasible: true, steps: [], notes: ["count <= 0; nothing to do"] };
  }

  function consumeFromInv(name: string, want: number): number {
    const have = inv[name] ?? 0;
    const used = Math.min(have, want);
    if (used > 0) {
      inv[name] = have - used;
      steps.push({ action: "have", item: name, count: used });
    }
    return want - used;
  }

  function recur(name: string, want: number, depth: number, visited: Set<string>): void {
    if (steps.length >= maxSteps) {
      if (feasible) notes.push(`step cap ${maxSteps} reached; plan truncated`);
      feasible = false;
      return;
    }
    const need = consumeFromInv(name, want);
    if (need <= 0) return;

    if (visited.has(name)) {
      steps.push({ action: "gather", item: name, count: need, hint: leafHint(name) });
      notes.push(`cycle detected for ${name}; falling back to gather`);
      return;
    }
    if (depth >= maxDepth) {
      steps.push({ action: "gather", item: name, count: need, hint: leafHint(name) });
      notes.push(`depth cap reached at ${name}; treat as gather`);
      return;
    }

    const itemDef = data.itemsByName[name];
    const recipes = itemDef ? data.recipes[itemDef.id] : null;
    const smeltSourcesUpfront = SMELT_SOURCES[name];
    const smeltable = smeltSourcesUpfront?.some((s) => (inv[s] ?? 0) > 0);
    const recipe = !smeltable && recipes ? pickBestRecipe(recipes, data, name) : null;
    if (recipe) {
      const perCraft = recipeResultCount(recipe);
      const crafts = Math.ceil(need / perCraft);
      const produced = crafts * perCraft;
      const surplus = produced - need;
      const ingredients = recipeIngredientCounts(recipe, data);
      const table = recipeRequiresTable(recipe);
      const childVisited = new Set(visited).add(name);
      for (const [ing, c] of Object.entries(ingredients)) {
        recur(ing, c * crafts, depth + 1, childVisited);
      }
      steps.push({ action: "craft", item: name, count: produced, requiresTable: table });
      if (surplus > 0) inv[name] = (inv[name] ?? 0) + surplus;
      return;
    }

    const smeltSources = SMELT_SOURCES[name];
    if (smeltSources) {
      const childVisited = new Set(visited).add(name);
      const source = smeltSources.find((s) => (inv[s] ?? 0) > 0) ?? smeltSources[0];
      recur(source, need, depth + 1, childVisited);
      steps.push({
        action: "smelt",
        item: name,
        count: need,
        requiresFurnace: true,
        hint: `smelt ${source} (needs fuel: coal, charcoal, or logs)`,
      });
      return;
    }

    steps.push({ action: "gather", item: name, count: need, hint: leafHint(name) });
  }

  recur(target, count, 0, new Set());
  return { target, count, feasible, steps: dedupeAdjacent(steps), notes };
}
