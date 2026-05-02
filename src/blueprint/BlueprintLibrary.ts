import fs from "node:fs/promises";
import path from "node:path";
import { loadBlueprint } from "./Blueprint";
import type { Vec3Like } from "../types";
import { ensureDir, pathExists } from "../utils/fs";

export type BlueprintLibraryEntry = {
  filePath: string;
  name: string;
  description?: string;
  size: Vec3Like;
  placements: number;
};

export type ImportBlueprintOptions = {
  name: string;
  destinationDir: string;
  sourceDir?: string;
  overwrite?: boolean;
};

export function defaultBlueprintLibraryDir(): string {
  return path.resolve(process.cwd(), "data", "blueprint-library");
}

function safeFileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function listBlueprintLibrary(sourceDir = defaultBlueprintLibraryDir()): Promise<BlueprintLibraryEntry[]> {
  const files = await fs
    .readdir(sourceDir, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".litematic"))
        .map((entry) => path.join(sourceDir, entry.name))
        .sort(),
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const entries: BlueprintLibraryEntry[] = [];
  for (const filePath of files) {
    const blueprint = await loadBlueprint(filePath);
    entries.push({
      filePath,
      name: blueprint.name,
      description: blueprint.description,
      size: blueprint.size,
      placements: blueprint.placements.length,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function importBlueprintFromLibrary(options: ImportBlueprintOptions): Promise<BlueprintLibraryEntry> {
  const sourceDir = options.sourceDir ?? defaultBlueprintLibraryDir();
  const entries = await listBlueprintLibrary(sourceDir);
  const requested = options.name.trim();
  const requestedBase = safeFileName(requested.replace(/\.litematic$/i, ""));
  const selected = entries.find((entry) => {
    const entryBase = safeFileName(path.basename(entry.filePath, ".litematic"));
    return entry.name === requested || entryBase === requestedBase || safeFileName(entry.name) === requestedBase;
  });
  if (!selected) {
    throw new Error(`Blueprint library entry not found: ${options.name}`);
  }

  const destinationName = `${safeFileName(selected.name) || path.basename(selected.filePath, ".litematic")}.litematic`;
  const destinationPath = path.resolve(options.destinationDir, destinationName);
  if (!options.overwrite && await pathExists(destinationPath)) {
    throw new Error(`Blueprint already exists: ${destinationPath}`);
  }
  await ensureDir(options.destinationDir);
  await fs.copyFile(selected.filePath, destinationPath);
  return {
    ...selected,
    filePath: destinationPath,
  };
}
