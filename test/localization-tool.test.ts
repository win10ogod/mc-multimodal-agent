import { describe, expect, it } from "vitest";
import {
  createMinecraftToolRegistry,
  type MinecraftToolContext,
} from "../src/tools/MinecraftTools";

describe("locate_self tool", () => {
  it("returns structured position, facing, local blocks, and navigation state", async () => {
    const registry = createMinecraftToolRegistry();
    const localization = {
      position: { x: 1.5, y: 64, z: -2.25 },
      blockPosition: { x: 1, y: 64, z: -3 },
      yawDeg: 90,
      facing: "west",
      feetBlock: { name: "grass_block", position: { x: 1, y: 64, z: -3 } },
      belowBlock: { name: "dirt", position: { x: 1, y: 63, z: -3 } },
      navigation: { id: "none", type: "goto", status: "idle" },
    };

    const result = await registry.execute("locate_self", {}, {
      bot: {
        localizationSnapshot: () => localization,
      },
    } as unknown as MinecraftToolContext);

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(localization);
  });

  it("refuses screen actions when the visual frame is stale", async () => {
    const registry = createMinecraftToolRegistry();
    let digCalled = false;

    const result = await registry.execute("dig_screen", { x: 10, y: 12 }, {
      vision: {
        screenFrameStaleReason: () => "camera yaw changed 20.0 degrees since the visual frame was captured",
        hitFromScreen: () => ({
          blockName: "oak_log",
          blockPosition: { x: 1, y: 64, z: 1 },
          distance: 3,
        }),
      },
      bot: {
        digAt: async () => {
          digCalled = true;
          return "oak_log";
        },
      },
    } as unknown as MinecraftToolContext);

    expect(result.ok).toBe(false);
    expect(result.text).toContain("Visual frame is stale");
    expect(digCalled).toBe(false);
  });

  it("adds relative direction metadata to nearby block search results", async () => {
    const registry = createMinecraftToolRegistry();

    const result = await registry.execute("find_nearby_blocks", {
      names: ["stone"],
      match: "exact",
      maxDistance: 4,
      verticalRange: 1,
      count: 1,
    }, {
      bot: {
        ensureConnected: () => undefined,
        raw: {
          entity: { position: { x: 0.5, y: 64, z: 0.5 } },
          blockAt: (pos: { x: number; y: number; z: number }) =>
            pos.x === 2 && pos.y === 64 && pos.z === -1 ? { name: "stone" } : { name: "air" },
        },
      },
    } as unknown as MinecraftToolContext);

    const [target] = result.data as Array<{ relative: unknown; direction: string }>;
    expect(target.relative).toEqual({ x: 2, y: 0, z: -1 });
    expect(target.direction).toBe("east 2, north 1");
  });

  it("captures a left-center-right visual sweep and restores the center frame for screen tools", async () => {
    const registry = createMinecraftToolRegistry();
    const turns: Array<{ yaw: number; pitch: number }> = [];
    const frames = [
      { width: 40, height: 20, dataUrl: "data:image/png;base64,center0", text: "center before", capturedAt: "t0", visibleBlocks: ["grass"], visibleTargets: [] },
      { width: 40, height: 20, dataUrl: "data:image/png;base64,left", text: "left view", capturedAt: "t1", visibleBlocks: ["oak_log"], visibleTargets: [] },
      { width: 40, height: 20, dataUrl: "data:image/png;base64,right", text: "right view", capturedAt: "t2", visibleBlocks: ["water"], visibleTargets: [] },
      { width: 40, height: 20, dataUrl: "data:image/png;base64,center1", text: "center restored", capturedAt: "t3", visibleBlocks: ["grass"], visibleTargets: [] },
    ];

    const result = await registry.execute("visual_sweep", { yawDeg: 30 }, {
      bot: {
        lookDelta: async (yaw: number, pitch: number) => {
          turns.push({ yaw, pitch });
        },
      },
      vision: {
        capture: () => frames.shift(),
      },
      config: {
        vision: {
          contextYawDeg: 45,
        },
      },
    } as unknown as MinecraftToolContext);

    expect(result.ok).toBe(true);
    expect(turns).toEqual([
      { yaw: -30, pitch: 0 },
      { yaw: 60, pitch: 0 },
      { yaw: -30, pitch: 0 },
    ]);
    expect((result.data as { frames: { center: { text: string }; left: { text: string }; right: { text: string } } }).frames).toMatchObject({
      center: { text: "center restored" },
      left: { text: "left view" },
      right: { text: "right view" },
    });
  });
});
