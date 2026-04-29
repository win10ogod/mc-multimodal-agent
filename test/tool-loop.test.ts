import { describe, expect, it } from "vitest";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolOutcome,
} from "../src/agent/toolLoopDetection";

describe("tool loop detection", () => {
  it("warns after repeated identical tool calls", () => {
    const state = { toolCallHistory: [] };
    const config = {
      enabled: true,
      historySize: 10,
      warningThreshold: 3,
      criticalThreshold: 5,
    };
    for (let i = 0; i < 3; i += 1) {
      recordToolCall(state, "observe", {}, `call-${i}`, config);
      recordToolOutcome(state, "observe", {}, `call-${i}`, { ok: true, text: "same" });
    }
    const result = detectToolCallLoop(state, "observe", {}, config);
    expect(result.stuck).toBe(true);
    if (result.stuck) {
      expect(result.level).toBe("warning");
    }
  });
});
