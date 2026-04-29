import { describe, expect, it } from "vitest";
import {
  createMinecraftToolRegistry,
  type MinecraftToolContext,
} from "../src/tools/MinecraftTools";

function makeContext(onStop: () => void): MinecraftToolContext {
  return {
    config: {
      loop: {
        maxToolSequenceSteps: 16,
      },
    },
    bot: {
      ensureConnected: () => undefined,
      stopMovement: onStop,
      raw: {
        entity: { position: { x: 0, y: 64, z: 0 } },
        blockAt: () => ({ name: "air" }),
      },
    },
  } as unknown as MinecraftToolContext;
}

describe("execute_steps tool", () => {
  it("executes a bounded sequence of atomic tools", async () => {
    const registry = createMinecraftToolRegistry();
    let stopCount = 0;
    const result = await registry.execute(
      "execute_steps",
      {
        steps: [
          { tool: "stop", arguments: {} },
          { tool: "stop", arguments: {} },
        ],
      },
      makeContext(() => {
        stopCount += 1;
      }),
    );

    expect(result.ok).toBe(true);
    expect(stopCount).toBe(2);
    expect(result.text).toContain("executed 2/2");
    expect((result.data as { executedSteps: unknown[] }).executedSteps).toHaveLength(2);
  });

  it("refuses meta tools inside a sequence", async () => {
    const registry = createMinecraftToolRegistry();
    const result = await registry.execute(
      "execute_steps",
      {
        steps: [{ tool: "execute_skill", arguments: { name: "unsafe" } }],
      },
      makeContext(() => undefined),
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("Refusing to execute meta tool execute_skill");
  });

  it("reports no target for one-shot harvesting without looping", async () => {
    const registry = createMinecraftToolRegistry();
    const result = await registry.execute(
      "harvest_nearby_blocks",
      {
        names: ["_log"],
        match: "suffix",
        count: 1,
        maxDistance: 1,
        verticalRange: 1,
      },
      makeContext(() => undefined),
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("no matches");
    expect((result.data as { executedSteps: unknown[] }).executedSteps).toHaveLength(1);
  });
});
