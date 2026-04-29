import path from "node:path";
import { Level } from "level";
import type { JsonObject } from "../types";
import { ensureDir, readJsonl } from "../utils/fs";
import { compactText, digest, nowIso } from "../utils/misc";

export type MemoryKind = "fact" | "lesson" | "failure" | "goal" | "environment";
export type MemoryLayer = "episodic" | "semantic" | "procedural" | "working";
export type MemorySource = "agent" | "player" | "system" | "flush" | "migration";

export type MemoryNote = {
  id: string;
  time: string;
  day: string;
  kind: MemoryKind;
  layer: MemoryLayer;
  source: MemorySource;
  importance: number;
  text: string;
  tags: string[];
  scope?: JsonObject;
  contentHash: string;
  updatedAt?: string;
};

export type CompactionSummary = {
  id: string;
  time: string;
  summary: string;
  contextHash?: string;
};

export type MemorySearchOptions = {
  limit?: number;
  kind?: MemoryKind;
  layer?: MemoryLayer;
  tags?: string[];
  includeRecentFallback?: boolean;
};

export type MemoryStatus = {
  backend: "leveldb";
  dbPath: string;
  notes: number;
  compactions: number;
  latestCompaction?: string;
};

const JSONL_MIGRATION_KEY = "meta!jsonl_migrated_v2";
const DEFAULT_RECALL_LIMIT = 8;

function isNotFound(error: unknown): boolean {
  const err = error as { code?: string; notFound?: boolean };
  return err?.code === "LEVEL_NOT_FOUND" || err?.notFound === true;
}

function dayFromIso(value: string): string {
  return value.slice(0, 10);
}

function keyPart(value: string): string {
  return encodeURIComponent(value.trim().toLowerCase());
}

function prefixEnd(prefix: string): string {
  return `${prefix}\xff`;
}

function isCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function memoryTerms(value: string): string[] {
  const terms = new Set<string>();
  for (const match of value.toLowerCase().matchAll(/[\p{L}\p{N}_:.-]+/gu)) {
    const token = match[0]?.trim();
    if (!token) {
      continue;
    }
    if (token.length >= 2 || isCjk(token)) {
      terms.add(token);
    }
  }
  return [...terms];
}

function clampImportance(value: unknown, fallback = 0.5): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function normalizeTags(value: string[] | undefined): string[] {
  return Array.from(
    new Set((value ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
  ).slice(0, 32);
}

function normalizeLayer(value: unknown, fallback: MemoryLayer): MemoryLayer {
  return value === "working" || value === "semantic" || value === "procedural" || value === "episodic"
    ? value
    : fallback;
}

function normalizeSource(value: unknown, fallback: MemorySource): MemorySource {
  return value === "agent" || value === "player" || value === "system" || value === "flush" || value === "migration"
    ? value
    : fallback;
}

function normalizeKind(value: unknown, fallback: MemoryKind): MemoryKind {
  return value === "fact" || value === "lesson" || value === "failure" || value === "goal" || value === "environment"
    ? value
    : fallback;
}

function makeContentHash(params: {
  kind: MemoryKind;
  layer: MemoryLayer;
  text: string;
  tags: string[];
  scope?: JsonObject;
}): string {
  return digest({
    kind: params.kind,
    layer: params.layer,
    text: params.text.trim(),
    tags: params.tags,
    scope: params.scope ?? {},
  }).slice(0, 24);
}

function scoreNote(note: MemoryNote, terms: string[], query: string): number {
  const haystack = `${note.kind} ${note.layer} ${note.tags.join(" ")} ${note.text}`.toLowerCase();
  const termScore = terms.reduce((sum, term) => {
    if (!haystack.includes(term)) {
      return sum;
    }
    const exactTagBonus = note.tags.includes(term) ? 3 : 0;
    return sum + 8 + exactTagBonus;
  }, 0);
  const exactPhraseScore = query.trim() && haystack.includes(query.toLowerCase().trim()) ? 12 : 0;
  const ageMs = Math.max(0, Date.now() - Date.parse(note.time));
  const recencyScore = Math.max(0, 3 - ageMs / (1000 * 60 * 60 * 24 * 14));
  const layerScore = note.layer === "semantic" || note.layer === "procedural" ? 2 : 0;
  return termScore + exactPhraseScore + note.importance * 6 + recencyScore + layerScore;
}

export class MemoryStore {
  private readonly dbPath: string;
  private readonly notesJsonlPath: string;
  private readonly compactionsJsonlPath: string;
  private readonly db: Level<string, unknown>;
  private lane: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.dbPath = path.join(dir, "leveldb");
    this.notesJsonlPath = path.join(dir, "notes.jsonl");
    this.compactionsJsonlPath = path.join(dir, "compactions.jsonl");
    this.db = new Level<string, unknown>(this.dbPath, { valueEncoding: "json" });
  }

  async init(): Promise<void> {
    await ensureDir(this.dir);
    await this.db.open();
    await this.migrateJsonlOnce();
  }

  async close(): Promise<void> {
    await this.lane;
    await this.db.close();
  }

  async addNote(params: {
    kind?: MemoryKind;
    layer?: MemoryLayer;
    source?: MemorySource;
    importance?: number;
    text: string;
    tags?: string[];
    scope?: JsonObject;
  }): Promise<MemoryNote> {
    return this.exclusive(async () => {
      const text = params.text.trim();
      if (!text) {
        throw new Error("Memory note text must not be empty.");
      }
      const now = nowIso();
      const kind = params.kind ?? "fact";
      const layer = params.layer ?? (kind === "goal" ? "working" : "episodic");
      const tags = normalizeTags(params.tags);
      const contentHash = makeContentHash({ kind, layer, text, tags, scope: params.scope });
      const existingId = await this.get<string>(`hash!${contentHash}`);
      if (existingId) {
        const existing = await this.get<MemoryNote>(`note!${existingId}`);
        if (existing) {
          return existing;
        }
      }
      const note: MemoryNote = {
        id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        time: now,
        day: dayFromIso(now),
        kind,
        layer,
        source: params.source ?? "agent",
        importance: clampImportance(params.importance),
        text,
        tags,
        scope: params.scope,
        contentHash,
      };
      await this.putIndexedNote(note);
      return note;
    });
  }

  async promoteNote(id: string, reason?: string): Promise<MemoryNote> {
    return this.exclusive(async () => {
      const note = await this.get<MemoryNote>(`note!${id}`);
      if (!note) {
        throw new Error(`Unknown memory note: ${id}`);
      }
      const promoted: MemoryNote = {
        ...note,
        layer: note.layer === "procedural" ? "procedural" : "semantic",
        importance: Math.max(note.importance, 0.85),
        tags: normalizeTags([...note.tags, "long_term", "promoted"]),
        updatedAt: nowIso(),
      };
      await this.putIndexedNote(promoted);
      if (reason?.trim()) {
        const now = nowIso();
        const text = `Promoted memory ${id}: ${reason.trim()}`;
        const tags = ["memory", "promotion"];
        await this.putIndexedNote({
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          time: now,
          day: dayFromIso(now),
          kind: "lesson",
          layer: "semantic",
          source: "system",
          importance: 0.65,
          text,
          tags,
          contentHash: makeContentHash({ kind: "lesson", layer: "semantic", text, tags }),
        });
      }
      return promoted;
    });
  }

  async getNote(id: string): Promise<MemoryNote | undefined> {
    return this.get<MemoryNote>(`note!${id.trim()}`);
  }

  async addCompaction(summary: string, meta?: { contextHash?: string }): Promise<CompactionSummary> {
    return this.exclusive(async () => {
      const trimmed = summary.trim();
      if (!trimmed) {
        throw new Error("Compaction summary must not be empty.");
      }
      if (meta?.contextHash) {
        const existingId = await this.get<string>(`compaction_hash!${meta.contextHash}`);
        if (existingId) {
          const existing = await this.get<CompactionSummary>(`compaction!${existingId}`);
          if (existing) {
            return existing;
          }
        }
      }
      const entry: CompactionSummary = {
        id: `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        time: nowIso(),
        summary: trimmed,
        contextHash: meta?.contextHash,
      };
      await this.db.put(`compaction!${entry.id}`, entry);
      await this.db.put(`compaction_by_time!${entry.time}!${entry.id}`, entry.id);
      if (entry.contextHash) {
        await this.db.put(`compaction_hash!${entry.contextHash}`, entry.id);
      }
      return entry;
    });
  }

  async latestCompaction(): Promise<CompactionSummary | undefined> {
    for await (const [, value] of this.db.iterator({
      gte: "compaction_by_time!",
      lt: prefixEnd("compaction_by_time!"),
      reverse: true,
      limit: 1,
    })) {
      if (typeof value === "string") {
        return this.get<CompactionSummary>(`compaction!${value}`);
      }
    }
    return undefined;
  }

  async search(query: string, limitOrOptions: number | MemorySearchOptions = DEFAULT_RECALL_LIMIT): Promise<MemoryNote[]> {
    const options: MemorySearchOptions =
      typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? DEFAULT_RECALL_LIMIT)));
    const terms = memoryTerms(query).slice(0, 24);
    if (terms.length === 0) {
      return this.recentNotes(limit, options);
    }

    const candidateIds = new Map<string, number>();
    for (const term of terms) {
      let seenForTerm = 0;
      for await (const [, value] of this.db.iterator({
        gte: `term!${keyPart(term)}!`,
        lt: prefixEnd(`term!${keyPart(term)}!`),
        reverse: true,
        limit: 128,
      })) {
        if (typeof value !== "string") {
          continue;
        }
        candidateIds.set(value, (candidateIds.get(value) ?? 0) + 1);
        seenForTerm += 1;
        if (seenForTerm >= 128) {
          break;
        }
      }
    }

    if (options.includeRecentFallback !== false) {
      for (const note of await this.recentNotes(64, options)) {
        candidateIds.set(note.id, candidateIds.get(note.id) ?? 0);
      }
    }

    const candidates: Array<{ note: MemoryNote; score: number }> = [];
    for (const [id, indexHits] of candidateIds.entries()) {
      const note = await this.get<MemoryNote>(`note!${id}`);
      if (!note || !this.matchesFilters(note, options)) {
        continue;
      }
      candidates.push({ note, score: scoreNote(note, terms, query) + indexHits * 3 });
    }

    return candidates
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.note.time.localeCompare(a.note.time))
      .slice(0, limit)
      .map((entry) => entry.note);
  }

  async recentNotes(limit = 16, options: MemorySearchOptions = {}): Promise<MemoryNote[]> {
    const notes: MemoryNote[] = [];
    for await (const [, value] of this.db.iterator({
      gte: "note_by_time!",
      lt: prefixEnd("note_by_time!"),
      reverse: true,
      limit: Math.max(limit * 4, limit),
    })) {
      if (typeof value !== "string") {
        continue;
      }
      const note = await this.get<MemoryNote>(`note!${value}`);
      if (!note || !this.matchesFilters(note, options)) {
        continue;
      }
      notes.push(note);
      if (notes.length >= limit) {
        break;
      }
    }
    return notes;
  }

  async status(): Promise<MemoryStatus> {
    let notes = 0;
    let compactions = 0;
    for await (const _ of this.db.iterator({ gte: "note!", lt: prefixEnd("note!") })) {
      notes += 1;
    }
    for await (const _ of this.db.iterator({ gte: "compaction!", lt: prefixEnd("compaction!") })) {
      compactions += 1;
    }
    const latest = await this.latestCompaction();
    return {
      backend: "leveldb",
      dbPath: this.dbPath,
      notes,
      compactions,
      latestCompaction: latest?.time,
    };
  }

  async buildPromptSection(focus = ""): Promise<string> {
    const latestCompaction = await this.latestCompaction();
    const relevant = focus.trim() ? await this.search(focus, { limit: 8 }) : [];
    const recent = await this.recentNotes(8);
    const seen = new Set<string>();
    const renderNote = (note: MemoryNote): string => {
      seen.add(note.id);
      const tags = note.tags.length > 0 ? ` tags=${note.tags.join(",")}` : "";
      return `- ${note.id} [${note.layer}/${note.kind} importance=${note.importance.toFixed(2)}${tags}] ${compactText(note.text, 260)}`;
    };
    const parts: string[] = [
      "Memory backend: LevelDB layered long-term store.",
      "Use memory_query for deeper recall and memory_note for durable facts/lessons/failures/goals.",
    ];
    if (latestCompaction?.summary) {
      parts.push("Latest compacted working summary:");
      parts.push(compactText(latestCompaction.summary, 1400));
    }
    if (relevant.length > 0) {
      parts.push("Relevant recalled memories:");
      parts.push(relevant.map(renderNote).join("\n"));
    }
    const freshRecent = recent.filter((note) => !seen.has(note.id));
    if (freshRecent.length > 0) {
      parts.push("Recent memories:");
      parts.push(freshRecent.map(renderNote).join("\n"));
    }
    return parts.join("\n").trim();
  }

  private async migrateJsonlOnce(): Promise<void> {
    if (await this.get<boolean>(JSONL_MIGRATION_KEY)) {
      return;
    }
    await this.exclusive(async () => {
      if (await this.get<boolean>(JSONL_MIGRATION_KEY)) {
        return;
      }
      const oldNotes = await readJsonl<Partial<MemoryNote>>(this.notesJsonlPath);
      for (const old of oldNotes) {
        const text = typeof old.text === "string" ? old.text.trim() : "";
        if (!text) {
          continue;
        }
        const time = typeof old.time === "string" ? old.time : nowIso();
        const kind = normalizeKind(old.kind, "fact");
        const layer = normalizeLayer(old.layer, kind === "goal" ? "working" : "episodic");
        const tags = normalizeTags(old.tags);
        await this.putIndexedNote({
          id: typeof old.id === "string" && old.id ? old.id : `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          time,
          day: dayFromIso(time),
          kind,
          layer,
          source: normalizeSource(old.source, "migration"),
          importance: clampImportance(old.importance),
          text,
          tags,
          scope: old.scope,
          contentHash: old.contentHash ?? makeContentHash({ kind, layer, text, tags, scope: old.scope }),
          updatedAt: old.updatedAt,
        });
      }

      const oldCompactions = await readJsonl<Partial<CompactionSummary>>(this.compactionsJsonlPath);
      for (const old of oldCompactions) {
        const summary = typeof old.summary === "string" ? old.summary.trim() : "";
        if (!summary) {
          continue;
        }
        const entry: CompactionSummary = {
          id: typeof old.id === "string" && old.id ? old.id : `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          time: typeof old.time === "string" ? old.time : nowIso(),
          summary,
          contextHash: old.contextHash,
        };
        await this.db.put(`compaction!${entry.id}`, entry);
        await this.db.put(`compaction_by_time!${entry.time}!${entry.id}`, entry.id);
        if (entry.contextHash) {
          await this.db.put(`compaction_hash!${entry.contextHash}`, entry.id);
        }
      }
      await this.db.put(JSONL_MIGRATION_KEY, true);
    });
  }

  private async putIndexedNote(note: MemoryNote): Promise<void> {
    await this.db.put(`note!${note.id}`, note);
    await this.db.put(`note_by_time!${note.time}!${note.id}`, note.id);
    await this.db.put(`day!${note.day}!${note.time}!${note.id}`, note.id);
    await this.db.put(`kind!${keyPart(note.kind)}!${note.time}!${note.id}`, note.id);
    await this.db.put(`layer!${keyPart(note.layer)}!${note.time}!${note.id}`, note.id);
    await this.db.put(`hash!${note.contentHash}`, note.id);
    for (const tag of note.tags) {
      await this.db.put(`tag!${keyPart(tag)}!${note.time}!${note.id}`, note.id);
    }
    for (const term of this.indexTerms(note).slice(0, 160)) {
      await this.db.put(`term!${keyPart(term)}!${note.time}!${note.id}`, note.id);
    }
  }

  private indexTerms(note: MemoryNote): string[] {
    return Array.from(
      new Set([
        ...memoryTerms(note.kind),
        ...memoryTerms(note.layer),
        ...note.tags.flatMap(memoryTerms),
        ...memoryTerms(note.text),
      ]),
    );
  }

  private matchesFilters(note: MemoryNote, options: MemorySearchOptions): boolean {
    if (options.kind && note.kind !== options.kind) {
      return false;
    }
    if (options.layer && note.layer !== options.layer) {
      return false;
    }
    const requiredTags = normalizeTags(options.tags);
    return requiredTags.every((tag) => note.tags.includes(tag));
  }

  private async get<T>(key: string): Promise<T | undefined> {
    try {
      return (await this.db.get(key)) as T;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lane.then(fn, fn);
    this.lane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
