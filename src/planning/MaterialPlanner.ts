import type { ExpandedBlueprint } from "../blueprint/Blueprint";

export type InventoryItem = {
  name: string;
  count: number;
};

export type MaterialPlanInput = {
  project: string;
  inventory?: InventoryItem[];
  blueprint?: Pick<ExpandedBlueprint, "name" | "placements">;
  required?: InventoryItem[];
  scale?: "small" | "medium" | "large";
};

export type MaterialPlan = {
  project: string;
  required: {
    items: InventoryItem[];
    planksEquivalent: number;
  };
  available: {
    items: InventoryItem[];
    planksEquivalent: number;
  };
  missing: InventoryItem[];
  notes: string[];
};

const WOOD_LOG_RE = /(?:_log|_wood|_stem|_hyphae)$/;
const WOOD_PLANK_RE = /_planks$/;
const WOOD_SLAB_RE = /_slab$/;

const LARGE_WOODEN_CASTLE_PLANKS = 768;
const PRESET_PLANKS: Record<string, number> = {
  small_wooden_castle: 192,
  medium_wooden_castle: 384,
  large_wooden_castle: LARGE_WOODEN_CASTLE_PLANKS,
  wooden_castle: LARGE_WOODEN_CASTLE_PLANKS,
};

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function addCount(map: Map<string, number>, name: string, count: number): void {
  const normalized = normalizeName(name);
  if (!normalized || !Number.isFinite(count) || count <= 0) {
    return;
  }
  map.set(normalized, (map.get(normalized) ?? 0) + count);
}

function sortedItems(map: Map<string, number>): InventoryItem[] {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }));
}

function itemWoodUnits(item: InventoryItem): number {
  const name = normalizeName(item.name);
  if (WOOD_LOG_RE.test(name)) {
    return item.count * 4;
  }
  if (WOOD_PLANK_RE.test(name)) {
    return item.count;
  }
  if (WOOD_SLAB_RE.test(name)) {
    return item.count * 0.5;
  }
  return 0;
}

function woodPlacementUnits(blockName: string, count: number): number {
  const name = normalizeName(blockName);
  if (WOOD_LOG_RE.test(name) || WOOD_PLANK_RE.test(name) || WOOD_SLAB_RE.test(name)) {
    return count;
  }
  return 0;
}

function inventoryMap(items: InventoryItem[] = []): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    addCount(out, item.name, item.count);
  }
  return out;
}

function blueprintRequirements(blueprint: Pick<ExpandedBlueprint, "placements">): {
  items: InventoryItem[];
  planksEquivalent: number;
} {
  const counts = new Map<string, number>();
  for (const placement of blueprint.placements) {
    addCount(counts, placement.block, 1);
  }
  const items = sortedItems(counts);
  const planksEquivalent = items.reduce((total, item) => total + woodPlacementUnits(item.name, item.count), 0);
  return { items, planksEquivalent };
}

function presetRequirement(input: MaterialPlanInput): { items: InventoryItem[]; planksEquivalent: number } {
  if (input.required && input.required.length > 0) {
    const counts = inventoryMap(input.required);
    const items = sortedItems(counts);
    return {
      items,
      planksEquivalent: items.reduce((total, item) => total + itemWoodUnits(item), 0),
    };
  }
  if (input.blueprint) {
    return blueprintRequirements(input.blueprint);
  }

  const project = normalizeName(input.project);
  const scaleDefault =
    input.scale === "small" ? PRESET_PLANKS.small_wooden_castle :
    input.scale === "medium" ? PRESET_PLANKS.medium_wooden_castle :
    PRESET_PLANKS.large_wooden_castle;
  const planksEquivalent = PRESET_PLANKS[project] ?? scaleDefault;
  return {
    items: [{ name: "any_log", count: Math.ceil(planksEquivalent / 4) }],
    planksEquivalent,
  };
}

export function planMaterials(input: MaterialPlanInput): MaterialPlan {
  const required = presetRequirement(input);
  const availableItems = sortedItems(inventoryMap(input.inventory));
  const availablePlanksEquivalent = availableItems.reduce((total, item) => total + itemWoodUnits(item), 0);
  const missing: InventoryItem[] = [];

  if (required.planksEquivalent > 0 && availablePlanksEquivalent < required.planksEquivalent) {
    missing.push({
      name: "any_log",
      count: Math.ceil((required.planksEquivalent - availablePlanksEquivalent) / 4),
    });
  }

  for (const item of required.items) {
    if (WOOD_LOG_RE.test(item.name) || WOOD_PLANK_RE.test(item.name) || WOOD_SLAB_RE.test(item.name) || item.name === "any_log") {
      continue;
    }
    const available = availableItems.find((candidate) => candidate.name === item.name)?.count ?? 0;
    if (available < item.count) {
      missing.push({ name: item.name, count: item.count - available });
    }
  }

  const notes = [
    input.blueprint
      ? `requirements derived from blueprint ${input.blueprint.name}`
      : `requirements derived from project preset ${input.project}`,
    "wood is normalized into plank-equivalent units so logs, planks, and slabs can be compared before choosing exact blocks",
  ];

  return {
    project: input.project,
    required,
    available: {
      items: availableItems,
      planksEquivalent: availablePlanksEquivalent,
    },
    missing,
    notes,
  };
}
