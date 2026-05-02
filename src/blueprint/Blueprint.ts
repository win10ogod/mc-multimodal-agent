import fs from "node:fs/promises";
import path from "node:path";
import * as nbt from "prismarine-nbt";
import type { Vec3Like } from "../types";
import { pathExists } from "../utils/fs";

export type BlueprintPlacement = {
  block: string;
  position: Vec3Like;
  char: string;
};

export type ExpandedBlueprint = {
  name: string;
  description?: string;
  size: Vec3Like;
  placements: BlueprintPlacement[];
};

type LitematicRoot = {
  Metadata?: {
    Name?: unknown;
    Description?: unknown;
    EnclosingSize?: Partial<Vec3Like>;
  };
  Regions?: Record<string, unknown>;
};

type LitematicRegion = {
  Position?: Partial<Vec3Like>;
  Size?: Partial<Vec3Like>;
  BlockStatePalette?: Array<{ Name?: unknown }>;
  BlockStates?: unknown[];
};

const LITEMATIC_EXTENSION = ".litematic";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Invalid litematic ${label}: expected integer.`);
  }
  return value;
}

function vecFromObject(value: unknown, label: string): Vec3Like {
  if (!isObject(value)) {
    throw new Error(`Invalid litematic ${label}: expected object.`);
  }
  return {
    x: requiredInt(value.x, `${label}.x`),
    y: requiredInt(value.y, `${label}.y`),
    z: requiredInt(value.z, `${label}.z`),
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeBlockName(name: string): string {
  return name.startsWith("minecraft:") ? name.slice("minecraft:".length) : name;
}

function isAirBlock(name: string): boolean {
  const normalized = normalizeBlockName(name);
  return normalized === "air" || normalized === "cave_air" || normalized === "void_air";
}

function longToUnsigned(value: unknown): bigint {
  if (typeof value === "bigint") {
    return BigInt.asUintN(64, value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt.asUintN(64, BigInt(Math.trunc(value)));
  }
  if (Array.isArray(value)) {
    const high = Number(value[0] ?? 0);
    const low = Number(value[1] ?? 0);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      return BigInt.asUintN(64, (BigInt(Math.trunc(high)) << 32n) | BigInt(low >>> 0));
    }
  }
  throw new Error("Invalid litematic BlockStates entry: expected 64-bit long.");
}

function paletteIndexAt(words: bigint[], index: number, bits: number): number {
  const startOffset = index * bits;
  const startWord = Math.floor(startOffset / 64);
  const endWord = Math.floor(((index + 1) * bits - 1) / 64);
  const startBit = startOffset % 64;
  const mask = (1n << BigInt(bits)) - 1n;

  if (startWord >= words.length) {
    return 0;
  }
  if (startWord === endWord) {
    return Number((words[startWord] >> BigInt(startBit)) & mask);
  }
  const first = words[startWord] >> BigInt(startBit);
  const second = (words[endWord] ?? 0n) << BigInt(64 - startBit);
  return Number((first | second) & mask);
}

function normalizeRegionCoordinate(index: number, size: number): number {
  return size < 0 ? index + size + 1 : index;
}

function litematicFiles(dir: string): Promise<string[]> {
  return fs
    .readdir(dir, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(LITEMATIC_EXTENSION))
        .map((entry) => path.join(dir, entry.name))
        .sort(),
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
}

function assertLitematicPath(filePath: string): void {
  if (path.extname(filePath).toLowerCase() !== LITEMATIC_EXTENSION) {
    throw new Error(`Only .litematic blueprint files are supported: ${filePath}`);
  }
}

function expandRegion(regionName: string, value: unknown): BlueprintPlacement[] {
  if (!isObject(value)) {
    throw new Error(`Invalid litematic region ${regionName}: expected object.`);
  }
  const region = value as LitematicRegion;
  const position = vecFromObject(region.Position, `region ${regionName}.Position`);
  const size = vecFromObject(region.Size, `region ${regionName}.Size`);
  const width = Math.abs(size.x);
  const height = Math.abs(size.y);
  const length = Math.abs(size.z);
  if (width === 0 || height === 0 || length === 0) {
    throw new Error(`Invalid litematic region ${regionName}: dimensions cannot be zero.`);
  }
  const palette = Array.isArray(region.BlockStatePalette) ? region.BlockStatePalette : [];
  if (palette.length === 0) {
    throw new Error(`Invalid litematic region ${regionName}: missing BlockStatePalette.`);
  }

  const bits = Math.max(Math.ceil(Math.log2(palette.length)), 2);
  const volume = width * height * length;
  const words = (Array.isArray(region.BlockStates) ? region.BlockStates : []).map(longToUnsigned);
  const placements: BlueprintPlacement[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let z = 0; z < length; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width * length + z * width + x;
        if (index >= volume) {
          continue;
        }
        const paletteIndex = paletteIndexAt(words, index, bits);
        const state = palette[paletteIndex];
        const blockName = typeof state?.Name === "string" ? state.Name : "";
        if (!blockName || isAirBlock(blockName)) {
          continue;
        }
        placements.push({
          block: normalizeBlockName(blockName),
          char: String(paletteIndex),
          position: {
            x: position.x + normalizeRegionCoordinate(x, size.x),
            y: position.y + normalizeRegionCoordinate(y, size.y),
            z: position.z + normalizeRegionCoordinate(z, size.z),
          },
        });
      }
    }
  }

  return placements;
}

function sizeFromMetadataOrPlacements(root: LitematicRoot, placements: BlueprintPlacement[]): Vec3Like {
  const size = root.Metadata?.EnclosingSize;
  if (
    size &&
    typeof size.x === "number" &&
    typeof size.y === "number" &&
    typeof size.z === "number"
  ) {
    return { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) };
  }
  if (placements.length === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  const xs = placements.map((placement) => placement.position.x);
  const ys = placements.map((placement) => placement.position.y);
  const zs = placements.map((placement) => placement.position.z);
  return {
    x: Math.max(...xs) - Math.min(...xs) + 1,
    y: Math.max(...ys) - Math.min(...ys) + 1,
    z: Math.max(...zs) - Math.min(...zs) + 1,
  };
}

export async function loadBlueprint(filePath: string): Promise<ExpandedBlueprint> {
  assertLitematicPath(filePath);
  const { parsed } = await nbt.parse(await fs.readFile(filePath));
  const root = nbt.simplify(parsed) as LitematicRoot;
  if (!isObject(root.Regions)) {
    throw new Error(`Invalid litematic blueprint ${filePath}: missing Regions.`);
  }
  const placements = Object.entries(root.Regions).flatMap(([name, region]) => expandRegion(name, region));
  return {
    name: stringOrUndefined(root.Metadata?.Name) ?? path.basename(filePath, LITEMATIC_EXTENSION),
    description: stringOrUndefined(root.Metadata?.Description),
    size: sizeFromMetadataOrPlacements(root, placements),
    placements,
  };
}

export async function resolveBlueprint(
  blueprintsDir: string,
  nameOrPath: string,
): Promise<{ filePath: string; blueprint: ExpandedBlueprint }> {
  const requested = nameOrPath.trim();
  const direct = path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested);
  const candidates = [
    direct,
    path.resolve(blueprintsDir, requested),
    requested.toLowerCase().endsWith(LITEMATIC_EXTENSION)
      ? path.resolve(blueprintsDir, requested)
      : path.resolve(blueprintsDir, `${requested}${LITEMATIC_EXTENSION}`),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await pathExists(candidate)) {
      assertLitematicPath(candidate);
      return {
        filePath: candidate,
        blueprint: await loadBlueprint(candidate),
      };
    }
  }
  if (requested.toLowerCase().endsWith(".json")) {
    throw new Error(`JSON blueprints are not supported. Use a .litematic file: ${requested}`);
  }
  throw new Error(`Litematic blueprint not found: ${nameOrPath}`);
}

export async function listBlueprints(blueprintsDir: string): Promise<
  Array<{ filePath: string; name: string; description?: string; size: Vec3Like; placements: number }>
> {
  const files = await litematicFiles(blueprintsDir);
  const out = [];
  for (const filePath of files) {
    const blueprint = await loadBlueprint(filePath);
    out.push({
      filePath,
      name: blueprint.name,
      description: blueprint.description,
      size: blueprint.size,
      placements: blueprint.placements.length,
    });
  }
  return out;
}
