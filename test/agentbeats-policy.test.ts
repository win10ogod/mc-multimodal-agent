import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
  McuVisualPolicy,
  normalizeMcuAction,
  parseMcuActionText,
  taskSpecificGuidance,
  toCompactMcuAgentActionPayload,
} from "../src/agentbeats/McuPolicy";

describe("AgentBeats MCU policy", () => {
  it("parses action JSON after thinking markup", () => {
    const parsed = parseMcuActionText(`<|channel>thought
aim at the block
<channel|>
{"type":"action","action_type":"env","hold_steps":4,"action":{"forward":1,"back":1,"left":0,"right":0,"jump":0,"sneak":0,"sprint":1,"attack":1,"use":0,"drop":0,"inventory":0,"hotbar.1":0,"hotbar.2":0,"hotbar.3":0,"hotbar.4":0,"hotbar.5":0,"hotbar.6":0,"hotbar.7":0,"hotbar.8":0,"hotbar.9":0,"camera":[3,120]}}`);
    expect(parsed?.hold_steps).toBe(4);
    expect(parsed?.action.forward).toBe(1);
    expect(parsed?.action.back).toBe(0);
    expect(parsed?.action.sprint).toBe(1);
    expect(parsed?.action.camera).toEqual([3, 10]);
  });

  it("normalizes invalid or conflicting action fields", () => {
    const action = normalizeMcuAction({
      forward: true,
      back: true,
      left: 1,
      right: 1,
      sprint: 1,
      "hotbar.1": 1,
      "hotbar.2": 1,
      camera: ["bad", -120],
    });
    expect(action.forward).toBe(1);
    expect(action.back).toBe(0);
    expect(action.left).toBe(1);
    expect(action.right).toBe(0);
    expect(action["hotbar.1"]).toBe(1);
    expect(action["hotbar.2"]).toBe(0);
    expect(action.camera).toEqual([0, -10]);
  });

  it("converts env actions to compact AgentBeats actions", () => {
    const action = normalizeMcuAction({
      forward: 1,
      sprint: 1,
      camera: [0, 8],
    });
    const payload = toCompactMcuAgentActionPayload(action);
    expect(payload.action_type).toBe("agent");
    expect(payload.buttons).toHaveLength(1);
    expect(payload.camera).toEqual([64]);
    expect(payload.buttons[0]).toBeGreaterThan(0);
  });

  it("adds task strategy guidance without leaking benchmark layout assumptions", () => {
    expect(taskSpecificGuidance("Mine horizontally")).toContain("horizontal tunnel");
    expect(taskSpecificGuidance("Mine obsidian blocks for various crafting or building purposes.")).toContain(
      "long continuous mine action",
    );
    expect(taskSpecificGuidance("Find and mine the diamond ore.")).toContain("suitable pickaxe");
    expect(taskSpecificGuidance("Find and mine the diamond ore.")).not.toContain("already");
  });

  it("refuses observations without an API key instead of falling back to heuristic actions", async () => {
    const config = loadConfig();
    config.openai.apiKey = "";
    const policy = new McuVisualPolicy(config);

    const ack = JSON.parse(await policy.handleText(JSON.stringify({ type: "init", text: "collect wood" }), "ctx"));
    expect(ack.success).toBe(true);

    const action = JSON.parse(await policy.handleText(JSON.stringify({ type: "obs", step: 0, obs: "" }), "ctx"));
    expect(action.type).toBe("ack");
    expect(action.success).toBe(false);
    expect(action.message).toContain("OPENAI_API_KEY");
  });
});
