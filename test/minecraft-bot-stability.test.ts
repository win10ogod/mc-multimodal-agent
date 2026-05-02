import { describe, expect, it, vi } from "vitest";
import { MinecraftBot } from "../src/bot/MinecraftBot";

function makeConfig() {
  return {
    minecraft: {
      host: "localhost",
      port: 25565,
      username: "OpenClawMC",
      auth: "offline",
      keepAliveTimeoutMs: 600_000,
      pathfindTimeoutMs: 15_000,
      pathfindThinkTimeoutMs: 5_000,
      pathfindTickTimeoutMs: 40,
      pathfindSearchRadius: 96,
      pathfindCanDig: true,
      pathfindAllow1by1Towers: true,
      pathfindAllowParkour: true,
      pathfindAllowSprinting: true,
      pathfindAllowEntityDetection: true,
      pathfindAvoidHostiles: true,
      pathfindMaxDropDown: 4,
      pathfindScaffoldBlocks: ["dirt"],
    },
  };
}

function makeBotWithRaw(raw: Record<string, unknown>): MinecraftBot {
  const bot = new MinecraftBot(makeConfig() as never);
  (bot as unknown as { bot: unknown; connected: boolean }).bot = raw;
  (bot as unknown as { bot: unknown; connected: boolean }).connected = true;
  return bot;
}

describe("MinecraftBot stability guards", () => {
  it("treats NaN coordinates as not connected so background reconnect can recover", () => {
    const bot = makeBotWithRaw({
      entity: {
        position: { x: Number.NaN, y: 63, z: Number.NaN },
      },
    });

    expect(bot.isConnected()).toBe(false);
    expect(bot.connectionSummary()).toContain("invalid bot position");
    expect(() => bot.ensureConnected()).toThrow(/invalid bot position/);
  });

  it("does not pathfind before digging a block already within direct reach", async () => {
    const block = { name: "oak_log" };
    const raw = {
      entity: {
        position: {
          x: 0,
          y: 64,
          z: 0,
          distanceTo: () => 2,
        },
      },
      blockAt: vi.fn(() => block),
      canDigBlock: vi.fn(() => true),
      lookAt: vi.fn(async () => undefined),
      dig: vi.fn(async () => undefined),
    };
    const bot = makeBotWithRaw(raw);
    const gotoNear = vi.spyOn(bot, "gotoNear").mockResolvedValue(false);

    await expect(bot.digAt({ x: 1, y: 64, z: 1 })).resolves.toBe("oak_log");

    expect(gotoNear).not.toHaveBeenCalled();
    expect(raw.dig).toHaveBeenCalledWith(block);
  });

  it("clears stale navigation state before reconnecting", () => {
    const bot = new MinecraftBot(makeConfig() as never);
    const timeout = setTimeout(() => undefined, 10_000);
    (bot as unknown as { activeNavigation: unknown }).activeNavigation = {
      id: "nav_stale",
      type: "follow",
      status: "running",
      range: 5,
      startedAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
      startedAtMs: Date.now(),
      timeoutMs: 30_000,
      timeout,
    };

    (bot as unknown as { resetRuntimeStateForReconnect: () => void }).resetRuntimeStateForReconnect();

    expect((bot as unknown as { activeNavigation?: unknown }).activeNavigation).toBeUndefined();
  });

  it("reports normalized yaw and a cardinal facing in status summaries", () => {
    const bot = makeBotWithRaw({
      entity: {
        position: {
          x: 0,
          y: 64,
          z: 0,
        },
        yaw: (450 * Math.PI) / 180,
        pitch: 0,
      },
      health: 20,
      food: 20,
    });

    expect(bot.statusSummary()).toContain("yaw=90.0");
    expect(bot.statusSummary()).toContain("facing=west");
  });
});
