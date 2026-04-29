import OpenAI from "openai";
import type { AgentConfig } from "../config";
import type { JsonObject, JsonValue, ToolResult } from "../types";

export type ProviderToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ProviderTurn = {
  text: string;
  toolCalls: ProviderToolCall[];
};

export type SkillDraft = {
  name: string;
  description: string;
  trigger: string;
  steps: JsonValue[];
  tags: string[];
  scope: Record<string, JsonValue>;
  preconditions: string[];
  successCriteria: string;
  failureModes: string[];
};

export type StartTurnInput = {
  instructions: string;
  text: string;
  imageDataUrl?: string;
  imageDataUrls?: string[];
  tools: JsonObject[];
};

export type ContinueTurnInput = {
  instructions: string;
  toolOutputs: Array<{
    callId: string;
    name: string;
    result: ToolResult;
  }>;
  tools: JsonObject[];
};

export interface ModelProvider {
  start(input: StartTurnInput): Promise<ProviderTurn>;
  continue(input: ContinueTurnInput): Promise<ProviderTurn>;
  summarize(input: { instructions: string; text: string; maxOutputTokens?: number }): Promise<string>;
  draftSkill(input: { instructions: string; text: string; maxOutputTokens?: number }): Promise<SkillDraft | undefined>;
}

type ResponseOutputItem = {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
};

function createClient(config: AgentConfig): OpenAI {
  return new OpenAI({
    apiKey: config.openai.apiKey,
    baseURL: config.openai.baseURL,
  });
}

function resultText(result: ToolResult): string {
  return JSON.stringify({
    ok: result.ok,
    text: result.text,
    data: result.data ?? null,
  });
}

function startImageUrls(input: StartTurnInput): string[] {
  const urls = input.imageDataUrls ?? (input.imageDataUrl ? [input.imageDataUrl] : []);
  return urls.filter((url) => typeof url === "string" && url.trim().length > 0);
}

function resultImages(result: ToolResult): Array<{ dataUrl: string; detail?: "low" | "high" | "auto" }> {
  return (result.content ?? [])
    .filter((entry): entry is { type: "image"; dataUrl: string; detail?: "low" | "high" | "auto" } => entry.type === "image")
    .filter((entry) => entry.dataUrl.trim().length > 0);
}

const AGENT_TURN_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["tool_call", "tool_calls", "final"],
      description:
        "Use tool_calls for an ordered batch of independent/deterministic tool executions, tool_call for one tool, or final to answer the user.",
    },
    tool_name: {
      type: "string",
      description: "The exact tool name to call for action=tool_call. Use an empty string otherwise.",
    },
    arguments_json: {
      type: "string",
      description: "A JSON object string containing tool arguments for action=tool_call. Use {} otherwise.",
    },
    tool_calls: {
      type: "array",
      description:
        "Ordered tool calls for action=tool_calls. Use this to do several deterministic steps in one model turn.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          tool_name: { type: "string" },
          arguments_json: { type: "string" },
        },
        required: ["tool_name", "arguments_json"],
      },
    },
    final_text: {
      type: "string",
      description: "Final user-facing text. Use an empty string when action is tool_call.",
    },
  },
  required: ["action", "tool_name", "arguments_json", "tool_calls", "final_text"],
};

const SUMMARY_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "Compact memory summary text.",
    },
  },
  required: ["summary"],
};

const SKILL_DRAFT_SCHEMA: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    should_record: {
      type: "boolean",
      description: "True only when the trace contains a reusable, repeatable skill worth saving.",
    },
    name: { type: "string", description: "Filename-safe short skill name." },
    description: { type: "string", description: "Human-readable skill description." },
    trigger: { type: "string", description: "When this skill should be considered." },
    steps_json: {
      type: "string",
      description: "JSON array of ordered atomic tool call steps. Each step should include tool and arguments.",
    },
    tags: { type: "array", items: { type: "string" } },
    scope_json: { type: "string", description: "JSON object describing environment/modpack/version scope." },
    preconditions: { type: "array", items: { type: "string" } },
    success_criteria: { type: "string" },
    failure_modes: { type: "array", items: { type: "string" } },
    rationale: { type: "string", description: "Brief reason for recording or skipping." },
  },
  required: [
    "should_record",
    "name",
    "description",
    "trigger",
    "steps_json",
    "tags",
    "scope_json",
    "preconditions",
    "success_criteria",
    "failure_modes",
    "rationale",
  ],
};

function chatResponseFormat(name: string, schema: JsonObject): JsonObject {
  return {
    type: "json_schema",
    json_schema: {
      name,
      strict: true,
      schema,
    },
  };
}

function responsesTextFormat(name: string, schema: JsonObject): JsonObject {
  return {
    format: {
      type: "json_schema",
      name,
      strict: true,
      schema,
    },
  };
}

function toolSpecsForPrompt(tools: JsonObject[]): string {
  return JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeBody(target: Record<string, unknown>, source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeBody(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
}

export function buildQwenExtraBody(config: AgentConfig): Record<string, unknown> {
  const qwen = config.openai.qwen;
  if (!qwen.enabled || config.openai.apiMode !== "chat") {
    return {};
  }
  const body: Record<string, unknown> = {};
  const templateKwargs: Record<string, unknown> = {};
  if (qwen.thinkingMode === "thinking") {
    templateKwargs.enable_thinking = true;
  } else if (qwen.thinkingMode === "instruct") {
    templateKwargs.enable_thinking = false;
  }
  if (qwen.preserveThinking) {
    templateKwargs.preserve_thinking = true;
  }

  if (Object.keys(templateKwargs).length > 0) {
    if (qwen.apiStyle === "dashscope") {
      Object.assign(body, templateKwargs);
    } else {
      body.chat_template_kwargs = templateKwargs;
    }
  }

  if (qwen.samplingProfile === "thinking") {
    Object.assign(body, {
      temperature: 1.0,
      top_p: 0.95,
      presence_penalty: 0.0,
      repetition_penalty: 1.0,
      top_k: 20,
      min_p: 0.0,
    });
  } else if (qwen.samplingProfile === "coding") {
    Object.assign(body, {
      temperature: 0.6,
      top_p: 0.95,
      presence_penalty: 0.0,
      repetition_penalty: 1.0,
      top_k: 20,
      min_p: 0.0,
    });
  } else if (qwen.samplingProfile === "instruct") {
    Object.assign(body, {
      temperature: 0.7,
      top_p: 0.8,
      presence_penalty: 1.5,
      repetition_penalty: 1.0,
      top_k: 20,
      min_p: 0.0,
    });
  }
  return body;
}

function applyProviderExtraBody(body: Record<string, unknown>, config: AgentConfig): void {
  mergeBody(body, buildQwenExtraBody(config));
  if (config.openai.extraBody) {
    mergeBody(body, config.openai.extraBody);
  }
}

function structuredInstructions(instructions: string, tools: JsonObject[]): string {
  return [
    instructions,
    "",
    "<structured_output_contract>",
    "Return JSON matching the response schema.",
    "To execute several already-decided deterministic steps in one model turn, set action to tool_calls and fill tool_calls with ordered objects {tool_name, arguments_json}.",
    "To execute one tool, set action to tool_call, tool_name to one listed below, arguments_json to a JSON object string, and tool_calls to an empty array.",
    "To finish, set action to final, tool_name to an empty string, arguments_json to {}, tool_calls to an empty array, and final_text to the concise result.",
    "Only batch tool calls when later calls do not require reading the earlier result first. Otherwise call one tool, inspect the result, then continue.",
    "Do not describe a tool call in prose. Request it through the structured JSON fields.",
    "</structured_output_contract>",
    "",
    "<tool_specs_json>",
    toolSpecsForPrompt(tools),
    "</tool_specs_json>",
  ].join("\n");
}

export function stripReasoningMarkup(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/<\|channel\>thought\s*[\s\S]*?(?:<channel\|>|(?=<\|channel\>(?:final|assistant))|$)\s*/gi, "")
    .replace(/<\|channel\>(?:final|assistant)\s*(?:<channel\|>)?\s*/gi, "")
    .replace(/<\|[^>]+?\|>/g, "")
    .replace(/<channel\|>/g, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") {
    return value.trim() || "{}";
  }
  if (value === undefined || value === null) {
    return "{}";
  }
  return JSON.stringify(value);
}

function normalizeArgumentsJson(value: unknown): string {
  const raw = stringifyArguments(value);
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? JSON.stringify(parsed) : "{}";
  } catch {
    return raw.startsWith("{") && raw.endsWith("}") ? raw : "{}";
  }
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.includes(".") ? trimmed.split(".").pop() : trimmed;
}

function structuredToolCalls(value: unknown): ProviderToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index): ProviderToolCall | undefined => {
      if (!isRecord(entry)) {
        return undefined;
      }
      const name = normalizeToolName(entry.tool_name ?? entry.tool ?? entry.name);
      if (!name) {
        return undefined;
      }
      return {
        id: `structured_call_${index + 1}`,
        name,
        arguments: normalizeArgumentsJson(entry.arguments_json ?? entry.arguments ?? entry.args ?? {}),
      };
    })
    .filter((entry): entry is ProviderToolCall => Boolean(entry));
}

export function parseStructuredAgentTurn(text: string): ProviderTurn | undefined {
  const stripped = stripReasoningMarkup(text);
  if (!stripped) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const action = parsed.action ?? parsed.type;
  if (action === "final") {
    return {
      text: typeof parsed.final_text === "string" ? parsed.final_text.trim() : "",
      toolCalls: [],
    };
  }
  if (action === "tool_calls") {
    const calls = structuredToolCalls(parsed.tool_calls ?? parsed.toolCalls ?? parsed.calls);
    return calls.length > 0 ? { text: "", toolCalls: calls } : undefined;
  }
  if (action !== "tool_call") {
    return undefined;
  }

  const batchedCalls = structuredToolCalls(parsed.tool_calls ?? parsed.toolCalls ?? parsed.calls);
  if (batchedCalls.length > 0) {
    return { text: "", toolCalls: batchedCalls };
  }
  const name = normalizeToolName(parsed.tool_name ?? parsed.tool ?? parsed.name);
  if (!name) {
    return undefined;
  }
  return {
    text: "",
    toolCalls: [
      {
        id: "structured_call_1",
        name,
        arguments: normalizeArgumentsJson(parsed.arguments_json ?? parsed.arguments ?? parsed.args ?? {}),
      },
    ],
  };
}

function parseStructuredSummary(text: string): string {
  const stripped = stripReasoningMarkup(text);
  try {
    const parsed = JSON.parse(stripped);
    if (isRecord(parsed) && typeof parsed.summary === "string") {
      return parsed.summary.trim();
    }
  } catch {
    // Fall back to raw text for compatible APIs that ignore response_format.
  }
  return stripped;
}

function parseJsonArrayString(value: unknown): JsonValue[] {
  if (Array.isArray(value)) {
    return value as JsonValue[];
  }
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as JsonValue[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObjectString(value: unknown): Record<string, JsonValue> {
  if (isRecord(value)) {
    return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? (parsed as Record<string, JsonValue>) : {};
  } catch {
    return {};
  }
}

function parseStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function parseSkillDraft(text: string): SkillDraft | undefined {
  const stripped = stripReasoningMarkup(text);
  if (!stripped) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.should_record !== true) {
    return undefined;
  }
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!name || !description) {
    return undefined;
  }
  return {
    name,
    description,
    trigger: typeof parsed.trigger === "string" ? parsed.trigger.trim() : description,
    steps: parseJsonArrayString(parsed.steps_json ?? parsed.steps),
    tags: parseStringList(parsed.tags),
    scope: parseJsonObjectString(parsed.scope_json ?? parsed.scope),
    preconditions: parseStringList(parsed.preconditions),
    successCriteria: typeof parsed.success_criteria === "string" ? parsed.success_criteria.trim() : "",
    failureModes: parseStringList(parsed.failure_modes),
  };
}

function turnFromTextAndToolCalls(text: string, nativeToolCalls: ProviderToolCall[]): ProviderTurn {
  const structuredTurn = parseStructuredAgentTurn(text);
  if (nativeToolCalls.length > 0) {
    return {
      text: structuredTurn?.text ?? text,
      toolCalls: nativeToolCalls,
    };
  }
  if (structuredTurn) {
    return structuredTurn;
  }
  const parsedTextToolCalls = parseTextToolCalls(text);
  return {
    text,
    toolCalls: parsedTextToolCalls,
  };
}

function toolCallFromObject(value: unknown): Omit<ProviderToolCall, "id">[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => toolCallFromObject(entry));
  }
  if (!isRecord(value)) {
    return [];
  }

  const nestedCalls = value.tool_calls ?? value.toolCalls ?? value.calls;
  if (Array.isArray(nestedCalls)) {
    return nestedCalls.flatMap((entry) => toolCallFromObject(entry));
  }
  const nestedCall = value.tool_call ?? value.toolCall ?? value.call;
  if (nestedCall) {
    return toolCallFromObject(nestedCall);
  }

  const functionValue = value.function;
  if (isRecord(functionValue)) {
    const name = normalizeToolName(functionValue.name ?? value.name ?? value.tool);
    if (name) {
      return [
        {
          name,
          arguments: stringifyArguments(
            functionValue.arguments ?? functionValue.args ?? value.arguments ?? value.args ?? {},
          ),
        },
      ];
    }
  }

  const name = normalizeToolName(value.tool ?? value.name ?? value.recipient_name);
  if (!name) {
    return [];
  }
  return [
    {
      name,
      arguments: stringifyArguments(value.arguments ?? value.args ?? value.parameters ?? value.input ?? {}),
    },
  ];
}

function jsonCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const stripped = stripReasoningMarkup(text);
  if (!stripped) {
    return [];
  }

  candidates.add(stripped);
  for (const match of stripped.matchAll(/```(?:json|tool|tool_call|function)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) {
      candidates.add(match[1].trim());
    }
  }

  const firstObject = stripped.indexOf("{");
  const lastObject = stripped.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.add(stripped.slice(firstObject, lastObject + 1));
  }

  const firstArray = stripped.indexOf("[");
  const lastArray = stripped.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.add(stripped.slice(firstArray, lastArray + 1));
  }

  return [...candidates];
}

export function parseTextToolCalls(text: string): ProviderToolCall[] {
  const parsedCalls: Array<Omit<ProviderToolCall, "id">> = [];

  for (const candidate of jsonCandidates(text)) {
    try {
      parsedCalls.push(...toolCallFromObject(JSON.parse(candidate)));
    } catch {
      // Non-JSON prose is expected for final answers.
    }
  }

  const stripped = stripReasoningMarkup(text);
  for (const match of stripped.matchAll(/<tool(?:_call)?\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool(?:_call)?>/gi)) {
    const name = normalizeToolName(match[1]);
    if (!name) {
      continue;
    }
    parsedCalls.push({
      name,
      arguments: stringifyArguments(parseMaybeJson(match[2] ?? "{}")),
    });
  }

  for (const match of stripped.matchAll(/\b([a-zA-Z_][\w.]*)\s*\(\s*({[\s\S]*?})\s*\)/g)) {
    const name = normalizeToolName(match[1]);
    if (!name) {
      continue;
    }
    parsedCalls.push({
      name,
      arguments: stringifyArguments(parseMaybeJson(match[2] ?? "{}")),
    });
  }

  const seen = new Set<string>();
  return parsedCalls
    .filter((call) => {
      const key = `${call.name}\n${call.arguments}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((call, index) => ({
      id: `text_call_${index + 1}`,
      ...call,
    }));
}

function extractResponsesText(response: any): string {
  if (typeof response.output_text === "string") {
    return stripReasoningMarkup(response.output_text);
  }
  const output = Array.isArray(response.output) ? (response.output as ResponseOutputItem[]) : [];
  return stripReasoningMarkup(output
    .flatMap((item) => item.content ?? [])
    .flatMap((content) => (typeof content.text === "string" ? [content.text] : []))
    .join("\n")
    .trim());
}

function extractResponsesToolCalls(response: any): ProviderToolCall[] {
  const output = Array.isArray(response.output) ? (response.output as ResponseOutputItem[]) : [];
  return output
    .filter((item) => item.type === "function_call" && item.name && item.call_id)
    .map((item) => ({
      id: item.call_id ?? "",
      name: item.name ?? "",
      arguments: item.arguments ?? "{}",
    }));
}

function extractChatText(completion: any): string {
  return stripReasoningMarkup(extractChatRawText(completion));
}

function extractChatRawText(completion: any): string {
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => (typeof part?.text === "string" ? [part.text] : []))
      .join("\n")
      .trim();
  }
  return "";
}

function extractChatToolCalls(completion: any): ProviderToolCall[] {
  const legacy = completion.choices?.[0]?.message?.function_call;
  if (legacy?.name) {
    return [
      {
        id: "legacy_call_1",
        name: String(legacy.name),
        arguments: typeof legacy.arguments === "string" ? legacy.arguments : "{}",
      },
    ];
  }
  const calls = completion.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) {
    return [];
  }
  return calls
    .filter((call) => call?.type === "function" && call.id && call.function?.name)
    .map((call) => ({
      id: String(call.id),
      name: String(call.function.name),
      arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
    }));
}

function toChatTools(tools: JsonObject[]): JsonObject[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    },
  })) as JsonObject[];
}

function toAssistantToolCalls(calls: ProviderToolCall[]): JsonObject[] {
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.arguments,
    },
  })) as JsonObject[];
}

export class ResponsesModelProvider implements ModelProvider {
  private readonly client: OpenAI;
  private previousResponseId?: string;
  private previousTurnUsedNativeToolCalls = false;

  constructor(private readonly config: AgentConfig) {
    this.client = createClient(config);
  }

  async start(input: StartTurnInput): Promise<ProviderTurn> {
    const content: Array<Record<string, unknown>> = [{ type: "input_text", text: input.text }];
    for (const imageUrl of startImageUrls(input)) {
      content.push({ type: "input_image", image_url: imageUrl, detail: "low" });
    }
    const body: Record<string, unknown> = {
      model: this.config.openai.model,
      instructions: this.config.openai.structuredOutputs
        ? structuredInstructions(input.instructions, input.tools)
        : input.instructions,
      input: [
        {
          role: "user",
          content,
        },
      ],
    };
    if (this.config.openai.structuredOutputs) {
      body.text = responsesTextFormat("minecraft_agent_turn", AGENT_TURN_SCHEMA);
    } else {
      body.tools = input.tools;
      body.parallel_tool_calls = false;
      body.max_tool_calls = Math.max(1, this.config.loop.maxToolCallsPerTurn);
    }
    if (this.config.openai.reasoningEffort) {
      body.reasoning = { effort: this.config.openai.reasoningEffort };
    }
    applyProviderExtraBody(body, this.config);
    const response = await this.client.responses.create(body as never);
    this.previousResponseId = response.id;
    const nativeToolCalls = extractResponsesToolCalls(response);
    this.previousTurnUsedNativeToolCalls = nativeToolCalls.length > 0;
    return turnFromTextAndToolCalls(extractResponsesText(response), nativeToolCalls);
  }

  async continue(input: ContinueTurnInput): Promise<ProviderTurn> {
    const responseInput = this.previousTurnUsedNativeToolCalls
      ? input.toolOutputs.map((output) => ({
          type: "function_call_output",
          call_id: output.callId,
          output: resultText(output.result),
        }))
      : input.toolOutputs.map((output) => {
          const content: Array<Record<string, unknown>> = [
            {
              type: "input_text",
              text: `Tool ${output.name} returned:\n${resultText(output.result)}`,
            },
          ];
          for (const image of resultImages(output.result)) {
            content.push({
              type: "input_image",
              image_url: image.dataUrl,
              detail: image.detail ?? "low",
            });
          }
          return {
            role: "user",
            content,
          };
        });
    const body: Record<string, unknown> = {
      model: this.config.openai.model,
      instructions: this.config.openai.structuredOutputs
        ? structuredInstructions(input.instructions, input.tools)
        : input.instructions,
      input: responseInput,
    };
    if (this.config.openai.structuredOutputs) {
      body.text = responsesTextFormat("minecraft_agent_turn", AGENT_TURN_SCHEMA);
    } else {
      body.tools = input.tools;
      body.parallel_tool_calls = false;
      body.max_tool_calls = Math.max(1, this.config.loop.maxToolCallsPerTurn);
    }
    if (this.previousResponseId) {
      body.previous_response_id = this.previousResponseId;
    }
    if (this.config.openai.reasoningEffort) {
      body.reasoning = { effort: this.config.openai.reasoningEffort };
    }
    applyProviderExtraBody(body, this.config);
    const response = await this.client.responses.create(body as never);
    this.previousResponseId = response.id;
    const nativeToolCalls = extractResponsesToolCalls(response);
    this.previousTurnUsedNativeToolCalls = nativeToolCalls.length > 0;
    return turnFromTextAndToolCalls(extractResponsesText(response), nativeToolCalls);
  }

  async summarize(input: { instructions: string; text: string; maxOutputTokens?: number }): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.openai.model,
      instructions: input.instructions,
      input: input.text,
      max_output_tokens: input.maxOutputTokens ?? 1200,
    };
    if (this.config.openai.structuredOutputs) {
      body.text = responsesTextFormat("minecraft_agent_summary", SUMMARY_SCHEMA);
    }
    applyProviderExtraBody(body, this.config);
    const response = await this.client.responses.create(body as never);
    return parseStructuredSummary(extractResponsesText(response));
  }

  async draftSkill(input: { instructions: string; text: string; maxOutputTokens?: number }): Promise<SkillDraft | undefined> {
    const body: Record<string, unknown> = {
      model: this.config.openai.model,
      instructions: input.instructions,
      input: input.text,
      max_output_tokens: input.maxOutputTokens ?? 1600,
    };
    if (this.config.openai.structuredOutputs) {
      body.text = responsesTextFormat("minecraft_skill_draft", SKILL_DRAFT_SCHEMA);
    }
    if (this.config.openai.reasoningEffort) {
      body.reasoning = { effort: this.config.openai.reasoningEffort };
    }
    applyProviderExtraBody(body, this.config);
    const response = await this.client.responses.create(body as never);
    return parseSkillDraft(extractResponsesText(response));
  }
}

export class ChatCompletionsModelProvider implements ModelProvider {
  private readonly client: OpenAI;
  private readonly messages: any[] = [];

  constructor(private readonly config: AgentConfig) {
    this.client = createClient(config);
  }

  async start(input: StartTurnInput): Promise<ProviderTurn> {
    this.messages.length = 0;
    this.messages.push({
      role: "system",
      content: this.config.openai.structuredOutputs
        ? structuredInstructions(input.instructions, input.tools)
        : input.instructions,
    });
    const content: Array<Record<string, unknown>> = [{ type: "text", text: input.text }];
    for (const imageUrl of startImageUrls(input)) {
      content.push({ type: "image_url", image_url: { url: imageUrl, detail: "low" } });
    }
    this.messages.push({
      role: "user",
      content,
    });
    return this.createChatCompletion(input.tools);
  }

  async continue(input: ContinueTurnInput): Promise<ProviderTurn> {
    if (this.config.openai.structuredOutputs) {
      for (const output of input.toolOutputs) {
        const content: Array<Record<string, unknown>> = [
          {
            type: "text",
            text: `Tool ${output.name} returned:\n${resultText(output.result)}`,
          },
        ];
        for (const image of resultImages(output.result)) {
          content.push({ type: "image_url", image_url: { url: image.dataUrl, detail: image.detail ?? "low" } });
        }
        this.messages.push({ role: "user", content });
      }
    } else {
      for (const output of input.toolOutputs) {
        this.messages.push({
          role: "tool",
          tool_call_id: output.callId,
          content: resultText(output.result),
        });
      }
      for (const output of input.toolOutputs) {
        const images = resultImages(output.result);
        if (images.length === 0) {
          continue;
        }
        const content: Array<Record<string, unknown>> = [
          {
            type: "text",
            text: `Tool ${output.name} returned this visual observation.`,
          },
        ];
        for (const image of images) {
          content.push({ type: "image_url", image_url: { url: image.dataUrl, detail: image.detail ?? "low" } });
        }
        this.messages.push({
          role: "user",
          content,
        });
      }
    }
    this.messages[0] = {
      role: "system",
      content: this.config.openai.structuredOutputs
        ? structuredInstructions(input.instructions, input.tools)
        : input.instructions,
    };
    return this.createChatCompletion(input.tools);
  }

  async summarize(input: { instructions: string; text: string; maxOutputTokens?: number }): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.openai.model,
      messages: [
        { role: "system", content: input.instructions },
        { role: "user", content: input.text },
      ],
      max_tokens: input.maxOutputTokens ?? 1200,
    };
    if (this.config.openai.structuredOutputs) {
      body.response_format = chatResponseFormat("minecraft_agent_summary", SUMMARY_SCHEMA);
    }
    applyProviderExtraBody(body, this.config);
    const completion = await this.client.chat.completions.create(body as never);
    return parseStructuredSummary(extractChatText(completion));
  }

  async draftSkill(input: { instructions: string; text: string; maxOutputTokens?: number }): Promise<SkillDraft | undefined> {
    const body: Record<string, unknown> = {
      model: this.config.openai.model,
      messages: [
        { role: "system", content: input.instructions },
        { role: "user", content: input.text },
      ],
      max_tokens: input.maxOutputTokens ?? 1600,
    };
    if (this.config.openai.structuredOutputs) {
      body.response_format = chatResponseFormat("minecraft_skill_draft", SKILL_DRAFT_SCHEMA);
    }
    applyProviderExtraBody(body, this.config);
    const completion = await this.client.chat.completions.create(body as never);
    return parseSkillDraft(extractChatText(completion));
  }

  private async createChatCompletion(tools: JsonObject[]): Promise<ProviderTurn> {
    const body: Record<string, unknown> = {
      model: this.config.openai.model,
      messages: this.messages,
    };
    if (this.config.openai.structuredOutputs) {
      body.response_format = chatResponseFormat("minecraft_agent_turn", AGENT_TURN_SCHEMA);
    } else {
      body.tools = toChatTools(tools);
      body.parallel_tool_calls = false;
      body.tool_choice = "auto";
    }
    applyProviderExtraBody(body, this.config);
    const completion = await this.client.chat.completions.create(body as never);
    const message = completion.choices?.[0]?.message;
    const nativeToolCalls = extractChatToolCalls(completion);
    const rawText = extractChatRawText(completion);
    const turn = turnFromTextAndToolCalls(stripReasoningMarkup(rawText), nativeToolCalls);
    const { text, toolCalls } = turn;
    const hasNativeToolCallMessage = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
    if (message) {
      if (this.config.openai.structuredOutputs) {
        this.messages.push(message);
      } else if (hasNativeToolCallMessage) {
        this.messages.push(message);
      } else if (toolCalls.length > 0) {
        this.messages.push({
          role: "assistant",
          content: this.config.openai.qwen.preserveThinking && rawText ? rawText : text || null,
          tool_calls: toAssistantToolCalls(toolCalls),
        });
      } else {
        this.messages.push(message);
      }
    }
    return {
      text,
      toolCalls,
    };
  }
}

export function createModelProvider(config: AgentConfig): ModelProvider {
  return config.openai.apiMode === "chat"
    ? new ChatCompletionsModelProvider(config)
    : new ResponsesModelProvider(config);
}
