import { describe, expect, it } from "vitest";
import { buildBaseSystemPrompt } from "../src/agent/systemPrompt";

describe("system prompt", () => {
  it("tells blueprint retries to reuse the returned world anchor", () => {
    const prompt = buildBaseSystemPrompt({
      strictVisual: false,
      toolNames: ["build_blueprint", "blueprint_build_continue"],
      soul: "",
    });

    expect(prompt).toContain("reuse that exact world anchor");
    expect(prompt).toContain("position=[x,y,z]");
    expect(prompt).toContain("Prefer blueprint_build_continue");
  });
});
