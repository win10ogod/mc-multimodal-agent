import minecraftData from "minecraft-data";
import type { BotApi, RawBotView } from "./BotApi";
import type {
  BuildSummary,
  CombatPulseSummary,
  CombatScanSummary,
  LocalizationSnapshot,
  NavigationSummary,
  PlacementSummary,
  RecipeCatalogSummary,
  RecipeSummary,
  RuntimeRegistrySnapshot,
  ScreenPlacementHit,
  WindowSummary,
} from "./MinecraftBot";
import type { Vec3Like } from "../types";
import type { BlueprintPlacement } from "../blueprint/Blueprint";

/**
 * Action intents emitted by the flyer agent's tools when running under MCU.
 * The button-compiler (Phase 4) will translate these into MCU button macros.
 */
export type McuActionIntent =
  | { kind: "say"; text: string }
  | { kind: "move"; direction: "forward" | "back" | "left" | "right"; durationMs: number; sprint?: boolean; sneak?: boolean; jump?: boolean }
  | { kind: "stopMovement" }
  | { kind: "look"; yawDeltaDeg: number; pitchDeltaDeg: number }
  | { kind: "goto"; pos: Vec3Like; range: number }
  | { kind: "stopNavigation"; reason: string }
  | { kind: "dig"; pos: Vec3Like }
  | { kind: "place"; hit: ScreenPlacementHit; itemName?: string }
  | { kind: "useHeld"; durationMs: number; offhand: boolean }
  | { kind: "attackEntity"; entityId: number; equipBestWeapon: boolean }
  | { kind: "activateBlock"; pos: Vec3Like }
  | { kind: "craft"; item: string; count: number }
  | { kind: "equip"; name: string }
  | { kind: "equipBestWeapon" }
  | { kind: "setHotbar"; slot: number }
  | { kind: "openWindow"; pos: Vec3Like }
  | { kind: "clickSlot"; slot: number; mouseButton: number; mode: number }
  | { kind: "transferWindow"; params: Record<string, unknown> }
  | { kind: "closeWindow" }
  | { kind: "follow"; username?: string; range: number }
  | { kind: "retreat"; entityId: number; durationMs: number }
  | { kind: "combatPulse"; params: Record<string, unknown> }
  | { kind: "eat"; force: boolean }
  | { kind: "buildBlueprint"; params: Record<string, unknown> };

export type McuVirtualBotOptions = {
  version: string;
  username?: string;
};

const EMPTY_WINDOW: WindowSummary = {
  id: 0,
  type: "none",
  title: "",
  inventoryStart: 0,
  inventoryEnd: 0,
  selectedItem: null,
  slots: [],
};

const EMPTY_NAV: NavigationSummary = {
  id: "mcu-virtual",
  type: "goto",
  status: "idle",
  range: 0,
  startedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  elapsedMs: 0,
  timeoutMs: 0,
  moving: false,
};

const EMPTY_COMBAT_SCAN: CombatScanSummary = {
  health: 20,
  food: 20,
  held: "air",
  pveEnabled: false,
  pvpEnabled: false,
  scanRange: 0,
  threats: [],
  nearbyEntities: [],
};

export class McuVirtualBot implements BotApi {
  readonly raw: RawBotView;
  private readonly mcData: ReturnType<typeof minecraftData>;
  private readonly intentLog: McuActionIntent[] = [];
  private readonly inventory = new Map<string, number>();
  private hotbarSelected = 0;
  private heldItem = "air";
  private readonly position: Vec3Like = { x: 0, y: 64, z: 0 };
  private latestFrame: string | null = null;
  private health = 20;
  private food = 20;

  constructor(opts: McuVirtualBotOptions) {
    const data = minecraftData(opts.version);
    if (!data) {
      throw new Error(`McuVirtualBot: minecraft-data has no registry for version ${opts.version}`);
    }
    this.mcData = data;
    this.raw = {
      entity: {
        position: this.position as unknown as RawBotView["entity"]["position"],
      },
      blockAt: () => undefined,
      version: opts.version,
    } as unknown as RawBotView;
  }

  // -------- MCU pipeline integration ---------------------------------------

  ingestFrame(b64: string): void {
    this.latestFrame = b64;
  }

  getLatestFrame(): string | null {
    return this.latestFrame;
  }

  setVirtualHealth(health: number, food: number): void {
    this.health = health;
    this.food = food;
  }

  drainIntents(): McuActionIntent[] {
    const out = this.intentLog.slice();
    this.intentLog.length = 0;
    return out;
  }

  recordObservedItem(name: string, count: number): void {
    this.inventory.set(name, count);
  }

  private push(intent: McuActionIntent): void {
    this.intentLog.push(intent);
  }

  // -------- BotApi: connection / status ------------------------------------

  ensureConnected(): void {
    // Always "connected" in MCU mode — the simulator is the world.
  }

  isConnected(): boolean {
    return true;
  }

  connectionSummary(): string {
    return `mcu virtual bot v${this.raw.version}`;
  }

  drainGuidance(): Array<{ time: string; username: string; message: string }> {
    return [];
  }

  async chat(message: string): Promise<void> {
    this.push({ kind: "say", text: message });
  }

  statusSummary(): string {
    const inv = [...this.inventory.entries()].map(([k, v]) => `${k}:${v}`).join(",") || "(empty)";
    return `mcu virtual bot health=${this.health} food=${this.food} held=${this.heldItem} pos=(${this.position.x.toFixed(1)},${this.position.y.toFixed(1)},${this.position.z.toFixed(1)}) inv=${inv}`;
  }

  // -------- BotApi: state reads --------------------------------------------

  inventorySummary(): Array<{ name: string; count: number; slot: number }> {
    return [...this.inventory.entries()].map(([name, count], idx) => ({ name, count, slot: idx }));
  }

  windowSummary(): WindowSummary {
    return EMPTY_WINDOW;
  }

  navigationStatus(): NavigationSummary {
    return EMPTY_NAV;
  }

  localizationSnapshot(): LocalizationSnapshot {
    const blockPosition = {
      x: Math.floor(this.position.x),
      y: Math.floor(this.position.y),
      z: Math.floor(this.position.z),
    };
    const feet = this.feetBlock();
    return {
      position: { ...this.position },
      blockPosition,
      eyePosition: { x: this.position.x, y: this.position.y + 1.62, z: this.position.z },
      yawDeg: 0,
      facing: "south",
      pitchDeg: 0,
      health: this.health,
      food: this.food,
      held: this.heldItem,
      feetBlock: null,
      belowBlock: {
        name: "unknown",
        position: feet,
      },
      navigation: EMPTY_NAV,
    };
  }

  feetBlock(): Vec3Like {
    return { x: Math.floor(this.position.x), y: Math.floor(this.position.y) - 1, z: Math.floor(this.position.z) };
  }

  runtimeRegistrySnapshot(): RuntimeRegistrySnapshot {
    const data = this.mcData;
    const items = (data.itemsArray ?? []).map((item: { name: string; id?: number; displayName?: string }) => ({
      name: item.name,
      id: item.id,
      displayName: item.displayName,
    }));
    const blocks = (data.blocksArray ?? []).map((block: { name: string; id?: number; displayName?: string }) => ({
      name: block.name,
      id: block.id,
      displayName: block.displayName,
    }));
    return { version: this.raw.version, items, blocks };
  }

  recipeCatalog(query = "", limit = 12): RecipeCatalogSummary {
    const recipes = this.virtualRecipeQuery(query, Math.max(1, Math.min(64, limit)));
    return {
      source: recipes.length > 0 ? "client" : "none",
      capturedAt: new Date(0).toISOString(),
      serverRecipeCount: 0,
      unlockedRecipeCount: 0,
      skippedByConfig: false,
      query,
      recipes,
    };
  }

  private virtualRecipeQuery(query: string, limit: number): RecipeSummary[] {
    const data = this.mcData;
    const normalized = query.trim().toLowerCase();
    const out: RecipeSummary[] = [];
    const candidates = (data.itemsArray ?? []).filter((item: { name: string; displayName?: string }) =>
      !normalized
        ? true
        : item.name.toLowerCase().includes(normalized) || (item.displayName ?? "").toLowerCase().includes(normalized),
    );
    let index = 0;
    for (const item of candidates as Array<{ id: number; name: string; displayName?: string }>) {
      const recipes = data.recipes[item.id] as Array<{ inShape?: unknown[][]; ingredients?: unknown[]; result?: { count?: number; id?: number } }> | undefined;
      if (!recipes?.length) continue;
      for (const r of recipes) {
        if (out.length >= limit) return out;
        const ingredients = collectIngredientChoices(r, data);
        const requiresTable = recipeRequiresTable(r);
        const missing = ingredients
          .map((ing) => {
            const need = ing.choices.reduce((a, b) => Math.max(a, b.count), 0);
            const haveAny = ing.choices.some((c) => (this.inventory.get(c.name) ?? 0) >= need);
            return haveAny
              ? null
              : {
                  name: ing.choices[0]?.name ?? "unknown",
                  required: need,
                  available: ing.choices.reduce((a, c) => a + (this.inventory.get(c.name) ?? 0), 0),
                };
          })
          .filter((m): m is { name: string; required: number; available: number } => Boolean(m));
        const resultName = data.items[r.result?.id ?? 0]?.name ?? item.name;
        out.push({
          source: "client",
          index: index++,
          result: { name: resultName, id: r.result?.id, count: r.result?.count ?? 1 },
          requiresTable,
          craftable: missing.length === 0,
          missing,
          ingredients,
        });
      }
    }
    return out;
  }

  // -------- BotApi: movement / look ----------------------------------------

  async lookDelta(yawDeltaDeg: number, pitchDeltaDeg: number): Promise<void> {
    this.push({ kind: "look", yawDeltaDeg, pitchDeltaDeg });
  }

  async move(params: { direction: "forward" | "back" | "left" | "right"; durationMs: number; sprint?: boolean; sneak?: boolean; jump?: boolean }): Promise<void> {
    this.push({ kind: "move", ...params });
  }

  stopMovement(): void {
    this.push({ kind: "stopMovement" });
  }

  async gotoNear(pos: Vec3Like, range = 2): Promise<boolean> {
    this.push({ kind: "goto", pos, range });
    return false;
  }

  startGotoNear(pos: Vec3Like, range = 2, _timeoutMs?: number): NavigationSummary {
    this.push({ kind: "goto", pos, range });
    return EMPTY_NAV;
  }

  stopNavigation(reason = "navigation stopped"): NavigationSummary {
    this.push({ kind: "stopNavigation", reason });
    return EMPTY_NAV;
  }

  // -------- BotApi: world interaction --------------------------------------

  async digAt(pos: Vec3Like): Promise<string> {
    this.push({ kind: "dig", pos });
    return "intent: dig queued";
  }

  async activateBlockAt(pos: Vec3Like): Promise<string> {
    this.push({ kind: "activateBlock", pos });
    return "intent: activate queued";
  }

  async placeOnScreenHit(hit: ScreenPlacementHit, itemName?: string): Promise<PlacementSummary> {
    this.push({ kind: "place", hit, itemName });
    return {
      target: hit.blockPosition,
      reference: hit.blockPosition,
      face: { x: 0, y: 1, z: 0 },
      item: itemName ?? this.heldItem,
      attempts: 0,
      verified: false,
    };
  }

  useHeldItem(durationMs = 250, offhand = false): string {
    this.push({ kind: "useHeld", durationMs, offhand });
    return "intent: use queued";
  }

  async attackEntityById(entityId: number, params: { range?: number; equipBestWeapon?: boolean } = {}): Promise<string> {
    this.push({ kind: "attackEntity", entityId, equipBestWeapon: params.equipBestWeapon === true });
    return "intent: attack queued";
  }

  async craftItem(name: string, count: number): Promise<string> {
    this.push({ kind: "craft", item: name, count });
    return "intent: craft queued";
  }

  async equipItem(name: string): Promise<void> {
    this.heldItem = name;
    this.push({ kind: "equip", name });
  }

  async equipBestWeapon(): Promise<string> {
    this.push({ kind: "equipBestWeapon" });
    return "intent: equipBestWeapon queued";
  }

  setHotbarSlot(slot: number): string {
    this.hotbarSelected = Math.max(0, Math.min(8, slot));
    this.push({ kind: "setHotbar", slot: this.hotbarSelected });
    return `intent: hotbar slot ${this.hotbarSelected} queued`;
  }

  // -------- BotApi: GUI / windows ------------------------------------------

  async openBlockWindowAt(pos: Vec3Like, _timeoutMs?: number): Promise<WindowSummary> {
    this.push({ kind: "openWindow", pos });
    return EMPTY_WINDOW;
  }

  async clickWindowSlot(slot: number, mouseButton = 0, mode = 0): Promise<WindowSummary> {
    this.push({ kind: "clickSlot", slot, mouseButton, mode });
    return EMPTY_WINDOW;
  }

  async transferWindowItem(params: Record<string, unknown>): Promise<WindowSummary> {
    this.push({ kind: "transferWindow", params });
    return EMPTY_WINDOW;
  }

  closeCurrentWindow(): string {
    this.push({ kind: "closeWindow" });
    return "intent: close window queued";
  }

  // -------- BotApi: combat / social / utility ------------------------------

  combatScan(_params: { range?: number; includePlayers?: boolean } = {}): CombatScanSummary {
    return { ...EMPTY_COMBAT_SCAN, held: this.heldItem };
  }

  async combatPulse(params: { durationMs?: number; includePlayers?: boolean; range?: number; attack?: boolean; retreatHealth?: number } = {}): Promise<CombatPulseSummary> {
    this.push({ kind: "combatPulse", params: params as Record<string, unknown> });
    return {
      ok: true,
      mode: "pve",
      durationMs: params.durationMs ?? 0,
      attacks: 0,
      retreats: 0,
      foodUses: 0,
      steps: [],
      finalScan: { ...EMPTY_COMBAT_SCAN, held: this.heldItem },
    };
  }

  async retreatFromEntity(entityId: number, durationMs = 900): Promise<string> {
    this.push({ kind: "retreat", entityId, durationMs });
    return "intent: retreat queued";
  }

  followPlayer(username?: string, range = 3): string {
    this.push({ kind: "follow", username, range });
    return `intent: follow ${username ?? "(any)"} queued`;
  }

  async eatBestFood(force = false): Promise<string> {
    this.push({ kind: "eat", force });
    return "intent: eat queued";
  }

  async buildBlueprint(params: {
    name: string;
    anchor: Vec3Like;
    placements: BlueprintPlacement[];
    clearMismatch?: boolean;
    limit?: number;
  }): Promise<BuildSummary> {
    this.push({ kind: "buildBlueprint", params: params as unknown as Record<string, unknown> });
    return { blueprint: params.name, attempted: 0, placed: 0, skipped: 0, failed: [] };
  }
}

// -------- recipe helpers -----------------------------------------------------

type IngredientChoice = { name: string; id?: number; count: number };

function collectIngredientChoices(
  recipe: { inShape?: unknown[][]; ingredients?: unknown[] },
  data: ReturnType<typeof minecraftData>,
): Array<{ choices: IngredientChoice[] }> {
  const out: Array<{ choices: IngredientChoice[] }> = [];
  const seen = new Map<string, IngredientChoice>();
  const push = (id: unknown, count = 1): void => {
    if (typeof id !== "number" || id <= 0) return;
    const def = data.items[id];
    if (!def) return;
    const key = def.name;
    const existing = seen.get(key);
    if (existing) {
      existing.count += count;
    } else {
      seen.set(key, { name: def.name, id, count });
    }
  };
  if (Array.isArray(recipe.inShape)) {
    for (const row of recipe.inShape) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        if (cell == null) continue;
        if (typeof cell === "number") push(cell);
        else if (Array.isArray(cell)) for (const id of cell) push(id);
      }
    }
  }
  if (Array.isArray(recipe.ingredients)) {
    for (const ingredient of recipe.ingredients) {
      if (typeof ingredient === "number") push(ingredient);
      else if (Array.isArray(ingredient)) for (const id of ingredient) push(id);
    }
  }
  for (const choice of seen.values()) {
    out.push({ choices: [choice] });
  }
  return out;
}

function recipeRequiresTable(recipe: { inShape?: unknown[][]; ingredients?: unknown[] }): boolean {
  if (Array.isArray(recipe.inShape)) {
    const rows = recipe.inShape.length;
    let cols = 0;
    for (const row of recipe.inShape) if (Array.isArray(row)) cols = Math.max(cols, row.length);
    return rows > 2 || cols > 2;
  }
  if (Array.isArray(recipe.ingredients)) return recipe.ingredients.length > 4;
  return false;
}
