import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as nbt from "prismarine-nbt";
import { afterEach, describe, expect, it } from "vitest";
import { importBlueprintFromLibrary, listBlueprintLibrary } from "../src/blueprint/BlueprintLibrary";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-blueprint-library-"));
  tempDirs.push(dir);
  return dir;
}

function singleBlockLitematic(name: string): Buffer {
  const root = nbt.comp({
    Version: nbt.int(6),
    SubVersion: nbt.int(1),
    MinecraftDataVersion: nbt.int(3955),
    Metadata: nbt.comp({
      Name: nbt.string(name),
      Description: nbt.string("library test"),
      Author: nbt.string("vitest"),
      EnclosingSize: nbt.comp({ x: nbt.int(1), y: nbt.int(1), z: nbt.int(1) }),
      RegionCount: nbt.int(1),
      TotalBlocks: nbt.int(1),
      TotalVolume: nbt.int(1),
      TimeCreated: nbt.long(BigInt(0)),
      TimeModified: nbt.long(BigInt(0)),
    }),
    Regions: nbt.comp({
      main: nbt.comp({
        Position: nbt.comp({ x: nbt.int(0), y: nbt.int(0), z: nbt.int(0) }),
        Size: nbt.comp({ x: nbt.int(1), y: nbt.int(1), z: nbt.int(1) }),
        BlockStatePalette: nbt.list(
          nbt.comp([
            { Name: nbt.string("minecraft:air") },
            { Name: nbt.string("minecraft:oak_planks") },
          ]),
        ),
        BlockStates: nbt.longArray([1n] as never),
        Entities: nbt.list(nbt.comp([])),
        TileEntities: nbt.list(nbt.comp([])),
        PendingBlockTicks: nbt.list(nbt.comp([])),
        PendingFluidTicks: nbt.list(nbt.comp([])),
      }),
    }),
  }, "");

  return gzipSync(nbt.writeUncompressed(root));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("BlueprintLibrary", () => {
  it("lists only bundled .litematic starter blueprints", async () => {
    const entries = await listBlueprintLibrary();

    expect(entries.some((entry) => entry.name === "wooden-watchtower")).toBe(true);
    expect(entries.some((entry) => entry.name === "wooden-castle-keep")).toBe(true);
    expect(entries.every((entry) => entry.filePath.endsWith(".litematic"))).toBe(true);
  });

  it("imports a .litematic blueprint into the local blueprints directory and ignores JSON files", async () => {
    const sourceDir = await tempDir();
    const destinationDir = await tempDir();
    await fs.writeFile(path.join(sourceDir, "library-watchtower.litematic"), singleBlockLitematic("library-watchtower"));
    await fs.writeFile(path.join(sourceDir, "legacy.json"), JSON.stringify({ name: "legacy" }), "utf8");

    const imported = await importBlueprintFromLibrary({
      name: "library-watchtower",
      destinationDir,
      sourceDir,
    });

    expect(imported.name).toBe("library-watchtower");
    expect(imported.filePath).toBe(path.join(destinationDir, "library-watchtower.litematic"));
    await expect(fs.stat(imported.filePath)).resolves.toBeTruthy();
    await expect(importBlueprintFromLibrary({ name: "legacy", destinationDir, sourceDir })).rejects.toThrow(
      /not found/i,
    );
  });
});
