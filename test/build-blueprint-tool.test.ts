import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMinecraftToolRegistry,
  type MinecraftToolContext,
} from "../src/tools/MinecraftTools";
import type { BlueprintPlacement } from "../src/blueprint/Blueprint";
import type { Vec3Like } from "../src/types";
import { MinecraftBot } from "../src/bot/MinecraftBot";

describe("build_blueprint tool", () => {
  it("loads a .litematic blueprint and delegates placements to the bot builder", async () => {
    const registry = createMinecraftToolRegistry();
    let received:
      | {
          name: string;
          anchor: Vec3Like;
          placements: BlueprintPlacement[];
          clearMismatch?: boolean;
          limit?: number;
        }
      | undefined;

    const result = await registry.execute(
      "build_blueprint",
      {
        blueprint: "example-hut",
        offset: [2, 0, 3],
        clearMismatch: true,
        limit: 7,
      },
      {
        config: {
          paths: {
            blueprints: path.resolve("blueprints"),
          },
        },
        bot: {
          feetBlock: () => ({ x: 10, y: 64, z: 20 }),
          buildBlueprint: async (params: typeof received) => {
            received = params;
            return {
              blueprint: params?.name ?? "",
              attempted: params?.placements.length ?? 0,
              placed: 7,
              skipped: 0,
              failed: [],
            };
          },
        },
      } as unknown as MinecraftToolContext,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain("blueprint example-hut");
    expect(received?.name).toBe("example-hut");
    expect(received?.anchor).toEqual({ x: 12, y: 64, z: 23 });
    expect(received?.clearMismatch).toBe(true);
    expect(received?.limit).toBe(7);
    expect(received?.placements.length).toBeGreaterThan(0);
    expect(received?.placements.every((placement) => placement.block !== "air")).toBe(true);
  });

  it("does not mutate the world when blueprint materials are missing", async () => {
    let blockAtCalls = 0;
    let digCalls = 0;
    let equipCalls = 0;
    let placeCalls = 0;

    const fakeBot = {
      raw: {
        inventory: {
          items: () => [{ name: "oak_log", count: 1 }],
        },
        blockAt: () => {
          blockAtCalls += 1;
          return undefined;
        },
      },
      digAt: async () => {
        digCalls += 1;
      },
      equipItem: async () => {
        equipCalls += 1;
      },
      placeBlockAt: async () => {
        placeCalls += 1;
      },
    };

    const summary = await MinecraftBot.prototype.buildBlueprint.call(fakeBot, {
      name: "missing-materials",
      anchor: { x: 0, y: 64, z: 0 },
      placements: [
        { block: "oak_log", char: "A", position: { x: 0, y: 0, z: 0 } },
        { block: "oak_log", char: "A", position: { x: 1, y: 0, z: 0 } },
      ],
      clearMismatch: true,
    });

    expect(summary.attempted).toBe(0);
    expect(summary.placed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toEqual([]);
    expect(summary.blocked).toBe("missing_materials");
    expect(summary.missing).toEqual([{ name: "oak_log", count: 1 }]);
    expect(summary.acquisitionPlan?.steps.map((step) => step.item)).toContain("wooden_pickaxe");
    expect(summary.acquisitionPlan?.steps.map((step) => step.item)).toContain("stone_pickaxe");
    expect(summary.acquisitionPlan?.steps.map((step) => step.item)).toContain("wooden_axe");
    expect(summary.acquisitionPlan?.steps.map((step) => step.item)).toContain("stone_axe");
    expect(summary.acquisitionPlan?.steps.find((step) => step.item === "oak_log")?.suggestedTool).toBe("stone_axe");
    expect(blockAtCalls).toBe(0);
    expect(digCalls).toBe(0);
    expect(equipCalls).toBe(0);
    expect(placeCalls).toBe(0);
  });

  it("returns a failed tool result when the bot builder is blocked by preflight", async () => {
    const registry = createMinecraftToolRegistry();
    const result = await registry.execute(
      "build_blueprint",
      {
        blueprint: "example-hut",
      },
      {
        config: {
          paths: {
            blueprints: path.resolve("blueprints"),
          },
        },
        bot: {
          feetBlock: () => ({ x: 0, y: 64, z: 0 }),
          buildBlueprint: async () => ({
            blueprint: "example-hut",
            attempted: 0,
            placed: 0,
            skipped: 0,
            failed: [],
            blocked: "missing_materials",
            missing: [{ name: "oak_log", count: 28 }],
            acquisitionPlan: {
              strategy: "tool_upgrade_then_gather",
              missing: [{ name: "oak_log", count: 28 }],
              steps: [
                { action: "plan_craft", item: "wooden_pickaxe", count: 1, reason: "bootstrap mining" },
                { action: "gather", item: "oak_log", count: 28, suggestedTool: "stone_axe", reason: "missing exact log" },
              ],
              notes: [],
            },
          }),
        },
      } as unknown as MinecraftToolContext,
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("blocked=missing_materials");
    expect(result.text).toContain("acquisition=tool_upgrade_then_gather");
    expect(result.data).toMatchObject({
      blocked: "missing_materials",
      missing: [{ name: "oak_log", count: 28 }],
      acquisitionPlan: {
        strategy: "tool_upgrade_then_gather",
      },
    });
  });

  it("supports dry-run preflight without mutating the world when materials are available", async () => {
    let blockAtCalls = 0;
    let digCalls = 0;
    let equipCalls = 0;
    let placeCalls = 0;

    const fakeBot = {
      raw: {
        inventory: {
          items: () => [{ name: "oak_log", count: 2 }],
        },
        blockAt: () => {
          blockAtCalls += 1;
          return undefined;
        },
      },
      digAt: async () => {
        digCalls += 1;
      },
      equipItem: async () => {
        equipCalls += 1;
      },
      placeBlockAt: async () => {
        placeCalls += 1;
      },
    };

    const summary = await MinecraftBot.prototype.buildBlueprint.call(fakeBot, {
      name: "dry-run",
      anchor: { x: 10, y: 64, z: 20 },
      placements: [
        { block: "oak_log", char: "A", position: { x: 0, y: 0, z: 0 } },
        { block: "oak_log", char: "A", position: { x: 1, y: 0, z: 0 } },
      ],
      dryRun: true,
    });

    expect(summary.attempted).toBe(0);
    expect(summary.placed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.blocked).toBeUndefined();
    expect(summary.required).toEqual([{ name: "oak_log", count: 2 }]);
    expect(summary.missing).toEqual([]);
    expect(blockAtCalls).toBe(0);
    expect(digCalls).toBe(0);
    expect(equipCalls).toBe(0);
    expect(placeCalls).toBe(0);
  });

  it("stops early after repeated navigation placement failures", async () => {
    let placeCalls = 0;
    const fakeBot = {
      raw: {
        inventory: {
          items: () => [{ name: "oak_log", count: 5 }],
        },
        blockAt: () => undefined,
      },
      equipItem: async () => {},
      placeBlockAt: async () => {
        placeCalls += 1;
        throw new Error("Pathfind timed out after 15000ms to 1,64,1");
      },
    };

    const summary = await MinecraftBot.prototype.buildBlueprint.call(fakeBot, {
      name: "navigation-blocked",
      anchor: { x: 0, y: 64, z: 0 },
      placements: [
        { block: "oak_log", char: "A", position: { x: 0, y: 0, z: 0 } },
        { block: "oak_log", char: "A", position: { x: 1, y: 0, z: 0 } },
        { block: "oak_log", char: "A", position: { x: 2, y: 0, z: 0 } },
        { block: "oak_log", char: "A", position: { x: 3, y: 0, z: 0 } },
        { block: "oak_log", char: "A", position: { x: 4, y: 0, z: 0 } },
      ],
    });

    expect(summary.attempted).toBe(2);
    expect(summary.failed).toHaveLength(2);
    expect(summary.blocked).toBe("navigation_blocked");
    expect(placeCalls).toBe(2);
  });
});
