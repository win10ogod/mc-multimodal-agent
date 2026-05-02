import type { BlueprintPlacement } from "../blueprint/Blueprint";

export type InventoryCount = {
  name: string;
  count: number;
};

export type MaterialAcquisitionStep = {
  action: "plan_craft" | "gather" | "retry";
  item?: string;
  count?: number;
  suggestedTool?: string;
  reason: string;
  suggestedToolCall?: {
    tool: string;
    arguments: Record<string, unknown>;
  };
};

export type MaterialAcquisitionPlan = {
  strategy: "tool_upgrade_then_gather" | "craft_or_gather_missing_materials";
  missing: InventoryCount[];
  steps: MaterialAcquisitionStep[];
  notes: string[];
};

export type BlueprintBuildPlan = {
  canBuild: boolean;
  plannedPlacements: BlueprintPlacement[];
  required: InventoryCount[];
  available: InventoryCount[];
  missing: InventoryCount[];
  acquisitionPlan?: MaterialAcquisitionPlan;
  footprint?: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
    size: { x: number; y: number; z: number };
  };
};

type BuildPlanInput = {
  placements: BlueprintPlacement[];
  inventory: InventoryCount[];
  limit?: number;
};

const DEFERRED_BLOCK_PATTERNS = [
  /glass(?:_pane)?$/,
  /_door$/,
  /_trapdoor$/,
  /_slab$/,
  /_stairs$/,
  /_button$/,
  /_pressure_plate$/,
  /torch$/,
  /lantern$/,
  /ladder$/,
  /sign$/,
  /bed$/,
];
const LOG_RE = /(?:_log|_wood|_stem|_hyphae)$/;
const WOOD_FAMILY_RE = /^(.+)_(?:planks|slab|stairs|fence|fence_gate|door|trapdoor|button|pressure_plate|sign|hanging_sign)$/;
const WOODEN_PICKAXES = new Set(["wooden_pickaxe"]);
const WOODEN_AXES = new Set(["wooden_axe"]);
const STONE_OR_BETTER_PICKAXES = new Set(["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"]);
const STONE_OR_BETTER_AXES = new Set(["stone_axe", "iron_axe", "diamond_axe", "netherite_axe"]);

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function addCount(counts: Map<string, number>, name: string, count: number): void {
  const normalized = normalizeName(name);
  if (!normalized || !Number.isFinite(count) || count <= 0) {
    return;
  }
  counts.set(normalized, (counts.get(normalized) ?? 0) + count);
}

function sortedCounts(counts: Map<string, number>): InventoryCount[] {
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }));
}

function countAvailable(counts: Map<string, number>, names: Iterable<string>): number {
  let total = 0;
  for (const name of names) {
    total += counts.get(name) ?? 0;
  }
  return total;
}

function hasAny(counts: Map<string, number>, names: Iterable<string>): boolean {
  return countAvailable(counts, names) > 0;
}

function woodSourceFor(name: string): { source: string; craft?: string; sourceCount: (missingCount: number) => number } | undefined {
  const normalized = normalizeName(name);
  if (normalized === "any_log") {
    return { source: "_log", sourceCount: (missingCount) => missingCount };
  }
  if (LOG_RE.test(normalized)) {
    return { source: normalized, sourceCount: (missingCount) => missingCount };
  }
  const family = WOOD_FAMILY_RE.exec(normalized)?.[1];
  if (!family) {
    return undefined;
  }
  const source = family === "crimson" || family === "warped" ? `${family}_stem` : `${family}_log`;
  return { source, craft: normalized, sourceCount: (missingCount) => Math.ceil(missingCount / 4) };
}

function gatherToolCall(
  item: string | string[],
  count: number,
  match: "exact" | "suffix" = "exact",
): MaterialAcquisitionStep["suggestedToolCall"] {
  return {
    tool: "harvest_nearby_blocks",
    arguments: {
      names: Array.isArray(item) ? item : [item],
      match,
      count,
      maxDistance: 48,
    },
  };
}

function craftToolCall(item: string, count: number): MaterialAcquisitionStep["suggestedToolCall"] {
  return {
    tool: "plan_craft",
    arguments: { item, count },
  };
}

function planMaterialAcquisition(missing: InventoryCount[], availableCounts: Map<string, number>): MaterialAcquisitionPlan | undefined {
  if (missing.length === 0) {
    return undefined;
  }

  const steps: MaterialAcquisitionStep[] = [];
  const sourceCounts = new Map<string, number>();
  const craftAfterGather = new Map<string, number>();
  const hasWoodNeed = missing.some((item) => Boolean(woodSourceFor(item.name)));
  const hasStonePickaxe = hasAny(availableCounts, STONE_OR_BETTER_PICKAXES);
  const hasStoneAxe = hasAny(availableCounts, STONE_OR_BETTER_AXES);

  if (hasWoodNeed || !hasStonePickaxe) {
    if (!hasStonePickaxe && !hasAny(availableCounts, [...STONE_OR_BETTER_PICKAXES, ...WOODEN_PICKAXES])) {
      steps.push({
        action: "plan_craft",
        item: "wooden_pickaxe",
        count: 1,
        reason: "bootstrap cobblestone mining before upgrading tools",
        suggestedToolCall: craftToolCall("wooden_pickaxe", 1),
      });
    }

    let cobblestoneNeeded = Math.max(0, 6 - (availableCounts.get("cobblestone") ?? 0));
    if (hasStonePickaxe) {
      cobblestoneNeeded = Math.max(0, cobblestoneNeeded - 3);
    }
    if (hasStoneAxe) {
      cobblestoneNeeded = Math.max(0, cobblestoneNeeded - 3);
    }
    if (cobblestoneNeeded > 0 && (!hasStonePickaxe || (hasWoodNeed && !hasStoneAxe))) {
      steps.push({
        action: "gather",
        item: "cobblestone",
        count: cobblestoneNeeded,
        suggestedTool: hasStonePickaxe ? "stone_pickaxe" : "wooden_pickaxe",
        reason: "upgrade wooden tools into stone tools before bulk material gathering",
        suggestedToolCall: gatherToolCall(["stone", "cobblestone"], cobblestoneNeeded),
      });
    }
    if (!hasStonePickaxe) {
      steps.push({
        action: "plan_craft",
        item: "stone_pickaxe",
        count: 1,
        reason: "upgrade pickaxe for reliable stone and resource collection",
        suggestedToolCall: craftToolCall("stone_pickaxe", 1),
      });
    }
    if (hasWoodNeed && !hasAny(availableCounts, [...STONE_OR_BETTER_AXES, ...WOODEN_AXES])) {
      steps.push({
        action: "plan_craft",
        item: "wooden_axe",
        count: 1,
        reason: "bootstrap wood gathering before upgrading to stone axe",
        suggestedToolCall: craftToolCall("wooden_axe", 1),
      });
    }
    if (hasWoodNeed && !hasStoneAxe) {
      steps.push({
        action: "plan_craft",
        item: "stone_axe",
        count: 1,
        reason: "upgrade axe before collecting blueprint wood materials",
        suggestedToolCall: craftToolCall("stone_axe", 1),
      });
    }
  }

  for (const item of missing) {
    const source = woodSourceFor(item.name);
    if (!source) {
      steps.push({
        action: "plan_craft",
        item: item.name,
        count: item.count,
        reason: "resolve non-wood blueprint material through crafting or gatherable recipe steps",
        suggestedToolCall: craftToolCall(item.name, item.count),
      });
      continue;
    }
    sourceCounts.set(source.source, (sourceCounts.get(source.source) ?? 0) + source.sourceCount(item.count));
    if (source.craft) {
      craftAfterGather.set(source.craft, (craftAfterGather.get(source.craft) ?? 0) + item.count);
    }
  }

  for (const [source, count] of [...sourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    steps.push({
      action: "gather",
      item: source,
      count,
      suggestedTool: "stone_axe",
      reason: `collect source wood for missing blueprint material${source === "_log" ? "s" : ` ${source}`}`,
      suggestedToolCall: gatherToolCall(source, count, source === "_log" ? "suffix" : "exact"),
    });
  }
  for (const [item, count] of [...craftAfterGather.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    steps.push({
      action: "plan_craft",
      item,
      count,
      reason: "craft exact blueprint wood block from gathered logs",
      suggestedToolCall: craftToolCall(item, count),
    });
  }

  steps.push({
    action: "retry",
    item: "build_blueprint",
    reason: "rerun build_blueprint dryRun, then execute the real build only when missing is empty",
  });

  return {
    strategy: hasWoodNeed ? "tool_upgrade_then_gather" : "craft_or_gather_missing_materials",
    missing,
    steps,
    notes: [
      "Use plan_craft for each tool/material crafting step so server recipes and missing ingredients are checked before acting.",
      "Use the suggested gather steps to collect exact blueprint materials; then rerun dryRun before real placement.",
    ],
  };
}

function placementFootprint(placements: BlueprintPlacement[]): BlueprintBuildPlan["footprint"] {
  if (placements.length === 0) {
    return undefined;
  }
  const xs = placements.map((placement) => placement.position.x);
  const ys = placements.map((placement) => placement.position.y);
  const zs = placements.map((placement) => placement.position.z);
  const min = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    z: Math.min(...zs),
  };
  const max = {
    x: Math.max(...xs),
    y: Math.max(...ys),
    z: Math.max(...zs),
  };
  return {
    min,
    max,
    size: {
      x: max.x - min.x + 1,
      y: max.y - min.y + 1,
      z: max.z - min.z + 1,
    },
  };
}

function deferredRank(block: string): number {
  const normalized = normalizeName(block);
  const index = DEFERRED_BLOCK_PATTERNS.findIndex((pattern) => pattern.test(normalized));
  return index < 0 ? 0 : index + 1;
}

function placementPhase(block: string): number {
  return deferredRank(block) === 0 ? 0 : 1;
}

export function orderBlueprintPlacements(placements: BlueprintPlacement[]): BlueprintPlacement[] {
  return placements.slice().sort((a, b) => {
    const aPhase = placementPhase(a.block);
    const bPhase = placementPhase(b.block);
    return (
      aPhase - bPhase ||
      deferredRank(a.block) - deferredRank(b.block) ||
      a.position.y - b.position.y ||
      a.position.z - b.position.z ||
      a.position.x - b.position.x ||
      a.block.localeCompare(b.block)
    );
  });
}

export function createBlueprintBuildPlan(input: BuildPlanInput): BlueprintBuildPlan {
  const plannedPlacements = orderBlueprintPlacements(input.placements).slice(0, input.limit ?? input.placements.length);
  const requiredCounts = new Map<string, number>();
  const availableCounts = new Map<string, number>();

  for (const placement of plannedPlacements) {
    addCount(requiredCounts, placement.block, 1);
  }
  for (const item of input.inventory) {
    addCount(availableCounts, item.name, item.count);
  }

  const missingCounts = new Map<string, number>();
  for (const [name, required] of requiredCounts) {
    const available = availableCounts.get(name) ?? 0;
    if (available < required) {
      missingCounts.set(name, required - available);
    }
  }

  return {
    canBuild: missingCounts.size === 0,
    plannedPlacements,
    required: sortedCounts(requiredCounts),
    available: sortedCounts(availableCounts),
    missing: sortedCounts(missingCounts),
    acquisitionPlan: planMaterialAcquisition(sortedCounts(missingCounts), availableCounts),
    footprint: placementFootprint(plannedPlacements),
  };
}
