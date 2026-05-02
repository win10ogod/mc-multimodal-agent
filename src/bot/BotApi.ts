import type { MinecraftBot } from "./MinecraftBot";
import type { VisualPerception } from "../vision/VisualPerception";

export type RawBotView = MinecraftBot["raw"];

export type VisionApi = Pick<
  VisualPerception,
  "capture" | "findVisibleTargets" | "hitFromScreen" | "screenFrameStaleReason" | "screenToDelta"
>;

const TOOL_BOT_METHODS = [
  "ensureConnected",
  "isConnected",
  "connectionSummary",
  "drainGuidance",
  "chat",
  "stopMovement",
  "stopNavigation",
  "inventorySummary",
  "statusSummary",
  "navigationStatus",
  "localizationSnapshot",
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
