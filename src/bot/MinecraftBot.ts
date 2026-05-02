import mineflayer from "mineflayer";
import type { Bot, ControlState } from "mineflayer";
import type { Socket } from "node:net";
import minecraftData from "minecraft-data";
import { goals, Movements, pathfinder } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { AgentConfig } from "../config";
import type { BlueprintPlacement } from "../blueprint/Blueprint";
import type { Vec3Like } from "../types";
import { sleep } from "../utils/misc";
import { createBlueprintBuildPlan, type InventoryCount, type MaterialAcquisitionPlan } from "./BlueprintBuildPlanner";
import { buildModdedTolerantCustomPackets } from "./moddedProtocol";

const AIR_NAMES = new Set(["air", "cave_air", "void_air"]);
const { GoalFollow, GoalNear } = goals;
const PATHFINDER_HAZARD_BLOCKS = [
  "fire",
  "soul_fire",
  "lava",
  "cactus",
  "magma_block",
  "campfire",
  "soul_campfire",
  "sweet_berry_bush",
  "powder_snow",
];
const BLUEPRINT_NAVIGATION_FAILURE_LIMIT = 2;

export type ScreenPlacementHit = {
  blockName: string;
  blockPosition: Vec3Like;
  previousPosition?: Vec3Like;
  distance: number;
};

export type PlacementSummary = {
  target: Vec3Like;
  reference: Vec3Like;
  face: Vec3Like;
  item: string;
  before?: string;
  after?: string;
  attempts: number;
  verified: boolean;
};

export type BuildSummary = {
  blueprint: string;
  attempted: number;
  placed: number;
  skipped: number;
  failed: Array<{ position: Vec3Like; block: string; reason: string }>;
  blocked?: "missing_materials" | "navigation_blocked";
  planned?: number;
  required?: InventoryCount[];
  available?: InventoryCount[];
  missing?: InventoryCount[];
  acquisitionPlan?: MaterialAcquisitionPlan;
  footprint?: ReturnType<typeof createBlueprintBuildPlan>["footprint"];
};

function isNavigationBuildFailure(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    normalized.includes("pathfind timed out") ||
    normalized.includes("path was stopped") ||
    normalized.includes("desired goal was not reached")
  );
}

export type PlayerGuidance = {
  time: string;
  username: string;
  message: string;
};

export type RuntimeRegistrySnapshot = {
  version: string;
  items: Array<{ name: string; id?: number; displayName?: string }>;
  blocks: Array<{ name: string; id?: number; displayName?: string }>;
};

export type ItemStackSummary = {
  slot: number;
  name: string;
  displayName?: string;
  type?: number;
  count: number;
  metadata?: number;
};

export type WindowSummary = {
  id: number;
  type: string;
  title: string;
  inventoryStart: number;
  inventoryEnd: number;
  selectedItem: ItemStackSummary | null;
  slots: ItemStackSummary[];
};

export type RecipeChoiceSummary = {
  id?: number;
  name: string;
  displayName?: string;
  metadata?: number | null;
  count: number;
};

export type RecipeIngredientSummary = {
  choices: RecipeChoiceSummary[];
};

export type RecipeSummary = {
  source: "server" | "client";
  index: number;
  id?: string;
  type?: string;
  result: RecipeChoiceSummary;
  requiresTable: boolean;
  craftable: boolean;
  missing: Array<{ name: string; id?: number; metadata?: number | null; required: number; available: number }>;
  ingredients?: RecipeIngredientSummary[];
  shape?: RecipeIngredientSummary[][];
};

export type RecipeCatalogSummary = {
  source: "server" | "client" | "none";
  capturedAt?: string;
  serverRecipeCount: number;
  unlockedRecipeCount: number;
  skippedByConfig: boolean;
  query?: string;
  recipes: RecipeSummary[];
};

export type CombatEntitySummary = {
  id: number;
  name: string;
  type: string;
  username?: string;
  hostile: boolean;
  player: boolean;
  distance: number;
  position: Vec3Like;
  health?: number;
};

export type CombatScanSummary = {
  health: number;
  food: number;
  held: string;
  pveEnabled: boolean;
  pvpEnabled: boolean;
  scanRange: number;
  threats: CombatEntitySummary[];
  nearbyEntities: CombatEntitySummary[];
};

export type CombatPulseSummary = {
  ok: boolean;
  mode: "pve" | "pvp";
  durationMs: number;
  attacks: number;
  retreats: number;
  foodUses: number;
  steps: Array<{ action: string; ok: boolean; text: string }>;
  finalScan: CombatScanSummary;
};

export type NavigationStatus = "idle" | "running" | "arrived" | "stopped" | "timeout" | "reset" | "skipped";

export type NavigationSummary = {
  id: string;
  type: "goto" | "follow";
  status: NavigationStatus;
  target?: Vec3Like;
  range: number;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  timeoutMs: number;
  distance?: number;
  moving: boolean;
  reason?: string;
};

export type LocalBlockSummary = {
  name: string;
  position: Vec3Like;
};

export type LocalizationSnapshot = {
  position: Vec3Like;
  blockPosition: Vec3Like;
  eyePosition: Vec3Like;
  yawDeg: number;
  facing: string;
  pitchDeg: number;
  health: number;
  food: number;
  held: string;
  feetBlock: LocalBlockSummary | null;
  belowBlock: LocalBlockSummary | null;
  navigation: NavigationSummary;
};

export type PathfinderMovementConfigurationSummary = {
  hazardBlocks: string[];
  entitiesToAvoid: string[];
  scaffoldingBlocks: string[];
};

type MovementSettingsTarget = {
  canDig?: boolean;
  allow1by1towers?: boolean;
  allowParkour?: boolean;
  allowSprinting?: boolean;
  allowEntityDetection?: boolean;
  maxDropDown?: number;
  blocksToAvoid?: Set<number>;
  entitiesToAvoid?: Set<string>;
  scafoldingBlocks?: number[];
};

type RegistryNameMaps = {
  blocksByName?: Record<string, { id?: number } | undefined>;
  itemsByName?: Record<string, { id?: number } | undefined>;
};

const HOSTILE_ENTITY_TERMS = [
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creeper",
  "drowned",
  "elder_guardian",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither",
  "zoglin",
  "zombie",
];

const WEAPON_SCORES: Array<[RegExp, number]> = [
  [/netherite_sword$/, 90],
  [/diamond_sword$/, 82],
  [/iron_sword$/, 70],
  [/stone_sword$/, 55],
  [/golden_sword$/, 45],
  [/wooden_sword$/, 35],
  [/netherite_axe$/, 78],
  [/diamond_axe$/, 72],
  [/iron_axe$/, 62],
  [/stone_axe$/, 50],
  [/golden_axe$/, 38],
  [/wooden_axe$/, 30],
  [/trident$/, 60],
  [/crossbow$/, 42],
  [/bow$/, 38],
];

const FOOD_SCORES: Array<[RegExp, number]> = [
  [/enchanted_golden_apple$/, 100],
  [/golden_apple$/, 90],
  [/cooked_beef$|steak$/, 75],
  [/cooked_porkchop$/, 72],
  [/golden_carrot$/, 70],
  [/cooked_mutton$|cooked_chicken$|cooked_cod$|cooked_salmon$/, 62],
  [/bread$|baked_potato$/, 45],
  [/apple$|carrot$/, 35],
  [/potato$|beef$|porkchop$|chicken$|mutton$|cod$|salmon$/, 20],
];

function toVec3(pos: Vec3Like): Vec3 {
  return new Vec3(pos.x, pos.y, pos.z);
}

function floorVec(pos: Vec3Like): Vec3Like {
  return {
    x: Math.floor(pos.x),
    y: Math.floor(pos.y),
    z: Math.floor(pos.z),
  };
}

function addVec(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function isFiniteVec3Like(pos: Vec3Like | undefined): pos is Vec3Like {
  return Boolean(pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z));
}

function isAirName(name: string | undefined): boolean {
  return !name || AIR_NAMES.has(name);
}

function blockSignature(block: ReturnType<Bot["blockAt"]>): string {
  if (!block) {
    return "none";
  }
  const stateId = "stateId" in block ? String((block as unknown as { stateId?: unknown }).stateId ?? "") : "";
  return `${block.name}:${block.type}:${block.metadata ?? ""}:${stateId}`;
}

function entityBaseName(entity: any): string {
  return String(entity.username ?? entity.mobType ?? entity.name ?? entity.displayName ?? entity.type ?? "unknown");
}

function isPlayerEntity(entity: any): boolean {
  return entity.type === "player" || typeof entity.username === "string";
}

function isHostileEntityName(name: string): boolean {
  const normalized = name.toLowerCase();
  return HOSTILE_ENTITY_TERMS.some((term) => normalized.includes(term));
}

function scoreNamedItem(name: string, scores: Array<[RegExp, number]>): number {
  return scores.find(([pattern]) => pattern.test(name))?.[1] ?? 0;
}

export function configurePathfinderMovementsForAgent(
  movements: MovementSettingsTarget,
  registry: RegistryNameMaps,
  config: AgentConfig,
): PathfinderMovementConfigurationSummary {
  movements.canDig = config.minecraft.pathfindCanDig;
  movements.allow1by1towers = config.minecraft.pathfindAllow1by1Towers;
  movements.allowParkour = config.minecraft.pathfindAllowParkour;
  movements.allowSprinting = config.minecraft.pathfindAllowSprinting;
  movements.allowEntityDetection = config.minecraft.pathfindAllowEntityDetection;
  movements.maxDropDown = Math.max(1, Math.min(16, config.minecraft.pathfindMaxDropDown));

  const hazardBlocks: string[] = [];
  if (movements.blocksToAvoid) {
    for (const name of PATHFINDER_HAZARD_BLOCKS) {
      const id = registry.blocksByName?.[name]?.id;
      if (typeof id !== "number") {
        continue;
      }
      movements.blocksToAvoid.add(id);
      hazardBlocks.push(name);
    }
  }

  const entitiesToAvoid: string[] = [];
  if (config.minecraft.pathfindAvoidHostiles && movements.entitiesToAvoid) {
    for (const name of HOSTILE_ENTITY_TERMS) {
      movements.entitiesToAvoid.add(name);
      entitiesToAvoid.push(name);
    }
  }

  const scaffoldingBlocks: string[] = [];
  if (movements.scafoldingBlocks) {
    movements.scafoldingBlocks.length = 0;
    for (const name of config.minecraft.pathfindScaffoldBlocks) {
      const id = registry.itemsByName?.[name]?.id;
      if (typeof id !== "number") {
        continue;
      }
      movements.scafoldingBlocks.push(id);
      scaffoldingBlocks.push(name);
    }
  }

  return { hazardBlocks, entitiesToAvoid, scaffoldingBlocks };
}

function itemSummary(item: unknown): ItemStackSummary | null {
  const stack = item as
    | {
        slot?: number;
        name?: string;
        displayName?: string;
        type?: number;
        count?: number;
        metadata?: number;
      }
    | undefined
    | null;
  if (!stack?.name) {
    return null;
  }
  return {
    slot: Number(stack.slot ?? -1),
    name: stack.name,
    displayName: stack.displayName,
    type: stack.type,
    count: Number(stack.count ?? 0),
    metadata: stack.metadata,
  };
}

function stringifyTitle(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "toString" in value && typeof value.toString === "function") {
    return value.toString();
  }
  return value ? String(value) : "";
}

function normalizeDegrees(value: number): number {
  let angle = value;
  while (angle > 180) {
    angle -= 360;
  }
  while (angle <= -180) {
    angle += 360;
  }
  return angle;
}

function facingFromYawDegrees(yaw: number): string {
  if (yaw >= -45 && yaw < 45) {
    return "north";
  }
  if (yaw >= 45 && yaw < 135) {
    return "west";
  }
  if (yaw >= -135 && yaw < -45) {
    return "east";
  }
  return "south";
}

export class MinecraftBot {
  private bot?: Bot;
  private mcData?: ReturnType<typeof minecraftData>;
  private readonly guidanceQueue: PlayerGuidance[] = [];
  private readonly serverRecipes: RecipeSummary[] = [];
  private readonly unlockedRecipes = new Set<string>();
  private recipesCapturedAt?: string;
  private recipesSkippedByConfig = false;
  private connected = false;
  private connecting?: Promise<void>;
  private connectionGeneration = 0;
  private disconnectRequested = false;
  private lastDisconnectReason = "";
  private lastPacketAt = 0;
  private lastKeepAliveAt = 0;
  private keepAliveReplies = 0;
  private keepAliveTimeouts = 0;
  private activeNavigation?: Omit<NavigationSummary, "elapsedMs" | "moving" | "distance"> & {
    startedAtMs: number;
    timeout?: NodeJS.Timeout;
  };

  constructor(private readonly config: AgentConfig) {}

  get raw(): Bot {
    if (!this.bot) {
      throw new Error("Minecraft bot is not connected.");
    }
    return this.bot;
  }

  get data(): ReturnType<typeof minecraftData> {
    if (!this.mcData) {
      throw new Error("Minecraft data is not ready.");
    }
    return this.mcData;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }
    const connecting = this.connectFresh();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) {
        this.connecting = undefined;
      }
    }
  }

  private async connectFresh(): Promise<void> {
    if (this.isConnected()) {
      return;
    }
    const connectionGeneration = this.connectionGeneration + 1;
    this.connectionGeneration = connectionGeneration;
    this.clearNavigationState();
    const previousBot = this.bot;
    if (previousBot) {
      this.resetRuntimeStateForReconnect();
      try {
        previousBot.removeAllListeners();
        previousBot.end("reconnect");
      } catch {
        // The previous client may already be fully closed.
      }
    }
    this.disconnectRequested = false;
    this.connected = false;
    this.lastDisconnectReason = "";
    const bot = mineflayer.createBot({
      host: this.config.minecraft.host,
      port: this.config.minecraft.port,
      username: this.config.minecraft.username,
      auth: this.config.minecraft.auth,
      version: this.config.minecraft.version,
      customPackets: buildModdedTolerantCustomPackets(this.config),
      hideErrors: this.config.minecraft.moddedTolerant,
      brand: this.config.minecraft.moddedTolerant ? "fabric" : "vanilla",
      keepAlive: false,
      checkTimeoutInterval: Math.max(30_000, this.config.minecraft.keepAliveTimeoutMs),
      closeTimeout: Math.max(30_000, this.config.minecraft.keepAliveTimeoutMs),
    });
    this.bot = bot;
    const isCurrentConnection = (): boolean =>
      this.bot === bot && this.connectionGeneration === connectionGeneration && !this.disconnectRequested;
    this.attachLenientKeepAlive(bot);
    this.attachRecipeCapture(bot);
    bot.loadPlugin(pathfinder);
    this.attachNavigationMonitor(bot);
    bot.on("end", (reason) => {
      if (!isCurrentConnection()) {
        return;
      }
      this.connected = false;
      this.lastDisconnectReason = `end: ${String(reason ?? "connection closed")}`;
      this.clearNavigationState();
    });
    bot.on("kicked", (reason) => {
      if (!isCurrentConnection()) {
        return;
      }
      this.connected = false;
      this.lastDisconnectReason = `kicked: ${String(reason)}`;
      this.clearNavigationState();
    });
    bot.on("error", (error) => {
      if (!isCurrentConnection()) {
        return;
      }
      this.lastDisconnectReason = `error: ${error.message}`;
      const client = bot._client as unknown as { ended?: boolean };
      if (client.ended) {
        this.connected = false;
        this.clearNavigationState();
      }
    });
    bot.on("chat", (username, message) => {
      if (!isCurrentConnection() || username === bot.username) {
        return;
      }
      const trigger = this.config.chatGuidance.trigger;
      if (this.config.chatGuidance.enabled && message.startsWith(trigger)) {
        this.guidanceQueue.push({
          time: new Date().toISOString(),
          username,
          message: message.slice(trigger.length).trim() || message,
        });
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          bot.removeListener("spawn", onSpawn);
          bot.removeListener("error", onError);
          bot.removeListener("kicked", onKicked);
        };
        const onSpawn = (): void => {
          if (!isCurrentConnection()) {
            cleanup();
            reject(new Error("Minecraft bot connection was superseded before spawn."));
            return;
          }
          this.connected = true;
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onKicked = (reason: string): void => {
          cleanup();
          reject(new Error(`Minecraft bot was kicked: ${reason}`));
        };
        bot.once("spawn", onSpawn);
        bot.once("error", onError);
        bot.once("kicked", onKicked);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("array size is abnormally large") || message.includes("Read error")) {
        throw new Error(
          [
            message,
            "",
            "Minecraft protocol decode failed. This usually means MC_VERSION does not match the server,",
            "or the server uses a mod loader/proxy that sends packets unsupported by mineflayer.",
            "Try leaving MC_VERSION empty for auto-detect, or set it to the exact server version from `npm run dev -- ping`.",
            "For Fabric/Forge/NeoForge packs, set MC_MODDED_TOLERANT=true and MC_SKIP_RECIPE_PACKETS=true to skip high-risk recipe payload parsing.",
          ].join("\n"),
        );
      }
      throw error;
    }

    try {
      this.mcData = minecraftData(bot.version);
    } catch {
      const botAny = bot as unknown as { registry?: ReturnType<typeof minecraftData> };
      if (!botAny.registry) {
        throw new Error(`minecraft-data has no registry for server version ${bot.version}.`);
      }
      this.mcData = botAny.registry;
    }
    const movements = new Movements(bot);
    configurePathfinderMovementsForAgent(
      movements,
      (bot as unknown as { registry: RegistryNameMaps }).registry,
      this.config,
    );
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.thinkTimeout = Math.max(500, Math.min(60_000, this.config.minecraft.pathfindThinkTimeoutMs));
    bot.pathfinder.tickTimeout = Math.max(10, Math.min(250, this.config.minecraft.pathfindTickTimeoutMs));
    (bot.pathfinder as unknown as { searchRadius: number }).searchRadius = this.config.minecraft.pathfindSearchRadius <= 0
      ? -1
      : Math.max(8, Math.min(256, this.config.minecraft.pathfindSearchRadius));
  }

  disconnect(): void {
    this.disconnectRequested = true;
    this.connectionGeneration += 1;
    this.connecting = undefined;
    this.connected = false;
    this.bot?.quit("Agent stopped");
  }

  resetRuntimeStateForReconnect(): void {
    this.connected = false;
    try {
      this.bot?.pathfinder?.stop();
    } catch {
      // The previous pathfinder may already be disposed.
    }
    this.clearNavigationState();
  }

  isConnected(): boolean {
    return Boolean(this.bot && this.connected && this.bot.entity && !this.invalidPositionReason());
  }

  connectionSummary(): string {
    const invalidPosition = this.invalidPositionReason();
    if (invalidPosition) {
      return `${invalidPosition} ${this.keepAliveSummary()}`.trim();
    }
    if (this.isConnected()) {
      return `connected ${this.keepAliveSummary()}`;
    }
    if (this.disconnectRequested) {
      return "disconnect requested";
    }
    const details = this.keepAliveSummary();
    return `${this.lastDisconnectReason || "not connected"} ${details}`.trim();
  }

  ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error(`Minecraft bot is not in game: ${this.connectionSummary()}`);
    }
  }

  private invalidPositionReason(): string | undefined {
    const pos = this.bot?.entity?.position;
    if (!pos) {
      return undefined;
    }
    if (isFiniteVec3Like(pos)) {
      return undefined;
    }
    this.connected = false;
    const rawPos = pos as unknown as { x?: unknown; y?: unknown; z?: unknown };
    return `invalid bot position x=${String(rawPos.x)} y=${String(rawPos.y)} z=${String(rawPos.z)}`;
  }

  private clearNavigationState(): void {
    if (this.activeNavigation?.timeout) {
      clearTimeout(this.activeNavigation.timeout);
    }
    this.activeNavigation = undefined;
  }

  private attachLenientKeepAlive(bot: Bot): void {
    const client = bot._client as unknown as {
      on: (event: string, listener: (...args: any[]) => void) => void;
      once: (event: string, listener: (...args: any[]) => void) => void;
      removeListener: (event: string, listener: (...args: any[]) => void) => void;
      write: (name: string, params: Record<string, unknown>) => void;
      end: (reason?: string) => void;
      socket?: Socket;
      ended?: boolean;
    };
    const timeoutMs = Math.max(30_000, this.config.minecraft.keepAliveTimeoutMs);
    const checkMs = Math.max(5_000, Math.min(30_000, Math.floor(timeoutMs / 4)));
    this.lastPacketAt = Date.now();
    this.lastKeepAliveAt = Date.now();

    const configureSocket = (): void => {
      try {
        client.socket?.setKeepAlive(true, 30_000);
        client.socket?.setNoDelay(true);
      } catch {
        // Socket keepalive is a best-effort OS hint.
      }
    };
    const onPacket = (): void => {
      this.lastPacketAt = Date.now();
    };
    const onKeepAlive = (packet: { keepAliveId?: unknown; id?: unknown }): void => {
      this.lastPacketAt = Date.now();
      this.lastKeepAliveAt = Date.now();
      const keepAliveId = packet.keepAliveId ?? packet.id;
      try {
        client.write("keep_alive", { keepAliveId });
        this.keepAliveReplies += 1;
      } catch (error) {
        this.lastDisconnectReason = `keepAlive write failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        try {
          client.end("keepAliveWriteError");
        } catch {
          // The socket may already be closing.
        }
      }
    };
    const monitor = setInterval(() => {
      if (client.ended || this.disconnectRequested) {
        return;
      }
      const now = Date.now();
      const packetIdleMs = now - this.lastPacketAt;
      const keepAliveIdleMs = now - this.lastKeepAliveAt;
      if (packetIdleMs < timeoutMs || keepAliveIdleMs < timeoutMs) {
        return;
      }
      this.keepAliveTimeouts += 1;
      this.lastDisconnectReason = [
        "socket idle timeout",
        `packet_idle_ms=${packetIdleMs}`,
        `keepalive_idle_ms=${keepAliveIdleMs}`,
        `timeout_ms=${timeoutMs}`,
      ].join(" ");
      try {
        client.end("socketIdleTimeout");
      } catch {
        // The socket may already be closing.
      }
    }, checkMs);
    monitor.unref?.();

    const cleanup = (): void => {
      clearInterval(monitor);
      client.removeListener("connect", configureSocket);
      client.removeListener("packet", onPacket);
      client.removeListener("keep_alive", onKeepAlive);
    };
    client.on("connect", configureSocket);
    client.on("packet", onPacket);
    client.on("keep_alive", onKeepAlive);
    client.once("end", cleanup);
    configureSocket();
  }

  private attachNavigationMonitor(bot: Bot): void {
    bot.on("goal_reached", () => {
      if (this.activeNavigation?.type === "follow" && this.activeNavigation.status === "running") {
        this.activeNavigation = {
          ...this.activeNavigation,
          updatedAt: new Date().toISOString(),
          reason: "following within range",
        };
        return;
      }
      this.finishNavigation("arrived", "goal reached");
    });
    bot.on("path_reset", (reason: string) => {
      const nav = this.activeNavigation;
      if (!nav || nav.status !== "running") {
        return;
      }
      if (nav.type === "follow") {
        this.activeNavigation = {
          ...nav,
          updatedAt: new Date().toISOString(),
          reason: typeof reason === "string" ? `follow path reset: ${reason}` : "follow path reset",
        };
        return;
      }
      this.finishNavigation("reset", typeof reason === "string" ? reason : "path reset");
    });
  }

  private finishNavigation(status: NavigationStatus, reason?: string): void {
    if (!this.activeNavigation) {
      return;
    }
    if (this.activeNavigation.timeout) {
      clearTimeout(this.activeNavigation.timeout);
    }
    this.activeNavigation = {
      ...this.activeNavigation,
      status,
      reason,
      updatedAt: new Date().toISOString(),
      timeout: undefined,
    };
  }

  private keepAliveSummary(): string {
    const now = Date.now();
    const packetIdleMs = this.lastPacketAt > 0 ? now - this.lastPacketAt : -1;
    const keepAliveIdleMs = this.lastKeepAliveAt > 0 ? now - this.lastKeepAliveAt : -1;
    return [
      `packet_idle_ms=${packetIdleMs}`,
      `keepalive_idle_ms=${keepAliveIdleMs}`,
      `keepalive_replies=${this.keepAliveReplies}`,
      `keepalive_timeouts=${this.keepAliveTimeouts}`,
    ].join(" ");
  }

  statusSummary(): string {
    this.ensureConnected();
    const bot = this.raw;
    const pos = bot.entity.position;
    const held = bot.heldItem?.name ?? "empty hand";
    const yawDeg = normalizeDegrees((bot.entity.yaw * 180) / Math.PI);
    return [
      `position=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
      `yaw=${yawDeg.toFixed(1)}`,
      `facing=${facingFromYawDegrees(yawDeg)}`,
      `pitch=${((bot.entity.pitch * 180) / Math.PI).toFixed(1)}`,
      `health=${bot.health}`,
      `food=${bot.food}`,
      `held=${held}`,
      `connection=${this.keepAliveSummary()}`,
    ].join(" ");
  }

  localizationSnapshot(): LocalizationSnapshot {
    this.ensureConnected();
    const bot = this.raw;
    const pos = bot.entity.position;
    const blockPosition = floorVec(pos);
    const eye = this.eyePosition();
    const yawDeg = normalizeDegrees((bot.entity.yaw * 180) / Math.PI);
    return {
      position: {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2)),
      },
      blockPosition,
      eyePosition: {
        x: Number(eye.x.toFixed(2)),
        y: Number(eye.y.toFixed(2)),
        z: Number(eye.z.toFixed(2)),
      },
      yawDeg: Number(yawDeg.toFixed(1)),
      facing: facingFromYawDegrees(yawDeg),
      pitchDeg: Number(((bot.entity.pitch * 180) / Math.PI).toFixed(1)),
      health: bot.health,
      food: bot.food,
      held: bot.heldItem?.name ?? "empty hand",
      feetBlock: this.localBlockAt(blockPosition),
      belowBlock: this.localBlockAt({ x: blockPosition.x, y: blockPosition.y - 1, z: blockPosition.z }),
      navigation: this.navigationStatus(),
    };
  }

  private localBlockAt(position: Vec3Like): LocalBlockSummary | null {
    const block = this.raw.blockAt(toVec3(position));
    if (!block) {
      return null;
    }
    return {
      name: block.name,
      position,
    };
  }

  combatScan(params: { range?: number; includePlayers?: boolean } = {}): CombatScanSummary {
    this.ensureConnected();
    const bot = this.raw;
    const range = Math.max(2, Math.min(64, params.range ?? this.config.combat.scanRange));
    const includePlayers = params.includePlayers === true && this.config.combat.allowPvp;
    const nearbyEntities = Object.values(bot.entities)
      .filter((entity: any) => entity && entity !== bot.entity && entity.position)
      .map((entity: any): CombatEntitySummary => {
        const name = entityBaseName(entity);
        const distance = Number(entity.position.distanceTo(bot.entity.position).toFixed(2));
        const player = isPlayerEntity(entity);
        return {
          id: Number(entity.id),
          name,
          type: String(entity.type ?? "unknown"),
          username: typeof entity.username === "string" ? entity.username : undefined,
          hostile: !player && isHostileEntityName(name),
          player,
          distance,
          position: {
            x: Number(entity.position.x.toFixed(2)),
            y: Number(entity.position.y.toFixed(2)),
            z: Number(entity.position.z.toFixed(2)),
          },
          health: typeof entity.health === "number" ? entity.health : undefined,
        };
      })
      .filter((entity) => entity.distance <= range)
      .sort((a, b) => Number(b.hostile) - Number(a.hostile) || a.distance - b.distance);
    const threats = nearbyEntities
      .filter((entity) => entity.hostile || (includePlayers && entity.player))
      .sort((a, b) => a.distance - b.distance);
    return {
      health: bot.health,
      food: bot.food,
      held: bot.heldItem?.name ?? "empty hand",
      pveEnabled: this.config.combat.pveEnabled,
      pvpEnabled: this.config.combat.allowPvp,
      scanRange: range,
      threats,
      nearbyEntities,
    };
  }

  feetBlock(): Vec3Like {
    this.ensureConnected();
    return floorVec(this.raw.entity.position);
  }

  eyePosition(): Vec3 {
    this.ensureConnected();
    const pos = this.raw.entity.position;
    return pos.offset(0, 1.62, 0);
  }

  async chat(message: string): Promise<void> {
    this.ensureConnected();
    this.raw.chat(message);
  }

  inventorySummary(): Array<{ name: string; count: number; slot: number }> {
    this.ensureConnected();
    return this.raw.inventory.items().map((item) => ({
      name: item.name,
      count: item.count,
      slot: item.slot,
    }));
  }

  windowSummary(): WindowSummary {
    this.ensureConnected();
    const window = this.raw.currentWindow ?? this.raw.inventory;
    const anyWindow = window as unknown as {
      id: number;
      type?: string;
      title?: unknown;
      inventoryStart?: number;
      inventoryEnd?: number;
      selectedItem?: unknown;
      slots: unknown[];
    };
    return {
      id: anyWindow.id,
      type: anyWindow.type ?? "unknown",
      title: stringifyTitle(anyWindow.title),
      inventoryStart: Number(anyWindow.inventoryStart ?? 0),
      inventoryEnd: Number(anyWindow.inventoryEnd ?? anyWindow.slots.length),
      selectedItem: itemSummary(anyWindow.selectedItem),
      slots: anyWindow.slots
        .map((item, slot) => {
          const summary = itemSummary(item);
          return summary ? { ...summary, slot } : null;
        })
        .filter((item): item is ItemStackSummary => Boolean(item)),
    };
  }

  drainGuidance(): PlayerGuidance[] {
    return this.guidanceQueue.splice(0, this.guidanceQueue.length);
  }

  runtimeRegistrySnapshot(): RuntimeRegistrySnapshot {
    const botAny = this.raw as unknown as {
      registry?: {
        itemsByName?: Record<string, { id?: number; displayName?: string; name?: string }>;
        blocksByName?: Record<string, { id?: number; displayName?: string; name?: string }>;
      };
    };
    const registry = botAny.registry ?? this.data;
    const itemsByName = registry.itemsByName ?? {};
    const blocksByName = registry.blocksByName ?? {};
    return {
      version: this.raw.version,
      items: Object.values(itemsByName).map((item) => ({
        name: String(item.name ?? ""),
        id: item.id,
        displayName: item.displayName,
      })).filter((item) => item.name),
      blocks: Object.values(blocksByName).map((block) => ({
        name: String(block.name ?? ""),
        id: block.id,
        displayName: block.displayName,
      })).filter((block) => block.name),
    };
  }

  recipeCatalog(query = "", limit = 12): RecipeCatalogSummary {
    this.ensureConnected();
    const normalizedQuery = query.trim().toLowerCase();
    const serverMatches = this.serverRecipes
      .filter((recipe) => this.recipeMatches(recipe, normalizedQuery))
      .slice(0, Math.max(1, Math.min(64, limit)));
    if (serverMatches.length > 0 || this.serverRecipes.length > 0) {
      return {
        source: "server",
        capturedAt: this.recipesCapturedAt,
        serverRecipeCount: this.serverRecipes.length,
        unlockedRecipeCount: this.unlockedRecipes.size,
        skippedByConfig: this.recipesSkippedByConfig,
        query,
        recipes: serverMatches,
      };
    }
    const clientRecipes = this.clientRecipeSummaries(query, limit);
    return {
      source: clientRecipes.length > 0 ? "client" : "none",
      capturedAt: this.recipesCapturedAt,
      serverRecipeCount: this.serverRecipes.length,
      unlockedRecipeCount: this.unlockedRecipes.size,
      skippedByConfig: this.recipesSkippedByConfig,
      query,
      recipes: clientRecipes,
    };
  }

  async lookDelta(yawDeltaDeg: number, pitchDeltaDeg: number): Promise<void> {
    const bot = this.raw;
    const yaw = bot.entity.yaw + (yawDeltaDeg * Math.PI) / 180;
    const pitch = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, bot.entity.pitch + (pitchDeltaDeg * Math.PI) / 180),
    );
    await bot.look(yaw, pitch, true);
  }

  async lookAtBlock(pos: Vec3Like): Promise<void> {
    await this.raw.lookAt(toVec3(pos).offset(0.5, 0.5, 0.5), true);
  }

  async move(params: {
    direction: "forward" | "back" | "left" | "right";
    durationMs: number;
    sprint?: boolean;
    sneak?: boolean;
    jump?: boolean;
  }): Promise<void> {
    const bot = this.raw;
    const controls: ControlState[] = [params.direction];
    if (params.sprint) {
      controls.push("sprint");
    }
    if (params.sneak) {
      controls.push("sneak");
    }
    if (params.jump) {
      controls.push("jump");
    }
    for (const control of controls) {
      bot.setControlState(control, true);
    }
    await sleep(Math.max(50, Math.min(5000, params.durationMs)));
    for (const control of controls) {
      bot.setControlState(control, false);
    }
  }

  stopMovement(): void {
    for (const control of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as ControlState[]) {
      this.raw.setControlState(control, false);
    }
    this.raw.pathfinder.stop();
    this.finishNavigation("stopped", "movement stopped");
  }

  async gotoNear(pos: Vec3Like, range = 2): Promise<boolean> {
    this.ensureConnected();
    const target = toVec3(pos).offset(0.5, 0, 0.5);
    const clampedRange = Math.max(0.5, range);
    if (this.raw.entity.position.distanceTo(target) <= clampedRange) {
      return false;
    }
    const timeoutMs = Math.max(1_000, this.config.minecraft.pathfindTimeoutMs);
    await Promise.race([
      this.raw.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, clampedRange)),
      sleep(timeoutMs).then(() => {
        this.raw.pathfinder.stop();
        throw new Error(`Pathfind timed out after ${timeoutMs}ms to ${pos.x},${pos.y},${pos.z}`);
      }),
    ]);
    return true;
  }

  startGotoNear(pos: Vec3Like, range = 2, timeoutMs = this.config.minecraft.pathfindTimeoutMs): NavigationSummary {
    this.ensureConnected();
    const target = toVec3(pos).offset(0.5, 0, 0.5);
    const clampedRange = Math.max(0.5, range);
    const clampedTimeout = Math.max(1_000, Math.min(120_000, timeoutMs));
    if (this.raw.entity.position.distanceTo(target) <= clampedRange) {
      const now = new Date().toISOString();
      this.activeNavigation = {
        id: `nav_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "goto",
        status: "skipped",
        target: { x: pos.x, y: pos.y, z: pos.z },
        range: clampedRange,
        startedAt: now,
        updatedAt: now,
        startedAtMs: Date.now(),
        timeoutMs: clampedTimeout,
        reason: "already within range",
      };
      return this.navigationStatus();
    }
    this.stopNavigation("replaced by new navigation");
    const id = `nav_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const timeout = setTimeout(() => {
      const nav = this.activeNavigation;
      if (!nav || nav.id !== id || nav.status !== "running") {
        return;
      }
      try {
        this.raw.pathfinder.stop();
      } catch {
        // The bot may have disconnected.
      }
      this.finishNavigation("timeout", `navigation timed out after ${clampedTimeout}ms`);
    }, clampedTimeout);
    timeout.unref?.();
    this.activeNavigation = {
      id,
      type: "goto",
      status: "running",
      target: { x: pos.x, y: pos.y, z: pos.z },
      range: clampedRange,
      startedAt: now,
      updatedAt: now,
      startedAtMs: Date.now(),
      timeoutMs: clampedTimeout,
      timeout,
    };
    this.raw.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, clampedRange));
    return this.navigationStatus();
  }

  navigationStatus(): NavigationSummary {
    this.ensureConnected();
    const nav = this.activeNavigation;
    if (!nav) {
      const now = new Date().toISOString();
      return {
        id: "none",
        type: "goto",
        status: "idle",
        range: 0,
        startedAt: now,
        updatedAt: now,
        elapsedMs: 0,
        timeoutMs: 0,
        moving: this.raw.pathfinder.isMoving(),
      };
    }
    if (nav.status === "running" && nav.timeoutMs > 0 && Date.now() - nav.startedAtMs > nav.timeoutMs) {
      try {
        this.raw.pathfinder.stop();
      } catch {
        // The bot may have disconnected.
      }
      this.finishNavigation("timeout", `navigation timed out after ${nav.timeoutMs}ms`);
    }
    const current = this.activeNavigation ?? nav;
    const distance = current.target
      ? Number(this.raw.entity.position.distanceTo(toVec3(current.target).offset(0.5, 0, 0.5)).toFixed(2))
      : undefined;
    return {
      id: current.id,
      type: current.type,
      status: current.status,
      target: current.target,
      range: current.range,
      startedAt: current.startedAt,
      updatedAt: current.updatedAt,
      elapsedMs: Date.now() - current.startedAtMs,
      timeoutMs: current.timeoutMs,
      distance,
      moving: this.raw.pathfinder.isMoving(),
      reason: current.reason,
    };
  }

  stopNavigation(reason = "navigation stopped"): NavigationSummary {
    this.ensureConnected();
    try {
      this.raw.pathfinder.stop();
    } catch {
      // The pathfinder may already be stopped.
    }
    this.finishNavigation("stopped", reason);
    return this.navigationStatus();
  }

  followPlayer(username?: string, range = 3): string {
    const bot = this.raw;
    const target = username
      ? bot.players[username]?.entity
      : Object.entries(bot.players)
          .filter(([name]) => name !== bot.username)
          .map(([, player]) => player.entity)
          .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity))
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];

    if (!target) {
      const targetName = username ? ` ${username}` : "";
      throw new Error(`Cannot follow${targetName}: player entity is not visible yet.`);
    }

    bot.pathfinder.setGoal(new GoalFollow(target, Math.max(1, Math.min(8, range))), true);
    const now = new Date().toISOString();
    this.activeNavigation = {
      id: `nav_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "follow",
      status: "running",
      target: {
        x: Number(target.position.x.toFixed(2)),
        y: Number(target.position.y.toFixed(2)),
        z: Number(target.position.z.toFixed(2)),
      },
      range: Math.max(1, Math.min(8, range)),
      startedAt: now,
      updatedAt: now,
      startedAtMs: Date.now(),
      timeoutMs: 0,
      reason: `following ${target.username ?? username ?? "nearest player"}`,
    };
    return `following ${target.username ?? username ?? "nearest player"} within ${range} blocks`;
  }

  async equipItem(name: string): Promise<void> {
    const item = this.findInventoryItem(name);
    if (!item) {
      throw new Error(`Item not found in inventory: ${name}`);
    }
    await this.raw.equip(item, "hand");
  }

  async equipBestWeapon(): Promise<string> {
    this.ensureConnected();
    const best = this.raw
      .inventory
      .items()
      .map((item) => ({ item, score: scoreNamedItem(item.name, WEAPON_SCORES) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.count - a.item.count)[0];
    if (!best) {
      return "no weapon found; keeping current held item";
    }
    await this.raw.equip(best.item, "hand");
    return `equipped best weapon ${best.item.name}`;
  }

  async eatBestFood(force = false): Promise<string> {
    this.ensureConnected();
    if (!force && this.raw.food >= 18 && this.raw.health > this.config.combat.lowHealth) {
      return `food/health acceptable: health=${this.raw.health} food=${this.raw.food}`;
    }
    const best = this.raw
      .inventory
      .items()
      .map((item) => ({ item, score: scoreNamedItem(item.name, FOOD_SCORES) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.count - a.item.count)[0];
    if (!best) {
      return "no food item found";
    }
    await this.raw.equip(best.item, "hand");
    await this.raw.consume();
    return `ate ${best.item.name}`;
  }

  async attackEntityById(entityId: number, params: { range?: number; equipBestWeapon?: boolean } = {}): Promise<string> {
    this.ensureConnected();
    const entity = this.raw.entities[entityId];
    if (!entity?.position) {
      throw new Error(`No attackable entity with id ${entityId}.`);
    }
    if (isPlayerEntity(entity) && !this.config.combat.allowPvp) {
      throw new Error("Refusing to attack player because COMBAT_ALLOW_PVP=false.");
    }
    if (params.equipBestWeapon !== false) {
      await this.equipBestWeapon();
    }
    const range = Math.max(1.8, Math.min(6, params.range ?? this.config.combat.attackRange));
    const distance = entity.position.distanceTo(this.raw.entity.position);
    if (distance > range) {
      await this.gotoNear(
        {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z,
        },
        Math.max(1, range - 0.5),
      );
    }
    await this.raw.lookAt(entity.position.offset(0, 0.8, 0), true);
    this.raw.attack(entity);
    return `attacked ${entityBaseName(entity)}#${entityId}`;
  }

  async retreatFromEntity(entityId: number, durationMs = 900): Promise<string> {
    this.ensureConnected();
    const entity = this.raw.entities[entityId];
    if (entity?.position) {
      await this.raw.lookAt(entity.position.offset(0, 0.8, 0), true);
    }
    await this.move({ direction: "back", durationMs: Math.max(100, Math.min(2500, durationMs)), sprint: true, jump: true });
    return entity?.position ? `retreated from ${entityBaseName(entity)}#${entityId}` : "retreated from last known threat";
  }

  async combatPulse(params: {
    durationMs?: number;
    includePlayers?: boolean;
    range?: number;
    attack?: boolean;
    retreatHealth?: number;
  } = {}): Promise<CombatPulseSummary> {
    this.ensureConnected();
    const includePlayers = params.includePlayers === true;
    if (includePlayers && !this.config.combat.allowPvp) {
      throw new Error("PVP combat pulse requires COMBAT_ALLOW_PVP=true.");
    }
    if (!includePlayers && !this.config.combat.pveEnabled) {
      throw new Error("PVE combat is disabled by COMBAT_PVE_ENABLED=false.");
    }
    const durationMs = Math.max(250, Math.min(30_000, params.durationMs ?? 3500));
    const range = Math.max(2, Math.min(64, params.range ?? this.config.combat.scanRange));
    const attack = params.attack !== false;
    const retreatHealth = params.retreatHealth ?? this.config.combat.criticalHealth;
    const started = Date.now();
    const steps: CombatPulseSummary["steps"] = [];
    let attacks = 0;
    let retreats = 0;
    let foodUses = 0;
    await this.equipBestWeapon().then((text) => steps.push({ action: "equip_best_weapon", ok: true, text }));
    while (Date.now() - started < durationMs) {
      const scan = this.combatScan({ range, includePlayers });
      const target = scan.threats[0];
      if (this.raw.health <= retreatHealth) {
        try {
          const text = await this.eatBestFood(false);
          steps.push({ action: "eat_best_food", ok: !text.includes("no food"), text });
          if (!text.includes("no food") && !text.includes("acceptable")) {
            foodUses += 1;
          }
        } catch (error) {
          steps.push({ action: "eat_best_food", ok: false, text: error instanceof Error ? error.message : String(error) });
        }
        if (target) {
          const text = await this.retreatFromEntity(target.id, 900);
          retreats += 1;
          steps.push({ action: "retreat", ok: true, text });
        }
        await sleep(250);
        continue;
      }
      if (!target) {
        steps.push({ action: "scan", ok: true, text: "no threats in range" });
        await sleep(300);
        break;
      }
      if (target.name.toLowerCase().includes("creeper") && target.distance < 4) {
        const text = await this.retreatFromEntity(target.id, 800);
        retreats += 1;
        steps.push({ action: "retreat", ok: true, text: `${text}; creeper spacing` });
        await sleep(250);
        continue;
      }
      if (!attack) {
        steps.push({ action: "track", ok: true, text: `tracked ${target.name}#${target.id} at d=${target.distance}` });
        await sleep(300);
        continue;
      }
      try {
        const text = await this.attackEntityById(target.id, { range: this.config.combat.attackRange });
        attacks += 1;
        steps.push({ action: "attack", ok: true, text });
      } catch (error) {
        steps.push({ action: "attack", ok: false, text: error instanceof Error ? error.message : String(error) });
        if (target) {
          try {
            const text = await this.retreatFromEntity(target.id, 600);
            retreats += 1;
            steps.push({ action: "retreat", ok: true, text });
          } catch {
            // Keep the combat loop moving.
          }
        }
      }
      await sleep(650);
    }
    const finalScan = this.combatScan({ range, includePlayers });
    return {
      ok: finalScan.threats.length === 0 || this.raw.health > this.config.combat.criticalHealth,
      mode: includePlayers ? "pvp" : "pve",
      durationMs,
      attacks,
      retreats,
      foodUses,
      steps,
      finalScan,
    };
  }

  async digAt(pos: Vec3Like): Promise<string> {
    this.ensureConnected();
    let block = this.raw.blockAt(toVec3(pos));
    if (!block || isAirName(block.name)) {
      throw new Error(`No diggable block at ${pos.x},${pos.y},${pos.z}`);
    }
    const canDig = (target: NonNullable<ReturnType<Bot["blockAt"]>>): boolean => {
      const digger = this.raw as unknown as { canDigBlock?: (block: NonNullable<ReturnType<Bot["blockAt"]>>) => boolean };
      if (typeof digger.canDigBlock !== "function") {
        return this.raw.entity.position.distanceTo(toVec3(pos).offset(0.5, 0.5, 0.5)) <= 5;
      }
      return digger.canDigBlock(target);
    };
    if (!canDig(block)) {
      await this.gotoNear(pos, 4);
      block = this.raw.blockAt(toVec3(pos));
      if (!block || isAirName(block.name)) {
        throw new Error(`No diggable block at ${pos.x},${pos.y},${pos.z}`);
      }
      if (!canDig(block)) {
        throw new Error(`Block at ${pos.x},${pos.y},${pos.z} is still out of dig reach after pathfinding.`);
      }
    }
    await this.lookAtBlock(pos);
    await this.raw.dig(block);
    return block.name;
  }

  async activateBlockAt(pos: Vec3Like): Promise<string> {
    this.ensureConnected();
    const block = this.raw.blockAt(toVec3(pos));
    if (!block || isAirName(block.name)) {
      throw new Error(`No activatable block at ${pos.x},${pos.y},${pos.z}`);
    }
    await this.gotoNear(pos, 4);
    await this.lookAtBlock(pos);
    await this.raw.activateBlock(block);
    return `activated ${block.name} at ${pos.x},${pos.y},${pos.z}`;
  }

  async openBlockWindowAt(pos: Vec3Like, timeoutMs = 5000): Promise<WindowSummary> {
    this.ensureConnected();
    const block = this.raw.blockAt(toVec3(pos));
    if (!block || isAirName(block.name)) {
      throw new Error(`No openable block at ${pos.x},${pos.y},${pos.z}`);
    }
    await this.gotoNear(pos, 4);
    await this.lookAtBlock(pos);
    await Promise.race([
      this.raw.openBlock(block),
      sleep(timeoutMs).then(() => {
        throw new Error(`Timed out waiting for window from ${block.name}. It may not expose a server-side UI.`);
      }),
    ]);
    return this.windowSummary();
  }

  async clickWindowSlot(slot: number, mouseButton = 0, mode = 0): Promise<WindowSummary> {
    this.ensureConnected();
    await this.raw.clickWindow(slot, mouseButton, mode);
    return this.windowSummary();
  }

  closeCurrentWindow(): string {
    this.ensureConnected();
    const window = this.raw.currentWindow;
    if (!window) {
      return "no current window to close";
    }
    this.raw.closeWindow(window);
    return "closed current window";
  }

  async transferWindowItem(params: {
    name: string;
    count?: number;
    direction?: "inventory_to_window" | "window_to_inventory" | "custom";
    sourceStart?: number;
    sourceEnd?: number;
    destStart?: number;
    destEnd?: number;
  }): Promise<WindowSummary> {
    this.ensureConnected();
    const window = this.raw.currentWindow ?? this.raw.inventory;
    const anyWindow = window as unknown as {
      inventoryStart: number;
      inventoryEnd: number;
    };
    const item = this.findItemDefinition(params.name);
    if (!item) {
      throw new Error(`Unknown item for transfer: ${params.name}`);
    }
    const direction = params.direction ?? "inventory_to_window";
    const containerStart = 0;
    const containerEnd = anyWindow.inventoryStart;
    const inventoryStart = anyWindow.inventoryStart;
    const inventoryEnd = anyWindow.inventoryEnd;
    const ranges =
      direction === "window_to_inventory"
        ? {
            sourceStart: containerStart,
            sourceEnd: containerEnd,
            destStart: inventoryStart,
            destEnd: inventoryEnd,
          }
        : direction === "custom"
          ? {
              sourceStart: params.sourceStart,
              sourceEnd: params.sourceEnd,
              destStart: params.destStart,
              destEnd: params.destEnd,
            }
          : {
              sourceStart: inventoryStart,
              sourceEnd: inventoryEnd,
              destStart: containerStart,
              destEnd: containerEnd,
            };
    if (
      ranges.sourceStart === undefined ||
      ranges.sourceEnd === undefined ||
      ranges.destStart === undefined ||
      ranges.destEnd === undefined
    ) {
      throw new Error("custom transfer requires sourceStart, sourceEnd, destStart, and destEnd.");
    }
    await this.raw.transfer({
      window,
      itemType: item.id,
      metadata: null,
      count: Math.max(1, params.count ?? 1),
      sourceStart: ranges.sourceStart,
      sourceEnd: ranges.sourceEnd,
      destStart: ranges.destStart,
      destEnd: ranges.destEnd,
    });
    return this.windowSummary();
  }

  setHotbarSlot(slot: number): string {
    this.ensureConnected();
    const clamped = Math.max(0, Math.min(8, Math.floor(slot)));
    this.raw.setQuickBarSlot(clamped);
    return `selected hotbar slot ${clamped}`;
  }

  useHeldItem(durationMs = 250, offhand = false): string {
    this.ensureConnected();
    this.raw.activateItem(offhand);
    setTimeout(() => {
      try {
        this.raw.deactivateItem();
      } catch {
        // The bot may have disconnected before the timer fires.
      }
    }, Math.max(50, Math.min(5000, durationMs)));
    return `used held item for ${durationMs}ms`;
  }

  async placeOnScreenHit(hit: ScreenPlacementHit, itemName?: string): Promise<PlacementSummary> {
    if (itemName) {
      await this.equipItem(itemName);
    }
    if (!this.raw.heldItem) {
      throw new Error("Cannot place: hand is empty.");
    }
    const referenceBlock = this.raw.blockAt(toVec3(hit.blockPosition));
    if (!referenceBlock || isAirName(referenceBlock.name)) {
      throw new Error("Visible target is no longer a solid placement reference.");
    }
    const target = hit.previousPosition;
    if (!target) {
      throw new Error("No visible adjacent air cell for placement.");
    }
    const face = new Vec3(
      target.x - hit.blockPosition.x,
      target.y - hit.blockPosition.y,
      target.z - hit.blockPosition.z,
    );
    await this.gotoNear(hit.blockPosition, 4);
    return this.placeBlockVerified({
      referencePosition: hit.blockPosition,
      target,
      face,
    });
  }

  async craftItem(name: string, count: number): Promise<string> {
    const item = this.findItemDefinition(name);
    if (!item) {
      throw new Error(`Unknown craft item: ${name}`);
    }
    const allRecipes = this.raw.recipesAll(item.id, null, true as never);
    const tableBlock = allRecipes.some((recipe) => recipe.requiresTable)
      ? this.findNearestBlockByName(["crafting_table"], 8)
      : undefined;
    const recipe = this.raw.recipesFor(item.id, null, Math.max(1, count), tableBlock ?? null)[0];
    if (!recipe) {
      const candidates = this.clientRecipeSummaries(name, 5);
      throw new Error(
        [
          `No currently craftable recipe for ${name}.`,
          candidates.length > 0 ? `Known candidates: ${JSON.stringify(candidates)}` : "No client recipe candidates found.",
          allRecipes.some((candidate) => candidate.requiresTable) && !tableBlock
            ? "A crafting_table is required but no loaded crafting_table block was found nearby. Use visual_find_blocks/find_nearby_blocks and move near one."
            : "",
        ].filter(Boolean).join("\n"),
      );
    }
    const craftTimes = Math.max(1, Math.ceil(count / Math.max(1, recipe.result.count ?? 1)));
    await this.raw.craft(recipe, craftTimes, tableBlock);
    return `crafted ${craftTimes * (recipe.result.count ?? 1)} ${name}${tableBlock ? " using crafting_table" : ""}`;
  }

  async buildBlueprint(params: {
    name: string;
    anchor: Vec3Like;
    placements: BlueprintPlacement[];
    clearMismatch?: boolean;
    limit?: number;
    dryRun?: boolean;
  }): Promise<BuildSummary> {
    const summary: BuildSummary = {
      blueprint: params.name,
      attempted: 0,
      placed: 0,
      skipped: 0,
      failed: [],
    };
    const buildPlan = createBlueprintBuildPlan({
      placements: params.placements,
      inventory: this.raw.inventory.items().map((item) => ({ name: item.name, count: item.count })),
      limit: params.limit,
    });
    summary.planned = buildPlan.plannedPlacements.length;
    summary.required = buildPlan.required;
    summary.available = buildPlan.available;
    summary.missing = buildPlan.missing;
    summary.acquisitionPlan = buildPlan.acquisitionPlan;
    summary.footprint = buildPlan.footprint;
    if (!buildPlan.canBuild) {
      summary.blocked = "missing_materials";
      return summary;
    }
    if (params.dryRun) {
      return summary;
    }

    let consecutiveNavigationFailures = 0;
    for (const placement of buildPlan.plannedPlacements) {
      const target = addVec(params.anchor, placement.position);
      summary.attempted += 1;
      try {
        const current = this.raw.blockAt(toVec3(target));
        if (current?.name === placement.block) {
          summary.skipped += 1;
          continue;
        }
        if (current && !isAirName(current.name)) {
          if (!params.clearMismatch) {
            summary.failed.push({
              position: target,
              block: placement.block,
              reason: `occupied by ${current.name}`,
            });
            continue;
          }
          await this.digAt(target);
        }
        await this.equipItem(placement.block);
        await this.placeBlockAt(target);
        summary.placed += 1;
        consecutiveNavigationFailures = 0;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        summary.failed.push({
          position: target,
          block: placement.block,
          reason,
        });
        consecutiveNavigationFailures = isNavigationBuildFailure(reason) ? consecutiveNavigationFailures + 1 : 0;
        if (consecutiveNavigationFailures >= BLUEPRINT_NAVIGATION_FAILURE_LIMIT) {
          summary.blocked = "navigation_blocked";
          break;
        }
      }
    }
    return summary;
  }

  async placeBlockAt(target: Vec3Like): Promise<PlacementSummary> {
    if (!this.raw.heldItem) {
      throw new Error("Cannot place: hand is empty.");
    }
    const neighbor = this.findPlacementNeighbor(target);
    if (!neighbor) {
      throw new Error(`No solid neighbor for placement at ${target.x},${target.y},${target.z}`);
    }
    await this.gotoNear(target, 4);
    return this.placeBlockVerified({
      referencePosition: {
        x: neighbor.block.position.x,
        y: neighbor.block.position.y,
        z: neighbor.block.position.z,
      },
      target,
      face: neighbor.face,
    });
  }

  private async placeBlockVerified(params: {
    referencePosition: Vec3Like;
    target: Vec3Like;
    face: Vec3;
  }): Promise<PlacementSummary> {
    this.ensureConnected();
    const heldItem = this.raw.heldItem;
    if (!heldItem) {
      throw new Error("Cannot place: hand is empty.");
    }

    const targetVec = toVec3(params.target);
    const beforeBlock = this.raw.blockAt(targetVec);
    const beforeName = beforeBlock?.name;
    const beforeSignature = blockSignature(beforeBlock);
    const maxAttempts = Math.max(1, this.config.minecraft.placementRetries + 1);
    let lastError: string | undefined;
    let afterName = beforeName;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const referenceBlock = this.raw.blockAt(toVec3(params.referencePosition));
      if (!referenceBlock || isAirName(referenceBlock.name)) {
        throw new Error(
          `Placement reference vanished at ${params.referencePosition.x},${params.referencePosition.y},${params.referencePosition.z}`,
        );
      }
      try {
        await this.sendPlacePacket(referenceBlock, params.face);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      const verified = await this.waitForPlacedBlock(targetVec, beforeSignature, this.config.minecraft.placementTimeoutMs);
      const afterBlock = this.raw.blockAt(targetVec);
      afterName = afterBlock?.name;
      if (verified) {
        return {
          target: params.target,
          reference: params.referencePosition,
          face: { x: params.face.x, y: params.face.y, z: params.face.z },
          item: heldItem.name,
          before: beforeName,
          after: afterName,
          attempts: attempt,
          verified: true,
        };
      }
      await sleep(150);
    }

    throw new Error(
      [
        `Placement at ${params.target.x},${params.target.y},${params.target.z} was not verified after ${maxAttempts} attempt(s).`,
        `before=${beforeName ?? "none"} after=${afterName ?? "none"} item=${heldItem.name}`,
        lastError ? `last_error=${lastError}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  private async sendPlacePacket(referenceBlock: NonNullable<ReturnType<Bot["blockAt"]>>, face: Vec3): Promise<void> {
    const botWithGenericPlace = this.raw as Bot & {
      _genericPlace?: (
        referenceBlock: NonNullable<ReturnType<Bot["blockAt"]>>,
        faceVector: Vec3,
        options: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    if (botWithGenericPlace._genericPlace) {
      await botWithGenericPlace._genericPlace(referenceBlock, face, {
        swingArm: "right",
        forceLook: true,
      });
      return;
    }
    try {
      await this.raw.placeBlock(referenceBlock, face);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("did not fire within timeout")) {
        throw error;
      }
      // Older mineflayer builds can throw before local chunk state catches up.
      // The caller verifies the actual target block after this.
    }
  }

  private async waitForPlacedBlock(target: Vec3, beforeSignature: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(500, timeoutMs);
    while (Date.now() <= deadline) {
      const block = this.raw.blockAt(target);
      const signature = blockSignature(block);
      if (block && !isAirName(block.name) && signature !== beforeSignature) {
        return true;
      }
      await sleep(100);
    }
    const block = this.raw.blockAt(target);
    return Boolean(block && !isAirName(block.name) && blockSignature(block) !== beforeSignature);
  }

  private findInventoryItem(name: string) {
    const normalized = name.trim().toLowerCase();
    return this.raw
      .inventory
      .items()
      .find((item) => item.name === normalized || item.displayName.toLowerCase() === normalized);
  }

  private findItemDefinition(name: string): { id: number; name?: string; displayName?: string } | undefined {
    const normalized = name.trim().toLowerCase();
    const registry = (this.raw as unknown as {
      registry?: {
        itemsByName?: Record<string, { id: number; name?: string; displayName?: string }>;
        itemsArray?: Array<{ id: number; name?: string; displayName?: string }>;
      };
    }).registry ?? this.data;
    return (
      registry.itemsByName?.[normalized] ??
      registry.itemsArray?.find(
        (item) => item.name === normalized || item.displayName?.toLowerCase() === normalized,
      )
    );
  }

  private attachRecipeCapture(bot: Bot): void {
    this.serverRecipes.splice(0, this.serverRecipes.length);
    this.unlockedRecipes.clear();
    this.recipesCapturedAt = undefined;
    this.recipesSkippedByConfig = this.config.minecraft.skipRecipePackets;
    if (!this.config.minecraft.captureRecipes) {
      return;
    }
    const client = (bot as unknown as { _client?: { on: (event: string, listener: (packet: any) => void) => void } })._client;
    if (!client) {
      return;
    }
    client.on("declare_recipes", (packet: any) => {
      this.recipesCapturedAt = new Date().toISOString();
      if (packet?.raw) {
        this.recipesSkippedByConfig = true;
        return;
      }
      const recipes = Array.isArray(packet?.recipes) ? packet.recipes : [];
      this.serverRecipes.splice(
        0,
        this.serverRecipes.length,
        ...recipes.map((recipe: any, index: number) => this.serverRecipeSummary(recipe, index)),
      );
    });
    client.on("unlock_recipes", (packet: any) => {
      for (const id of [...(Array.isArray(packet?.recipes1) ? packet.recipes1 : []), ...(Array.isArray(packet?.recipes2) ? packet.recipes2 : [])]) {
        if (typeof id === "string") {
          this.unlockedRecipes.add(id);
        }
      }
    });
  }

  private clientRecipeSummaries(query: string, limit: number): RecipeSummary[] {
    const item = this.findItemDefinition(query);
    if (!item) {
      return [];
    }
    return this.raw.recipesAll(item.id, null, true as never)
      .slice(0, Math.max(1, Math.min(64, limit)))
      .map((recipe, index) => this.clientRecipeSummary(recipe, index, Math.max(1, recipe.result.count ?? 1)));
  }

  private clientRecipeSummary(recipe: any, index: number, desiredCount: number): RecipeSummary {
    const craftTimes = Math.max(1, Math.ceil(desiredCount / Math.max(1, recipe.result?.count ?? 1)));
    const missing = (Array.isArray(recipe.delta) ? recipe.delta : [])
      .filter((item: any) => item?.count < 0)
      .map((item: any) => {
        const required = Math.abs(Number(item.count ?? 0)) * craftTimes;
        const available = this.raw.inventory.count(item.id, item.metadata ?? null);
        return {
          name: this.itemNameFromId(item.id),
          id: item.id,
          metadata: item.metadata ?? null,
          required,
          available,
        };
      })
      .filter((item: { available: number; required: number }) => item.available < item.required);
    return {
      source: "client",
      index,
      result: this.recipeChoiceFromItem(recipe.result),
      requiresTable: Boolean(recipe.requiresTable),
      craftable: missing.length === 0,
      missing,
      ingredients: Array.isArray(recipe.ingredients)
        ? recipe.ingredients.map((item: any) => ({ choices: [this.recipeChoiceFromItem(item, Math.abs(item.count ?? 1))] }))
        : undefined,
      shape: Array.isArray(recipe.inShape)
        ? recipe.inShape.map((row: any[]) =>
            row.map((item) => ({ choices: item?.id === -1 ? [] : [this.recipeChoiceFromItem(item)] })),
          )
        : undefined,
    };
  }

  private serverRecipeSummary(recipe: any, index: number): RecipeSummary {
    const data = recipe?.data ?? {};
    const shape = this.serverRecipeShape(data);
    const ingredients = shape?.flat().filter((ingredient) => ingredient.choices.length > 0) ?? this.serverRecipeIngredients(data);
    const result = this.choiceFromSlot(data.result ?? recipe?.result);
    const missing = this.missingForIngredients(ingredients);
    return {
      source: "server",
      index,
      id: typeof recipe?.name === "string" ? recipe.name : undefined,
      type: typeof recipe?.type === "string" ? recipe.type : undefined,
      result,
      requiresTable: this.serverRecipeRequiresTable(recipe, shape, ingredients),
      craftable: missing.length === 0,
      missing,
      ingredients,
      shape,
    };
  }

  private serverRecipeShape(data: any): RecipeIngredientSummary[][] | undefined {
    if (!Array.isArray(data?.ingredients) || typeof data.gridWidth !== "number" || typeof data.gridHeight !== "number") {
      return undefined;
    }
    const rows: RecipeIngredientSummary[][] = [];
    for (let y = 0; y < data.gridHeight; y += 1) {
      const row: RecipeIngredientSummary[] = [];
      for (let x = 0; x < data.gridWidth; x += 1) {
        row.push(this.ingredientSummary(data.ingredients[x]?.[y] ?? data.ingredients[y]?.[x]));
      }
      rows.push(row);
    }
    return rows;
  }

  private serverRecipeIngredients(data: any): RecipeIngredientSummary[] | undefined {
    if (!Array.isArray(data?.ingredients)) {
      return undefined;
    }
    return data.ingredients.map((ingredient: any) => this.ingredientSummary(ingredient));
  }

  private serverRecipeRequiresTable(recipe: any, shape?: RecipeIngredientSummary[][], ingredients?: RecipeIngredientSummary[]): boolean {
    const type = typeof recipe?.type === "string" ? recipe.type : "";
    if (type.includes("smelting") || type.includes("blasting") || type.includes("smoking") || type.includes("stonecutting")) {
      return true;
    }
    if (!shape) {
      return (ingredients?.length ?? 0) > 4;
    }
    return shape.length > 2 || shape.some((row) => row.length > 2);
  }

  private ingredientSummary(value: any): RecipeIngredientSummary {
    const choices = (Array.isArray(value) ? value : [value])
      .map((slot) => this.choiceFromSlot(slot))
      .filter((choice) => choice.name !== "empty");
    return { choices };
  }

  private missingForIngredients(ingredients: RecipeIngredientSummary[] | undefined): RecipeSummary["missing"] {
    if (!ingredients) {
      return [];
    }
    return ingredients.flatMap((ingredient) => {
      const candidates = ingredient.choices;
      if (candidates.length === 0) {
        return [];
      }
      const availableCandidate = candidates.find(
        (choice) => choice.id !== undefined && this.raw.inventory.count(choice.id, choice.metadata ?? null) >= choice.count,
      );
      if (availableCandidate) {
        return [];
      }
      const choice = candidates[0];
      const available = choice.id === undefined ? 0 : this.raw.inventory.count(choice.id, choice.metadata ?? null);
      return [{
        name: choice.name,
        id: choice.id,
        metadata: choice.metadata ?? null,
        required: choice.count,
        available,
      }];
    });
  }

  private choiceFromSlot(slot: any): RecipeChoiceSummary {
    if (!slot || slot.present === false) {
      return { name: "empty", count: 0 };
    }
    const id = Number(
      slot.itemId ?? slot.itemID ?? slot.itemType ?? slot.type ?? slot.id ?? slot.blockId ?? Number.NaN,
    );
    const count = Number(slot.itemCount ?? slot.count ?? slot.item_count ?? 1);
    if (!Number.isFinite(id) || id < 0) {
      return { name: "empty", count: 0 };
    }
    return {
      id,
      name: this.itemNameFromId(id),
      displayName: this.itemDisplayNameFromId(id),
      metadata: typeof slot.metadata === "number" ? slot.metadata : null,
      count: Math.max(1, count),
    };
  }

  private recipeChoiceFromItem(item: any, countOverride?: number): RecipeChoiceSummary {
    const id = Number(item?.id ?? item?.type ?? Number.NaN);
    if (!Number.isFinite(id) || id < 0) {
      return { name: "empty", count: 0 };
    }
    return {
      id,
      name: this.itemNameFromId(id),
      displayName: this.itemDisplayNameFromId(id),
      metadata: item?.metadata ?? null,
      count: Math.max(1, Number(countOverride ?? item?.count ?? 1)),
    };
  }

  private recipeMatches(recipe: RecipeSummary, query: string): boolean {
    if (!query) {
      return true;
    }
    const haystack = [
      recipe.id,
      recipe.type,
      recipe.result.name,
      recipe.result.displayName,
      JSON.stringify(recipe.ingredients ?? []),
      JSON.stringify(recipe.shape ?? []),
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query);
  }

  private itemNameFromId(id: number): string {
    const registry = (((this.raw as unknown as {
      registry?: {
        items?: Record<number, { name?: string; displayName?: string }>;
        itemsById?: Record<number, { name?: string; displayName?: string }>;
      };
    }).registry ?? this.data) as {
      items?: Record<number, { name?: string; displayName?: string }>;
      itemsById?: Record<number, { name?: string; displayName?: string }>;
    });
    return registry.itemsById?.[id]?.name ?? registry.items?.[id]?.name ?? `item_${id}`;
  }

  private itemDisplayNameFromId(id: number): string | undefined {
    const registry = (((this.raw as unknown as {
      registry?: {
        items?: Record<number, { name?: string; displayName?: string }>;
        itemsById?: Record<number, { name?: string; displayName?: string }>;
      };
    }).registry ?? this.data) as {
      items?: Record<number, { name?: string; displayName?: string }>;
      itemsById?: Record<number, { name?: string; displayName?: string }>;
    });
    return registry.itemsById?.[id]?.displayName ?? registry.items?.[id]?.displayName;
  }

  private findNearestBlockByName(names: string[], maxDistance: number) {
    const targets = new Set(names.map((name) => name.toLowerCase()));
    return this.raw.findBlock({
      matching: (block) => targets.has(block?.name ?? ""),
      maxDistance,
      count: 1,
    }) ?? undefined;
  }

  private findPlacementNeighbor(target: Vec3Like):
    | { block: NonNullable<ReturnType<Bot["blockAt"]>>; face: Vec3 }
    | undefined {
    const directions = [
      new Vec3(0, -1, 0),
      new Vec3(0, 1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];
    for (const direction of directions) {
      const neighborPos = toVec3(target).minus(direction);
      const block = this.raw.blockAt(neighborPos);
      if (!block || isAirName(block.name)) {
        continue;
      }
      return {
        block,
        face: direction,
      };
    }
    return undefined;
  }
}
