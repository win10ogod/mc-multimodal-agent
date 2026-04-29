import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ItemCatalog } from "../src/knowledge/ItemCatalog";

describe("ItemCatalog", () => {
  it("merges arbitrary dynamic fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-catalog-"));
    const catalog = new ItemCatalog(path.join(dir, "catalog.json"), "1.21.4");
    await catalog.load();

    await catalog.upsert({
      name: "oak planks",
      fields: { visual: "tan", structural: true },
    });
    await catalog.upsert({
      name: "oak_planks",
      aliases: ["wood board"],
      fields: { placeHint: "walls" },
    });

    const result = catalog.query("wood board", 1)[0];
    expect(result?.name).toBe("oak_planks");
    expect(result?.fields).toMatchObject({
      visual: "tan",
      structural: true,
      placeHint: "walls",
    });
  });
});
