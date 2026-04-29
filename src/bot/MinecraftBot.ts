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
import { buildModdedTolerantCustomPackets } from "./moddedProtocol";

const AIR_NAMES = new Set(["air", "cave_air", "void_air"]);
const { GoalFollow, GoalNear } = goals;

export type ScreenPlacementHit = {
  blockName: string;
  blockPosition: Vec3Like;
  previousPosition?: Vec3Like;
  distance: number;
};

export type BuildSummary = {
  blueprint: string;
  attempted: number;
  placed: number;
  skipped: number;
  failed: Array<{ position: Vec3Like; block: string; reason: string }>;
};

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

function isAirName(name: string | undefined): boolean {
  return !name || AIR_NAMES.has(name);
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

export class MinecraftBot {
  private bot?: Bot;
  private mcData?: ReturnType<typeof minecraftData>;
  private readonly guidanceQueue: PlayerGuidance[] = [];
  private readonly serverRecipes: RecipeSummary[] = [];
  private readonly unlockedRecipes = new Set<string>();
  private recipesCapturedAt?: string;
  private recipesSkippedByConfig = false;
  private connected = false;
  private disconnectRequested = false;
  private lastDisconnectReason = "";
  private lastPacketAt = 0;
  private lastKeepAliveAt = 0;
  private keepAliveReplies = 0;
  private keepAliveTimeouts = 0;

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
    if (this.connected && this.bot?.entity) {
      return;
    }
    const previousBot = this.bot;
    if (previousBot) {
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
    this.attachLenientKeepAlive(bot);
    this.attachRecipeCapture(bot);
    bot.loadPlugin(pathfinder);

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          bot.removeListener("spawn", onSpawn);
          bot.removeListener("error", onError);
          bot.removeListener("kicked", onKicked);
        };
        const onSpawn = (): void => {
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
    bot.pathfinder.setMovements(movements);
    bot.on("end", (reason) => {
      this.connected = false;
      this.lastDisconnectReason = `end: ${String(reason ?? "connection closed")}`;
    });
    bot.on("kicked", (reason) => {
      this.connected = false;
      this.lastDisconnectReason = `kicked: ${String(reason)}`;
    });
    bot.on("error", (error) => {
      this.lastDisconnectReason = `error: ${error.message}`;
      const client = bot._client as unknown as { ended?: boolean };
      if (client.ended) {
        this.connected = false;
      }
    });
    bot.on("chat", (username, message) => {
      if (username === bot.username) {
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
  }

  disconnect(): void {
    this.disconnectRequested = true;
    this.connected = false;
    this.bot?.quit("Agent stopped");
  }

  isConnected(): boolean {
    return Boolean(this.bot && this.connected && this.bot.entity);
  }

  connectionSummary(): string {
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
    return [
      `position=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
      `yaw=${((bot.entity.yaw * 180) / Math.PI).toFixed(1)}`,
      `pitch=${((bot.entity.pitch * 180) / Math.PI).toFixed(1)}`,
      `health=${bot.health}`,
      `food=${bot.food}`,
      `held=${held}`,
      `connection=${this.keepAliveSummary()}`,
    ].join(" ");
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
  }

  async gotoNear(pos: Vec3Like, range = 2): Promise<void> {
    this.ensureConnected();
    await this.raw.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, range));
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
    return `following ${target.username ?? username ?? "nearest player"} within ${range} blocks`;
  }

  async equipItem(name: string): Promise<void> {
    const item = this.findInventoryItem(name);
    if (!item) {
      throw new Error(`Item not found in inventory: ${name}`);
    }
    await this.raw.equip(item, "hand");
  }

  async digAt(pos: Vec3Like): Promise<string> {
    this.ensureConnected();
    const block = this.raw.blockAt(toVec3(pos));
    if (!block || isAirName(block.name)) {
      throw new Error(`No diggable block at ${pos.x},${pos.y},${pos.z}`);
    }
    await this.gotoNear(pos, 4);
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

  async placeOnScreenHit(hit: ScreenPlacementHit, itemName?: string): Promise<Vec3Like> {
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
    await this.raw.lookAt(toVec3(target).offset(0.5, 0.5, 0.5), true);
    await this.raw.placeBlock(referenceBlock, face);
    return target;
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
  }): Promise<BuildSummary> {
    const summary: BuildSummary = {
      blueprint: params.name,
      attempted: 0,
      placed: 0,
      skipped: 0,
      failed: [],
    };
    const placements = params.placements
      .slice()
      .sort(
        (a, b) =>
          a.position.y - b.position.y ||
          a.position.z - b.position.z ||
          a.position.x - b.position.x,
      )
      .slice(0, params.limit ?? params.placements.length);

    for (const placement of placements) {
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
      } catch (error) {
        summary.failed.push({
          position: target,
          block: placement.block,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return summary;
  }

  async placeBlockAt(target: Vec3Like): Promise<void> {
    if (!this.raw.heldItem) {
      throw new Error("Cannot place: hand is empty.");
    }
    const neighbor = this.findPlacementNeighbor(target);
    if (!neighbor) {
      throw new Error(`No solid neighbor for placement at ${target.x},${target.y},${target.z}`);
    }
    await this.gotoNear(target, 4);
    await this.raw.lookAt(toVec3(target).offset(0.5, 0.5, 0.5), true);
    await this.raw.placeBlock(neighbor.block, neighbor.face);
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
