import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/MemoryStore";

const stores: MemoryStore[] = [];

async function makeStore(): Promise<MemoryStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-memory-"));
  const store = new MemoryStore(dir);
  stores.push(store);
  await store.init();
  return store;
}

afterEach(async () => {
  while (stores.length > 0) {
    await stores.pop()?.close();
  }
});

describe("MemoryStore", () => {
  it("stores and recalls layered LevelDB memories", async () => {
    const store = await makeStore();
    const note = await store.addNote({
      kind: "lesson",
      layer: "procedural",
      importance: 0.9,
      text: "In this Fabric pack, rubber logs should be cut with the tree tap workflow.",
      tags: ["fabric", "rubber"],
    });

    const results = await store.search("rubber tree tap", { limit: 4, layer: "procedural" });
    expect(results[0]?.id).toBe(note.id);
    expect(results[0]?.importance).toBe(0.9);

    const prompt = await store.buildPromptSection("How do I handle rubber logs?");
    expect(prompt).toContain("LevelDB");
    expect(prompt).toContain("rubber logs");
  });

  it("promotes useful notes into long-term memory", async () => {
    const store = await makeStore();
    const note = await store.addNote({
      text: "ZINWIN10 prefers the agent to ask before changing modded machine settings.",
      tags: ["player", "preference"],
    });

    const promoted = await store.promoteNote(note.id, "Repeatedly relevant player preference.");
    expect(promoted.layer).toBe("semantic");
    expect(promoted.tags).toContain("long_term");
    expect(promoted.importance).toBeGreaterThanOrEqual(0.85);

    const results = await store.search("machine settings preference", { tags: ["long_term"] });
    expect(results[0]?.id).toBe(note.id);
  });

  it("deduplicates compactions by context hash", async () => {
    const store = await makeStore();
    const first = await store.addCompaction("summary A", { contextHash: "abc" });
    const second = await store.addCompaction("summary B", { contextHash: "abc" });

    expect(second.id).toBe(first.id);
    expect((await store.latestCompaction())?.summary).toBe("summary A");
  });
});
