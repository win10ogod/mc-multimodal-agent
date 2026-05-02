import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMinecraftToolRegistry,
  type MinecraftToolContext,
} from "../src/tools/MinecraftTools";
import type { BlueprintPlacement } from "../src/blueprint/Blueprint";
import type { Vec3Like } from "../src/types";

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
});
