import path from "node:path";
import { listJsonFiles, pathExists, readJsonFile } from "../utils/fs";
import type { Vec3Like } from "../types";

export type BlueprintFile = {
  name: string;
  description?: string;
  palette: Record<string, string>;
  layers: string[][];
};

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

function assertBlueprint(value: BlueprintFile): void {
  if (!value || typeof value !== "object") {
    throw new Error("Blueprint must be a JSON object.");
  }
  if (!value.name?.trim()) {
    throw new Error("Blueprint requires a non-empty name.");
  }
  if (!value.palette || typeof value.palette !== "object") {
    throw new Error("Blueprint requires a palette object.");
  }
  if (!Array.isArray(value.layers) || value.layers.length === 0) {
    throw new Error("Blueprint requires non-empty layers.");
  }
  for (const [y, layer] of value.layers.entries()) {
    if (!Array.isArray(layer) || layer.length === 0) {
      throw new Error(`Blueprint layer ${y} must be a non-empty string array.`);
    }
    for (const row of layer) {
      if (typeof row !== "string") {
        throw new Error(`Blueprint layer ${y} contains a non-string row.`);
      }
    }
  }
}

export function expandBlueprint(blueprint: BlueprintFile): ExpandedBlueprint {
  assertBlueprint(blueprint);
  const maxZ = Math.max(...blueprint.layers.map((layer) => layer.length));
  const maxX = Math.max(
    ...blueprint.layers.flatMap((layer) => layer.map((row) => row.length)),
  );
  const placements: BlueprintPlacement[] = [];

  for (let y = 0; y < blueprint.layers.length; y += 1) {
    const layer = blueprint.layers[y] ?? [];
    for (let z = 0; z < layer.length; z += 1) {
      const row = layer[z] ?? "";
      for (let x = 0; x < row.length; x += 1) {
        const char = row[x] ?? " ";
        if (char === " " || char === ".") {
          continue;
        }
        const block = blueprint.palette[char];
        if (!block) {
          throw new Error(`Blueprint ${blueprint.name} uses unmapped palette char "${char}".`);
        }
        placements.push({
          block,
          char,
          position: { x, y, z },
        });
      }
    }
  }

  return {
    name: blueprint.name,
    description: blueprint.description,
    size: { x: maxX, y: blueprint.layers.length, z: maxZ },
    placements,
  };
}

export async function loadBlueprint(filePath: string): Promise<ExpandedBlueprint> {
  const raw = await readJsonFile<BlueprintFile>(filePath, {
    name: "",
    palette: {},
    layers: [],
  });
  return expandBlueprint(raw);
}

export async function resolveBlueprint(
  blueprintsDir: string,
  nameOrPath: string,
): Promise<{ filePath: string; blueprint: ExpandedBlueprint }> {
  const direct = path.isAbsolute(nameOrPath)
    ? nameOrPath
    : path.resolve(process.cwd(), nameOrPath);
  const candidates = [
    direct,
    path.resolve(blueprintsDir, nameOrPath),
    path.resolve(blueprintsDir, `${nameOrPath}.json`),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return {
        filePath: candidate,
        blueprint: await loadBlueprint(candidate),
      };
    }
  }
  throw new Error(`Blueprint not found: ${nameOrPath}`);
}

export async function listBlueprints(blueprintsDir: string): Promise<
  Array<{ filePath: string; name: string; description?: string; size: Vec3Like; placements: number }>
> {
  const files = await listJsonFiles(blueprintsDir);
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
