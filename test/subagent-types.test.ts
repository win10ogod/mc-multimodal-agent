import { describe, it, expect } from "vitest";
import { makeEpisodeState } from "../src/agentbeats/agents/SubAgent";

describe("EpisodeState", () => {
  it("starts empty with the given taskText", () => {
    const s = makeEpisodeState("craft 4 oak planks");
    expect(s.taskText).toBe("craft 4 oak planks");
    expect(s.subgoals).toEqual([]);
    expect(s.idx).toBe(0);
    expect(s.earlyStop).toBe(false);
    expect(s.singleTask).toBe(false);
    expect(s.uiState).toBeNull();
  });
});
