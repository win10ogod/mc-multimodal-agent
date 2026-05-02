import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config";
import { configurePathfinderMovementsForAgent } from "../src/bot/MinecraftBot";

describe("pathfinder movement settings", () => {
  it("applies configurable movement policy, scaffolding, and hazard avoidance", () => {
    const movements = {
      canDig: false,
      allow1by1towers: false,
      allowParkour: false,
      allowSprinting: false,
      allowEntityDetection: false,
      maxDropDown: 0,
      blocksToAvoid: new Set<number>(),
      entitiesToAvoid: new Set<string>(),
      scafoldingBlocks: [] as number[],
    };
    const registry = {
      blocksByName: {
        cactus: { id: 10 },
        magma_block: { id: 11 },
        powder_snow: { id: 12 },
      },
      itemsByName: {
        dirt: { id: 1 },
        cobblestone: { id: 2 },
        netherrack: { id: 3 },
      },
    };
    const config = {
      minecraft: {
        pathfindCanDig: true,
        pathfindAllow1by1Towers: true,
        pathfindAllowParkour: true,
        pathfindAllowSprinting: true,
        pathfindAllowEntityDetection: true,
        pathfindMaxDropDown: 5,
        pathfindAvoidHostiles: true,
        pathfindScaffoldBlocks: ["dirt", "netherrack", "missing_block"],
      },
    } as AgentConfig;

    const summary = configurePathfinderMovementsForAgent(movements, registry, config);

    expect(movements.canDig).toBe(true);
    expect(movements.allowParkour).toBe(true);
    expect(movements.allowSprinting).toBe(true);
    expect(movements.maxDropDown).toBe(5);
    expect(movements.blocksToAvoid.has(10)).toBe(true);
    expect(movements.blocksToAvoid.has(11)).toBe(true);
    expect(movements.blocksToAvoid.has(12)).toBe(true);
    expect(movements.entitiesToAvoid.has("creeper")).toBe(true);
    expect(movements.scafoldingBlocks).toEqual([1, 3]);
    expect(summary.scaffoldingBlocks).toEqual(["dirt", "netherrack"]);
  });
});
