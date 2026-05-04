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
  parseTargetItem,
  planClosedLoopCraft,
  servoCursorStep,
  type ClosedLoopCraftPlan,
  type UiFastControlFrame,
} from "./tools/UiFastControl";
import { probeNextCraftAction, vlmVerifySlotState } from "./tools/InventoryProbe";
import { detectCursorWithExpectation, detectGuiLayout, samplePatchFingerprint } from "./tools/SlotDetector";
import { getDebugRecorder } from "./tools/DebugRecorder";
import { dispatchObservation } from "./agents/Dispatcher";
import type { EpisodeState, SubAgent, SubAgentKind } from "./agents/SubAgent";
import { makeEpisodeState } from "./agents/SubAgent";
import { createWorldExplorer } from "./agents/subagents/WorldExplorer";
import { createMining } from "./agents/subagents/Mining";
import { createCombat } from "./agents/subagents/Combat";
import { createPlacing } from "./agents/subagents/Placing";

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
  /** When true, the policy emits no-op actions without calling the
   *  VLM for the rest of the episode. Set by the closed-loop probe
   *  saying "done". The benchmark can't be told to early-end, but
   *  this saves API budget for the remaining steps. */
  earlyStop: boolean;
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

export function parseMcuActionText(text: string): (McuPolicyDecision & { task_done?: boolean }) | undefined {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const actionSource = isRecord(parsed.action) ? parsed.action : parsed;
      const hold = Number.parseInt(String(parsed.hold_steps ?? parsed.holdSteps ?? ""), 10);
      const taskDone = parsed.task_done === true || parsed.taskDone === true;
      return {
        ...ACTION_PAYLOAD_PREFIX,
        hold_steps: Number.isFinite(hold) ? hold : undefined,
        action: normalizeMcuAction(actionSource),
        task_done: taskDone,
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
        "DONE CONDITION (CRITICAL): set task_done=true ONLY when the requested crafted item is VISIBLE in your MAIN INVENTORY GRID or HOTBAR row. The result slot inside the crafting GUI does NOT count -- the item is not yours until you take it out AND store it in an inventory slot. A common mistake: seeing oak_planks appear in the small result slot to the right of the 2x2 grid and immediately declaring done. That is wrong -- the planks must be moved into a real inventory slot first. If you only see the item in the result slot, keep working: take it out and place it in the inventory.",
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
  private readonly episodes = new Map<string, EpisodeState>();

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
    // Try to derive a sensible "open inventory" macro target from the
    // task. Crafting tasks get the recipe target as a hint; non-crafting
    // tasks (which still benefit from closed-loop UI control once a GUI
    // opens) just press inventory once and let the regular VLM path
    // drive any out-of-inventory steps. parseTargetItem returns null
    // for tasks that don't match the "craft X" pattern.
    const inventoryHintTarget = (() => {
      try {
        return parseTargetItem(taskText) ?? "";
      } catch { return ""; }
    })();
    const pendingMacroFrames: UiFastControlFrame[] = inventoryHintTarget
      ? buildCraftOpenInventoryFrames(inventoryHintTarget)
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
      earlyStop: false,
    });
    console.log(
      `[agentbeats] init context=${contextId} task=${JSON.stringify(taskText)} closedLoop=${closedLoopCraft ? "enabled" : "disabled"}`,
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
      earlyStop: false,
    };
    this.contexts.set(contextId, state);

    // ── MCU_USE_PLANNER gated branch ──────────────────────────────────────
    // When MCU_USE_PLANNER=1: run the planner/dispatcher BEFORE the existing
    // closed-loop body. When the gate is off (default), this block is skipped
    // entirely and behavior is byte-identical to the previous implementation.
    const usePlanner = process.env.MCU_USE_PLANNER === "1";
    if (usePlanner) {
      // Lazy-init episode for this contextId
      let episode = this.episodes.get(contextId);
      if (!episode) {
        const taskText = state.taskText || ((payload as any)?.task ?? "");
        episode = makeEpisodeState(taskText);
        this.episodes.set(contextId, episode);
      }

      // First-time plan
      if (episode.subgoals.length === 0) {
        const { planGoals } = await import("./agents/GoalPlanner");
        const out = await planGoals(
          { client: this.client, model: this.config.openai.model },
          episode.taskText,
          [],
        );
        if (out.overall_done) {
          episode.earlyStop = true;
          state.earlyStop = true;
          return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: this.config.agentbeats.maxHoldSteps };
        }
        episode.subgoals = out.subgoals;
        episode.singleTask = out.subgoals.length === 1;
      }

      const currentSubgoal = episode.subgoals[episode.idx];
      // Single-task ui_inventory bypass: fall through to existing closed-loop body unchanged.
      // Multi-subgoal first-step that is NOT ui_inventory: route through dispatcher with stub world sub-agents.
      if (!episode.singleTask && currentSubgoal && currentSubgoal.kind !== "ui_inventory") {
        const worldDeps = { client: this.client, model: this.config.openai.model };
        const subagents: Record<SubAgentKind, SubAgent> = {
          ui_inventory: { kind: "ui_inventory", systemPrompt: "", step: async () => ({ kind: "subgoal_failed", reason: "ui_inventory bridge not yet wired" }) },
          world_explore: createWorldExplorer(worldDeps),
          mining: createMining(worldDeps),
          combat: createCombat(worldDeps),
          placing: createPlacing(worldDeps),
        };
        const result = await dispatchObservation(
          {
            client: this.client,
            plannerModel: this.config.openai.model,
            subagents,
            runClosedLoopStep: async () => ({ kind: "subgoal_failed", reason: "closed-loop bridge not yet wired" }),
          },
          episode,
          { imageBase64: payload.obs ?? "", contextId },
        );
        if (episode.earlyStop) {
          state.earlyStop = true;
        }
        return { ...ACTION_PAYLOAD_PREFIX, action: result.action, hold_steps: result.holdSteps };
      }
      // else: single-task ui_inventory (or multi-task with ui_inventory first) —
      // fall through to the existing closed-loop body unchanged.
    }
    // ── end MCU_USE_PLANNER gated branch ──────────────────────────────────

    const step = Math.max(0, Number.isFinite(payload.step) ? Number(payload.step) : 0);

    // VLM-driven early stop: when the model previously set task_done=true,
    // do not call it again for the rest of the episode. Emit a dummy
    // no-op action each step. The benchmark cannot be early-ended by
    // the agent, but skipping API calls saves significant cost while
    // the env burns through its remaining max_steps.
    if (state.earlyStop) {
      return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: this.config.agentbeats.maxHoldSteps };
    }

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
        const cursor = detectCursorWithExpectation(payload.obs, layout, null);
        plan.cursor = cursor ?? plan.cursor;

        // Park the cursor in a clear left-side spot before each new
        // probe. This is REQUIRED so the VLM can clearly see whether
        // the cursor is carrying an item (held-item icon overlays the
        // cursor sprite). With the cursor anywhere over a slot, the
        // VLM cannot tell holding vs not-holding from the image alone.
        if (plan.pendingClick === null) {
          // Skip park if a previous "hover" action requested it (cursor
          // is intentionally on the slot the VLM wants to inspect so
          // MC's tooltip renders in the next probe image).
          if (plan.skipNextPark) {
            plan.skipNextPark = false;
            plan.parkSteps = 0;
            console.log(`[agentbeats] skipNextPark consumed; cursor stays at current spot for probe`);
            // OCR-on-settle: a verify_slots batch has cursor parked on
            // a slot; tooltip should be rendered. Read it, record memory,
            // advance the queue. After the last slot, servo back to the
            // park position before returning control to the main probe.
            if (plan.pendingTooltipRead) {
              const { readTooltip } = await import("./tools/SlotOcr");
              const target = plan.pendingTooltipRead;
              try {
                const r = await readTooltip({
                  client: this.client,
                  model: this.config.openai.model,
                  obsBase64: payload.obs ?? "",
                  slotPos: { x: target.x, y: target.y },
                  slotName: target.slotName,
                });
                // No retry: MC does not render a slot tooltip while
                // the cursor is holding an item; an "empty" reply in
                // that situation is the tooltip being suppressed, not
                // a transient miss, so retrying would hit the same
                // result. The agent must clear the cursor and re-issue
                // verify_slots if it really wants to inspect.
                const slotPatch = samplePatchFingerprint(payload.obs ?? "", target.x, target.y, 6) ?? undefined;
                plan.slotMemory.record(target.x, target.y, r.item, plan.iteration, slotPatch);
                console.log(`[agentbeats] slot_ocr slot=${target.slotIndex}(${target.slotName ?? "?"}) -> ${r.item}${slotPatch ? ` fp=${slotPatch.stddev.toFixed(1)}` : ""}`);
              } catch (e) {
                console.warn(`[agentbeats] slot OCR failed: ${e instanceof Error ? e.message : String(e)}`);
              }
              plan.pendingTooltipRead = null;
            }
            // Advance the OCR batch.
            if (plan.pendingOcrBatch) {
              if (plan.pendingOcrBatch.parking) {
                // Cursor just finished parking; batch complete.
                console.log(`[agentbeats] verify_slots batch complete (parked)`);
                plan.pendingOcrBatch = null;
                // Fall through to probe.
              } else {
                plan.pendingOcrBatch.idx += 1;
                if (plan.pendingOcrBatch.idx < plan.pendingOcrBatch.slots.length) {
                  const next = plan.pendingOcrBatch.slots[plan.pendingOcrBatch.idx];
                  plan.pendingClick = {
                    rasterIndex: next.slot, slotName: next.name, slotRole: undefined,
                    frozenTarget: { x: next.x, y: next.y },
                    button: "attack", shift: false, expectAfter: "should_fill",
                    phase: "servo", retries: 0, kind: "hover" as "click",
                    actionKind: "pickup" as "pickup",
                  };
                  plan.servoSteps = 0;     // critical: new servo starts fresh, not under prior cap
                  plan.skipNextPark = true;
                  plan.pendingTooltipRead = { slotIndex: next.slot, x: next.x, y: next.y, slotName: next.name };
                  console.log(`[agentbeats] verify_slots OCR advance idx=${plan.pendingOcrBatch.idx}/${plan.pendingOcrBatch.slots.length} slot=${next.slot}`);
                  return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
                }
                // All slots OCR'd. Move cursor back to park position so
                // the next probe sees a clean cursor (not lingering on a
                // real slot which would change tooltip / risk a click).
                const parkSpot = { x: layout.windowX + 4, y: layout.windowY + 4 };
                plan.pendingClick = {
                  rasterIndex: -1, slotName: "park", slotRole: undefined,
                  frozenTarget: parkSpot,
                  button: "attack", shift: false, expectAfter: "should_fill",
                  phase: "servo", retries: 0, kind: "hover" as "click",
                  actionKind: "pickup" as "pickup",
                };
                plan.servoSteps = 0;
                plan.skipNextPark = true;
                plan.pendingOcrBatch.parking = true;
                console.log(`[agentbeats] verify_slots OCR done; servoing cursor to park (${parkSpot.x},${parkSpot.y})`);
                return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
              }
            }
          } else {
          const PARK_STEP_CAP = 6;
          // Park at the TOP-LEFT corner of the window. Cursor sprite
          // tip at (parkSpot) extends down-right ~10x14 px into the
          // window header area where no inventory slots live. The
          // previous park (windowX+8, windowH/2) put the cursor right
          // ON main_inv_0 in the player_inventory layout, which then
          // contaminated every pre-check sample of that slot
          // (cursor + held-item pixels read as "filled" stddev~137).
          const parkSpot = {
            x: layout.windowX + 4,
            y: layout.windowY + 4,
          };
          const distFromPark = cursor ? Math.hypot(cursor.x - parkSpot.x, cursor.y - parkSpot.y) : Infinity;
          if (distFromPark > 12 && plan.parkSteps < PARK_STEP_CAP) {
            const stepResult = servoCursorStep({
              cursor,
              target: parkSpot,
              button: "attack",
              hitThresholdPx: 8,
            });
            if (stepResult && !stepResult.click) {
              plan.parkSteps += 1;
              console.log(`[agentbeats] park step=${plan.parkSteps}/${PARK_STEP_CAP}: cursor=(${cursor?.x},${cursor?.y}) -> (${parkSpot.x},${parkSpot.y}) ${stepResult.reason}`);
              return { ...ACTION_PAYLOAD_PREFIX, action: stepResult.action, hold_steps: 1 };
            }
          }
          if (plan.parkSteps >= PARK_STEP_CAP) {
            console.warn(`[agentbeats] park step cap reached (${plan.parkSteps}); proceeding to probe with cursor at (${cursor?.x},${cursor?.y})`);
          }
          plan.parkSteps = 0;
          } // end skipNextPark gate
          // Re-SOM only NOW, just before calling the VLM. Within an
          // in-flight click sequence the layout stays stable (we keep
          // using the locked session); fresh detection only matters at
          // the moment the VLM is about to make a new decision.
          let layoutForProbe = layout;
          {
            const fresh = detectGuiLayout(payload.obs, plan.layoutHint ?? undefined);
            if (fresh) {
              plan.sessionLayout = fresh;
              plan.layoutHint = fresh.matchedLayoutId;
              layoutForProbe = fresh;
              console.log(`[agentbeats] re-detected SoM for fresh probe: ${fresh.matchedLayoutId ?? "unknown"} slots=${fresh.slots.length}`);
            }
          }
          // CV cursor-holding detection: sample a small patch at the
          // cursor's actual pixel position. An empty cursor is mostly
          // the arrow sprite (a few light pixels on background) -> low
          // stddev. A holding cursor adds a 10x10 item-icon overlay
          // near the cursor -> high stddev. The previous "(cx+8,cy+8)"
          // offset version landed on neighbor slots and reported false
          // positives; sampling AT the cursor avoids that.
          const cursorHolding: boolean | null = (() => {
            if (!cursor) return null;
            const patch = samplePatchFingerprint(payload.obs, cursor.x, cursor.y, 5);
            if (!patch) return null;
            // Empty cursor patches measure stddev ~ 10-25; holding
            // with an item icon measures > 40 in observed runs.
            if (patch.stddev > 40) return true;
            if (patch.stddev < 25) return false;
            return null;  // ambiguous band
          })();
          try {
            // Build slot-memory snapshot keyed to current raster indices so
            // the probe sees "slot 1 = cobblestone (read 4 iters ago)" etc.
            // Each detected slot's absolute pixel pos is looked up in
            // slotMemory; matched entries become the probe's known-contents
            // hint, freeing the agent from re-hovering identified slots.
            plan.slotMemory.pruneStale(plan.iteration);
            const knownSlots: Array<{ index: number; name?: string; item: string; ageIters: number }> = [];
            for (const s of layoutForProbe.slots) {
              const mem = plan.slotMemory.lookup(s.cx, s.cy);
              if (mem && mem.item !== "empty" && mem.item !== "unknown") {
                knownSlots.push({ index: s.index, name: s.name, item: mem.item, ageIters: plan.iteration - mem.step });
              }
            }
            const result = await probeNextCraftAction({
              client: this.client,
              model: this.config.openai.model,
              obsBase64: payload.obs,
              taskText: plan.taskText,
              iteration: plan.iteration,
              sessionLayout: layoutForProbe, // freshly redetected for each probe
              recentActions: state.closedLoopHistory,
              cursorHolding,
              pickupSourceSlot: plan.pickupSourceSlot ?? null,
              knownSlots,
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
              // CV-verify the probe's "done" claim: the result slot
              // must actually be empty AND the cursor must be empty
              // (we use cursorItemSignature == null as proxy). If
              // accepted, set plan.done so control falls through to
              // the regular VLM which can then set task_done.
              const resultSlot = layoutForProbe.slots.find((s) => s.role === "result");
              const resultPatch = resultSlot ? samplePatchFingerprint(payload.obs, resultSlot.cx, resultSlot.cy, 12) : null;
              const resultEmpty = !!resultPatch && resultPatch.stddev < 25;
              const cursorEmpty = plan.cursorItemSignature === null;
              if (resultEmpty && cursorEmpty) {
                console.log(`[agentbeats] closed-loop probe says done; CV-verified (result empty, cursor empty); accepting`);
                plan.done = true;
              } else {
                console.warn(`[agentbeats] closed-loop probe said done but CV-verify failed (resultEmpty=${resultEmpty}, cursorEmpty=${cursorEmpty}); ignoring`);
                state.closedLoopHistory.unshift(`done IGNORED (resultEmpty=${resultEmpty}, cursorEmpty=${cursorEmpty})`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              }
            } else if (probed.action === "fallback_manual") {
              console.log(`[agentbeats] closed-loop probe says fallback_manual reason=${probed.reason ?? ""} -- handing control to manual LLM cursor`);
              plan.done = true;
            } else if (probed.action === "move") {
              // High-level atomic move: pickup `from` -> place at `to`
              // -> auto-return remainder to `from` (when count=one).
              // Build the click chain; first click goes to pendingClick,
              // rest queue in plan.pendingChain and promote on verify.
              const fromSlot = layoutForProbe.slots[probed.from];
              const toSlot = layoutForProbe.slots[probed.to];
              const movingWholeStack = (probed.count ?? "one") === "all";
              // Refuse swap: when count=all (whole-stack place into to=B)
              // and B is CV-detected as already filled (stddev > 35),
              // refuse the move. Placing on a filled slot triggers a
              // destructive item swap. Skip this guard for from==to
              // (legit auto-return to a slot we just emptied).
              const destPatch = (toSlot && fromSlot && fromSlot.name !== toSlot.name && movingWholeStack)
                ? samplePatchFingerprint(payload.obs, toSlot.cx, toSlot.cy, 12)
                : null;
              // Same-item stacking allowance: if the destination is
              // filled BUT its color signature matches what the cursor
              // is currently carrying (cursorItemSignature recorded at
              // last pickup), the click will STACK same-item piles in
              // MC -- not swap. Allow it.
              const sigDist = (destPatch && plan.cursorItemSignature)
                ? Math.hypot(
                    destPatch.meanR - plan.cursorItemSignature.meanR,
                    destPatch.meanG - plan.cursorItemSignature.meanG,
                    destPatch.meanB - plan.cursorItemSignature.meanB,
                  )
                : null;
              const destSameItem = sigDist !== null && sigDist < 30;
              const destLooksFilled = !!destPatch && destPatch.stddev > 35 && !destSameItem;
              const dbgPre = getDebugRecorder();
              if (dbgPre.isEnabled() && destPatch && toSlot) {
                dbgPre.record({
                  type: "pre_check_move",
                  iteration: plan.iteration,
                  step,
                  data: {
                    from: { index: probed.from, name: fromSlot?.name },
                    to: { index: probed.to, name: toSlot.name, cx: toSlot.cx, cy: toSlot.cy },
                    count: probed.count,
                    destPatch: { meanR: destPatch.meanR, meanG: destPatch.meanG, meanB: destPatch.meanB, stddev: destPatch.stddev },
                    decision: destLooksFilled ? "REFUSE_FILLED" : "PROCEED",
                  },
                }, payload.obs, "jpg");
              }
              if (!fromSlot || !toSlot) {
                console.warn(`[agentbeats] move from=${probed.from} to=${probed.to}: slot(s) not in layout (have ${layoutForProbe.slots.length}); skipping`);
              } else if (destLooksFilled) {
                console.warn(`[agentbeats] move to=${probed.to}(${toSlot.name ?? "?"}) refused: destination looks FILLED (stddev=${destPatch!.stddev.toFixed(1)} > 35); place_all here would trigger an item swap. Reprobe`);
                state.closedLoopHistory.unshift(`refused move to=${probed.to}(${toSlot.name ?? "?"}) (destination already has an item; pick a visually empty slot)`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              } else if (
                plan.pickupSourceSlot
                && plan.pickupSourceSlot.name
                && toSlot.name === plan.pickupSourceSlot.name
                && fromSlot.name !== plan.pickupSourceSlot.name
              ) {
                // Hard guard: VLM is asking to dump cursor contents into
                // the slot we just refilled with the original ingredient
                // via auto-return. This always triggers an item swap
                // (e.g. crafted planks <-> log stack). Refuse and force
                // the VLM to pick a different empty slot. Exception:
                // a self-move (from==to) is the legit auto-return itself.
                console.warn(`[agentbeats] move to=${probed.to}(${toSlot.name}) refused: that's the recorded pickup source slot which still holds the original ingredient -- placing here would swap items. Reprobe`);
                state.closedLoopHistory.unshift(`refused move to=${probed.to}(${toSlot.name}) (would swap with returned ingredient stack)`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              } else {
                const mkClick = (s: { index: number; name?: string; role?: string; cx: number; cy: number }, button: "attack" | "use", expectAfter: "should_empty" | "should_fill", actionKind: "pickup" | "place_one" | "place_all" | "take", kind: "click" | "auto_return"): import("./tools/UiFastControl").PendingClick => ({
                  rasterIndex: s.index, slotName: s.name, slotRole: s.role,
                  frozenTarget: { x: s.cx, y: s.cy },
                  button, shift: false, expectAfter,
                  phase: "servo", retries: 0, kind, actionKind,
                });
                const chain: import("./tools/UiFastControl").PendingClick[] = [];
                chain.push(mkClick(fromSlot, "attack", "should_empty", "pickup", "click"));
                if (probed.count === "all") {
                  chain.push(mkClick(toSlot, "attack", "should_fill", "place_all", "click"));
                } else {
                  chain.push(mkClick(toSlot, "use", "should_fill", "place_one", "click"));
                  chain.push(mkClick(fromSlot, "attack", "should_fill", "place_all", "auto_return"));
                }
                // Only record pickupSourceSlot when picking from a real
                // ingredient source (hotbar/main_inv). Moves whose source
                // is the result slot or a craft grid slot must NOT
                // overwrite the recorded source -- that source is the
                // slot we need to AVOID dumping crafted output into.
                const fromIsIngredientSource =
                  fromSlot.role === "hotbar" || fromSlot.role === "main_inv";
                if (fromIsIngredientSource) {
                  plan.pickupSourceSlot = { index: fromSlot.index, name: fromSlot.name };
                  console.log(`[agentbeats] recorded pickupSourceSlot=${fromSlot.index} (${fromSlot.name ?? "?"}) for move`);
                }
                plan.pendingClick = chain.shift()!;
                plan.pendingChain = chain;
                plan.servoSteps = 0;
                state.closedLoopHistory.unshift(`move ${fromSlot.name ?? probed.from} -> ${toSlot.name ?? probed.to} (count=${probed.count ?? "one"})`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                console.log(`[agentbeats] closed-loop probe iter=${plan.iteration}: move from=${probed.from}(${fromSlot.name ?? "?"}) to=${probed.to}(${toSlot.name ?? "?"}) count=${probed.count ?? "one"} reason=${probed.reason ?? ""}; chain=${chain.length + 1} clicks`);
              }
            } else if (probed.action === "put") {
              const dest = layoutForProbe.slots[probed.slot];
              // Same swap guard as for move count=all: refuse if dest looks filled.
              if (dest) {
                const putPatch = samplePatchFingerprint(payload.obs, dest.cx, dest.cy, 12);
                if (putPatch && putPatch.stddev > 35) {
                  console.warn(`[agentbeats] put slot=${probed.slot}(${dest.name ?? "?"}) refused: destination looks FILLED (stddev=${putPatch.stddev.toFixed(1)} > 35); would trigger an item swap. Reprobe`);
                  state.closedLoopHistory.unshift(`refused put slot=${probed.slot}(${dest.name ?? "?"}) (destination already has an item; pick a visually empty slot)`);
                  state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                  // Skip building the click; fall through to next obs which reprobes.
                  return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
                }
              }
              if (!dest) {
                console.warn(`[agentbeats] put slot=${probed.slot}: not in layout; skipping`);
              } else {
                plan.pendingClick = {
                  rasterIndex: dest.index, slotName: dest.name, slotRole: dest.role,
                  frozenTarget: { x: dest.cx, y: dest.cy },
                  button: "attack", shift: false, expectAfter: "should_fill",
                  phase: "servo", retries: 0, kind: "click", actionKind: "place_all",
                };
                plan.pendingChain = [];
                plan.servoSteps = 0;
                state.closedLoopHistory.unshift(`put -> ${dest.name ?? probed.slot}`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                console.log(`[agentbeats] closed-loop probe iter=${plan.iteration}: put slot=${probed.slot}(${dest.name ?? "?"}) reason=${probed.reason ?? ""}`);
              }
            } else if (probed.action === "verify_slots") {
              // Guard: MC suppresses slot tooltips while the cursor
              // holds an item (the held-item label is shown instead),
              // so OCR would return "empty" for every slot. Refuse the
              // batch and tell the agent to clear the cursor first.
              if (cursorHolding === true) {
                state.closedLoopHistory.unshift(`verify_slots refused: cursor is holding an item; clear cursor first`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                console.warn(`[agentbeats] verify_slots refused: cursor is holding an item (CV); tooltips are suppressed`);
                return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
              }
              // verify_slots: hover cursor on each requested slot in
              // sequence, OCR the rendered tooltip, write SlotMemory,
              // then park the cursor before returning to the probe.
              // CV stddev fast-path lets visually-empty slots short-
              // circuit with zero cursor movement and zero LLM cost.
              const queue = probed.slots
                .map((s) => {
                  const d = layoutForProbe.slots[s];
                  return d ? { slot: s, x: d.cx, y: d.cy, name: d.name } : null;
                })
                .filter((e): e is NonNullable<typeof e> => e !== null);
              if (queue.length === 0) {
                console.warn(`[agentbeats] verify_slots: no resolvable slots in [${probed.slots.join(",")}]; skipping`);
              } else {
                const cvEmpty: typeof queue = [];
                const needOcr: typeof queue = [];
                for (const q of queue) {
                  const patch = samplePatchFingerprint(payload.obs, q.x, q.y, 6);
                  if (patch && patch.stddev < 25) cvEmpty.push(q);
                  else needOcr.push(q);
                }
                // Record CV-empty results immediately; no servo needed.
                for (const q of cvEmpty) {
                  plan.slotMemory.record(q.x, q.y, "empty", plan.iteration);
                }
                console.log(`[agentbeats] verify_slots batch=${queue.length} cv_empty=${cvEmpty.length} ocr=${needOcr.length} slots=${queue.map((q) => `${q.slot}(${q.name ?? "?"})`).join(",")}`);
                if (needOcr.length === 0) {
                  // Everything was CV-empty; nothing to OCR. Just return
                  // and let the probe see the updated slotMemory.
                  state.closedLoopHistory.unshift(`verify_slots[${queue.length}] cv_empty=${cvEmpty.length}`);
                  state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                  return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
                }
                // Arm the OCR batch state machine: queue the non-empty
                // slots and start servoing cursor toward the first one.
                plan.pendingOcrBatch = { slots: needOcr, idx: 0, parking: false };
                const first = needOcr[0];
                plan.pendingClick = {
                  rasterIndex: first.slot, slotName: first.name, slotRole: undefined,
                  frozenTarget: { x: first.x, y: first.y },
                  button: "attack", shift: false, expectAfter: "should_fill",
                  phase: "servo", retries: 0, kind: "hover" as "click",
                  actionKind: "pickup" as "pickup",
                };
                plan.pendingChain = [];
                plan.servoSteps = 0;
                plan.skipNextPark = true;
                plan.pendingTooltipRead = { slotIndex: first.slot, x: first.x, y: first.y, slotName: first.name };
                state.closedLoopHistory.unshift(`verify_slots[${queue.length}] cv_empty=${cvEmpty.length} ocr=${needOcr.length}`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                console.log(`[agentbeats] verify_slots OCR batch start: first slot=${first.slot}(${first.name ?? "?"})`);
              }
            } else {
              // Legacy low-level actions: pickup / place_one / place_all / take.
              const button: "attack" | "use" = probed.action === "place_one" ? "use" : "attack";
              const shift = false;
              const probedSlot = layoutForProbe.slots[probed.slot];
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
                if (probed.action === "pickup"
                    && (probedSlot.role === "hotbar" || probedSlot.role === "main_inv")) {
                  plan.pickupSourceSlot = { index: probed.slot, name: probedSlot.name };
                  console.log(`[agentbeats] recorded pickupSourceSlot=${probed.slot} (${probedSlot.name ?? "?"}) for legacy pickup`);
                }
                // Pre-take auto-return: "take" requires an empty cursor
                // (otherwise it does nothing in MC). If we have a
                // recorded pickup source, schedule a place_all back to
                // it FIRST. Next probe will re-issue take when result
                // slot is still filled and cursor is now empty.
                // Putting auto-return here (just in front of crafting)
                // instead of after every place_one keeps multi-slot
                // recipes working: leftover stays in the cursor across
                // multiple place_one calls until the recipe is ready.
                if (probed.action === "take"
                    && plan.pickupSourceSlot
                    && plan.pickupSourceSlot.name
                    && cursorHolding !== false) {
                  const ret = layoutForProbe.slots.find((s) => s.name === plan.pickupSourceSlot!.name);
                  if (ret) {
                    console.log(`[agentbeats] PRE-TAKE AUTO_RETURN: scheduling place_all back to ${ret.name} (raster=${ret.index}) before take`);
                    plan.pendingClick = {
                      rasterIndex: ret.index,
                      slotName: ret.name,
                      slotRole: ret.role,
                      frozenTarget: { x: ret.cx, y: ret.cy },
                      button: "attack",
                      shift: false,
                      expectAfter: "should_fill",
                      phase: "servo",
                      retries: 0,
                      kind: "auto_return",
                      actionKind: "place_all",
                    };
                    plan.servoSteps = 0;
                    state.closedLoopHistory.unshift(`auto_return -> ${ret.name} (before take)`);
                    state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                    return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
                  }
                  // Original pickup slot is no longer in the layout
                  // (e.g. layout reset, slot rearranged). Skip the take
                  // and surface to the LLM so it picks a fallback dump
                  // slot for the leftover via the next probe.
                  console.warn(`[agentbeats] PRE-TAKE AUTO_RETURN: original source slot "${plan.pickupSourceSlot.name}" not in current layout; skipping take so next probe can choose a fallback dump slot`);
                  state.closedLoopHistory.unshift(`auto_return blocked: source ${plan.pickupSourceSlot.name} not in layout; please place_all leftover into any empty main_inv slot before take`);
                  state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                  return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
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
                  actionKind: probed.action as "pickup" | "place_one" | "place_all" | "take",
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
            // Don't surrender to manual LLM control on a transient probe
            // failure -- closed-loop is enforced. Reset the session and
            // try again on the next obs frame.
            console.warn(`[agentbeats] closed-loop probe failed: ${formatModelProviderError(error)} -- resetting SoM session and reprobing next frame (closed-loop enforced)`);
            plan.sessionLayout = null;
            plan.layoutHint = null;
            plan.pendingClick = null;
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

          // Strict thresholds: looser values caused clicks to land 13-17
          // px off slot center (servo cap firing during overshoot
          // approach), missing MC's effective hit region. Strict 5 px
          // threshold + 10-frame stuck cap matches the run that
          // achieved sim_score=1.0.
          const SERVO_STEP_CAP = 10;
          const MAX_RETRIES = 4;
          const HIT_THRESHOLD_PX = 5;

          // Helper: emit a closed-loop action and remember the cam delta
          // so the next frame's stale-cursor check has ground truth.
          // hold_steps: 1 by default (servo / click need fresh obs each
          // env step). For pure noop frames (no buttons, no cam) bump
          // to 2 so the env runs a couple of steps without us paying
          // the obs round-trip cost on every one.
          const emit = (action: McuEnvAction, holdSteps: number = 1): McuPolicyDecision => {
            plan.lastEmittedCam = [action.camera[0], action.camera[1]];
            return { ...ACTION_PAYLOAD_PREFIX, action, hold_steps: holdSteps };
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
            // Hover: servo to slot, then exit WITHOUT clicking. Cursor
            // is left on the slot for MC to render its tooltip in the
            // next probe image.
            if ((pc.kind as string) === "hover") {
              // Slots are ~18 px apart on screen; a 12 px arrival
              // tolerance let the cursor settle on the EDGE of the
              // target slot, where MC would render the NEIGHBOR slot's
              // tooltip and OCR would correctly read the wrong slot's
              // item -- corrupting slotMemory. 3 px keeps the cursor
              // pixel inside the intended slot.
              const arrived = !!cursor && Math.hypot(cursor.x - slotCenter.cx, cursor.y - slotCenter.cy) < 3;
              if (arrived || plan.servoSteps > SERVO_STEP_CAP) {
                console.log(`[agentbeats] hover arrived at ${pc.slotName ?? pc.rasterIndex} cursor=(${cursor?.x},${cursor?.y}); leaving cursor for tooltip; clearing pendingClick`);
                state.closedLoopHistory.unshift(`hover slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} done`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                plan.pendingClick = null;
                // Brief settle frame; if MC hasn't rendered the tooltip
                // yet, the OCR retry loop in the next handleObservation
                // tick will re-fire the OCR up to 3 times before giving
                // up.
                return emit(defaultMcuAction(), 4);
              }
              if (stepResult) {
                // servoCursorStep can return click=true with the button
                // pressed once cursor is within its hit threshold (~5 px),
                // but for hover we must NEVER click -- a click would
                // pickup/place the item and corrupt slot state. Strip
                // any attack/use buttons before emitting.
                const cameraOnly = { ...stepResult.action, attack: 0 as 0 | 1, use: 0 as 0 | 1 };
                return emit(cameraOnly);
              }
              return emit(defaultMcuAction());
            }
            // Require at least one servo step before allowing a click.
            // Inventory slots are ~18 px apart, and HIT_THRESHOLD_PX is
            // a few px. If the prior chain step left the cursor already
            // within hit threshold of the NEW target, servoCursorStep
            // would return click=true on the very first tick and fire
            // a click before the cursor was actually re-aimed for the
            // new slot -- which can land on a neighbor or fail to
            // register. Forcing a servo step ensures the cursor settles
            // freshly on the intended slot center.
            const shouldClickNow = plan.servoSteps > SERVO_STEP_CAP
              || (stepResult && stepResult.click && plan.servoSteps >= 1);
            if (shouldClickNow) {
              // Safety: clicking outside the inventory window drops the
              // held stack to the world ("throw"). Refuse to fire if the
              // detected cursor is outside the window bbox.
              const cursorInsideWindow = !!cursor
                && cursor.x >= layout.windowX
                && cursor.x <= layout.windowX + layout.windowW
                && cursor.y >= layout.windowY
                && cursor.y <= layout.windowY + layout.windowH;
              if (!cursorInsideWindow) {
                console.warn(`[agentbeats] click suppressed: cursor (${cursor?.x},${cursor?.y}) outside inventory window [${layout.windowX},${layout.windowY},${layout.windowW}x${layout.windowH}]; aborting to avoid throwing held item`);
                state.closedLoopHistory.unshift(`abort ${pc.slotName ?? pc.rasterIndex} (cursor outside window; would throw item)`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                plan.pendingClick = null;
                plan.sessionLayout = null;
                plan.layoutHint = null;
                return emit(defaultMcuAction());
              }
              pc.prePatch = samplePatchFingerprint(payload.obs, slotCenter.cx, slotCenter.cy) ?? undefined;
              // Pre-condition for "should_empty" actions (pickup/take):
              // source slot MUST currently have an item (pre.stddev
              // high). If it looks already empty, the click would do
              // nothing -- abort and reprobe so the VLM picks a slot
              // that actually has the ingredient.
              if (pc.expectAfter === "should_empty"
                  && pc.prePatch
                  && pc.prePatch.stddev < 25) {
                console.warn(`[agentbeats] pickup/take aborted: slot=${pc.rasterIndex}(${pc.slotName ?? "?"}) looks already empty (pre.stddev=${pc.prePatch.stddev.toFixed(1)})`);
                state.closedLoopHistory.unshift(`abort ${pc.kind ?? "click"} slot=${pc.rasterIndex} (source slot empty; nothing to grab)`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                plan.pendingClick = null;
                return emit(defaultMcuAction());
              }
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
            // Pure settle frame, no input. Run 2 env steps so MC has time to apply the click.
            return emit(defaultMcuAction(), 2);
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
              // Pure noop wait-for-verify frame: bump hold_steps.
              return emit(defaultMcuAction(), 2);
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
            // A successful click mutated the slot's contents — the slot
            // memory entry (if any) for this absolute pos is now stale.
            // Forget it; the agent will re-discover via hover if needed.
            // A successful click mutated the slot. Invalidate the slot's
            // memory entry; subsequent perception will re-OCR if the
            // agent decides to verify_slots that slot. We do NOT
            // speculatively write the cursor's item into the
            // destination -- per the user's "perception only" rule,
            // memory only contains entries confirmed by OCR.
            if (matched && pc.kind !== ("hover" as never)) {
              plan.slotMemory.invalidate(slotCenter.cx, slotCenter.cy);
            }
            console.log(
              `[agentbeats] verify ${pc.slotName ?? pc.rasterIndex}: post.stddev=${post.stddev.toFixed(1)} expect=${pc.expectAfter} -> ${matched ? "OK" : "MISMATCH"} (retry ${pc.retries}/${MAX_RETRIES})`,
            );
            const dbgPolicy = getDebugRecorder();
            if (dbgPolicy.isEnabled()) {
              dbgPolicy.record({
                type: "verify",
                step,
                data: {
                  slotName: pc.slotName, slotIndex: pc.rasterIndex,
                  slotCenter: { cx: slotCenter.cx, cy: slotCenter.cy },
                  expectAfter: pc.expectAfter,
                  prePatch: pc.prePatch ? { meanR: pc.prePatch.meanR, meanG: pc.prePatch.meanG, meanB: pc.prePatch.meanB, stddev: pc.prePatch.stddev } : null,
                  postPatch: { meanR: post.meanR, meanG: post.meanG, meanB: post.meanB, stddev: post.stddev },
                  matched, retries: pc.retries,
                  cursor: plan.cursor,
                  actionKind: pc.actionKind, kind: pc.kind,
                },
              }, payload.obs, "jpg");
            }
            if (matched) {
              state.closedLoopHistory.unshift(`${pc.actionKind ?? pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} OK`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              // Record / clear cursorItemSignature based on this click:
              //   pickup OK  -> cursor now carries the item from the source slot.
              //                Capture the source's prePatch RGB as the signature.
              //   place_all OK (kind=click) -> cursor is now empty.
              //                Clear the signature.
              //   place_one OK -> cursor still carries (count-1) of same item.
              //                Keep signature.
              //   auto_return OK -> cursor empty. Clear.
              if (pc.actionKind === "pickup" && pc.prePatch) {
                plan.cursorItemSignature = {
                  meanR: pc.prePatch.meanR,
                  meanG: pc.prePatch.meanG,
                  meanB: pc.prePatch.meanB,
                };
                console.log(`[agentbeats] cursorItemSignature set from pickup ${pc.slotName ?? pc.rasterIndex}: rgb=(${pc.prePatch.meanR.toFixed(0)},${pc.prePatch.meanG.toFixed(0)},${pc.prePatch.meanB.toFixed(0)})`);
              } else if (pc.actionKind === "place_all" || pc.kind === "auto_return") {
                plan.cursorItemSignature = null;
              }
              // Advance the chain: if there's a queued follow-up click
              // (e.g. the place_one or auto_return inside a "move" op),
              // promote it into pendingClick. Otherwise return to VLM.
              const next = plan.pendingChain.shift();
              if (next) {
                next.phase = "servo";
                next.retries = 0;
                next.prePatch = undefined;
                plan.pendingClick = next;
                plan.servoSteps = 0;
                console.log(`[agentbeats] chain advance -> ${next.actionKind ?? next.kind} slot=${next.rasterIndex}(${next.slotName ?? "?"}) (${plan.pendingChain.length} more queued)`);
              } else {
                plan.pendingClick = null;
              }
              return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
            }
            // Mismatch path: CV said the click did not produce the
            // expected slot state. CV is fooled by rendering noise
            // around freshly-emptied slots and ambiguous icon variance.
            // On the FIRST mismatch only, ask the VLM for a second
            // opinion before burning a retry. If the VLM agrees the
            // expected state holds, accept as success and advance the
            // chain. (Cheap: at most one extra VLM call per click.)
            if (pc.retries === 0 && this.config.openai.apiKey) {
              try {
                const vlmOk = await vlmVerifySlotState({
                  client: this.client,
                  model: this.config.openai.model,
                  obsBase64: payload.obs,
                  slot: { cx: slotCenter.cx, cy: slotCenter.cy, name: pc.slotName },
                  expectAfter: pc.expectAfter,
                  taskTarget: plan.taskText,
                });
                if (vlmOk === true) {
                  console.log(`[agentbeats] VLM sub-verify says ${pc.expectAfter} HOLDS for ${pc.slotName ?? pc.rasterIndex} (CV was fooled, post.stddev=${post.stddev.toFixed(1)}); accepting as success`);
                  state.closedLoopHistory.unshift(`${pc.actionKind ?? pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} OK (VLM-verified)`);
                  state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                  const next = plan.pendingChain.shift();
                  if (next) {
                    next.phase = "servo";
                    next.retries = 0;
                    next.prePatch = undefined;
                    plan.pendingClick = next;
                    plan.servoSteps = 0;
                    console.log(`[agentbeats] chain advance -> ${next.actionKind ?? next.kind} slot=${next.rasterIndex}(${next.slotName ?? "?"}) (${plan.pendingChain.length} more queued)`);
                  } else {
                    plan.pendingClick = null;
                  }
                  return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
                }
              } catch (e) {
                console.warn(`[agentbeats] VLM sub-verify call failed: ${e instanceof Error ? e.message : String(e)}; falling through to retry`);
              }
            }
            if (pc.retries < MAX_RETRIES) {
              pc.retries += 1;
              pc.phase = "servo";
              plan.servoSteps = 0;
              console.log(`[agentbeats] RETRY click on ${pc.slotName ?? pc.rasterIndex} (attempt ${pc.retries + 1}/${MAX_RETRIES + 1})`);
              return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: 1 };
            }
            // Retries exhausted (5 attempts total). Surface back to VLM
            // reasoning -- drop the rest of the chain too so the LLM
            // can replan from current observed state.
            const failureLabel = `${pc.actionKind ?? pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} FAILED post.stddev=${post.stddev.toFixed(0)}`;
            state.closedLoopHistory.unshift(`${failureLabel} (chain aborted; ${plan.pendingChain.length} dropped)`);
            state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            console.warn(`[agentbeats] ${failureLabel}; retries exhausted; clearing chain (${plan.pendingChain.length} dropped) and returning to VLM`);
            plan.pendingClick = null;
            plan.pendingChain = [];
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
    if ((decision as McuPolicyDecision & { task_done?: boolean }).task_done) {
      console.log(`[agentbeats] VLM declared task_done=true at step=${step}; entering early-stop noop loop for the rest of the episode`);
      state.earlyStop = true;
      return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: this.config.agentbeats.maxHoldSteps };
    }
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
