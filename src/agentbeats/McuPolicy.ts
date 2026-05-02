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
  type McuCompactAgentActionPayload,
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
  recentObservationImages: string[];
};

const ACTION_PAYLOAD_PREFIX = {
  type: "action",
  action_type: "env",
} as const;

const MCU_CAMERA_BINS = 11;
const MCU_CAMERA_NULL_BIN = Math.floor(MCU_CAMERA_BINS / 2);
const MCU_CAMERA_MAX_DEG = 10;
const MCU_CAMERA_BIN_SIZE_DEG = 2;

const HOTBAR_GROUP = ["none", ...Array.from({ length: 9 }, (_, index) => `hotbar.${index + 1}`)];
const BUTTON_GROUPS = [
  HOTBAR_GROUP,
  ["none", "forward", "back"],
  ["none", "left", "right"],
  ["none", "sprint", "sneak"],
  ["none", "use"],
  ["none", "drop"],
  ["none", "attack"],
  ["none", "jump"],
  ["none", "camera"],
] as const;
const MCU_INVENTORY_BUTTON_INDEX = BUTTON_GROUPS.reduce((total, group) => total * group.length, 1);

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

function chatBodySignature(body: Record<string, unknown>): string {
  return [
    "max_tokens" in body ? "max_tokens" : "",
    "max_completion_tokens" in body ? "max_completion_tokens" : "",
    "response_format" in body ? "response_format" : "",
  ].join("|");
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
  action.camera = [
    clampNumber(camera[0], -MCU_CAMERA_MAX_DEG, MCU_CAMERA_MAX_DEG),
    clampNumber(camera[1], -MCU_CAMERA_MAX_DEG, MCU_CAMERA_MAX_DEG),
  ];
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

function cameraBin(value: number): number {
  const clipped = Math.max(-MCU_CAMERA_MAX_DEG, Math.min(MCU_CAMERA_MAX_DEG, value));
  return Math.max(
    0,
    Math.min(MCU_CAMERA_BINS - 1, Math.round((clipped + MCU_CAMERA_MAX_DEG) / MCU_CAMERA_BIN_SIZE_DEG)),
  );
}

function chooseGroup(action: McuEnvAction, group: readonly string[]): string {
  for (let index = group.length - 1; index >= 1; index -= 1) {
    const key = group[index] as McuButtonKey;
    if (action[key] === 1) {
      return group[index];
    }
  }
  return "none";
}

export function toCompactMcuAgentActionPayload(action: McuEnvAction): McuCompactAgentActionPayload {
  const cameraX = cameraBin(action.camera[0]);
  const cameraY = cameraBin(action.camera[1]);
  const cameraIndex = cameraX * MCU_CAMERA_BINS + cameraY;

  let buttonsIndex = 0;
  if (action.inventory) {
    buttonsIndex = MCU_INVENTORY_BUTTON_INDEX;
  } else {
    for (const group of BUTTON_GROUPS) {
      const choice =
        group === BUTTON_GROUPS[BUTTON_GROUPS.length - 1]
          ? cameraIndex === MCU_CAMERA_NULL_BIN * MCU_CAMERA_BINS + MCU_CAMERA_NULL_BIN
            ? "none"
            : "camera"
          : chooseGroup(action, group);
      buttonsIndex = buttonsIndex * group.length + (group as readonly string[]).indexOf(choice);
    }
  }

  return {
    type: "action",
    action_type: "agent",
    buttons: [buttonsIndex],
    camera: [cameraIndex],
  };
}

function shouldUseModelOnStep(step: number, modelEveryNSteps: number): boolean {
  return step <= 0 || step % Math.max(1, modelEveryNSteps) === 0;
}

function taskKind(taskText: string): string {
  const task = taskText.toLowerCase();
  if (/horizontal/.test(task)) {
    return "mine_horizontally";
  }
  if (/obsidian/.test(task)) {
    return "mine_obsidian";
  }
  if (/diamond/.test(task) && /ore|mine|find/.test(task)) {
    return "mine_diamond_ore";
  }
  if (/grass/.test(task)) {
    return "collect_grass";
  }
  if (/wool|shear|sheep/.test(task)) {
    return "collect_wool";
  }
  if (/stone/.test(task) && !/enchant|lapis|cobble.*craft/.test(task)) {
    return "cut_stone";
  }
  if (/craft|recipe|合成/.test(task)) {
    return "crafting";
  }
  if (/smelt|furnace|熔/.test(task)) {
    return "smelting";
  }
  if (/brew|potion|釀/.test(task)) {
    return "brewing";
  }
  if (/enchant|附魔/.test(task)) {
    return "enchanting";
  }
  if (/\bdrop\b|丟|扔/.test(task)) {
    return "drop";
  }
  if (/throw|snowball/.test(task)) {
    return "throw";
  }
  if (/sleep|bed/.test(task)) {
    return "sleep";
  }
  return "";
}

export function taskSpecificGuidance(taskText: string): string {
  switch (taskKind(taskText)) {
    case "mine_horizontally":
      return [
        "Task strategy: mine a straight horizontal tunnel.",
        "Keep yaw steady, center reachable block faces, hold attack until blocks break, then advance cautiously.",
      ].join(" ");
    case "mine_obsidian":
      return [
        "Task strategy: obsidian takes a long continuous mine action with the correct pickaxe.",
        "Center visible obsidian or likely dark floor-level block faces and hold attack instead of wandering.",
      ].join(" ");
    case "mine_diamond_ore":
      return [
        "Task strategy: diamond ore requires a suitable pickaxe.",
        "Search with small camera changes, center visible diamond ore, then hold attack until it breaks.",
      ].join(" ");
    case "collect_grass":
      return "Task strategy: move through visible tall grass patches and break them with the equipped tool.";
    case "collect_wool":
      return "Task strategy: move close to visible sheep, center the sheep, and use rather than attack.";
    case "cut_stone":
      return "Task strategy: center reachable stone block faces and hold attack repeatedly until stone breaks.";
    case "crafting":
      return [
        "Task strategy: ingredients are already in your starting inventory.",
        "First press inventory (E) to open the GUI. Inside the inventory, place ingredients in the 2x2 craft grid for simple recipes, or right-click (use) the crafting table for 3x3 recipes. Always start by setting inventory to 1 on step 0 unless you are clearly already inside the GUI.",
      ].join(" ");
    case "smelting":
      return [
        "Task strategy: a furnace and fuel are provided.",
        "Approach the furnace (forward), then right-click it (use=1) to open the furnace GUI. Inside, place the raw item in the top slot and fuel in the bottom slot.",
      ].join(" ");
    case "brewing":
      return [
        "Task strategy: brewing requires a brewing stand, blaze powder, and ingredients.",
        "Approach the brewing stand and right-click it (use=1) to open the GUI; place ingredients per the recipe.",
      ].join(" ");
    case "enchanting":
      return [
        "Task strategy: an enchanting table and lapis lazuli are provided.",
        "Approach the table and right-click it (use=1) to open the enchant GUI; pick an enchantment slot.",
      ].join(" ");
    case "drop":
      return [
        "Task strategy: drop an item from your hotbar or inventory.",
        "Press drop (Q, drop=1) directly to drop the held item; otherwise open inventory (E) first to select.",
      ].join(" ");
    case "throw":
      return [
        "Task strategy: select the throwable on the hotbar (e.g. hotbar.1), then right-click (use=1) to throw.",
      ].join(" ");
    case "sleep":
      return [
        "Task strategy: locate a bed, approach it, then right-click (use=1) on it. Only sleeps at night or in the Nether/End fails — assume night.",
      ].join(" ");
    default:
      return "";
  }
}

function isMiningLikeTask(taskText: string): boolean {
  return /mine|mining|dig|stone|cobble|diamond|iron|coal|ore|obsidian|dirt|wood|log|tree|grass|挖|礦|石|木|樹|草/.test(
    taskText.toLowerCase(),
  );
}

function isWoolTask(taskText: string): boolean {
  return /wool|shear|sheep|羊毛|剪羊|綿羊/.test(taskText.toLowerCase());
}

function isBuildingLikeTask(taskText: string): boolean {
  return /build|place|house|hut|tower|bridge|造|建|放置/.test(taskText.toLowerCase());
}

function hasPhysicalIntent(action: McuEnvAction): boolean {
  return (
    MCU_BUTTON_KEYS.some((key) => action[key] === 1) ||
    Math.abs(action.camera[0]) >= 0.1 ||
    Math.abs(action.camera[1]) >= 0.1
  );
}

function isCraftingLikeTask(taskText: string): boolean {
  return /craft|recipe|smelt|brew|enchant|furnace|crafting[_ ]?table|enchanting[_ ]?table|inventory|物品欄|合成|熔煉|釀造|附魔/i.test(
    taskText.toLowerCase(),
  );
}

function isDropLikeTask(taskText: string): boolean {
  return /\bdrop\b|throw|丟|扔|拋/i.test(taskText.toLowerCase());
}

function repairDecisionForTask(decision: McuPolicyDecision, taskText: string, step: number): McuPolicyDecision {
  const action = normalizeMcuAction(decision.action);

  const woolTask = isWoolTask(taskText);
  const miningLikeTask = isMiningLikeTask(taskText);
  const buildingLikeTask = isBuildingLikeTask(taskText);
  const craftingLikeTask = isCraftingLikeTask(taskText);
  const dropLikeTask = isDropLikeTask(taskText);

  if (!craftingLikeTask) {
    action.inventory = 0;
  }
  if (!dropLikeTask) {
    action.drop = 0;
  }

  if (woolTask && action.attack && !action.use) {
    action.attack = 0;
    action.use = 1;
  }

  if (miningLikeTask && !woolTask && !buildingLikeTask && !craftingLikeTask && action.use && !action.attack) {
    action.use = 0;
    action.attack = 1;
  }

  if (!hasPhysicalIntent(action)) {
    action.forward = miningLikeTask || woolTask ? 1 : 0;
    action.sprint = 0;
    action.camera = [0, step % 32 < 16 ? 8 : -8];
  }

  let holdSteps = decision.hold_steps;
  if (!holdSteps || holdSteps < 1) {
    holdSteps = action.attack ? 6 : action.use ? 2 : 3;
  }
  if (action.attack && /obsidian/.test(taskText.toLowerCase())) {
    holdSteps = Math.max(holdSteps, 10);
  }

  return {
    ...ACTION_PAYLOAD_PREFIX,
    hold_steps: holdSteps,
    action,
  };
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
      try {
        const decision = await this.handleObservation(contextId, payload as McuObservationPayload);
        return JSON.stringify(toCompactMcuAgentActionPayload(decision.action));
      } catch (error) {
        return JSON.stringify({
          type: "ack",
          success: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
      recentObservationImages: [],
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
      recentObservationImages: [],
    };
    this.contexts.set(contextId, state);

    const step = Math.max(0, Number.isFinite(payload.step) ? Number(payload.step) : 0);
    if (payload.obs) {
      state.recentObservationImages.push(payload.obs);
      state.recentObservationImages = state.recentObservationImages.slice(-3);
    }

    if (!this.config.openai.apiKey) {
      throw new Error("OPENAI_API_KEY or API_KEY is required for AgentBeats observations; heuristic fallback actions are disabled.");
    }
    if (state.recentObservationImages.length === 0) {
      throw new Error("AgentBeats observation image is required; heuristic fallback actions are disabled.");
    }

    if (step <= state.holdUntilStep && !shouldUseModelOnStep(step, this.config.agentbeats.modelEveryNSteps)) {
      return { ...ACTION_PAYLOAD_PREFIX, action: state.lastAction, hold_steps: 1 };
    }

    let decision = await this.modelDecision(state, step);
    decision = repairDecisionForTask(decision, state.taskText, step);

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

  private async modelDecision(state: McuContextState, step: number): Promise<McuPolicyDecision> {
    const imageParts = state.recentObservationImages.flatMap((obsBase64, index, images) => {
      const imageDataUrl = obsBase64.startsWith("data:image/") ? obsBase64 : `data:image/jpeg;base64,${obsBase64}`;
      const label = index === images.length - 1 ? "current frame" : `previous frame ${images.length - index - 1}`;
      return [
        {
          type: "text",
          text: `Image: ${label}.`,
        },
        {
          type: "image_url",
          image_url: {
            url: imageDataUrl,
            detail: "high",
          },
        },
      ];
    });
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
                taskSpecificGuidance(state.taskText),
                `Step: ${step}`,
                `Recent actions:\n${compactRecentActions(state.recentActions) || "none"}`,
                "Use visual evidence from the recent frames. Do not assume hidden map coordinates or benchmark-specific spawn layouts.",
                "Choose the next action from the image sequence. Output only the strict JSON action payload.",
              ].join("\n\n"),
            },
            ...imageParts,
          ],
        },
      ],
      max_completion_tokens: 1_200,
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
    let current = body;
    const seen = new Set<string>();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      seen.add(chatBodySignature(current));
      try {
        return await withRetry(this.config, "agentbeats.chat", () =>
          this.client.chat.completions.create(current as never),
        );
      } catch (error) {
        const message = formatModelProviderError(error).toLowerCase();
        const fallback = { ...current };

        if (
          message.includes("unsupported_parameter") &&
          message.includes("max_completion_tokens") &&
          "max_completion_tokens" in fallback
        ) {
          fallback.max_tokens = fallback.max_completion_tokens;
          delete fallback.max_completion_tokens;
          console.warn("[agentbeats] provider rejected max_completion_tokens; retrying with max_tokens.");
        } else if (
          message.includes("unsupported_parameter") &&
          message.includes("max_tokens") &&
          "max_tokens" in fallback
        ) {
          fallback.max_completion_tokens = fallback.max_tokens;
          delete fallback.max_tokens;
          console.warn("[agentbeats] provider rejected max_tokens; retrying with max_completion_tokens.");
        } else if (
          "response_format" in fallback &&
          (message.includes("response_format") || message.includes("schema") || message.includes("structured"))
        ) {
          delete fallback.response_format;
          console.warn("[agentbeats] provider rejected structured output; retrying MCU action request without response_format.");
        } else {
          throw error;
        }

        const signature = chatBodySignature(fallback);
        if (seen.has(signature)) {
          throw error;
        }
        current = fallback;
      }
    }

    try {
      return await withRetry(this.config, "agentbeats.chat.final", () =>
        this.client.chat.completions.create(current as never),
      );
    } catch (error) {
      const message = formatModelProviderError(error).toLowerCase();
      throw new Error(`AgentBeats chat completion failed after compatibility retries: ${message}`);
    }
  }
}
