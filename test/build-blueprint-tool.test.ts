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

  it("uses an explicit world anchor so retries do not drift after the bot moves", async () => {
    const registry = createMinecraftToolRegistry();
    let received:
      | {
          anchor: Vec3Like;
        }
      | undefined;
    let feetBlockCalls = 0;

    const result = await registry.execute(
      "build_blueprint",
      {
        blueprint: "example-hut",
        position: [100, 70, 200],
        offset: [2, 0, 3],
        dryRun: true,
      },
      {
        config: {
          paths: {
            blueprints: path.resolve("blueprints"),
          },
        },
        bot: {
          feetBlock: () => {
            feetBlockCalls += 1;
            return { x: 10, y: 64, z: 20 };
          },
          buildBlueprint: async (params: { anchor: Vec3Like }) => {
            received = params;
            return {
              blueprint: "example-hut",
              attempted: 0,
              placed: 0,
              skipped: 0,
              failed: [],
              planned: 40,
              missing: [],
              anchor: params.anchor,
            };
          },
        },
      } as unknown as MinecraftToolContext,
    );

    expect(result.ok).toBe(true);
    expect(received?.anchor).toEqual({ x: 100, y: 70, z: 200 });
    expect(feetBlockCalls).toBe(0);
    expect(result.text).toContain("anchor=100,70,200");
  });

  it("returns a failed tool result when actual blueprint placement is partial", async () => {
    const registry = createMinecraftToolRegistry();
    const result = await registry.execute(
      "build_blueprint",
      {
        blueprint: "example-hut",
        position: [100, 70, 200],
        limit: 2,
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
            attempted: 2,
            placed: 1,
            skipped: 0,
            failed: [
              {
                position: { x: 101, y: 70, z: 200 },
                block: "oak_log",
                reason: "No solid neighbor for placement at 101,70,200",
              },
            ],
          }),
        },
      } as unknown as MinecraftToolContext,
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("failed=1");
    expect(result.text).toContain("No solid neighbor");
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

describe("blueprint_build_continue tool", () => {
  it("preflights, grants safe missing materials, rechecks, and builds at one stable anchor", async () => {
    const registry = createMinecraftToolRegistry();
    const sent: string[] = [];
    const calls: Array<{ anchor: Vec3Like; dryRun?: boolean; clearMismatch?: boolean; limit?: number }> = [];
    const summaries = [
      {
        blueprint: "example-hut",
        anchor: { x: 100, y: 70, z: 200 },
        attempted: 0,
        placed: 0,
        skipped: 0,
        failed: [],
        blocked: "missing_materials" as const,
        missing: [{ name: "oak_log", count: 2 }],
      },
      {
        blueprint: "example-hut",
        anchor: { x: 100, y: 70, z: 200 },
        attempted: 0,
        placed: 0,
        skipped: 0,
        failed: [],
        planned: 40,
        missing: [],
      },
      {
        blueprint: "example-hut",
        anchor: { x: 100, y: 70, z: 200 },
        attempted: 40,
        placed: 40,
        skipped: 0,
        failed: [],
        planned: 40,
        missing: [],
      },
    ];

    const result = await registry.execute(
      "blueprint_build_continue",
      {
        blueprint: "example-hut",
        position: [100, 70, 200],
        offset: [9, 9, 9],
        limit: 40,
      },
      {
        config: {
          minecraft: {
            username: "OpenClawMC",
            allowCommandMaterials: true,
            commandMaterialMaxCount: 128,
            commandMaterialAllowedItems: ["oak_log"],
          },
          paths: {
            blueprints: path.resolve("blueprints"),
          },
        },
        bot: {
          feetBlock: () => ({ x: 1, y: 2, z: 3 }),
          chat: async (message: string) => {
            sent.push(message);
          },
          buildBlueprint: async (params: { anchor: Vec3Like; dryRun?: boolean; clearMismatch?: boolean; limit?: number }) => {
            calls.push({
              anchor: params.anchor,
              dryRun: params.dryRun,
              clearMismatch: params.clearMismatch,
              limit: params.limit,
            });
            const next = summaries.shift();
            if (!next) {
              throw new Error("unexpected extra buildBlueprint call");
            }
            return next;
          },
        },
      } as unknown as MinecraftToolContext,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain("state=complete");
    expect(sent).toEqual(["/give OpenClawMC minecraft:oak_log 2"]);
    expect(calls.map((call) => call.dryRun)).toEqual([true, true, false]);
    expect(calls.map((call) => call.anchor)).toEqual([
      { x: 100, y: 70, z: 200 },
      { x: 100, y: 70, z: 200 },
      { x: 100, y: 70, z: 200 },
    ]);
    expect(calls.every((call) => call.limit === 40)).toBe(true);
  });

  it("returns actionable next tool calls when material grants are unavailable", async () => {
    const registry = createMinecraftToolRegistry();
    const result = await registry.execute(
      "blueprint_build_continue",
      {
        blueprint: "example-hut",
        position: [100, 70, 200],
        limit: 40,
      },
      {
        config: {
          minecraft: {
            username: "OpenClawMC",
            allowCommandMaterials: false,
            commandMaterialMaxCount: 128,
            commandMaterialAllowedItems: ["oak_log"],
          },
          paths: {
            blueprints: path.resolve("blueprints"),
          },
        },
        bot: {
          feetBlock: () => ({ x: 1, y: 2, z: 3 }),
          buildBlueprint: async () => ({
            blueprint: "example-hut",
            anchor: { x: 100, y: 70, z: 200 },
            attempted: 0,
            placed: 0,
            skipped: 0,
            failed: [],
            blocked: "missing_materials",
            missing: [{ name: "oak_log", count: 2 }],
            acquisitionPlan: {
              strategy: "tool_upgrade_then_gather",
              missing: [{ name: "oak_log", count: 2 }],
              steps: [
                {
                  action: "gather",
                  item: "oak_log",
                  count: 2,
                  reason: "collect missing logs",
                  suggestedToolCall: {
                    tool: "harvest_nearby_blocks",
                    arguments: { names: ["oak_log"], count: 2, maxDistance: 48 },
                  },
                },
              ],
              notes: [],
            },
          }),
        },
      } as unknown as MinecraftToolContext,
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("state=blocked_missing_materials");
    expect(result.data).toMatchObject({
      nextToolCalls: [
        {
          tool: "harvest_nearby_blocks",
          arguments: { names: ["oak_log"], count: 2, maxDistance: 48 },
        },
        {
          tool: "blueprint_build_continue",
          arguments: { blueprint: "example-hut", position: [100, 70, 200], limit: 40 },
        },
      ],
    });
  });

  it("keeps failed placement recovery anchored to the same world position", async () => {
    const registry = createMinecraftToolRegistry();
    const summaries = [
      {
        blueprint: "example-hut",
        anchor: { x: 100, y: 70, z: 200 },
        attempted: 0,
        placed: 0,
        skipped: 0,
        failed: [],
        planned: 40,
        missing: [],
      },
      {
        blueprint: "example-hut",
        anchor: { x: 100, y: 70, z: 200 },
        attempted: 40,
        placed: 20,
        skipped: 5,
        failed: [
          {
            position: { x: 104, y: 72, z: 203 },
            block: "oak_log",
            reason: "No solid neighbor for placement at 104,72,203",
          },
        ],
        planned: 40,
        missing: [],
      },
    ];

    const result = await registry.execute(
      "blueprint_build_continue",
      {
        blueprint: "example-hut",
        position: [100, 70, 200],
        limit: 40,
      },
      {
        config: {
          minecraft: {
            username: "OpenClawMC",
            allowCommandMaterials: false,
            commandMaterialMaxCount: 128,
            commandMaterialAllowedItems: [],
          },
          paths: {
            blueprints: path.resolve("blueprints"),
          },
        },
        bot: {
          feetBlock: () => ({ x: 1, y: 2, z: 3 }),
          buildBlueprint: async () => {
            const next = summaries.shift();
            if (!next) {
              throw new Error("unexpected extra buildBlueprint call");
            }
            return next;
          },
        },
      } as unknown as MinecraftToolContext,
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("state=partial");
    expect(result.text).toContain("No solid neighbor");
    expect(result.data).toMatchObject({
      nextToolCalls: [
        { tool: "observe", arguments: {} },
        {
          tool: "blueprint_build_continue",
          arguments: { blueprint: "example-hut", position: [100, 70, 200], limit: 40 },
        },
      ],
    });
  });
});
