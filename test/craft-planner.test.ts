import minecraftData from "minecraft-data";
import { describe, expect, it } from "vitest";
import { planCraft } from "../src/bot/CraftPlanner";

const data = minecraftData("1.20.4");

describe("planCraft", () => {
  it("returns a 'have' step when inventory already covers the target", () => {
    const plan = planCraft({ data, target: "stick", count: 2, inventory: { stick: 5 } });
    expect(plan.feasible).toBe(true);
    expect(plan.steps).toEqual([{ action: "have", item: "stick", count: 2 }]);
  });

  it("plans stick from oak_planks with surplus accounted for", () => {
    const plan = planCraft({ data, target: "stick", count: 1, inventory: { oak_planks: 4 } });
    expect(plan.feasible).toBe(true);
    const haveStep = plan.steps.find((s) => s.action === "have" && s.item === "oak_planks");
    const craftStep = plan.steps.find((s) => s.action === "craft" && s.item === "stick");
    expect(haveStep).toBeDefined();
    expect(craftStep).toBeDefined();
    expect(craftStep?.count).toBe(4);
  });

  it("plans wooden_pickaxe from oak_logs and surfaces table requirement", () => {
    const plan = planCraft({ data, target: "wooden_pickaxe", count: 1, inventory: { oak_log: 2 } });
    expect(plan.feasible).toBe(true);
    const stickCraft = plan.steps.find((s) => s.action === "craft" && s.item === "stick");
    const pickCraft = plan.steps.find((s) => s.action === "craft" && s.item === "wooden_pickaxe");
    expect(stickCraft).toBeDefined();
    expect(pickCraft).toBeDefined();
    expect(pickCraft?.requiresTable).toBe(true);
  });

  it("plans iron_pickaxe from raw materials including a smelt step", () => {
    const plan = planCraft({
      data,
      target: "iron_pickaxe",
      count: 1,
      inventory: { oak_log: 2, raw_iron: 3 },
    });
    expect(plan.feasible).toBe(true);
    const smelt = plan.steps.find((s) => s.action === "smelt" && s.item === "iron_ingot");
    expect(smelt?.requiresFurnace).toBe(true);
    expect(smelt?.count).toBe(3);
    const pick = plan.steps.find((s) => s.action === "craft" && s.item === "iron_pickaxe");
    expect(pick?.requiresTable).toBe(true);
  });

  it("emits gather steps for unknown leaves", () => {
    const plan = planCraft({ data, target: "diamond_pickaxe", count: 1, inventory: {} });
    expect(plan.feasible).toBe(true);
    const gatherDiamond = plan.steps.find((s) => s.action === "gather" && s.item === "diamond");
    expect(gatherDiamond).toBeDefined();
    expect(gatherDiamond?.hint).toMatch(/mine/i);
  });

  it("returns a missing step when the item is not in minecraft-data", () => {
    const plan = planCraft({ data, target: "unobtanium_sword", count: 1, inventory: {} });
    expect(plan.feasible).toBe(false);
    expect(plan.steps[0]).toMatchObject({ action: "missing", item: "unobtanium_sword" });
  });

  it("respects maxSteps and marks plan infeasible when truncated", () => {
    const plan = planCraft({
      data,
      target: "diamond_pickaxe",
      count: 4,
      inventory: {},
      maxSteps: 3,
    });
    expect(plan.feasible).toBe(false);
    expect(plan.notes.some((n) => n.includes("step cap"))).toBe(true);
  });
});
