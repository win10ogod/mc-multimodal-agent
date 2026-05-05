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
  type ClosedLoopCraftPlan,
  type UiFastControlFrame,
} from "./tools/UiFastControl";
import { dispatchObservation } from "./agents/Dispatcher";
import { runClosedLoopStep } from "./agents/runClosedLoopStep";
import { getDebugRecorder } from "./tools/DebugRecorder";
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

export type McuObservationPayload = {
  type: "obs";
  step?: number;
  obs?: string;
};

export type McuContextState = {
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

export function shouldUseModelOnStep(step: number, modelEveryNSteps: number): boolean {
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

export function repairDecisionForTask(decision: McuPolicyDecision, taskText: string, step: number): McuPolicyDecision {
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
    let episode = this.episodes.get(contextId);
    if (!episode) {
      episode = makeEpisodeState(state.taskText || ((payload as any)?.task ?? ""));
      this.episodes.set(contextId, episode);
    }

    const recorder = getDebugRecorder();
    const closedLoopResult = await runClosedLoopStep(
      {
        client: this.client,
        model: this.config.openai.model,
        apiKey: this.config.openai.apiKey || undefined,
        maxHoldSteps: this.config.agentbeats.maxHoldSteps,
        defaultHoldSteps: this.config.agentbeats.defaultHoldSteps,
        modelEveryNSteps: this.config.agentbeats.modelEveryNSteps,
        debugDir: recorder.getDir(),
        recordDebug: async (kind, payload) => { recorder.record({ type: kind, data: payload as Record<string, unknown> }); },
        modelDecision: (ctx, s) => this.modelDecision(ctx, s),
      },
      {
        context: state,
        episode,
        obsBase64: payload.obs ?? "",
        contextId,
        payload,
        step,
      },
    );

    // Propagate earlyStop set inside runClosedLoopStep back to the caller
    if (closedLoopResult.kind === "subgoal_done") {
      state.earlyStop = true;
      return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: this.config.agentbeats.maxHoldSteps };
    }
    if (closedLoopResult.kind === "subgoal_failed") {
      // Treat a hard failure the same as earlyStop for backward compat.
      return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: this.config.agentbeats.maxHoldSteps };
    }
    // kind === "act"
    return { ...ACTION_PAYLOAD_PREFIX, action: closedLoopResult.action, hold_steps: closedLoopResult.holdSteps };
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
