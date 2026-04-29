import { appendJsonl, readJsonl } from "../utils/fs";
import { compactText, nowIso } from "../utils/misc";
import type { JsonValue } from "../types";

export type TranscriptEntry = {
  time: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  meta?: JsonValue;
};

export class TranscriptStore {
  constructor(private readonly filePath: string) {}

  async append(entry: Omit<TranscriptEntry, "time">): Promise<void> {
    await appendJsonl(this.filePath, {
      time: nowIso(),
      ...entry,
    });
  }

  async recent(maxEntries = 40): Promise<TranscriptEntry[]> {
    return readJsonl<TranscriptEntry>(this.filePath, maxEntries);
  }

  async countApprox(): Promise<number> {
    return (await readJsonl<TranscriptEntry>(this.filePath)).length;
  }

  async renderRecent(maxEntries = 32, maxChars = 12000): Promise<string> {
    const rendered = (await this.recent(maxEntries))
      .map((entry) => `${entry.role.toUpperCase()}: ${compactText(entry.text, 800)}`)
      .join("\n\n");
    return compactText(rendered, maxChars);
  }
}
