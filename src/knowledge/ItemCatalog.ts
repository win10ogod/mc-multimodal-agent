import minecraftData from "minecraft-data";
import { readJsonFile, writeJsonFile } from "../utils/fs";
import { compactText, nowIso } from "../utils/misc";
import type { JsonObject, JsonValue } from "../types";

export type CatalogKind = "item" | "block" | "entity" | "unknown";

export type ItemCatalogRecord = {
  name: string;
  kind: CatalogKind;
  aliases: string[];
  fields: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
};

type CatalogFile = {
  schemaVersion: 1;
  records: Record<string, ItemCatalogRecord>;
};

export type CatalogSearchResult = {
  name: string;
  kind: CatalogKind;
  source: "custom" | "runtime" | "minecraft-data";
  aliases: string[];
  fields: Record<string, JsonValue>;
};

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

function jsonFields(fields: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    out[key] = JSON.parse(JSON.stringify(value)) as JsonValue;
  }
  return out;
}

export class ItemCatalog {
  private file: CatalogFile = { schemaVersion: 1, records: {} };
  private runtimeRecords = new Map<string, CatalogSearchResult>();

  constructor(
    private readonly filePath: string,
    private readonly minecraftVersion: string | undefined,
  ) {}

  async load(): Promise<void> {
    this.file = await readJsonFile<CatalogFile>(this.filePath, {
      schemaVersion: 1,
      records: {},
    });
  }

  async save(): Promise<void> {
    await writeJsonFile(this.filePath, this.file);
  }

  async upsert(params: {
    name: string;
    kind?: CatalogKind;
    aliases?: string[];
    fields?: Record<string, unknown>;
  }): Promise<ItemCatalogRecord> {
    const key = normalizeName(params.name);
    const now = nowIso();
    const existing = this.file.records[key];
    const record: ItemCatalogRecord = {
      name: key,
      kind: params.kind ?? existing?.kind ?? this.inferKind(key),
      aliases: Array.from(new Set([...(existing?.aliases ?? []), ...(params.aliases ?? [])])),
      fields: {
        ...(existing?.fields ?? {}),
        ...jsonFields(params.fields ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.file.records[key] = record;
    await this.save();
    return record;
  }

  query(term: string, limit = 12): CatalogSearchResult[] {
    const needle = normalizeName(term);
    const rawNeedle = term.trim().toLowerCase();
    const results = new Map<string, CatalogSearchResult>();

    for (const record of Object.values(this.file.records)) {
      const haystack = [record.name, ...record.aliases, JSON.stringify(record.fields)].join(" ");
      const normalizedHaystack = normalizeName(haystack);
      const lowerHaystack = haystack.toLowerCase();
      if (normalizedHaystack.includes(needle) || lowerHaystack.includes(rawNeedle)) {
        results.set(record.name, {
          name: record.name,
          kind: record.kind,
          source: "custom",
          aliases: record.aliases,
          fields: record.fields,
        });
      }
    }

    for (const record of this.runtimeRecords.values()) {
      const haystack = [record.name, ...record.aliases, JSON.stringify(record.fields)].join(" ");
      if (results.has(record.name)) {
        continue;
      }
      if (normalizeName(haystack).includes(needle) || haystack.toLowerCase().includes(rawNeedle)) {
        results.set(record.name, record);
      }
    }

    const data = this.safeMinecraftData();
    if (data) {
      for (const item of [...Object.values(data.itemsByName), ...Object.values(data.blocksByName)]) {
        const name = String(item.name);
        if (results.has(name) || !name.includes(needle)) {
          continue;
        }
        results.set(name, {
          name,
          kind: data.blocksByName[name] ? "block" : "item",
          source: "minecraft-data",
          aliases: [],
          fields: {
            id: Number(item.id),
            displayName: String(item.displayName ?? name),
          },
        });
        if (results.size >= limit) {
          break;
        }
      }
    }

    return [...results.values()].slice(0, limit);
  }

  get(name: string): CatalogSearchResult | undefined {
    return this.query(name, 1)[0];
  }

  buildPromptSection(maxRecords = 20): string {
    const custom = Object.values(this.file.records)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, maxRecords);
    const runtime = [...this.runtimeRecords.values()].slice(0, 20);
    if (custom.length === 0 && runtime.length === 0) {
      return "No custom or runtime item/block catalog entries yet.";
    }
    const customText = custom
      .map((record) => {
        const fields = compactText(JSON.stringify(record.fields), 500);
        const aliases = record.aliases.length > 0 ? ` aliases=${record.aliases.join(",")}` : "";
        return `- ${record.name} (${record.kind}${aliases}): ${fields}`;
      })
      .join("\n");
    const runtimeText =
      runtime.length > 0
        ? [
            "Runtime registry examples from connected server/modpack:",
            ...runtime.map((record) => `- ${record.name} (${record.kind}) ${record.fields.displayName ?? ""}`),
          ].join("\n")
        : "";
    return [customText, runtimeText].filter(Boolean).join("\n");
  }

  toJson(): JsonObject {
    return this.file as unknown as JsonObject;
  }

  syncRuntimeRegistry(snapshot: {
    version: string;
    items: Array<{ name: string; id?: number; displayName?: string }>;
    blocks: Array<{ name: string; id?: number; displayName?: string }>;
  }): void {
    this.runtimeRecords.clear();
    for (const item of snapshot.items) {
      this.runtimeRecords.set(item.name, {
        name: item.name,
        kind: "item",
        source: "runtime",
        aliases: [],
        fields: {
          id: item.id ?? null,
          displayName: item.displayName ?? item.name,
          version: snapshot.version,
        },
      });
    }
    for (const block of snapshot.blocks) {
      this.runtimeRecords.set(block.name, {
        name: block.name,
        kind: "block",
        source: "runtime",
        aliases: [],
        fields: {
          id: block.id ?? null,
          displayName: block.displayName ?? block.name,
          version: snapshot.version,
        },
      });
    }
  }

  private inferKind(name: string): CatalogKind {
    const data = this.safeMinecraftData();
    if (!data) {
      return "unknown";
    }
    if (data.blocksByName[name]) {
      return "block";
    }
    if (data.itemsByName[name]) {
      return "item";
    }
    return "unknown";
  }

  private safeMinecraftData(): ReturnType<typeof minecraftData> | undefined {
    try {
      return minecraftData(this.minecraftVersion ?? "1.21.4");
    } catch {
      return undefined;
    }
  }
}
