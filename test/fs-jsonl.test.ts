import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonl } from "../src/utils/fs";

describe("readJsonl", () => {
  it("skips null-byte padded and malformed lines so corrupted logs do not stop startup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-jsonl-"));
    const file = path.join(dir, "transcript.jsonl");

    await fs.writeFile(
      file,
      [
        JSON.stringify({ role: "user", text: "first" }),
        "\u0000\u0000\u0000\u0000",
        "{\"role\":\"assistant\",\"text\":\"unterminated\"",
        JSON.stringify({ role: "assistant", text: "second" }),
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(readJsonl<{ role: string; text: string }>(file)).resolves.toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "second" },
    ]);
  });
});
