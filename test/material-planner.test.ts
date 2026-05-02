import { describe, expect, it } from "vitest";
import { planMaterials } from "../src/planning/MaterialPlanner";

describe("MaterialPlanner", () => {
  it("estimates missing wood for a large wooden castle from inventory", () => {
    const plan = planMaterials({
      project: "large_wooden_castle",
      inventory: [
        { name: "oak_log", count: 13 },
        { name: "birch_log", count: 15 },
        { name: "oak_planks", count: 16 },
      ],
    });

    expect(plan.project).toBe("large_wooden_castle");
    expect(plan.available.planksEquivalent).toBe(128);
    expect(plan.required.planksEquivalent).toBeGreaterThan(plan.available.planksEquivalent);
    expect(plan.missing.some((item) => item.name === "any_log")).toBe(true);
  });

  it("counts expanded blueprint block requirements", () => {
    const plan = planMaterials({
      project: "blueprint",
      blueprint: {
        name: "tiny",
        placements: [
          { block: "oak_planks", char: "P", position: { x: 0, y: 0, z: 0 } },
          { block: "oak_planks", char: "P", position: { x: 1, y: 0, z: 0 } },
          { block: "oak_log", char: "L", position: { x: 0, y: 1, z: 0 } },
        ],
      },
      inventory: [{ name: "oak_log", count: 1 }],
    });

    expect(plan.required.items).toEqual([
      { name: "oak_log", count: 1 },
      { name: "oak_planks", count: 2 },
    ]);
    expect(plan.available.planksEquivalent).toBe(4);
    expect(plan.missing).toEqual([]);
  });
});
