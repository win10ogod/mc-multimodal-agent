import OpenAI from "openai";
import type { AgentConfig } from "../config";
import {
  buildQwenExtraBody,
  formatModelProviderError,
  isRetryableModelProviderError,
  stripReasoningMarkup,
} from "../openai/ModelProvider";
import {
  defaultMcuAction,
  MCU_ACTION_SCHEMA,
  MCU_BUTTON_KEYS,
  MCU_SYSTEM_PROMPT,
  type McuActionPayload,
  type McuButtonKey,
  type McuEnvAction,
  type McuPolicyDecision,
} from "./McuPrompt";

type McuInitPayload = {
  type: "init";
  prompt?: string;
  text?: string;
};

type McuObservationPayload = {
  type: "obs";
  step?: number;
  obs?: string;
};

type McuContextState = {
  taskText: string;
  promptText: string;
  lastAction: McuEnvAction;
  holdUntilStep: number;
  recentActions: McuEnvAction[];
};

const ACTION_PAYLOAD_PREFIX: Pick<McuActionPayload, "type" | "action_type"> = {
  type: "action",
  action_type: "env",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeBody(target: Record<string, unknown>, source: Record<string, unknown> | undefined): void {
  if (!source) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(target[key])) {
      mergeBody(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
}

function chatResponseFormat(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name,
      strict: true,
      schema,
    },
  };
}

function extractChatRawText(completion: unknown): string {
  const value = completion as any;
  const content = value?.choices?.[0]?.message?.content;
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

async function withRetry<T>(config: AgentConfig, operation: string, request: () => Promise<T>): Promise<T> {
  const attempts = Math.max(1, config.openai.maxRetries + 1);
  const initialDelayMs = Math.max(100, config.openai.retryInitialDelayMs);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableModelProviderError(error)) {
        break;
      }
      const jitter = Math.floor(Math.random() * 250);
      const delayMs = Math.min(30_000, initialDelayMs * 2 ** (attempt - 1)) + jitter;
      console.warn(
        `[agentbeats] ${operation} failed (${attempt}/${attempts}): ${formatModelProviderError(
          error,
        )}. Retrying in ${delayMs}ms.`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function jsonCandidates(text: string): string[] {
  const stripped = stripReasoningMarkup(text);
  const candidates = new Set<string>();
  if (!stripped) {
    return [];
  }
  candidates.add(stripped);
  for (const match of stripped.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) {
      candidates.add(match[1].trim());
    }
  }
  const firstObject = stripped.indexOf("{");
  const lastObject = stripped.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.add(stripped.slice(firstObject, lastObject + 1));
  }
  return [...candidates];
}

function binary(value: unknown): 0 | 1 {
  if (value === 1 || value === true || value === "1" || value === "true") {
    return 1;
  }
  return 0;
}

function clampNumber(value: unknown, min: number, max: number, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeMcuAction(value: unknown): McuEnvAction {
  const source = isRecord(value) ? value : {};
  const action = defaultMcuAction();
  for (const key of MCU_BUTTON_KEYS) {
    action[key] = binary(source[key]);
  }

  if (action.forward && action.back) {
    action.back = 0;
  }
  if (action.left && action.right) {
    action.right = 0;
  }
  if (!action.forward) {
    action.sprint = 0;
  }

  let hotbarSelected = false;
  for (let slot = 1; slot <= 9; slot += 1) {
    const key = `hotbar.${slot}` as McuButtonKey;
    if (action[key] && hotbarSelected) {
      action[key] = 0;
    } else if (action[key]) {
      hotbarSelected = true;
    }
  }

  const camera = Array.isArray(source.camera) ? source.camera : [];
  action.camera = [clampNumber(camera[0], -90, 90), clampNumber(camera[1], -90, 90)];
  return action;
}

export function parseMcuActionText(text: string): McuPolicyDecision | undefined {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const actionSource = isRecord(parsed.action) ? parsed.action : parsed;
      const hold = Number.parseInt(String(parsed.hold_steps ?? parsed.holdSteps ?? ""), 10);
      return {
        ...ACTION_PAYLOAD_PREFIX,
        hold_steps: Number.isFinite(hold) ? hold : undefined,
        action: normalizeMcuAction(actionSource),
      };
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function actionPayload(action: McuEnvAction): McuActionPayload {
  return {
    ...ACTION_PAYLOAD_PREFIX,
    action,
  };
}

function shouldUseModelOnStep(step: number, modelEveryNSteps: number): boolean {
  return step <= 0 || step % Math.max(1, modelEveryNSteps) === 0;
}

function heuristicAction(taskText: string, step: number): McuPolicyDecision {
  const task = taskText.toLowerCase();
  const action = defaultMcuAction();
  const scanYaw = step % 32 < 16 ? 18 : -18;

  if (/tree|wood|log|oak|spruce|birch|jungle|acacia|dark oak|mangrove|cherry|木|樹|砍/.test(task)) {
    action.forward = 1;
    action.sprint = 1;
    action.attack = step % 24 >= 12 ? 1 : 0;
    action.camera = [step % 24 >= 12 ? 4 : 0, step % 24 >= 12 ? 0 : scanYaw];
    return { ...ACTION_PAYLOAD_PREFIX, hold_steps: action.attack ? 6 : 3, action };
  }

  if (/mine|mining|stone|cobble|diamond|iron|coal|ore|dig|挖|礦|石/.test(task)) {
    action.forward = step % 20 < 8 ? 1 : 0;
    action.attack = 1;
    action.camera = [step % 20 < 8 ? 8 : 18, step % 28 < 14 ? 8 : -8];
    return { ...ACTION_PAYLOAD_PREFIX, hold_steps: 5, action };
  }

  if (/build|place|house|hut|tower|bridge|造|建|放置/.test(task)) {
    action["hotbar.1"] = step % 40 === 0 ? 1 : 0;
    action.use = step % 12 >= 8 ? 1 : 0;
    action.forward = step % 12 < 5 ? 1 : 0;
    action.jump = action.use;
    action.camera = [action.use ? 32 : 8, step % 24 < 12 ? 10 : -10];
    return { ...ACTION_PAYLOAD_PREFIX, hold_steps: action.use ? 2 : 3, action };
  }

  action.forward = 1;
  action.sprint = 1;
  action.jump = step % 18 === 0 ? 1 : 0;
  action.camera = [0, scanYaw];
  return { ...ACTION_PAYLOAD_PREFIX, hold_steps: 3, action };
}

function compactRecentActions(actions: McuEnvAction[]): string {
  return actions
    .slice(-8)
    .map((action, index) => {
      const pressed = MCU_BUTTON_KEYS.filter((key) => action[key] === 1).join("+") || "none";
      return `${index + 1}. ${pressed}; camera=${JSON.stringify(action.camera)}`;
    })
    .join("\n");
}

export class McuVisualPolicy {
  private readonly client: OpenAI;
  private readonly contexts = new Map<string, McuContextState>();

  constructor(private readonly config: AgentConfig) {
    this.client = new OpenAI({
      apiKey: config.openai.apiKey || "missing-key",
      baseURL: config.openai.baseURL,
      timeout: Math.max(1_000, config.openai.requestTimeoutMs),
      maxRetries: 0,
    });
  }

  async handleText(inputText: string, contextId: string): Promise<string> {
    let payload: unknown;
    try {
      payload = JSON.parse(inputText);
    } catch {
      return JSON.stringify({
        type: "ack",
        success: false,
        message: "Expected JSON payload with type init or obs.",
      });
    }

    if (!isRecord(payload) || typeof payload.type !== "string") {
      return JSON.stringify({
        type: "ack",
        success: false,
        message: "Invalid MCU payload.",
      });
    }

    if (payload.type === "init") {
      return this.handleInit(contextId, payload as McuInitPayload);
    }
    if (payload.type === "obs") {
      const decision = await this.handleObservation(contextId, payload as McuObservationPayload);
      return JSON.stringify(actionPayload(decision.action));
    }

    return JSON.stringify({
      type: "ack",
      success: false,
      message: `Unknown payload type: ${payload.type}`,
    });
  }

  private handleInit(contextId: string, payload: McuInitPayload): string {
    const taskText = payload.text?.trim() || "";
    const promptText = payload.prompt?.trim() || "";
    this.contexts.set(contextId, {
      taskText,
      promptText,
      lastAction: defaultMcuAction(),
      holdUntilStep: -1,
      recentActions: [],
    });
    console.log(`[agentbeats] init context=${contextId} task=${JSON.stringify(taskText)}`);
    return JSON.stringify({
      type: "ack",
      success: true,
      message: "Initialization successful.",
    });
  }

  private async handleObservation(contextId: string, payload: McuObservationPayload): Promise<McuPolicyDecision> {
    const state = this.contexts.get(contextId) ?? {
      taskText: "",
      promptText: "",
      lastAction: defaultMcuAction(),
      holdUntilStep: -1,
      recentActions: [],
    };
    this.contexts.set(contextId, state);

    const step = Math.max(0, Number.isFinite(payload.step) ? Number(payload.step) : 0);
    if (step <= state.holdUntilStep && !shouldUseModelOnStep(step, this.config.agentbeats.modelEveryNSteps)) {
      return { ...ACTION_PAYLOAD_PREFIX, action: state.lastAction, hold_steps: 1 };
    }

    let decision: McuPolicyDecision | undefined;
    if (this.config.openai.apiKey && payload.obs) {
      try {
        decision = await this.modelDecision(state, step, payload.obs);
      } catch (error) {
        console.warn(`[agentbeats] model decision failed: ${formatModelProviderError(error)}. Using heuristic action.`);
      }
    }
    decision ??= heuristicAction(state.taskText, step);

    const holdSteps = Math.max(
      1,
      Math.min(this.config.agentbeats.maxHoldSteps, decision.hold_steps ?? this.config.agentbeats.defaultHoldSteps),
    );
    state.lastAction = decision.action;
    state.holdUntilStep = step + holdSteps - 1;
    state.recentActions.push(decision.action);
    state.recentActions = state.recentActions.slice(-16);

    console.log(
      `[agentbeats] step=${step} hold=${holdSteps} action=${JSON.stringify({
        pressed: MCU_BUTTON_KEYS.filter((key) => decision?.action[key] === 1),
        camera: decision.action.camera,
      })}`,
    );
    return { ...decision, hold_steps: holdSteps };
  }

  private async modelDecision(state: McuContextState, step: number, obsBase64: string): Promise<McuPolicyDecision> {
    const imageDataUrl = obsBase64.startsWith("data:image/") ? obsBase64 : `data:image/jpeg;base64,${obsBase64}`;
    const body: Record<string, unknown> = {
      model: this.config.openai.model,
      messages: [
        {
          role: "system",
          content: [
            MCU_SYSTEM_PROMPT,
            state.promptText ? `\n\nAdditional evaluator prompt:\n${state.promptText}` : "",
          ].join(""),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `Task: ${state.taskText || "(no task text provided)"}`,
                `Step: ${step}`,
                `Recent actions:\n${compactRecentActions(state.recentActions) || "none"}`,
                "Choose the next action from the current image. Output only the strict JSON action payload.",
              ].join("\n\n"),
            },
            {
              type: "image_url",
              image_url: {
                url: imageDataUrl,
                detail: "low",
              },
            },
          ],
        },
      ],
      max_tokens: 700,
    };
    if (this.config.openai.structuredOutputs) {
      body.response_format = chatResponseFormat("mcu_env_action", MCU_ACTION_SCHEMA as unknown as Record<string, unknown>);
    }
    mergeBody(body, buildQwenExtraBody(this.config));
    if (this.config.openai.extraBody) {
      mergeBody(body, this.config.openai.extraBody);
    }

    const completion = await this.createChatCompletionWithFallback(body);
    const text = extractChatRawText(completion);
    const parsed = parseMcuActionText(text);
    if (!parsed) {
      throw new Error(`Model did not return a valid MCU action JSON: ${stripReasoningMarkup(text).slice(0, 400)}`);
    }
    return parsed;
  }

  private async createChatCompletionWithFallback(body: Record<string, unknown>): Promise<unknown> {
    try {
      return await withRetry(this.config, "agentbeats.chat", () => this.client.chat.completions.create(body as never));
    } catch (error) {
      if (!("response_format" in body)) {
        throw error;
      }
      const message = formatModelProviderError(error).toLowerCase();
      if (!message.includes("response_format") && !message.includes("schema") && !message.includes("structured")) {
        throw error;
      }
      const fallback = { ...body };
      delete fallback.response_format;
      console.warn("[agentbeats] provider rejected structured output; retrying MCU action request without response_format.");
      return withRetry(this.config, "agentbeats.chat.compat", () => this.client.chat.completions.create(fallback as never));
    }
  }
}
