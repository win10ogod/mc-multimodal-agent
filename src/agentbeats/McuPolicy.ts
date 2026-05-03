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
import {
  buildCraftOpenInventoryFrames,
  planClosedLoopCraft,
  servoCursorStep,
  type ClosedLoopCraftPlan,
  type UiFastControlFrame,
} from "./UiFastControl";
import { probeNextCraftAction } from "./InventoryProbe";
import { detectCursor, detectCursorHolding, detectGuiLayout, samplePatchFingerprint } from "./SlotDetector";

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
  pendingMacroFrames: UiFastControlFrame[];
  closedLoopCraft: ClosedLoopCraftPlan | null;
  /** Short labels of the most recent closed-loop probe actions (newest first),
   *  passed back to the VLM each iteration so it doesn't repeat itself. */
  closedLoopHistory: string[];
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
        "Task strategy: ingredients (and a crafting_table item if needed) are pre-given in inventory.",
        "Open inventory ONCE with inventory=1 (single frame); after it is open, do NOT press inventory again until you are done — repeated inventory presses just toggle the GUI off and waste steps.",
        "IMPORTANT: a CV-driven UI helper takes over cursor control automatically when the inventory is open for handled 2x2 recipes (oak_planks, crafting_table). Manual VLM cursor control runs at ~3% success rate. If the inventory is open and the helper is operating, emit a NO-OP action (no buttons pressed, camera=[0,0]) so the helper can run uninterrupted; do NOT issue camera deltas yourself.",
        "For 3x3 recipes (furnace, cake, enchanting_table, ladder, bell, diorite, clock, bee_nest, stonecut): you must FIRST place the crafting_table block in the world. Select the hotbar slot holding the crafting_table, tilt camera down so a clear ground tile is centered, use=1 to place it, then use=1 again on the placed block to open the 3x3 GUI before placing ingredients.",
        "Manual cursor control fallback (only for unhandled recipes): camera=[0,5] moves cursor right ~5, [0,-5] left, [5,0] down, [-5,0] up. use=1 places ONE item; attack=1 grabs/drops whole stack.",
        "Loop avoidance: if you have issued the same single button (inventory, use, or attack) for more than ~10 consecutive frames with camera=[0,0] and nothing has changed visibly, switch strategy — emit camera deltas, walk forward, or close the GUI and re-approach.",
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
  private readonly toolDrivers = new Map<string, import("./McuToolDriver").McuToolDriver>();

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
      if (this.config.agentbeats.useToolAgent) {
        return this.handleToolAgentInit(contextId, payload as McuInitPayload);
      }
      return this.handleInit(contextId, payload as McuInitPayload);
    }
    if (payload.type === "obs") {
      try {
        const decision = this.config.agentbeats.useToolAgent
          ? await this.handleToolAgentObservation(contextId, payload as McuObservationPayload)
          : await this.handleObservation(contextId, payload as McuObservationPayload);
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
    const closedLoopCraft = planClosedLoopCraft(taskText);
    const pendingMacroFrames: UiFastControlFrame[] = closedLoopCraft
      ? buildCraftOpenInventoryFrames(closedLoopCraft.target)
      : [];
    this.contexts.set(contextId, {
      taskText,
      promptText,
      lastAction: defaultMcuAction(),
      holdUntilStep: -1,
      recentActions: [],
      recentObservationImages: [],
      pendingMacroFrames,
      closedLoopCraft,
      closedLoopHistory: [],
    });
    console.log(
      `[agentbeats] init context=${contextId} task=${JSON.stringify(taskText)} closedLoop=${closedLoopCraft ? `${closedLoopCraft.target} ingredient=${closedLoopCraft.ingredient}` : "none"}`,
    );
    return JSON.stringify({
      type: "ack",
      success: true,
      message: "Initialization successful.",
    });
  }

  private async handleToolAgentInit(contextId: string, payload: McuInitPayload): Promise<string> {
    const { McuToolDriver } = await import("./McuToolDriver");
    const taskText = payload.text?.trim() || "";
    const promptText = payload.prompt?.trim() || "";
    const driver = new McuToolDriver({
      config: this.config,
      contextId,
      taskText,
      promptText,
    });
    this.toolDrivers.set(contextId, driver);
    console.log(`[agentbeats] tool-agent init context=${contextId} task=${JSON.stringify(taskText)}`);
    return JSON.stringify({ type: "ack", success: true, message: "Tool-agent initialized." });
  }

  private async handleToolAgentObservation(contextId: string, payload: McuObservationPayload): Promise<McuPolicyDecision> {
    let driver = this.toolDrivers.get(contextId);
    if (!driver) {
      const { McuToolDriver } = await import("./McuToolDriver");
      driver = new McuToolDriver({ config: this.config, contextId, taskText: "" });
      this.toolDrivers.set(contextId, driver);
    }
    const step = Math.max(0, Number.isFinite(payload.step) ? Number(payload.step) : 0);
    if (payload.obs) {
      driver.ingestObservation(payload.obs);
    }
    let decision: McuPolicyDecision;
    try {
      decision = await driver.step(step);
    } catch (error) {
      console.warn(`[agentbeats] tool-agent step failed: ${formatModelProviderError(error)}`);
      decision = { type: "action", action_type: "env", action: defaultMcuAction(), hold_steps: 1 };
    }
    const intents = driver.drainIntents();
    if (intents.length > 0) {
      console.log(`[agentbeats] tool-agent step=${step} intents=${intents.map((i) => i.kind).join(",")}`);
    }
    const holdSteps = Math.max(1, Math.min(this.config.agentbeats.maxHoldSteps, decision.hold_steps ?? this.config.agentbeats.defaultHoldSteps));
    return { ...decision, hold_steps: holdSteps };
  }

  private async handleObservation(contextId: string, payload: McuObservationPayload): Promise<McuPolicyDecision> {
    const state: McuContextState = this.contexts.get(contextId) ?? {
      taskText: "",
      promptText: "",
      lastAction: defaultMcuAction(),
      holdUntilStep: -1,
      recentActions: [],
      recentObservationImages: [],
      pendingMacroFrames: [],
      closedLoopCraft: null,
      closedLoopHistory: [],
    };
    this.contexts.set(contextId, state);

    const step = Math.max(0, Number.isFinite(payload.step) ? Number(payload.step) : 0);
    if (payload.obs) {
      state.recentObservationImages.push(payload.obs);
      state.recentObservationImages = state.recentObservationImages.slice(-3);
    }

    const emitMacroFrame = (frame: UiFastControlFrame): McuPolicyDecision => {
      const holdSteps = Math.max(
        1,
        Math.min(this.config.agentbeats.maxHoldSteps, frame.holdSteps),
      );
      state.lastAction = frame.action;
      state.holdUntilStep = step + holdSteps - 1;
      state.recentActions.push(frame.action);
      state.recentActions = state.recentActions.slice(-16);
      console.log(
        `[agentbeats] macro step=${step} hold=${holdSteps} ${frame.label} action=${JSON.stringify({
          pressed: MCU_BUTTON_KEYS.filter((key) => frame.action[key] === 1),
          camera: frame.action.camera,
        })}`,
      );
      return { ...ACTION_PAYLOAD_PREFIX, action: frame.action, hold_steps: holdSteps };
    };

    // Drain any queued macro frames first.
    if (state.pendingMacroFrames.length > 0) {
      const frame = state.pendingMacroFrames.shift()!;
      return emitMacroFrame(frame);
    }

    // Closed-loop crafting (Image-Based Visual Servoing):
    //   - Each obs: detect layout + cursor.
    //   - If no pendingClick: probe VLM for next action, set the click target.
    //   - With a pendingClick: emit ONE camera correction toward the slot,
    //     OR a click frame when the cursor is within tolerance of the target.
    //   - Repeats until VLM says "done" or iteration cap is hit.
    const plan = state.closedLoopCraft;
    if (plan && !plan.done && plan.iteration < plan.maxIterations && payload.obs) {
      // Each obs: detect the inventory window FRESH (CV-cheap) -- this is
      // how we know if the GUI is still open. If yes and we have a session
      // layout already, REUSE it so slot indices stay stable. If yes and
      // no session yet, capture one. If no window detected, RESET the
      // session (UI closed) and end the closed-loop.
      const liveLayout = detectGuiLayout(payload.obs, plan.layoutHint ?? undefined);
      if (!liveLayout) {
        console.log(`[agentbeats] closed-loop: inventory window no longer visible at step=${step}; resetting session`);
        plan.sessionLayout = null;
        plan.layoutHint = null;
        plan.pendingClick = null;
        plan.awaitingVerify = null;
        plan.done = true;
      } else if (plan.sessionLayout === null) {
        // First detection in this session -- lock it.
        plan.sessionLayout = liveLayout;
        plan.layoutHint = liveLayout.matchedLayoutId;
        console.log(`[agentbeats] closed-loop session locked: layout=${liveLayout.matchedLayoutId ?? "unknown"} slots=${liveLayout.slots.length}`);
      }
      const layout = (plan.sessionLayout as ReturnType<typeof detectGuiLayout> | null) ?? liveLayout;
      if (!layout) {
        // Already handled above (plan.done=true path)
      } else {
        const rawCursor = detectCursor(payload.obs, layout);
        // Stale-detection guard: the white-blob detector can latch onto a
        // static GUI feature (slot highlight, item icon) and report the
        // SAME pixel forever despite the sim moving the cursor. If the
        // last frame we emitted a non-zero camera delta and the new
        // reading is within 2px of the previous reading, treat the
        // detection as stale and pretend we don't see the cursor.
        const camLast = plan.lastEmittedCam;
        const camWasNonZero = Math.abs(camLast[0]) > 0 || Math.abs(camLast[1]) > 0;
        const sameAsLast = !!(rawCursor && plan.lastCursorRead
          && Math.abs(rawCursor.x - plan.lastCursorRead.x) <= 2
          && Math.abs(rawCursor.y - plan.lastCursorRead.y) <= 2);
        const isStale = camWasNonZero && sameAsLast;
        if (isStale) {
          plan.staleCursorFrames += 1;
          console.warn(`[agentbeats] stale cursor reading (${rawCursor?.x},${rawCursor?.y}) after cam=[${camLast[0]},${camLast[1]}] (${plan.staleCursorFrames}/3)`);
        } else {
          plan.staleCursorFrames = 0;
        }
        const cursor = isStale ? null : rawCursor;
        plan.lastCursorRead = rawCursor ?? plan.lastCursorRead;
        plan.cursor = cursor ?? plan.cursor;
        // Persistent staleness -> the detector is hopeless this round.
        // Abort the current pendingClick so the next probe replans rather
        // than spamming clicks on a phantom cursor position.
        if (plan.staleCursorFrames >= 3 && plan.pendingClick !== null) {
          console.warn(`[agentbeats] cursor detection stale for 3 frames; aborting pendingClick (${plan.pendingClick.kind ?? "click"} slot=${plan.pendingClick.rasterIndex}); invalidating SoM session for fresh detection`);
          state.closedLoopHistory.unshift(`abort slot=${plan.pendingClick.rasterIndex} (cursor detection stale; resetting SoM session)`);
          state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
          plan.pendingClick = null;
          plan.staleCursorFrames = 0;
          plan.lastEmittedCam = [0, 0];
          plan.lastCursorRead = null;
          // Invalidate the session-locked SoM layout so the next frame
          // re-runs detection from scratch. Keeps the closed-loop in
          // charge (manual LLM cursor control runs at ~3% success).
          plan.sessionLayout = null;
          plan.layoutHint = null;
          return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
        }

        // If we have no current click target, ask the VLM for one.
        if (plan.pendingClick === null) {
          // CV cursor-holding detection is unreliable: the offset patch
          // (cx+8, cy+8) routinely lands on a real inventory slot's
          // item icon and reports false "holding". Pass null and let
          // the VLM read held-item state visually from the SoM image.
          const cursorHolding = null;
          try {
            const result = await probeNextCraftAction({
              client: this.client,
              model: this.config.openai.model,
              obsBase64: payload.obs,
              taskTarget: plan.target,
              ingredient: plan.ingredient,
              iteration: plan.iteration,
              sessionLayout: layout, // session-locked; same marks all session
              recentActions: state.closedLoopHistory,
              cursorHolding,
              pickupSourceSlot: plan.pickupSourceSlot ?? null,
            });
            plan.iteration += 1;
            const probed = result.action;
            if (!probed) {
              // Probe failed to return an action — invalidate the SoM
              // session so the next frame redetects (some slots may have
              // been occluded the first time) and re-probes. Don't set
              // done: manual LLM cursor control runs at ~3% success.
              console.log(`[agentbeats] closed-loop probe returned no action; invalidating SoM session and reprobing next frame`);
              plan.sessionLayout = null;
              plan.layoutHint = null;
            } else if (probed.action === "done") {
              console.log(`[agentbeats] closed-loop probe says done reason=${probed.reason ?? ""}`);
              plan.done = true;
            } else if (probed.action === "fallback_manual") {
              console.log(`[agentbeats] closed-loop probe says fallback_manual reason=${probed.reason ?? ""} -- handing control to manual LLM cursor`);
              plan.done = true;
            } else {
              // Click semantics in MC inventory:
              //   pickup    -> attack (left-click): grab whole stack
              //   place_one -> use    (right-click): drop 1 item, keep rest
              //   place_all -> attack (left-click): drop whole stack
              //   take      -> attack (left-click). NOTE: shift+click is
              //                broken in the MCU sim, so we never use sneak
              //                here; the VLM is told to ensure cursor empty
              //                before issuing "take" or "pickup".
              const button: "attack" | "use" = probed.action === "place_one" ? "use" : "attack";
              const shift = false;
              const probedSlot = layout.slots[probed.slot];
              if (!probedSlot) {
                console.warn(`[agentbeats] probe returned slot ${probed.slot} but layout only has ${layout.slots.length}; skipping`);
              } else if (probed.action === "pickup" && cursorHolding === true) {
                // Hard guard: cursor is already carrying an item, so a
                // "pickup" would actually swap stacks and corrupt state.
                // Skip this probe; next iteration the VLM will see the
                // updated cursor_holding=yes hint and choose place_all.
                console.warn(`[agentbeats] probe asked for pickup at slot ${probed.slot} but CV says cursor is HOLDING; refusing -- will reprobe`);
                state.closedLoopHistory.unshift(`refused pickup slot=${probed.slot} (cursor not empty)`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              } else if (probed.action === "take" && cursorHolding === true) {
                console.warn(`[agentbeats] probe asked for take at slot ${probed.slot} but CV says cursor is HOLDING; refusing -- will reprobe`);
                state.closedLoopHistory.unshift(`refused take slot=${probed.slot} (cursor not empty)`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              } else {
                if (probed.action === "pickup") {
                  plan.pickupSourceSlot = { index: probed.slot, name: probedSlot.name };
                  console.log(`[agentbeats] recorded pickupSourceSlot=${probed.slot} (${probedSlot.name ?? "?"})`);
                }
                const expectAfter: "should_empty" | "should_fill" =
                  (probed.action === "place_one" || probed.action === "place_all") ? "should_fill" : "should_empty";
                plan.pendingClick = {
                  rasterIndex: probed.slot,
                  slotName: probedSlot.name,
                  slotRole: probedSlot.role,
                  frozenTarget: { x: probedSlot.cx, y: probedSlot.cy },
                  button,
                  shift,
                  expectAfter,
                  phase: "servo",
                  retries: 0,
                  kind: "click",
                };
                plan.servoSteps = 0;
                state.closedLoopHistory.unshift(`${probed.action} slot=${probed.slot}${probedSlot.name ? `(${probedSlot.name})` : ""}`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                console.log(
                  `[agentbeats] closed-loop probe iter=${plan.iteration}: ${probed.action} slot=${probed.slot} name=${probedSlot.name ?? "?"} reason=${probed.reason ?? ""}`,
                );
              }
            }
          } catch (error) {
            console.warn(`[agentbeats] closed-loop probe failed: ${formatModelProviderError(error)} -- ending closed-loop`);
            plan.done = true;
          }
        }

        // Click state machine: servo -> fired -> moveAway -> verify ->
        // (success: clear & next probe | fail: retry up to MAX_RETRIES).
        if (plan.pendingClick !== null && !plan.done) {
          const pc = plan.pendingClick;
          // Resolve current target slot pixel by semantic name (stable
          // across frames even when raster indices shift).
          const resolveSlot = (): { cx: number; cy: number } => {
            if (pc.slotName) {
              const f = layout.slots.find((s) => s.name === pc.slotName);
              if (f) return { cx: f.cx, cy: f.cy };
            }
            if (pc.slotRole) {
              const f = layout.slots.find((s) => s.role === pc.slotRole);
              if (f) return { cx: f.cx, cy: f.cy };
            }
            const f = layout.slots[pc.rasterIndex];
            if (f) return { cx: f.cx, cy: f.cy };
            return { cx: pc.frozenTarget.x, cy: pc.frozenTarget.y };
          };
          const slotCenter = resolveSlot();

          // Safe spot to move cursor to for verification: somewhere
          // inside the inventory window away from the just-clicked slot.
          // Use a corner of the window opposite to the slot.
          const safeSpot = {
            x: slotCenter.cx > layout.windowX + layout.windowW / 2
              ? layout.windowX + 8
              : layout.windowX + layout.windowW - 8,
            y: layout.windowY + layout.windowH - 8,
          };

          const SERVO_STEP_CAP = 10;
          const MAX_RETRIES = 2;
          const HIT_THRESHOLD_PX = 5;

          // Helper: emit a closed-loop action and remember the cam delta
          // so the next frame's stale-cursor check has ground truth.
          const emit = (action: McuEnvAction): McuPolicyDecision => {
            plan.lastEmittedCam = [action.camera[0], action.camera[1]];
            return { ...ACTION_PAYLOAD_PREFIX, action, hold_steps: 1 };
          };

          // === Phase: servo === move cursor to slot, then click
          if (pc.phase === "servo") {
            const stepResult = servoCursorStep({
              cursor,
              target: { x: slotCenter.cx, y: slotCenter.cy },
              button: pc.button,
              shift: pc.shift,
              hitThresholdPx: HIT_THRESHOLD_PX,
            });
            plan.servoSteps += 1;
            const shouldClickNow = plan.servoSteps > SERVO_STEP_CAP || (stepResult && stepResult.click);
            if (shouldClickNow) {
              pc.prePatch = samplePatchFingerprint(payload.obs, slotCenter.cx, slotCenter.cy) ?? undefined;
              const action = defaultMcuAction();
              action[pc.button] = 1;
              if (pc.shift) action.sneak = 1;
              pc.phase = "fired";
              plan.servoSteps = 0;
              console.log(`[agentbeats] click ${pc.slotName ?? pc.rasterIndex} (${pc.button}${pc.shift ? "+sneak" : ""}) prePatch.stddev=${pc.prePatch?.stddev.toFixed(1) ?? "?"}`);
              return emit(action);
            }
            if (stepResult) {
              console.log(
                `[agentbeats] servo step=${step} cursor=(${cursor?.x},${cursor?.y}) target=(${slotCenter.cx},${slotCenter.cy}) name=${pc.slotName ?? "?"} ${stepResult.reason}`,
              );
              return emit(stepResult.action);
            }
            console.log(`[agentbeats] servo step=${step}: no cursor detected; noop`);
            return emit(defaultMcuAction());
          }

          // === Phase: fired === one settle frame to let the click apply
          if (pc.phase === "fired") {
            pc.phase = "moveAway";
            plan.servoSteps = 0;
            console.log(`[agentbeats] click settled; moving cursor away from ${pc.slotName ?? pc.rasterIndex} for verify`);
            return emit(defaultMcuAction());
          }

          // === Phase: moveAway === servo cursor to safe spot
          if (pc.phase === "moveAway") {
            const stepResult = servoCursorStep({
              cursor,
              target: safeSpot,
              button: "attack",
              hitThresholdPx: HIT_THRESHOLD_PX,
            });
            plan.servoSteps += 1;
            const distFromSafe = cursor ? Math.hypot(cursor.x - safeSpot.x, cursor.y - safeSpot.y) : 999;
            const arrived = distFromSafe < 12 || plan.servoSteps > SERVO_STEP_CAP;
            if (arrived) {
              pc.phase = "verify";
              console.log(`[agentbeats] cursor at safe spot (${cursor?.x},${cursor?.y}); next frame will verify`);
              return emit(defaultMcuAction());
            }
            if (stepResult && !stepResult.click) {
              return emit(stepResult.action);
            }
            return emit(defaultMcuAction());
          }

          // === Phase: verify === sample target slot patch, decide
          if (pc.phase === "verify") {
            const post = samplePatchFingerprint(payload.obs, slotCenter.cx, slotCenter.cy);
            if (!post) {
              console.warn(`[agentbeats] verify: could not sample patch; assuming success`);
              plan.pendingClick = null;
              return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
            }
            const isEmpty = post.stddev < 25;
            const isFilled = post.stddev > 35;
            const matched = pc.expectAfter === "should_empty" ? isEmpty : isFilled;
            console.log(
              `[agentbeats] verify ${pc.slotName ?? pc.rasterIndex}: post.stddev=${post.stddev.toFixed(1)} expect=${pc.expectAfter} -> ${matched ? "OK" : "MISMATCH"} (retry ${pc.retries}/${MAX_RETRIES})`,
            );
            if (matched) {
              state.closedLoopHistory.unshift(`${pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} OK`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              plan.pendingClick = null;
              return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
            }
            // Mismatch path
            if (pc.retries < MAX_RETRIES) {
              pc.retries += 1;
              pc.phase = "servo";
              plan.servoSteps = 0;
              console.log(`[agentbeats] RETRY click on ${pc.slotName ?? pc.rasterIndex} (attempt ${pc.retries + 1}/${MAX_RETRIES + 1})`);
              return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
            }
            // Retries exhausted. If we were already running a cleanup
            // click, give up entirely and surface to the LLM. Otherwise
            // schedule a cleanup: place_all back to the original pickup
            // source slot (or the first empty main_inv if no source) so
            // the cursor is empty before the next LLM probe.
            const failureLabel = `${pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} FAILED post.stddev=${post.stddev.toFixed(0)}`;
            state.closedLoopHistory.unshift(failureLabel);
            state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            console.warn(`[agentbeats] ${failureLabel}; retries exhausted`);
            const cursorHoldingNow = detectCursorHolding(payload.obs, plan.cursor);
            if (pc.kind !== "cleanup" && cursorHoldingNow === true) {
              // Pick a target for the cleanup click: prefer the original
              // pickup source slot (returns leftover ingredient there), else
              // the first empty main_inv slot.
              let cleanupTarget: typeof layout.slots[number] | null = null;
              if (plan.pickupSourceSlot && plan.pickupSourceSlot.name) {
                cleanupTarget = layout.slots.find((s) => s.name === plan.pickupSourceSlot!.name) ?? null;
              }
              if (!cleanupTarget) {
                for (const s of layout.slots) {
                  if (s.role !== "main_inv") continue;
                  const patch = samplePatchFingerprint(payload.obs, s.cx, s.cy);
                  if (patch && patch.stddev < 25) { cleanupTarget = s; break; }
                }
              }
              if (cleanupTarget) {
                console.log(`[agentbeats] CLEANUP: place_all into ${cleanupTarget.name ?? cleanupTarget.index} before reprobing`);
                plan.pendingClick = {
                  rasterIndex: cleanupTarget.index,
                  slotName: cleanupTarget.name,
                  slotRole: cleanupTarget.role,
                  frozenTarget: { x: cleanupTarget.cx, y: cleanupTarget.cy },
                  button: "attack",
                  shift: false,
                  expectAfter: "should_fill",
                  phase: "servo",
                  retries: 0,
                  kind: "cleanup",
                };
                plan.servoSteps = 0;
                return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
              }
              console.warn(`[agentbeats] CLEANUP: no viable target; surfacing to LLM`);
            }
            // Either cursor empty already, or cleanup itself failed, or no
            // target — clear and let the next probe replan from scratch.
            plan.pendingClick = null;
            return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
          }

        }
      }
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
