import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentManager, type SubagentRunner } from "../src/agents/SubagentManager";

const tempDirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-subagents-"));
  tempDirs.push(dir);
  return path.join(dir, "subagents.json");
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
  );
});

describe("SubagentManager", () => {
  it("spawns an isolated model-only subagent and records completion", async () => {
    const filePath = await tempFile();
    const manager = new SubagentManager(filePath, async (run) => `planned:${run.task}`);
    await manager.load();

    const run = await manager.spawn({
      label: "castle planner",
      role: "planner",
      task: "Plan a wooden castle",
    });

    expect(run.status).toBe("running");
    await manager.waitFor(run.id);

    const completed = manager.get(run.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toBe("planned:Plan a wooden castle");
    expect(manager.list().map((item) => item.id)).toEqual([run.id]);
  });

  it("records OpenClaw-style fork context, parent linkage, and handoff timeline", async () => {
    const filePath = await tempFile();
    const runner: SubagentRunner = async (run) => {
      expect(run.contextMode).toBe("fork");
      expect(run.parentRunId).toBe("parent_turn_1");
      expect(run.forkedContext).toContain("inventory=oak_log:16");
      return "child handoff";
    };
    const manager = new SubagentManager(filePath, runner);
    await manager.load();

    const run = await manager.spawn({
      agentId: "builder-planner",
      label: "castle planner",
      role: "planner",
      task: "Plan a wooden castle",
      parentRunId: "parent_turn_1",
      contextMode: "fork",
      forkedContext: "inventory=oak_log:16",
      model: "local-test-model",
      thinking: "low",
    });
    await manager.waitFor(run.id);

    const completed = manager.get(run.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.agentId).toBe("builder-planner");
    expect(completed?.contextMode).toBe("fork");
    expect(completed?.handoff?.summary).toBe("child handoff");
    expect(completed?.events.map((event) => event.type)).toEqual(["spawned", "completed"]);
  });

  it("allows the parent to steer then cancel a running child", async () => {
    const filePath = await tempFile();
    const manager = new SubagentManager(filePath, async (_run, controls) => {
      const message = await controls.waitForMessage(0, 5_000);
      expect(message?.text).toBe("Prefer a 15x15 keep.");
      await new Promise<string>((_resolve, reject) => {
        controls.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return "unreachable";
    });
    await manager.load();

    const run = await manager.spawn({ task: "Plan keep layout" });
    await manager.send(run.id, "Prefer a 15x15 keep.", { type: "steer" });
    const cancelled = await manager.cancel(run.id, "Superseded by main plan");

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("Superseded by main plan");
    expect(cancelled.messages.map((message) => message.text)).toEqual(["Prefer a 15x15 keep."]);
    expect(cancelled.events.map((event) => event.type)).toContain("message");
    expect(cancelled.events.map((event) => event.type)).toContain("cancelled");
  });

  it("times out long-running children", async () => {
    const filePath = await tempFile();
    const manager = new SubagentManager(filePath, async (_run, controls) => {
      await new Promise<void>((resolve) => controls.signal.addEventListener("abort", () => resolve(), { once: true }));
      return "too late";
    });
    await manager.load();

    const run = await manager.spawn({ task: "Never finish", runTimeoutMs: 10 });
    await manager.waitFor(run.id, 500);

    const timedOut = manager.get(run.id);
    expect(timedOut?.status).toBe("timed_out");
    expect(timedOut?.events.map((event) => event.type)).toContain("timed_out");
  });

  it("marks stale running children failed after restart", async () => {
    const filePath = await tempFile();
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          runs: [
            {
              id: "subagent_stale",
              role: "planner",
              task: "Old child",
              status: "running",
              contextMode: "isolated",
              createdAt: "2026-05-02T00:00:00.000Z",
              updatedAt: "2026-05-02T00:00:00.000Z",
              startedAt: "2026-05-02T00:00:00.000Z",
              messages: [],
              events: [{ type: "spawned", at: "2026-05-02T00:00:00.000Z" }],
            },
          ],
        },
        null,
        2,
      ),
    );

    const manager = new SubagentManager(filePath, async () => "unused");
    await manager.load();

    const recovered = manager.get("subagent_stale");
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toContain("stale running");
    expect(recovered?.events.map((event) => event.type)).toContain("stale_recovered");
  });
});
