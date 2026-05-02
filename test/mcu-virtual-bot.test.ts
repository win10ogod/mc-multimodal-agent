import { describe, expect, it } from "vitest";
import { McuVirtualBot } from "../src/bot/McuVirtualBot";
import { McuIntentCompiler } from "../src/agentbeats/McuIntentCompiler";

function bot() {
  return new McuVirtualBot({ version: "1.20.4" });
}

describe("McuVirtualBot", () => {
  it("exposes minecraft-data registry through runtimeRegistrySnapshot", () => {
    const snap = bot().runtimeRegistrySnapshot();
    expect(snap.version).toBe("1.20.4");
    expect(snap.items.length).toBeGreaterThan(500);
    expect(snap.blocks.length).toBeGreaterThan(500);
    expect(snap.items.find((it) => it.name === "iron_ingot")).toBeDefined();
  });

  it("recipeCatalog returns client recipes for a known item", () => {
    const cat = bot().recipeCatalog("stick", 4);
    expect(cat.source).toBe("client");
    expect(cat.recipes.length).toBeGreaterThan(0);
    const stick = cat.recipes.find((r) => r.result.name === "stick" || r.result.id !== undefined);
    expect(stick).toBeDefined();
    expect(stick?.requiresTable).toBe(false);
  });

  it("inventorySummary tracks items added via recordObservedItem", () => {
    const b = bot();
    expect(b.inventorySummary()).toHaveLength(0);
    b.recordObservedItem("oak_log", 3);
    b.recordObservedItem("stick", 2);
    const inv = b.inventorySummary();
    expect(inv).toHaveLength(2);
    expect(inv.find((s) => s.name === "oak_log")?.count).toBe(3);
  });

  it("queues an action intent when craftItem is called and drains it once", async () => {
    const b = bot();
    const before = b.drainIntents();
    expect(before).toHaveLength(0);
    await b.craftItem("wooden_pickaxe", 1);
    const drained = b.drainIntents();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ kind: "craft", item: "wooden_pickaxe", count: 1 });
    expect(b.drainIntents()).toHaveLength(0);
  });

  it("drained intents from a craft+equip sequence compile into MCU button frames", async () => {
    const b = bot();
    await b.craftItem("wooden_pickaxe", 1);
    b.setHotbarSlot(2);
    await b.lookDelta(25, 5);
    const intents = b.drainIntents();
    const compiler = new McuIntentCompiler();
    compiler.enqueueIntents(intents);

    const frames: Array<{ kind: string; pressed: string }> = [];
    while (compiler.hasPending()) {
      const step = compiler.next()!;
      const pressed = Object.entries(step.action)
        .filter(([k, v]) => k !== "camera" && v === 1)
        .map(([k]) => k)
        .join("+");
      frames.push({ kind: step.source, pressed });
    }
    expect(frames.find((f) => f.kind === "craft" && f.pressed === "inventory")).toBeDefined();
    expect(frames.find((f) => f.kind === "setHotbar" && f.pressed === "hotbar.3")).toBeDefined();
    expect(frames.filter((f) => f.kind === "look").length).toBeGreaterThanOrEqual(2);
  });

  it("ingestFrame stores the latest base64 frame for vision lookup", () => {
    const b = bot();
    expect(b.getLatestFrame()).toBeNull();
    b.ingestFrame("Zm9v");
    expect(b.getLatestFrame()).toBe("Zm9v");
  });
});
