import { describe, expect, it } from "vitest";
import {
  buildQwenExtraBody,
  parseSkillDraft,
  parseStructuredAgentTurn,
  parseTextToolCalls,
  stripReasoningMarkup,
} from "../src/openai/ModelProvider";
import type { AgentConfig } from "../src/config";

describe("model provider text tool parsing", () => {
  it("preserves output after simple thought channel markup", () => {
    const output = stripReasoningMarkup(
      [
        "<|channel>thought",
        "I should follow the player.",
        "<channel|>",
        '{"tool":"follow_player","arguments":{"username":"ZINWIN10","range":3}}',
      ].join("\n"),
    );

    expect(output).toBe('{"tool":"follow_player","arguments":{"username":"ZINWIN10","range":3}}');
  });

  it("removes Nemotron/Qwen think blocks before parsing", () => {
    const output = stripReasoningMarkup(
      [
        "<think>",
        "Internal reasoning that should not reach the parser.",
        "</think>",
        '{"tool":"observe","arguments":{}}',
      ].join("\n"),
    );

    expect(output).toBe('{"tool":"observe","arguments":{}}');
  });

  it("turns JSON tool output into provider tool calls", () => {
    const calls = parseTextToolCalls(
      [
        "<|channel>thought",
        "Use the follow_player tool.",
        "<channel|>",
        '{"tool":"follow_player","arguments":{"username":"ZINWIN10","range":3}}',
      ].join("\n"),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: "text_call_1",
      name: "follow_player",
      arguments: '{"username":"ZINWIN10","range":3}',
    });
  });

  it("supports OpenAI-style JSON tool_calls in text", () => {
    const calls = parseTextToolCalls(
      JSON.stringify({
        tool_calls: [
          {
            type: "function",
            function: {
              name: "observe",
              arguments: {},
            },
          },
        ],
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "observe",
      arguments: "{}",
    });
  });

  it("parses structured output tool calls after thought markup", () => {
    const turn = parseStructuredAgentTurn(
      [
        "<|channel>thought",
        "The player asked me to follow them.",
        "<channel|>",
        JSON.stringify({
          action: "tool_call",
          tool_name: "follow_player",
          arguments_json: "{\"username\":\"ZINWIN10\",\"range\":3}",
          final_text: "",
        }),
      ].join("\n"),
    );

    expect(turn?.toolCalls).toHaveLength(1);
    expect(turn?.toolCalls[0]).toMatchObject({
      id: "structured_call_1",
      name: "follow_player",
      arguments: "{\"username\":\"ZINWIN10\",\"range\":3}",
    });
  });

  it("parses ordered structured output tool call batches", () => {
    const turn = parseStructuredAgentTurn(
      JSON.stringify({
        action: "tool_calls",
        tool_name: "",
        arguments_json: "{}",
        tool_calls: [
          { tool_name: "find_nearby_blocks", arguments_json: "{\"names\":[\"_log\"],\"match\":\"suffix\"}" },
          { tool_name: "inventory", arguments_json: "{}" },
        ],
        final_text: "",
      }),
    );

    expect(turn?.toolCalls).toHaveLength(2);
    expect(turn?.toolCalls[0]).toMatchObject({ id: "structured_call_1", name: "find_nearby_blocks" });
    expect(turn?.toolCalls[1]).toMatchObject({ id: "structured_call_2", name: "inventory", arguments: "{}" });
  });

  it("parses structured output final text", () => {
    const turn = parseStructuredAgentTurn(
      JSON.stringify({
        action: "final",
        tool_name: "",
        arguments_json: "{}",
        tool_calls: [],
        final_text: "Done.",
      }),
    );

    expect(turn).toEqual({
      text: "Done.",
      toolCalls: [],
    });
  });

  it("parses auto skill drafts", () => {
    const draft = parseSkillDraft(
      JSON.stringify({
        should_record: true,
        name: "find_and_dig_logs",
        description: "Find nearby log blocks and dig one.",
        trigger: "When asked to collect wood.",
        steps_json: JSON.stringify([{ tool: "find_nearby_blocks", arguments: { names: ["_log"], match: "suffix" } }]),
        tags: ["wood", "auto"],
        scope_json: JSON.stringify({ version: "1.21.1" }),
        preconditions: ["Bot is in a loaded outdoor area."],
        success_criteria: "Inventory contains at least one log.",
        failure_modes: ["No logs found nearby."],
        rationale: "Reusable tool sequence.",
      }),
    );

    expect(draft?.name).toBe("find_and_dig_logs");
    expect(draft?.steps[0]).toMatchObject({ tool: "find_nearby_blocks" });
    expect(draft?.scope.version).toBe("1.21.1");
  });

  it("builds Qwen thinking and preserve-thinking body for vLLM/SGLang", () => {
    const config = {
      openai: {
        apiMode: "chat",
        qwen: {
          enabled: true,
          thinkingMode: "thinking",
          preserveThinking: true,
          apiStyle: "chat_template_kwargs",
          samplingProfile: "coding",
        },
      },
    } as AgentConfig;

    expect(buildQwenExtraBody(config)).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true,
      },
    });
  });

  it("builds Qwen instruct body for DashScope-compatible API", () => {
    const config = {
      openai: {
        apiMode: "chat",
        qwen: {
          enabled: true,
          thinkingMode: "instruct",
          preserveThinking: true,
          apiStyle: "dashscope",
          samplingProfile: "instruct",
        },
      },
    } as AgentConfig;

    expect(buildQwenExtraBody(config)).toMatchObject({
      enable_thinking: false,
      preserve_thinking: true,
      temperature: 0.7,
      presence_penalty: 1.5,
    });
  });
});
