import { createHash } from "node:crypto";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseKeyValuePairs(pairs: string[]): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) {
      out[pair] = true;
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const raw = pair.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    if (raw === "true") {
      out[key] = true;
    } else if (raw === "false") {
      out[key] = false;
    } else if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
      out[key] = Number(raw);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function compactText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
