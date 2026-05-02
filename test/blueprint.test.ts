import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as nbt from "prismarine-nbt";
import { describe, expect, it } from "vitest";
import { listBlueprints, loadBlueprint, resolveBlueprint } from "../src/blueprint/Blueprint";

function packBlockStates(indices: number[], paletteSize: number): bigint[] {
  const bits = Math.max(Math.ceil(Math.log2(paletteSize)), 2);
  const longs = Array.from({ length: Math.ceil((indices.length * bits) / 64) }, () => 0n);
  const mask = (1n << BigInt(bits)) - 1n;

  for (let index = 0; index < indices.length; index += 1) {
    const value = BigInt(indices[index] ?? 0) & mask;
    const bitOffset = index * bits;
    const longIndex = Math.floor(bitOffset / 64);
    const startBit = bitOffset % 64;
    longs[longIndex] = (longs[longIndex] ?? 0n) | (value << BigInt(startBit));
    const overflow = startBit + bits - 64;
    if (overflow > 0) {
      longs[longIndex + 1] = (longs[longIndex + 1] ?? 0n) | (value >> BigInt(bits - overflow));
    }
  }

  return longs;
}

function litematicBuffer(params: {
  name: string;
  size: { x: number; y: number; z: number };
  palette: string[];
  indices: number[];
}): Buffer {
  const longArray = packBlockStates(params.indices, params.palette.length);
  const root = nbt.comp({
    Version: nbt.int(6),
    SubVersion: nbt.int(1),
    MinecraftDataVersion: nbt.int(3955),
    Metadata: nbt.comp({
      Name: nbt.string(params.name),
      Description: nbt.string("test schematic"),
      Author: nbt.string("vitest"),
      EnclosingSize: nbt.comp({
        x: nbt.int(params.size.x),
        y: nbt.int(params.size.y),
        z: nbt.int(params.size.z),
      }),
      RegionCount: nbt.int(1),
      TotalBlocks: nbt.int(params.indices.filter((index) => index !== 0).length),
      TotalVolume: nbt.int(params.indices.length),
      TimeCreated: nbt.long(BigInt(0)),
      TimeModified: nbt.long(BigInt(0)),
    }),
    Regions: nbt.comp({
      main: nbt.comp({
        Position: nbt.comp({ x: nbt.int(0), y: nbt.int(0), z: nbt.int(0) }),
        Size: nbt.comp({
          x: nbt.int(params.size.x),
          y: nbt.int(params.size.y),
          z: nbt.int(params.size.z),
        }),
        BlockStatePalette: nbt.list(
          nbt.comp(params.palette.map((name) => ({ Name: nbt.string(name) }))),
        ),
        BlockStates: nbt.longArray(longArray as never),
        Entities: nbt.list(nbt.comp([])),
        TileEntities: nbt.list(nbt.comp([])),
        PendingBlockTicks: nbt.list(nbt.comp([])),
        PendingFluidTicks: nbt.list(nbt.comp([])),
      }),
    }),
  }, "");

  return gzipSync(nbt.writeUncompressed(root));
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mc-blueprints-"));
}

describe("Litematic blueprints", () => {
  it("loads non-air placements from a .litematic file", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "tiny.litematic");
    await fs.writeFile(
      filePath,
      litematicBuffer({
        name: "tiny",
        size: { x: 2, y: 1, z: 2 },
        palette: ["minecraft:air", "minecraft:oak_planks", "minecraft:oak_log"],
        indices: [
          1, 0,
          2, 1,
        ],
      }),
    );

    const blueprint = await loadBlueprint(filePath);

    expect(blueprint.name).toBe("tiny");
    expect(blueprint.description).toBe("test schematic");
    expect(blueprint.size).toEqual({ x: 2, y: 1, z: 2 });
    expect(blueprint.placements).toEqual([
      { block: "oak_planks", char: "1", position: { x: 0, y: 0, z: 0 } },
      { block: "oak_log", char: "2", position: { x: 0, y: 0, z: 1 } },
      { block: "oak_planks", char: "1", position: { x: 1, y: 0, z: 1 } },
    ]);
  });

  it("lists and resolves only .litematic blueprints", async () => {
    const dir = await tempDir();
    const litematicPath = path.join(dir, "tiny.litematic");
    await fs.writeFile(
      litematicPath,
      litematicBuffer({
        name: "tiny",
        size: { x: 1, y: 1, z: 1 },
        palette: ["minecraft:air", "minecraft:oak_planks"],
        indices: [1],
      }),
    );
    await fs.writeFile(path.join(dir, "legacy.json"), JSON.stringify({ name: "legacy" }), "utf8");

    await expect(listBlueprints(dir)).resolves.toEqual([
      {
        filePath: litematicPath,
        name: "tiny",
        description: "test schematic",
        size: { x: 1, y: 1, z: 1 },
        placements: 1,
      },
    ]);
    await expect(resolveBlueprint(dir, "tiny")).resolves.toMatchObject({
      filePath: litematicPath,
      blueprint: { name: "tiny" },
    });
    await expect(resolveBlueprint(dir, "legacy.json")).rejects.toThrow(/litematic/i);
  });
});
