import { describe, expect, it } from "vitest";
import { compiledStepIsValid, McuIntentCompiler } from "../src/agentbeats/McuIntentCompiler";
import type { McuActionIntent } from "../src/bot/McuVirtualBot";

function compile(intent: McuActionIntent) {
  const compiler = new McuIntentCompiler();
  compiler.enqueueIntents([intent]);
  const out: ReturnType<McuIntentCompiler["next"]>[] = [];
  while (compiler.hasPending()) out.push(compiler.next());
  return out;
}

describe("McuIntentCompiler", () => {
  it("translates a forward sprint move into a held forward+sprint button", () => {
    const steps = compile({ kind: "move", direction: "forward", durationMs: 600, sprint: true });
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    expect(step.action.forward).toBe(1);
    expect(step.action.sprint).toBe(1);
    expect(step.holdSteps).toBeGreaterThanOrEqual(8);
    expect(compiledStepIsValid(step)).toBe(true);
  });

  it("splits a large yaw rotation into multiple ≤10° camera frames", () => {
    const steps = compile({ kind: "look", yawDeltaDeg: 35, pitchDeltaDeg: 0 });
    expect(steps.length).toBeGreaterThanOrEqual(4);
    for (const step of steps) {
      expect(Math.abs(step.action.camera[1])).toBeLessThanOrEqual(10);
      expect(compiledStepIsValid(step)).toBe(true);
    }
    const totalYaw = steps.reduce((sum, step) => sum + step.action.camera[1], 0);
    expect(totalYaw).toBeCloseTo(35, 1);
  });

  it("maps craft into an inventory toggle (model performs GUI clicks itself)", () => {
    const steps = compile({ kind: "craft", item: "wooden_pickaxe", count: 1 });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.action.inventory).toBe(1);
  });

  it("maps dig and attackEntity into a held attack", () => {
    for (const intent of [
      { kind: "dig" as const, pos: { x: 0, y: 0, z: 0 } },
      { kind: "attackEntity" as const, entityId: 1, equipBestWeapon: false },
    ]) {
      const [step] = compile(intent);
      expect(step?.action.attack).toBe(1);
      expect(step?.holdSteps).toBeGreaterThan(1);
    }
  });

  it("maps setHotbar slot 0 to hotbar.1 (1-indexed in MCU)", () => {
    const [step] = compile({ kind: "setHotbar", slot: 0 });
    expect(step?.action["hotbar.1"]).toBe(1);
    for (let i = 2; i <= 9; i += 1) {
      expect(step?.action[`hotbar.${i}` as keyof typeof step.action]).toBe(0);
    }
  });

  it("respects safety queue cap and stops enqueueing after the limit", () => {
    const compiler = new McuIntentCompiler();
    const intents: McuActionIntent[] = Array.from({ length: 1000 }, () => ({
      kind: "look",
      yawDeltaDeg: 35,
      pitchDeltaDeg: 0,
    }));
    compiler.enqueueIntents(intents);
    expect(compiler.pendingCount()).toBeLessThanOrEqual(256);
  });
});
