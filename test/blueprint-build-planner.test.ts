import { describe, expect, it } from "vitest";
import {
  createBlueprintBuildPlan,
  orderBlueprintPlacements,
} from "../src/bot/BlueprintBuildPlanner";
import type { BlueprintPlacement } from "../src/blueprint/Blueprint";

function placement(block: string, x: number, y: number, z: number): BlueprintPlacement {
  return {
    block,
    char: block,
    position: { x, y, z },
  };
}

describe("blueprint build planner", () => {
  it("blocks building before world mutation when required materials are missing", () => {
    const plan = createBlueprintBuildPlan({
      placements: [
        placement("oak_log", 0, 0, 0),
        placement("oak_log", 1, 0, 0),
        placement("oak_planks", 2, 0, 0),
        placement("glass", 3, 0, 0),
      ],
      inventory: [
        { name: "oak_log", count: 1 },
        { name: "oak_planks", count: 8 },
      ],
    });

    expect(plan.canBuild).toBe(false);
    expect(plan.required).toEqual([
      { name: "glass", count: 1 },
      { name: "oak_log", count: 2 },
      { name: "oak_planks", count: 1 },
    ]);
    expect(plan.available).toEqual([
      { name: "oak_log", count: 1 },
      { name: "oak_planks", count: 8 },
    ]);
    expect(plan.missing).toEqual([
      { name: "glass", count: 1 },
      { name: "oak_log", count: 1 },
    ]);
    expect(plan.footprint).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 3, y: 0, z: 0 },
      size: { x: 4, y: 1, z: 1 },
    });
  });

  it("orders solid lower supports before fragile and orientation-sensitive blocks", () => {
    const ordered = orderBlueprintPlacements([
      placement("oak_slab", 0, 2, 0),
      placement("oak_door", 0, 1, 1),
      placement("glass", 1, 1, 1),
      placement("oak_planks", 1, 1, 0),
      placement("oak_planks", 1, 0, 0),
      placement("oak_log", 0, 0, 0),
    ]);

    expect(ordered.map((entry) => `${entry.block}@${entry.position.x},${entry.position.y},${entry.position.z}`)).toEqual([
      "oak_log@0,0,0",
      "oak_planks@1,0,0",
      "oak_planks@1,1,0",
      "glass@1,1,1",
      "oak_door@0,1,1",
      "oak_slab@0,2,0",
    ]);
  });

  it("plans wood-to-stone tool upgrades before gathering missing wood materials", () => {
    const plan = createBlueprintBuildPlan({
      placements: [
        placement("oak_log", 0, 0, 0),
        placement("oak_log", 1, 0, 0),
        placement("oak_log", 2, 0, 0),
        placement("oak_log", 3, 0, 0),
        placement("oak_log", 4, 0, 0),
        placement("oak_planks", 0, 1, 0),
        placement("oak_planks", 1, 1, 0),
        placement("oak_planks", 2, 1, 0),
        placement("oak_planks", 3, 1, 0),
        placement("oak_planks", 4, 1, 0),
        placement("oak_planks", 0, 1, 1),
        placement("oak_planks", 1, 1, 1),
        placement("oak_planks", 2, 1, 1),
      ],
      inventory: [],
    });

    expect(plan.canBuild).toBe(false);
    expect(plan.acquisitionPlan?.strategy).toBe("tool_upgrade_then_gather");
    expect(plan.acquisitionPlan?.steps.map((step) => `${step.action}:${step.item ?? ""}:${step.count ?? ""}`)).toEqual([
      "plan_craft:wooden_pickaxe:1",
      "gather:cobblestone:6",
      "plan_craft:stone_pickaxe:1",
      "plan_craft:wooden_axe:1",
      "plan_craft:stone_axe:1",
      "gather:oak_log:7",
      "plan_craft:oak_planks:8",
      "retry:build_blueprint:",
    ]);
    expect(plan.acquisitionPlan?.steps.find((step) => step.item === "oak_log")?.suggestedTool).toBe("stone_axe");
  });
});
