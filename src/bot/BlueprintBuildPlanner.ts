import type { BlueprintPlacement } from "../blueprint/Blueprint";

export type InventoryCount = {
  name: string;
  count: number;
};

export type BlueprintBuildPlan = {
  canBuild: boolean;
  plannedPlacements: BlueprintPlacement[];
  required: InventoryCount[];
  available: InventoryCount[];
  missing: InventoryCount[];
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
    footprint: placementFootprint(plannedPlacements),
  };
}
