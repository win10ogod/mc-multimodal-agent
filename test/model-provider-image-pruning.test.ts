import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/config";

const mocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  requestBodies: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: mocks.chatCreate,
      },
    };
  },
}));

import { ChatCompletionsModelProvider } from "../src/openai/ModelProvider";

function config(maxImagesPerPrompt: number): AgentConfig {
  return {
    openai: {
      apiKey: "test-key",
      apiMode: "chat",
      model: "test-model",
      structuredOutputs: false,
      parallelToolCalls: true,
      maxImagesPerPrompt,
      maxRetries: 0,
      retryInitialDelayMs: 100,
      qwen: {
        enabled: false,
        preserveThinking: false,
      },
    },
  } as AgentConfig;
}

function countChatImages(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let count = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    count += content.filter((part) => {
      return Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "image_url");
    }).length;
  }
  return count;
}

describe("ChatCompletionsModelProvider image pruning", () => {
  it("limits retained chat history images before each API request", async () => {
    mocks.requestBodies.length = 0;
    mocks.chatCreate.mockImplementation(async (body: Record<string, unknown>) => {
      mocks.requestBodies.push(body);
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: "ok",
            },
          },
        ],
      };
    });

    const provider = new ChatCompletionsModelProvider(config(4));
    await provider.start({
      instructions: "test instructions",
      text: "start",
      tools: [],
      imageDataUrls: ["data:image/png;base64,start1", "data:image/png;base64,start2", "data:image/png;base64,start3"],
    });
    await provider.continue({
      instructions: "test instructions",
      tools: [],
      toolOutputs: [
        {
          callId: "call_1",
          name: "observe",
          result: {
            ok: true,
            text: "first observation",
            content: [{ type: "image", dataUrl: "data:image/png;base64:tool1", detail: "low" }],
          },
        },
        {
          callId: "call_2",
          name: "observe",
          result: {
            ok: true,
            text: "second observation",
            content: [{ type: "image", dataUrl: "data:image/png;base64:tool2", detail: "low" }],
          },
        },
      ],
    });

    expect(countChatImages(mocks.requestBodies.at(-1)?.messages)).toBeLessThanOrEqual(4);
  });
});
