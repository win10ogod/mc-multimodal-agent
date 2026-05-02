import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  start: vi.fn(),
  continue: vi.fn(),
  summarize: vi.fn(),
}));

vi.mock("../src/openai/ModelProvider", () => ({
  createModelProvider: () => provider,
  formatModelProviderError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  isRetryableModelProviderError: () => false,
}));

import { AgentLoop } from "../src/agent/AgentLoop";

let tempDir = "";

beforeEach(async () => {
  provider.start.mockReset();
  provider.continue.mockReset();
  provider.summarize.mockReset();
  provider.start.mockResolvedValue({ text: "recovered", toolCalls: [] });
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-reconnect-"));
  await fs.mkdir(path.join(tempDir, "blueprints"));
  await fs.mkdir(path.join(tempDir, "blueprint-library"));
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
});

function fakeConfig() {
  return {
    strictVisual: false,
    minecraft: {
      host: "localhost",
      port: 25565,
      auth: "offline",
      moddedTolerant: false,
      autoReconnect: true,
    },
    combat: {
      pveEnabled: true,
      allowPvp: false,
      autoDefense: false,
    },
    observability: {
      logInternalFlow: false,
      logToolArgs: false,
      logToolResults: false,
      slowOperationLogMs: 0,
    },
    loop: {
      overallTaskTimeoutMs: 60_000,
      taskTimeoutMs: 30_000,
      maxSegments: 2,
      maxToolCallsPerTurn: 4,
      maxToolCalls: 8,
      maxModelTurns: 4,
      checkpointEveryToolCalls: 0,
      autoObserveAfterActions: false,
      compactAfterMessages: 999_999,
    },
    vision: {
      contextFrames: 1,
      contextYawDeg: 42,
      contextSweep: false,
    },
    paths: {
      blueprints: path.join(tempDir, "blueprints"),
      blueprintLibrary: path.join(tempDir, "blueprint-library"),
      soul: path.join(tempDir, "missing-soul.md"),
    },
    skillLearning: {
      autoRecord: false,
      minToolCalls: 3,
    },
  };
}

function fakeDeps(initialConnected = false) {
  let connected = initialConnected;
  const bot = {
    connect: vi.fn(async () => {
      connected = true;
    }),
    isConnected: vi.fn(() => connected),
    ensureConnected: vi.fn(() => {
      if (!connected) {
        throw new Error("Minecraft bot is not in game: invalid bot position x=NaN y=64 z=NaN");
      }
    }),
    connectionSummary: vi.fn(() => (connected ? "connected" : "invalid bot position x=NaN y=64 z=NaN")),
    drainGuidance: vi.fn(() => []),
    statusSummary: vi.fn(() => "position=(0,64,0)"),
    navigationStatus: vi.fn(() => ({ id: "none", status: "idle" })),
    recipeCatalog: vi.fn(() => ({
      source: "client",
      serverRecipeCount: 0,
      skippedByConfig: false,
    })),
    runtimeRegistrySnapshot: vi.fn(() => ({ items: [], blocks: [] })),
    stopMovement: vi.fn(),
    setConnectedForTest: (value: boolean) => {
      connected = value;
    },
    raw: {
      version: "1.21.1",
    },
  };
  return {
    config: fakeConfig(),
    bot,
    vision: {
      capture: vi.fn(() => ({
        width: 320,
        height: 180,
        capturedAt: "2026-05-02T00:00:00.000Z",
        visibleBlocks: [],
        visibleTargets: [],
        text: "empty frame",
        dataUrl: "data:image/png;base64,",
      })),
    },
    tools: {
      definitions: vi.fn(() => []),
      names: vi.fn(() => []),
      execute: vi.fn(async () => ({ ok: true, text: "tool ok" })),
    },
    catalog: {
      syncRuntimeRegistry: vi.fn(),
      buildPromptSection: vi.fn(() => ""),
    },
    memory: {
      addNote: vi.fn(async () => undefined),
      buildPromptSection: vi.fn(async () => ""),
      latestCompaction: vi.fn(async () => undefined),
    },
    goals: {
      ensureRoot: vi.fn(async () => undefined),
      buildPromptSection: vi.fn(() => ""),
    },
    skills: {
      buildPromptSection: vi.fn(() => ""),
    },
    transcript: {
      append: vi.fn(async () => undefined),
      renderRecent: vi.fn(async () => ""),
      countApprox: vi.fn(async () => 0),
    },
  } as never;
}

describe("AgentLoop reconnect recovery", () => {
  it("reconnects before starting a task when the bot position is invalid", async () => {
    const deps = fakeDeps() as any;
    const loop = new AgentLoop(deps);

    await expect(loop.runTask("recover from NaN")).resolves.toBe("recovered");

    expect(deps.bot.connect).toHaveBeenCalledTimes(1);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it("reconnects and continues when the bot position becomes invalid after a tool call", async () => {
    provider.start.mockResolvedValueOnce({
      text: "",
      toolCalls: [{ id: "call_1", name: "noop", arguments: "{}" }],
    });
    provider.continue.mockResolvedValueOnce({ text: "continued after reconnect", toolCalls: [] });
    const deps = fakeDeps(true) as any;
    deps.tools.execute.mockImplementationOnce(async () => {
      deps.bot.setConnectedForTest(false);
      return { ok: true, text: "tool moved into invalid position" };
    });
    const loop = new AgentLoop(deps);

    await expect(loop.runTask("recover after tool")).resolves.toBe("continued after reconnect");

    expect(deps.bot.connect).toHaveBeenCalledTimes(1);
    expect(provider.continue).toHaveBeenCalledTimes(1);
  });
});
