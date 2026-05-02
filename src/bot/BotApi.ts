import type { MinecraftBot } from "./MinecraftBot";

export type RawBotView = MinecraftBot["raw"];

const TOOL_BOT_METHODS = [
  "ensureConnected",
  "chat",
  "stopMovement",
  "stopNavigation",
  "inventorySummary",
  "statusSummary",
  "navigationStatus",
  "windowSummary",
  "recipeCatalog",
  "runtimeRegistrySnapshot",
  "lookDelta",
  "move",
  "gotoNear",
  "startGotoNear",
  "digAt",
  "placeOnScreenHit",
  "useHeldItem",
  "attackEntityById",
  "activateBlockAt",
  "craftItem",
  "equipItem",
  "equipBestWeapon",
  "setHotbarSlot",
  "openBlockWindowAt",
  "clickWindowSlot",
  "transferWindowItem",
  "closeCurrentWindow",
  "combatScan",
  "combatPulse",
  "retreatFromEntity",
  "followPlayer",
  "eatBestFood",
  "buildBlueprint",
  "feetBlock",
] as const;

type ToolBotMethod = (typeof TOOL_BOT_METHODS)[number];

export type BotApi = Pick<MinecraftBot, ToolBotMethod> & {
  readonly raw: RawBotView;
};
