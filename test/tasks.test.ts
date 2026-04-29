import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TaskStore } from "../src/tasks/TaskStore";

describe("TaskStore", () => {
  it("tracks due interval tasks and reschedules after run", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-tasks-"));
    const tasks = new TaskStore(path.join(dir, "tasks.json"));
    await tasks.load();
    const task = await tasks.add({
      prompt: "check wheat",
      intervalSeconds: 60,
    });

    expect(tasks.due(new Date(Date.now() - 1000))).toHaveLength(0);
    expect(tasks.due(new Date(Date.now() + 61_000)).map((item) => item.id)).toContain(task.id);

    await tasks.markRun(task.id, new Date("2026-01-01T00:00:00.000Z"));
    expect(tasks.list()[0]?.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
  });
});
