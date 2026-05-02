import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithSlowOperationWatchdog } from "../src/agent/slowOperationWatchdog";

afterEach(() => {
  vi.useRealTimers();
});

describe("slow operation watchdog", () => {
  it("logs repeated heartbeat events while an operation is still running", async () => {
    vi.useFakeTimers();
    const events: Array<Record<string, unknown>> = [];

    const promise = runWithSlowOperationWatchdog({
      label: "tool:harvest_nearby_blocks",
      thresholdMs: 10,
      intervalMs: 10,
      snapshot: () => ({ connected: true }),
      log: (event) => events.push(event),
      action: () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 35)),
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(15);

    await expect(promise).resolves.toBe("done");
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      label: "tool:harvest_nearby_blocks",
      elapsedMs: 10,
      connected: true,
    });
    expect(events[2]?.elapsedMs).toBe(30);
  });

  it("does not log for operations that finish before the threshold", async () => {
    vi.useFakeTimers();
    const events: Array<Record<string, unknown>> = [];

    const promise = runWithSlowOperationWatchdog({
      label: "model:start",
      thresholdMs: 50,
      log: (event) => events.push(event),
      action: () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 10)),
    });

    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toBe("done");
    expect(events).toEqual([]);
  });
});
