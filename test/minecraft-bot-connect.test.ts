import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    autoSpawn: true,
    createdBots: [] as any[],
    createBot: vi.fn(),
  };
});

class FakeBot extends EventEmitter {
  username = "OpenClawMC";
  version = "1.21.1";
  registry = { blocksByName: {}, itemsByName: {} };
  entity = {
    position: { x: 0, y: 64, z: 0 },
    yaw: 0,
    pitch: 0,
  };
  _client = Object.assign(new EventEmitter(), {
    socket: {
      setKeepAlive: vi.fn(),
      setNoDelay: vi.fn(),
    },
    write: vi.fn(),
    end: vi.fn(),
    ended: false,
  });
  pathfinder = {
    setMovements: vi.fn(),
    stop: vi.fn(),
    thinkTimeout: 0,
    tickTimeout: 0,
  };
  loadPlugin = vi.fn();
  quit = vi.fn();
  end = vi.fn((reason?: string) => {
    this._client.ended = true;
    this.emit("end", reason);
    this._client.emit("end", reason);
  });
}

vi.mock("mineflayer", () => ({
  default: { createBot: mocks.createBot },
  createBot: mocks.createBot,
}));

vi.mock("mineflayer-pathfinder", () => ({
  pathfinder: {},
  Movements: class {
    allow1by1towers = false;
    allowParkour = false;
    allowSprinting = false;
    canDig = false;
    dontCreateFlow = false;
    maxDropDown = 0;
    scaffoldBlocks: number[] = [];
    blocksToAvoid = new Set<number>();
    entitiesToAvoid = new Set();
    constructor() {}
  },
  goals: {
    GoalFollow: class {},
    GoalNear: class {},
  },
}));

vi.mock("minecraft-data", () => ({
  default: vi.fn(() => ({ blocksByName: {}, itemsByName: {} })),
}));

import { MinecraftBot } from "../src/bot/MinecraftBot";

function makeConfig() {
  return {
    minecraft: {
      host: "localhost",
      port: 25565,
      username: "OpenClawMC",
      auth: "offline",
      keepAliveTimeoutMs: 600_000,
      moddedTolerant: false,
      captureRecipes: false,
      skipRecipePackets: true,
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
    chatGuidance: {
      enabled: true,
      trigger: "",
    },
  };
}

describe("MinecraftBot connect stability", () => {
  beforeEach(() => {
    mocks.autoSpawn = true;
    mocks.createdBots.length = 0;
    mocks.createBot.mockImplementation(() => {
      const bot = new FakeBot();
      mocks.createdBots.push(bot);
      if (mocks.autoSpawn) {
        queueMicrotask(() => bot.emit("spawn"));
      }
      return bot;
    });
  });

  it("coalesces concurrent connect calls into one mineflayer client", async () => {
    const bot = new MinecraftBot(makeConfig() as never);

    const firstConnect = bot.connect();
    const secondConnect = bot.connect();

    expect(mocks.createBot).toHaveBeenCalledTimes(1);
    expect(mocks.createdBots).toHaveLength(1);
    await Promise.all([firstConnect, secondConnect]);
    expect(bot.isConnected()).toBe(true);
  });

  it("does not let a stale in-flight spawn revive a disconnected bot", async () => {
    mocks.autoSpawn = false;
    const bot = new MinecraftBot(makeConfig() as never);

    const pendingConnect = bot.connect().then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(mocks.createdBots).toHaveLength(1);

    bot.disconnect();
    mocks.createdBots[0].emit("spawn");

    const result = await pendingConnect;
    expect(result).toBeInstanceOf(Error);
    expect(bot.isConnected()).toBe(false);
  });
});
