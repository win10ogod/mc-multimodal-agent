import type { AgentConfig } from "../config";
import minecraftData from "minecraft-data";
import type { BotApi } from "../bot/BotApi";
import { planCraft } from "../bot/CraftPlanner";
import { resolveBlueprint } from "../blueprint/Blueprint";
import type { ItemCatalog } from "../knowledge/ItemCatalog";
import type { MemoryStore } from "../memory/MemoryStore";
import type { GoalNode, GoalStore, GoalStatus } from "../goals/GoalStore";
import type { SkillLibrary } from "../skills/SkillLibrary";
import type { ImitationObserver } from "../learning/ImitationObserver";
import type { TaskStore } from "../tasks/TaskStore";
import type { JsonObject, JsonValue, ToolResult, Vec3Like } from "../types";
import type { VisionApi } from "../bot/BotApi";
import { ToolRegistry } from "./ToolRegistry";
import { compactText, sleep } from "../utils/misc";
import { Vec3 } from "vec3";

export type MinecraftToolContext = {
  config: AgentConfig;
  bot: BotApi;
  vision: VisionApi;
  catalog: ItemCatalog;
  memory: MemoryStore;
  goals?: GoalStore;
  skills: SkillLibrary;
  imitation?: ImitationObserver;
  tasks?: TaskStore;
};

function ok(text: string, data?: JsonValue): ToolResult {
  return { ok: true, text, data };
}

function requiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalNumber(args: JsonObject, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function screenXY(args: JsonObject): { x: number; y: number } {
  return {
    x: optionalNumber(args, "x", 160),
    y: optionalNumber(args, "y", 90),
  };
}

function vecFromArray(value: JsonValue | undefined): Vec3Like {
  if (!Array.isArray(value) || value.length !== 3) {
    return { x: 0, y: 0, z: 0 };
  }
  return {
    x: Number(value[0] ?? 0),
    y: Number(value[1] ?? 0),
    z: Number(value[2] ?? 0),
  };
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function blockMatches(name: string, needles: string[], mode: string): boolean {
  const normalized = name.toLowerCase();
  const terms = needles.map((item) => item.toLowerCase());
  if (mode === "exact") {
    return terms.includes(normalized);
  }
  if (mode === "suffix") {
    return terms.some((term) => normalized.endsWith(term));
  }
  return terms.some((term) => normalized.includes(term));
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function chatSafeLine(value: string): string {
  return compactText(value.replace(/\s+/g, " ").trim(), 220);
}

async function announceGoalPlan(ctx: MinecraftToolContext, root: GoalNode, goals: GoalNode[]): Promise<void> {
  if (!ctx.config.observability.announcePlansInChat) {
    return;
  }
  const maxLines = Math.max(1, Math.min(12, ctx.config.observability.planChatMaxLines));
  const orderedGoals = goals
    .filter((goal) => goal.parentId === root.id)
    .sort((a, b) => a.order - b.order || b.priority - a.priority);
  const lines = [`[Agent] Plan for: ${compactText(root.title, 160)}`];
  const goalLineLimit = orderedGoals.length > maxLines - 1 ? Math.max(0, maxLines - 2) : Math.max(0, maxLines - 1);
  for (const [index, goal] of orderedGoals.slice(0, goalLineLimit).entries()) {
    lines.push(`[${index + 1}] ${compactText(goal.title, 170)}`);
  }
  if (orderedGoals.length > lines.length - 1) {
    lines.push(`[Agent] ...${orderedGoals.length - (lines.length - 1)} more steps in state/goals.json`);
  }
  for (const line of lines.slice(0, maxLines)) {
    await ctx.bot.chat(chatSafeLine(line));
    await sleep(350);
  }
}

function defaultSkillScope(ctx: MinecraftToolContext): Record<string, unknown> {
  return {
    server: `${ctx.config.minecraft.host}:${ctx.config.minecraft.port}`,
    version: ctx.bot.raw.version,
    auth: ctx.config.minecraft.auth,
    moddedTolerant: ctx.config.minecraft.moddedTolerant,
  };
}

function jsonObjectFromValue(value: JsonValue | undefined): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonObject;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function skillStepFromValue(value: JsonValue): { tool: string; arguments: JsonObject } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as JsonObject;
  const rawTool = entry.tool ?? entry.tool_name ?? entry.name;
  if (typeof rawTool !== "string" || !rawTool.trim()) {
    return undefined;
  }
  return {
    tool: rawTool.trim(),
    arguments: jsonObjectFromValue(entry.arguments ?? entry.args ?? entry.parameters),
  };
}

const SKILL_META_TOOLS = new Set([
  "execute_steps",
  "execute_skill",
  "inspect_skill",
  "query_skills",
  "record_skill",
  "mark_skill_attempt",
  "imitation_to_skill",
  "schedule_task",
  "list_tasks",
  "memory_note",
  "memory_query",
  "memory_get",
  "memory_promote",
  "memory_status",
  "goal_plan",
  "goal_list",
  "goal_next",
  "goal_update",
  "goal_checkpoint",
  "environment_profile",
]);

async function findNearbyBlocksChunked(params: {
  ctx: MinecraftToolContext;
  names: string[];
  match: string;
  maxDistance: number;
  verticalRange: number;
  count: number;
}): Promise<{ checked: number; results: Array<{ name: string; position: Vec3Like; distance: number }> }> {
  params.ctx.bot.ensureConnected();
  const origin = params.ctx.bot.raw.entity.position;
  const originBlock = {
    x: Math.floor(origin.x),
    y: Math.floor(origin.y),
    z: Math.floor(origin.z),
  };
  const maxDistance = Math.max(1, Math.min(96, Math.floor(params.maxDistance)));
  const verticalRange = Math.max(1, Math.min(maxDistance, Math.floor(params.verticalRange)));
  const count = Math.max(1, Math.min(128, Math.floor(params.count)));
  const maxDistanceSq = maxDistance * maxDistance;
  const results: Array<{ name: string; position: Vec3Like; distance: number }> = [];
  let checked = 0;

  const inspect = (dx: number, dy: number, dz: number): void => {
    if (dx * dx + dy * dy + dz * dz > maxDistanceSq) {
      return;
    }
    checked += 1;
    const pos = new Vec3(originBlock.x + dx, originBlock.y + dy, originBlock.z + dz);
    const block = params.ctx.bot.raw.blockAt(pos);
    if (!block || !blockMatches(block.name, params.names, params.match)) {
      return;
    }
    results.push({
      name: block.name,
      position: { x: pos.x, y: pos.y, z: pos.z },
      distance: Number(pos.distanceTo(origin).toFixed(2)),
    });
  };

  for (let radius = 0; radius <= maxDistance && results.length < count; radius += 1) {
    for (let dy = -verticalRange; dy <= verticalRange && results.length < count; dy += 1) {
      if (radius === 0) {
        inspect(0, dy, 0);
        if (checked > 0 && checked % 4096 === 0) {
          await sleep(0);
          params.ctx.bot.ensureConnected();
        }
        continue;
      }

      for (let dx = -radius; dx <= radius && results.length < count; dx += 1) {
        inspect(dx, dy, -radius);
        if (results.length >= count) {
          break;
        }
        inspect(dx, dy, radius);
        if (checked > 0 && checked % 4096 === 0) {
          await sleep(0);
          params.ctx.bot.ensureConnected();
        }
      }

      for (let dz = -radius + 1; dz <= radius - 1 && results.length < count; dz += 1) {
        inspect(-radius, dy, dz);
        if (results.length >= count) {
          break;
        }
        inspect(radius, dy, dz);
        if (checked > 0 && checked % 4096 === 0) {
          await sleep(0);
          params.ctx.bot.ensureConnected();
        }
      }
    }
    if (checked > 0 && checked % 4096 !== 0) {
      await sleep(0);
      params.ctx.bot.ensureConnected();
    }
  }

  results.sort((a, b) => a.distance - b.distance);
  return { checked, results: results.slice(0, count) };
}

export function createMinecraftToolRegistry(): ToolRegistry<MinecraftToolContext> {
  const registry = new ToolRegistry<MinecraftToolContext>();

  registry.register({
    name: "observe",
    description:
      "Capture a fresh first-person visual frame. Use this before locating blocks/items or after actions change the view.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => {
      const frame = ctx.vision.capture();
      return {
        ok: true,
        text: frame.text,
        content: [
          { type: "text", text: frame.text },
          { type: "image", dataUrl: frame.dataUrl, detail: "low" },
        ],
        data: {
          width: frame.width,
          height: frame.height,
          capturedAt: frame.capturedAt,
          visibleBlocks: frame.visibleBlocks,
          visibleTargets: frame.visibleTargets,
        },
      };
    },
  });

  registry.register({
    name: "visual_find_blocks",
    description:
      "Find visible blocks in the latest visual frame by name pattern and return screen coordinates. Use this to connect perception to actions like look_screen, pathfind_screen, dig_screen, place_screen, or finding a visible crafting table/machine.",
    parameters: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Visible block name fragments, suffixes, or exact names. Empty means return nearest visible targets.",
        },
        match: { type: "string", enum: ["contains", "suffix", "exact"], default: "contains" },
        count: { type: "number", minimum: 1, maximum: 64 },
        refresh: { type: "boolean", description: "Capture a fresh frame before searching." },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (args.refresh === true) {
        ctx.vision.capture();
      }
      const targets = ctx.vision.findVisibleTargets(
        stringArray(args.names),
        typeof args.match === "string" ? args.match : "contains",
        optionalNumber(args, "count", 12),
      );
      return ok(`found ${targets.length} visible targets`, targets as unknown as JsonValue);
    },
  });

  registry.register({
    name: "look_screen",
    description: "Turn the player camera so a selected screen coordinate moves toward the center.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "Screen x coordinate in the latest visual frame." },
        y: { type: "number", description: "Screen y coordinate in the latest visual frame." },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const { x, y } = screenXY(args);
      const delta = ctx.vision.screenToDelta(x, y);
      await ctx.bot.lookDelta(delta.yawDeltaDeg, delta.pitchDeltaDeg);
      return ok(`looked toward screen (${x}, ${y})`, delta as unknown as JsonValue);
    },
  });

  registry.register({
    name: "turn",
    description: "Rotate camera by explicit yaw and pitch deltas in degrees.",
    parameters: {
      type: "object",
      properties: {
        yawDeltaDeg: { type: "number" },
        pitchDeltaDeg: { type: "number" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const yawDeltaDeg = optionalNumber(args, "yawDeltaDeg", 0);
      const pitchDeltaDeg = optionalNumber(args, "pitchDeltaDeg", 0);
      await ctx.bot.lookDelta(yawDeltaDeg, pitchDeltaDeg);
      return ok(`turned yaw=${yawDeltaDeg} pitch=${pitchDeltaDeg}`);
    },
  });

  registry.register({
    name: "move",
    description: "Move like a human player for a short duration.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["forward", "back", "left", "right"] },
        durationMs: { type: "number", minimum: 50, maximum: 5000 },
        sprint: { type: "boolean" },
        sneak: { type: "boolean" },
        jump: { type: "boolean" },
      },
      required: ["direction", "durationMs"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const direction = requiredString(args, "direction") as "forward" | "back" | "left" | "right";
      await ctx.bot.move({
        direction,
        durationMs: optionalNumber(args, "durationMs", 400),
        sprint: args.sprint === true,
        sneak: args.sneak === true,
        jump: args.jump === true,
      });
      return ok(`moved ${direction}`);
    },
  });

  registry.register({
    name: "stop",
    description: "Release movement keys and stop pathfinding.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => {
      ctx.bot.stopMovement();
      return ok("stopped movement");
    },
  });

  registry.register({
    name: "wait",
    description:
      "Wait for a short duration without changing controls. Use between machine/container actions, crafting output polling, movement settling, or player-guided demonstrations.",
    parameters: {
      type: "object",
      properties: {
        durationMs: { type: "number", minimum: 50, maximum: 30000 },
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const durationMs = Math.max(50, Math.min(30_000, optionalNumber(args, "durationMs", 1000)));
      await sleep(durationMs);
      return ok(`waited ${durationMs}ms${typeof args.reason === "string" ? `: ${args.reason}` : ""}`);
    },
  });

  registry.register({
    name: "follow_player",
    description:
      "Continuously follow a nearby Minecraft player by username. Use this when a player asks the agent to follow them.",
    parameters: {
      type: "object",
      properties: {
        username: { type: "string", description: "Player username. Omit to follow the nearest visible player." },
        range: { type: "number", minimum: 1, maximum: 8 },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const username = typeof args.username === "string" && args.username.trim() ? args.username.trim() : undefined;
      return ok(ctx.bot.followPlayer(username, optionalNumber(args, "range", 3)));
    },
  });

  registry.register({
    name: "dig_screen",
    description: "Dig the solid block visible at a screen coordinate from the latest visual frame.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const { x, y } = screenXY(args);
      const hit = ctx.vision.hitFromScreen(x, y);
      if (!hit) {
        throw new Error(`No visible block hit at screen (${x}, ${y}). Use observe or choose another pixel.`);
      }
      const dug = await ctx.bot.digAt(hit.blockPosition);
      return ok(`dug visible block ${dug} at screen (${x}, ${y})`);
    },
  });

  registry.register({
    name: "place_screen",
    description:
      "Place the held or named item onto the visible face at a screen coordinate from the latest visual frame. The tool verifies the target block after sending the place action, so retry with a different face/position if it reports not verified.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        item: { type: "string", description: "Optional inventory item name to equip first." },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const { x, y } = screenXY(args);
      const hit = ctx.vision.hitFromScreen(x, y);
      if (!hit) {
        throw new Error(`No visible placement target at screen (${x}, ${y}).`);
      }
      const item = typeof args.item === "string" ? args.item : undefined;
      const placement = await ctx.bot.placeOnScreenHit(hit, item);
      return ok(
        `placed ${placement.item} from screen (${x}, ${y}) at ${placement.target.x},${placement.target.y},${placement.target.z} after ${placement.attempts} attempt(s)`,
        placement as unknown as JsonValue,
      );
    },
  });

  registry.register({
    name: "pathfind_screen",
    description:
      "Walk near the visible block at a screen coordinate. Use background=true for non-blocking navigation so the agent can keep observing while walking.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        range: { type: "number", minimum: 1, maximum: 8 },
        background: { type: "boolean" },
        timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const { x, y } = screenXY(args);
      const hit = ctx.vision.hitFromScreen(x, y);
      if (!hit) {
        throw new Error(`No visible path target at screen (${x}, ${y}).`);
      }
      const range = optionalNumber(args, "range", 2);
      if (args.background === true) {
        const status = ctx.bot.startGotoNear(hit.blockPosition, range, optionalNumber(args, "timeoutMs", ctx.config.minecraft.pathfindTimeoutMs));
        return ok(`started background navigation to visible target at screen (${x}, ${y})`, status as unknown as JsonValue);
      }
      const moved = await ctx.bot.gotoNear(hit.blockPosition, range);
      return ok(`${moved ? "walked near" : "already near"} visible target at screen (${x}, ${y})`);
    },
  });

  registry.register({
    name: "find_nearby_blocks",
    description:
      "Search loaded nearby blocks by name pattern and return positions. Use this to learn/explore generic tasks without hard-coded recipes, for example finding logs, ores, machines, or modded blocks.",
    parameters: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Block name fragments, suffixes, or exact names, such as log, _log, ore, chest.",
        },
        match: { type: "string", enum: ["contains", "suffix", "exact"], default: "contains" },
        maxDistance: { type: "number", minimum: 1, maximum: 96 },
        verticalRange: {
          type: "number",
          minimum: 1,
          maximum: 96,
          description: "Vertical search distance above/below the bot. Omit for a practical default.",
        },
        count: { type: "number", minimum: 1, maximum: 128 },
      },
      required: ["names"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const names = stringArray(args.names);
      if (names.length === 0) {
        throw new Error("names must contain at least one block name pattern.");
      }
      const match = typeof args.match === "string" ? args.match : "contains";
      const maxDistance = optionalNumber(args, "maxDistance", 48);
      const { checked, results } = await findNearbyBlocksChunked({
        ctx,
        names,
        match,
        maxDistance,
        verticalRange: optionalNumber(args, "verticalRange", Math.min(maxDistance, 32)),
        count: optionalNumber(args, "count", 16),
      });
      return ok(`found ${results.length} matching blocks after checking ${checked} nearby positions`, results as unknown as JsonValue);
    },
  });

  registry.register({
    name: "pathfind_to_block",
    description:
      "Walk near a block position returned by find_nearby_blocks. Use background=true for non-blocking navigation, then call navigation_status while the bot walks.",
    parameters: {
      type: "object",
      properties: {
        position: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
        },
        range: { type: "number", minimum: 1, maximum: 8 },
        background: { type: "boolean" },
        timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
      },
      required: ["position"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const pos = vecFromArray(args.position);
      const range = optionalNumber(args, "range", 3);
      if (args.background === true) {
        const status = ctx.bot.startGotoNear(pos, range, optionalNumber(args, "timeoutMs", ctx.config.minecraft.pathfindTimeoutMs));
        return ok(`started background navigation to block ${pos.x},${pos.y},${pos.z}`, status as unknown as JsonValue);
      }
      const moved = await ctx.bot.gotoNear(pos, range);
      return ok(`${moved ? "walked near" : "already near"} block ${pos.x},${pos.y},${pos.z}`);
    },
  });

  registry.register({
    name: "navigation_start",
    description:
      "Start non-blocking navigation to an explicit block position and return immediately. Use navigation_status to monitor progress while the bot keeps walking.",
    parameters: {
      type: "object",
      properties: {
        position: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
        },
        range: { type: "number", minimum: 1, maximum: 8 },
        timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
      },
      required: ["position"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const pos = vecFromArray(args.position);
      const status = ctx.bot.startGotoNear(
        pos,
        optionalNumber(args, "range", 3),
        optionalNumber(args, "timeoutMs", ctx.config.minecraft.pathfindTimeoutMs),
      );
      return ok(`started navigation ${status.id}`, status as unknown as JsonValue);
    },
  });

  registry.register({
    name: "navigation_status",
    description:
      "Inspect current non-blocking navigation/follow status, including distance, moving flag, timeout, and completion state.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => ok("navigation status", ctx.bot.navigationStatus() as unknown as JsonValue),
  });

  registry.register({
    name: "navigation_stop",
    description: "Stop current non-blocking navigation or follow movement.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(
        "navigation stopped",
        ctx.bot.stopNavigation(typeof args.reason === "string" ? args.reason : "navigation_stop tool") as unknown as JsonValue,
      ),
  });

  registry.register({
    name: "dig_block",
    description:
      "Dig a block at an explicit position returned by find_nearby_blocks or learned procedure state. Prefer visual tools for visual-only localization; use this for generic block-search results.",
    parameters: {
      type: "object",
      properties: {
        position: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
        },
      },
      required: ["position"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const pos = vecFromArray(args.position);
      const dug = await ctx.bot.digAt(pos);
      return ok(`dug ${dug} at ${pos.x},${pos.y},${pos.z}`);
    },
  });

  registry.register({
    name: "harvest_nearby_blocks",
    description:
      "One-shot routine for common gathering actions: search loaded nearby blocks by name pattern, walk near each target, dig it, and report internal atomic steps. Use for requests like finding trees and chopping logs when no fresh reasoning is needed between each dug block.",
    parameters: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Block name fragments, suffixes, or exact names, such as _log, log, ore.",
        },
        match: { type: "string", enum: ["contains", "suffix", "exact"], default: "contains" },
        count: { type: "number", minimum: 1, maximum: 32 },
        maxDistance: { type: "number", minimum: 1, maximum: 96 },
        verticalRange: { type: "number", minimum: 1, maximum: 96 },
        stopOnFailure: { type: "boolean" },
      },
      required: ["names"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const names = stringArray(args.names);
      if (names.length === 0) {
        throw new Error("names must contain at least one block name pattern.");
      }
      const match = typeof args.match === "string" ? args.match : "contains";
      const count = Math.max(1, Math.min(32, Math.floor(optionalNumber(args, "count", 1))));
      const maxDistance = optionalNumber(args, "maxDistance", 48);
      const stopOnFailure = args.stopOnFailure !== false;
      const search = await findNearbyBlocksChunked({
        ctx,
        names,
        match,
        maxDistance,
        verticalRange: optionalNumber(args, "verticalRange", Math.min(maxDistance, 32)),
        count: Math.max(count * 3, count),
      });
      const targets = search.results.slice(0, count);
      const executedSteps: Array<{
        step: number;
        tool: string;
        arguments: JsonObject;
        ok: boolean;
        text: string;
      }> = [
        {
          step: 1,
          tool: "find_nearby_blocks",
          arguments: {
            names,
            match,
            maxDistance,
            verticalRange: optionalNumber(args, "verticalRange", Math.min(maxDistance, 32)),
            count,
          },
          ok: targets.length > 0,
          text: `found ${search.results.length} matching blocks after checking ${search.checked} positions`,
        },
      ];
      const harvested: Array<{ name: string; position: Vec3Like }> = [];
      const failed: Array<{ name: string; position: Vec3Like; reason: string }> = [];
      let stepIndex = 2;
      for (const target of targets) {
        const positionArray = [target.position.x, target.position.y, target.position.z];
        try {
          await ctx.bot.gotoNear(target.position, 4);
          executedSteps.push({
            step: stepIndex,
            tool: "pathfind_to_block",
            arguments: { position: positionArray, range: 4 },
            ok: true,
            text: `walked near block ${positionArray.join(",")}`,
          });
          stepIndex += 1;
          const dug = await ctx.bot.digAt(target.position);
          harvested.push({ name: dug, position: target.position });
          executedSteps.push({
            step: stepIndex,
            tool: "dig_block",
            arguments: { position: positionArray },
            ok: true,
            text: `dug ${dug} at ${positionArray.join(",")}`,
          });
          stepIndex += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failed.push({ name: target.name, position: target.position, reason });
          executedSteps.push({
            step: stepIndex,
            tool: "dig_block",
            arguments: { position: positionArray },
            ok: false,
            text: reason,
          });
          stepIndex += 1;
          if (stopOnFailure) {
            break;
          }
        }
      }
      const success = harvested.length > 0 && (failed.length === 0 || !stopOnFailure);
      return {
        ok: success,
        text: `harvested ${harvested.length}/${targets.length} target blocks${
          targets.length === 0 ? `; no matches for ${names.join(", ")}` : ""
        }${failed.length > 0 ? `; ${failed.length} failed` : ""}`,
        data: {
          success,
          searchChecked: search.checked,
          matched: search.results.length,
          harvested,
          failed,
          executedSteps,
        } as unknown as JsonValue,
      };
    },
  });

  registry.register({
    name: "activate_block",
    description:
      "Right-click/activate a block at an explicit position. Use for generic modded machines, workstations, buttons, levers, doors, and blocks learned from player instruction.",
    parameters: {
      type: "object",
      properties: {
        position: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
        },
      },
      required: ["position"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const pos = vecFromArray(args.position);
      return ok(await ctx.bot.activateBlockAt(pos));
    },
  });

  registry.register({
    name: "open_block_window",
    description:
      "Open a server-side block UI/window at a position and return its slots. Use this for crafting tables, chests, furnaces, and modded machine containers.",
    parameters: {
      type: "object",
      properties: {
        position: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
        },
        timeoutMs: { type: "number", minimum: 500, maximum: 15000 },
      },
      required: ["position"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const pos = vecFromArray(args.position);
      return ok(
        `opened block window at ${pos.x},${pos.y},${pos.z}`,
        (await ctx.bot.openBlockWindowAt(pos, optionalNumber(args, "timeoutMs", 5000))) as unknown as JsonValue,
      );
    },
  });

  registry.register({
    name: "observe_window",
    description:
      "Inspect the current server-side inventory/container window, including slot numbers and item stacks. Use after opening a modded UI or after any click/transfer.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => ok("window", ctx.bot.windowSummary() as unknown as JsonValue),
  });

  registry.register({
    name: "click_window_slot",
    description:
      "Click a slot in the current window. mode=0 normal click, mode=1 shift-click, mode=4 drop, mode=6 double click. mouseButton=0 left, 1 right.",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "number" },
        mouseButton: { type: "number", minimum: 0, maximum: 8 },
        mode: { type: "number", minimum: 0, maximum: 6 },
      },
      required: ["slot"],
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(
        "clicked window slot",
        (await ctx.bot.clickWindowSlot(
          Math.floor(optionalNumber(args, "slot", 0)),
          Math.floor(optionalNumber(args, "mouseButton", 0)),
          Math.floor(optionalNumber(args, "mode", 0)),
        )) as unknown as JsonValue,
      ),
  });

  registry.register({
    name: "transfer_window_item",
    description:
      "Move item stacks between player inventory and the current window. Use for learned machine recipes and modded container workflows. For unknown UIs, inspect slot ranges with observe_window first.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number", minimum: 1 },
        direction: {
          type: "string",
          enum: ["inventory_to_window", "window_to_inventory", "custom"],
          default: "inventory_to_window",
        },
        sourceStart: { type: "number" },
        sourceEnd: { type: "number" },
        destStart: { type: "number" },
        destEnd: { type: "number" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(
        "transferred window item",
        (await ctx.bot.transferWindowItem({
          name: requiredString(args, "name"),
          count: Math.floor(optionalNumber(args, "count", 1)),
          direction:
            args.direction === "window_to_inventory" || args.direction === "custom"
              ? args.direction
              : "inventory_to_window",
          sourceStart: typeof args.sourceStart === "number" ? Math.floor(args.sourceStart) : undefined,
          sourceEnd: typeof args.sourceEnd === "number" ? Math.floor(args.sourceEnd) : undefined,
          destStart: typeof args.destStart === "number" ? Math.floor(args.destStart) : undefined,
          destEnd: typeof args.destEnd === "number" ? Math.floor(args.destEnd) : undefined,
        })) as unknown as JsonValue,
      ),
  });

  registry.register({
    name: "close_window",
    description: "Close the currently open server-side window/container.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => ok(ctx.bot.closeCurrentWindow()),
  });

  registry.register({
    name: "select_hotbar_slot",
    description: "Select a hotbar slot 0-8. Use before use_held_item when a learned procedure needs an item in hand.",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "number", minimum: 0, maximum: 8 },
      },
      required: ["slot"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => ok(ctx.bot.setHotbarSlot(optionalNumber(args, "slot", 0))),
  });

  registry.register({
    name: "use_held_item",
    description:
      "Use/right-click with the held item for a short duration. This is a generic server-visible action, not an arbitrary client-only keyboard keybind.",
    parameters: {
      type: "object",
      properties: {
        durationMs: { type: "number", minimum: 50, maximum: 5000 },
        offhand: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(ctx.bot.useHeldItem(optionalNumber(args, "durationMs", 250), args.offhand === true)),
  });

  registry.register({
    name: "inventory",
    description: "Inspect inventory item names and counts.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => ok("inventory", ctx.bot.inventorySummary() as unknown as JsonValue),
  });

  registry.register({
    name: "recipe_status",
    description:
      "Report whether server recipes were captured, skipped for modded tolerance, or falling back to client minecraft-data recipes.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => ok("recipe status", ctx.bot.recipeCatalog("", 1) as unknown as JsonValue),
  });

  registry.register({
    name: "recipe_query",
    description:
      "Query known crafting recipes from the server recipe packet when available, otherwise from Mineflayer/minecraft-data. Returns ingredients, missing inventory, whether a crafting table or machine-like workstation is required, and craftability.",
    parameters: {
      type: "object",
      properties: {
        item: {
          type: "string",
          description: "Output item/recipe name or fragment, e.g. stick, crafting_table, modid:item_name.",
        },
        limit: { type: "number", minimum: 1, maximum: 64 },
      },
      required: ["item"],
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(
        "recipe query",
        ctx.bot.recipeCatalog(requiredString(args, "item"), optionalNumber(args, "limit", 12)) as unknown as JsonValue,
      ),
  });

  registry.register({
    name: "plan_craft",
    description:
      "Recursively plan how to craft a target item from current inventory down to gatherable resources. Returns an ordered list of steps (have/craft/smelt/gather) with table/furnace requirements. Use BEFORE multi-step crafting tasks (tools, armor, anything that needs ingots) to avoid chaining recipe_query calls.",
    parameters: {
      type: "object",
      properties: {
        item: { type: "string", description: "Target item name, e.g. iron_pickaxe, diamond_sword." },
        count: { type: "number", minimum: 1, maximum: 64, description: "How many to plan for. Default 1." },
        maxDepth: { type: "number", minimum: 1, maximum: 8 },
        maxSteps: { type: "number", minimum: 4, maximum: 80 },
      },
      required: ["item"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const item = requiredString(args, "item");
      const count = optionalNumber(args, "count", 1);
      const inventory: Record<string, number> = {};
      for (const stack of ctx.bot.inventorySummary()) {
        inventory[stack.name] = (inventory[stack.name] ?? 0) + stack.count;
      }
      const version = ctx.bot.raw.version;
      const data = minecraftData(version);
      if (!data) {
        return { ok: false, text: `minecraft-data has no registry for version ${version}` };
      }
      const plan = planCraft({
        data,
        target: item,
        count,
        inventory,
        maxDepth: optionalNumber(args, "maxDepth", 4),
        maxSteps: optionalNumber(args, "maxSteps", 40),
      });
      return ok(`plan_craft ${item} x${count}`, plan as unknown as JsonValue);
    },
  });

  registry.register({
    name: "equip_item",
    description: "Equip an inventory item by Minecraft item name.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const name = requiredString(args, "name");
      await ctx.bot.equipItem(name);
      return ok(`equipped ${name}`);
    },
  });

  registry.register({
    name: "combat_scan",
    description:
      "Scan nearby entities and classify immediate PVE/PVP threats. Use before combat decisions and after taking damage.",
    parameters: {
      type: "object",
      properties: {
        range: { type: "number", minimum: 2, maximum: 64 },
        includePlayers: {
          type: "boolean",
          description: "Include players as threats only when COMBAT_ALLOW_PVP=true.",
        },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(
        "combat scan",
        ctx.bot.combatScan({
          range: optionalNumber(args, "range", ctx.config.combat.scanRange),
          includePlayers: args.includePlayers === true,
        }) as unknown as JsonValue,
      ),
  });

  registry.register({
    name: "equip_best_weapon",
    description: "Equip the best detected melee/ranged weapon from inventory for PVE/PVP.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => ok(await ctx.bot.equipBestWeapon()),
  });

  registry.register({
    name: "eat_best_food",
    description:
      "Eat the best available food when health/food is low. Set force=true to eat even if current status looks acceptable.",
    parameters: {
      type: "object",
      properties: {
        force: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => ok(await ctx.bot.eatBestFood(args.force === true)),
  });

  registry.register({
    name: "attack_entity",
    description:
      "Attack one entity id returned by combat_scan. Refuses player targets unless COMBAT_ALLOW_PVP=true.",
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "number" },
        range: { type: "number", minimum: 1.8, maximum: 6 },
        equipBestWeapon: { type: "boolean" },
      },
      required: ["entityId"],
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(
        await ctx.bot.attackEntityById(Math.floor(optionalNumber(args, "entityId", -1)), {
          range: optionalNumber(args, "range", ctx.config.combat.attackRange),
          equipBestWeapon: args.equipBestWeapon !== false,
        }),
      ),
  });

  registry.register({
    name: "retreat_from_entity",
    description: "Fast defensive retreat away from one entity id returned by combat_scan.",
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "number" },
        durationMs: { type: "number", minimum: 100, maximum: 2500 },
      },
      required: ["entityId"],
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(await ctx.bot.retreatFromEntity(Math.floor(optionalNumber(args, "entityId", -1)), optionalNumber(args, "durationMs", 900))),
  });

  registry.register({
    name: "combat_pulse",
    description:
      "Run a local low-latency combat/reflex loop for a short duration. Handles scanning, weapon equip, attacking, eating, and retreating without waiting for model turns between each tick. PVP requires COMBAT_ALLOW_PVP=true.",
    parameters: {
      type: "object",
      properties: {
        durationMs: { type: "number", minimum: 250, maximum: 30000 },
        includePlayers: { type: "boolean" },
        range: { type: "number", minimum: 2, maximum: 64 },
        attack: { type: "boolean" },
        retreatHealth: { type: "number", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const summary = await ctx.bot.combatPulse({
        durationMs: optionalNumber(args, "durationMs", 3500),
        includePlayers: args.includePlayers === true,
        range: optionalNumber(args, "range", ctx.config.combat.scanRange),
        attack: args.attack !== false,
        retreatHealth: optionalNumber(args, "retreatHealth", ctx.config.combat.criticalHealth),
      });
      return {
        ok: summary.ok,
        text: `${summary.mode} combat pulse: attacks=${summary.attacks} retreats=${summary.retreats} food=${summary.foodUses} threats_left=${summary.finalScan.threats.length}`,
        data: {
          ...summary,
          executedSteps: summary.steps.map((step, index) => ({
            step: index + 1,
            tool: step.action,
            arguments: {},
            ok: step.ok,
            text: step.text,
          })),
        } as unknown as JsonValue,
      };
    },
  });

  registry.register({
    name: "craft_item",
    description:
      "Craft an item if a known recipe and required ingredients are available. Prefer recipe_query first, then locate a visible/nearby crafting_table when required.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number", minimum: 1 },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const message = await ctx.bot.craftItem(requiredString(args, "name"), optionalNumber(args, "count", 1));
      return ok(message);
    },
  });

  registry.register({
    name: "build_blueprint",
    description:
      "Build a JSON blueprint bottom-up from an anchor. Use after visually choosing a clear building area.",
    parameters: {
      type: "object",
      properties: {
        blueprint: { type: "string", description: "Blueprint name, file path, or file basename." },
        anchor: { type: "string", enum: ["feet", "relative"], default: "feet" },
        offset: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
          description: "XYZ offset from current feet block.",
        },
        clearMismatch: { type: "boolean" },
        limit: { type: "number", description: "Optional max placements for incremental building." },
      },
      required: ["blueprint"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const requested = requiredString(args, "blueprint");
      const { blueprint } = await resolveBlueprint(ctx.config.paths.blueprints, requested);
      const base = ctx.bot.feetBlock();
      const offset = vecFromArray(args.offset);
      const anchor = {
        x: base.x + offset.x,
        y: base.y + offset.y,
        z: base.z + offset.z,
      };
      const summary = await ctx.bot.buildBlueprint({
        name: blueprint.name,
        anchor,
        placements: blueprint.placements,
        clearMismatch: args.clearMismatch === true,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return ok(`blueprint ${blueprint.name}: placed=${summary.placed} skipped=${summary.skipped} failed=${summary.failed.length}`, summary as unknown as JsonValue);
    },
  });

  registry.register({
    name: "catalog_query",
    description: "Search dynamic item/block information and Minecraft item names.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok("catalog results", ctx.catalog.query(requiredString(args, "query")) as unknown as JsonValue),
  });

  registry.register({
    name: "catalog_sync_runtime",
    description:
      "Refresh the item/block catalog from the connected server runtime registry. Useful for modded servers and arbitrary Minecraft versions.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => {
      const snapshot = ctx.bot.runtimeRegistrySnapshot();
      ctx.catalog.syncRuntimeRegistry(snapshot);
      return ok(
        `runtime catalog synced: ${snapshot.items.length} items, ${snapshot.blocks.length} blocks for ${snapshot.version}`,
        {
          version: snapshot.version,
          items: snapshot.items.length,
          blocks: snapshot.blocks.length,
        },
      );
    },
  });

  registry.register({
    name: "catalog_upsert",
    description: "Add or update dynamic item/block fields learned during play.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["item", "block", "entity", "unknown"] },
        fields: { type: "object", additionalProperties: true },
        aliases: { type: "array", items: { type: "string" } },
      },
      required: ["name", "fields"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const record = await ctx.catalog.upsert({
        name: requiredString(args, "name"),
        kind: typeof args.kind === "string" ? (args.kind as never) : undefined,
        fields: (args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)
          ? (args.fields as Record<string, unknown>)
          : {}) as Record<string, unknown>,
        aliases: Array.isArray(args.aliases)
          ? args.aliases.filter((item): item is string => typeof item === "string")
          : [],
      });
      return ok(`catalog updated ${record.name}`, record as unknown as JsonValue);
    },
  });

  registry.register({
    name: "memory_note",
    description:
      "Persist a fact, lesson, failure, goal, or environment observation into the LevelDB long-term memory store. Use semantic/procedural layer for durable knowledge, episodic for events, and working for active goals.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        kind: { type: "string", enum: ["fact", "lesson", "failure", "goal", "environment"] },
        layer: { type: "string", enum: ["episodic", "semantic", "procedural", "working"] },
        source: { type: "string", enum: ["agent", "player", "system", "flush", "migration"] },
        importance: { type: "number", minimum: 0, maximum: 1 },
        tags: { type: "array", items: { type: "string" } },
        scope: { type: "object", additionalProperties: true },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const note = await ctx.memory.addNote({
        text: requiredString(args, "text"),
        kind: typeof args.kind === "string" ? (args.kind as never) : "fact",
        layer: typeof args.layer === "string" ? (args.layer as never) : undefined,
        source: typeof args.source === "string" ? (args.source as never) : "agent",
        importance: typeof args.importance === "number" ? args.importance : undefined,
        tags: Array.isArray(args.tags)
          ? args.tags.filter((item): item is string => typeof item === "string")
          : [],
        scope:
          args.scope && typeof args.scope === "object" && !Array.isArray(args.scope)
            ? (args.scope as JsonObject)
            : undefined,
      });
      return ok(`memory saved ${note.id}`, note as unknown as JsonValue);
    },
  });

  registry.register({
    name: "memory_query",
    description:
      "Search the LevelDB long-term memory store. Use this before relying on old assumptions, modpack lessons, player preferences, or previous failures.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 50 },
        kind: { type: "string", enum: ["fact", "lesson", "failure", "goal", "environment"] },
        layer: { type: "string", enum: ["episodic", "semantic", "procedural", "working"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(
        "memory results",
        (await ctx.memory.search(requiredString(args, "query"), {
          limit: optionalNumber(args, "limit", 8),
          kind: typeof args.kind === "string" ? (args.kind as never) : undefined,
          layer: typeof args.layer === "string" ? (args.layer as never) : undefined,
          tags: Array.isArray(args.tags)
            ? args.tags.filter((item): item is string => typeof item === "string")
            : undefined,
        })) as unknown as JsonValue,
      ),
  });

  registry.register({
    name: "memory_get",
    description: "Read one exact LevelDB memory note by id after memory_query returns a relevant candidate.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const id = requiredString(args, "id");
      const note = await ctx.memory.getNote(id);
      if (!note) {
        throw new Error(`Unknown memory note: ${id}`);
      }
      return ok(`memory ${id}`, note as unknown as JsonValue);
    },
  });

  registry.register({
    name: "memory_promote",
    description:
      "Promote an existing memory note into long-term semantic/procedural memory after it proves generally useful.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(
        `memory promoted ${requiredString(args, "id")}`,
        (await ctx.memory.promoteNote(
          requiredString(args, "id"),
          typeof args.reason === "string" ? args.reason : undefined,
        )) as unknown as JsonValue,
      ),
  });

  registry.register({
    name: "memory_status",
    description: "Inspect LevelDB memory backend status and counts.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => ok("memory status", (await ctx.memory.status()) as unknown as JsonValue),
  });

  registry.register({
    name: "goal_plan",
    description:
      "Create or extend a persistent goal tree for a complex task. Use before executing multi-step tasks such as building, resource gathering, modded crafting, or exploration.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        goals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              successCriteria: { type: "string" },
              priority: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["task", "goals"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.goals) {
        throw new Error("Goal store is not available.");
      }
      const goals = Array.isArray(args.goals)
        ? args.goals
            .filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
            .map((item) => ({
              title: requiredString(item, "title"),
              description: typeof item.description === "string" ? item.description : undefined,
              successCriteria: typeof item.successCriteria === "string" ? item.successCriteria : undefined,
              priority: typeof item.priority === "number" ? item.priority : undefined,
            }))
        : [];
      const plan = await ctx.goals.createPlan({ task: requiredString(args, "task"), goals });
      const currentGoals = ctx.goals.list({ rootId: plan.root.rootId, includeDone: true });
      try {
        await announceGoalPlan(ctx, plan.root, currentGoals);
      } catch (error) {
        console.warn(`Failed to announce goal plan in chat: ${error instanceof Error ? error.message : String(error)}`);
      }
      return ok(`goal plan ${plan.root.id} with ${plan.goals.length} new subgoals`, plan as unknown as JsonValue);
    },
  });

  registry.register({
    name: "goal_list",
    description: "List persistent goals and subgoals, including blocked/running work from previous turns.",
    parameters: {
      type: "object",
      properties: {
        rootId: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "running", "blocked", "done", "failed", "cancelled"],
        },
        includeDone: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.goals) {
        throw new Error("Goal store is not available.");
      }
      return ok(
        "goals",
        ctx.goals.list({
          rootId: typeof args.rootId === "string" ? args.rootId : undefined,
          status: typeof args.status === "string" ? (args.status as GoalStatus) : undefined,
          includeDone: args.includeDone === true,
        }) as unknown as JsonValue,
      );
    },
  });

  registry.register({
    name: "goal_next",
    description: "Return the next pending/running subgoal to work on from the current persistent goal tree.",
    parameters: {
      type: "object",
      properties: {
        rootId: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.goals) {
        throw new Error("Goal store is not available.");
      }
      const next = ctx.goals.next(typeof args.rootId === "string" ? args.rootId : undefined);
      return next ? ok(`next goal ${next.id}`, next as unknown as JsonValue) : ok("no pending goal");
    },
  });

  registry.register({
    name: "goal_update",
    description:
      "Update persistent goal status after verification. Mark blocked with blockers instead of looping; mark done only after observation/inventory/world state verifies success.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "running", "blocked", "done", "failed", "cancelled"],
        },
        note: { type: "string" },
        verification: { type: "string" },
        blockers: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.goals) {
        throw new Error("Goal store is not available.");
      }
      const goal = await ctx.goals.update({
        id: requiredString(args, "id"),
        status: typeof args.status === "string" ? (args.status as GoalStatus) : undefined,
        note: typeof args.note === "string" ? args.note : undefined,
        verification: typeof args.verification === "string" ? args.verification : undefined,
        blockers: Array.isArray(args.blockers)
          ? args.blockers.filter((item): item is string => typeof item === "string")
          : undefined,
      });
      if (goal.status === "blocked" || goal.status === "failed") {
        await ctx.memory.addNote({
          kind: goal.status === "blocked" ? "goal" : "failure",
          layer: "working",
          source: "agent",
          importance: 0.75,
          text: `Goal ${goal.id} ${goal.status}: ${goal.title}. ${
            goal.blockers.length > 0 ? `Blockers: ${goal.blockers.join("; ")}. ` : ""
          }${goal.notes.at(-1) ?? ""}`,
          tags: ["goal", goal.status],
        });
      }
      return ok(`goal ${goal.id} updated ${goal.status}`, goal as unknown as JsonValue);
    },
  });

  registry.register({
    name: "goal_checkpoint",
    description: "Write a progress checkpoint to the active root goal so long tasks can resume after limits, reconnects, or restarts.",
    parameters: {
      type: "object",
      properties: {
        rootId: { type: "string" },
        note: { type: "string" },
      },
      required: ["note"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.goals) {
        throw new Error("Goal store is not available.");
      }
      const goal = await ctx.goals.checkpoint({
        rootId: typeof args.rootId === "string" ? args.rootId : undefined,
        note: requiredString(args, "note"),
      });
      await ctx.memory.addNote({
        kind: "goal",
        layer: "working",
        source: "agent",
        importance: 0.7,
        text: `Goal checkpoint ${goal.id}: ${goal.notes.at(-1) ?? args.note}`,
        tags: ["goal", "checkpoint"],
      });
      return ok(`goal checkpoint ${goal.id}`, goal as unknown as JsonValue);
    },
  });

  registry.register({
    name: "environment_profile",
    description:
      "Inspect and persist a compact profile of the current Minecraft server/modpack capabilities, registry counts, recipe status, and connection state.",
    parameters: {
      type: "object",
      properties: {
        persist: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const registrySnapshot = ctx.bot.runtimeRegistrySnapshot();
      const recipes = ctx.bot.recipeCatalog("", 1);
      const profile = {
        server: `${ctx.config.minecraft.host}:${ctx.config.minecraft.port}`,
        version: ctx.bot.raw.version,
        auth: ctx.config.minecraft.auth,
        moddedTolerant: ctx.config.minecraft.moddedTolerant,
        strictVisual: ctx.config.strictVisual,
        registry: {
          items: registrySnapshot.items.length,
          blocks: registrySnapshot.blocks.length,
        },
        recipes: {
          source: recipes.source,
          serverRecipeCount: recipes.serverRecipeCount,
          unlockedRecipeCount: recipes.unlockedRecipeCount,
          skippedByConfig: recipes.skippedByConfig,
        },
        status: ctx.bot.statusSummary(),
      };
      if (args.persist !== false) {
        await ctx.memory.addNote({
          kind: "environment",
          layer: "semantic",
          source: "system",
          importance: 0.8,
          text: `Environment profile: ${JSON.stringify(profile)}`,
          tags: ["environment", "profile", profile.version, ctx.config.minecraft.moddedTolerant ? "modded" : "vanilla"],
          scope: {
            server: profile.server,
            version: profile.version,
          },
        });
      }
      return ok("environment profile", profile as unknown as JsonValue);
    },
  });

  registry.register({
    name: "record_skill",
    description:
      "Record a newly learned repeatable skill as an ordered sequence of atomic tool calls, with environment scope and success checks.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        trigger: { type: "string" },
        steps: { type: "array", items: {} },
        tags: { type: "array", items: { type: "string" } },
        scope: {
          type: "object",
          additionalProperties: true,
          description:
            "Environment where this skill applies, e.g. server/modpack/version/dimension/keybind context. Required for modded or keybind-specific behavior.",
        },
        preconditions: {
          type: "array",
          items: { type: "string" },
          description: "Facts that must be true before running the skill, such as required items, nearby blocks, UI state, or player guidance.",
        },
        successCriteria: { type: "string" },
        failureModes: {
          type: "array",
          items: { type: "string" },
          description: "Known ways this skill can fail and what to try next.",
        },
      },
      required: ["name", "description"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const skill = await ctx.skills.record({
        name: requiredString(args, "name"),
        description: requiredString(args, "description"),
        trigger: typeof args.trigger === "string" ? args.trigger : undefined,
        steps: Array.isArray(args.steps) ? args.steps : [],
        tags: stringList(args.tags),
        scope: args.scope && typeof args.scope === "object" && !Array.isArray(args.scope)
          ? (args.scope as Record<string, unknown>)
          : defaultSkillScope(ctx),
        preconditions: stringList(args.preconditions),
        successCriteria: typeof args.successCriteria === "string" ? args.successCriteria : undefined,
        failureModes: stringList(args.failureModes),
      });
      return ok(`skill recorded ${skill.name}`, skill as unknown as JsonValue);
    },
  });

  registry.register({
    name: "imitation_recent",
    description: "Read recent nearby player behavior observations for imitation learning.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.imitation) {
        throw new Error("Imitation observer is not enabled.");
      }
      const limit = optionalNumber(args, "limit", 40);
      return ok("recent imitation observations", (await ctx.imitation.recent(limit)) as unknown as JsonValue);
    },
  });

  registry.register({
    name: "imitation_to_skill",
    description:
      "Convert recent observed nearby player behavior into a draft JSON+MD skill for later refinement.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.imitation) {
        throw new Error("Imitation observer is not enabled.");
      }
      const name = requiredString(args, "name");
      const draft = await ctx.imitation.summarizeForSkill(name);
      const skill = await ctx.skills.record({
        name,
        description: draft.description,
        trigger: `When a player-like procedure similar to ${name} is needed.`,
        steps: draft.steps,
        tags: stringList(args.tags).length > 0 ? stringList(args.tags) : ["imitation"],
        scope: defaultSkillScope(ctx),
        preconditions: ["Recent nearby player behavior was observed in the same environment."],
        successCriteria: "Replay the observed atomic actions and verify the expected world or inventory change.",
      });
      return ok(`imitation skill drafted ${skill.name}`, skill as unknown as JsonValue);
    },
  });

  registry.register({
    name: "query_skills",
    description: "Search learned skills by trigger, description, tags, scope, and recorded steps.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args, ctx) =>
      ok(
        "skill results",
        ctx.skills.query(requiredString(args, "query"), optionalNumber(args, "limit", 8)) as unknown as JsonValue,
      ),
  });

  registry.register({
    name: "inspect_skill",
    description:
      "Read the exact stored definition of one learned skill, including preconditions, scope, ordered atomic tool steps, success criteria, and failure modes.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const name = requiredString(args, "name");
      const skill = ctx.skills.get(name);
      if (!skill) {
        throw new Error(`Unknown skill: ${name}`);
      }
      return ok(`skill ${skill.name}`, skill as unknown as JsonValue);
    },
  });

  registry.register({
    name: "execute_steps",
    description:
      "Execute a short ordered list of already-decided atomic tool calls. Use only for deterministic consecutive steps that do not require fresh visual/model reasoning between steps; otherwise call one atomic tool at a time.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description:
            "Ordered atomic tool calls. Each item must be {tool: string, arguments: object}. Meta tools and nested execute_steps are refused.",
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              arguments: { type: "object", additionalProperties: true },
            },
            required: ["tool", "arguments"],
            additionalProperties: true,
          },
        },
        stopOnFailure: {
          type: "boolean",
          description: "If true, stop at the first failed step. Defaults to true.",
        },
        dryRun: {
          type: "boolean",
          description: "If true, validate and return the resolved steps without executing them.",
        },
        maxSteps: {
          type: "number",
          minimum: 1,
          maximum: 64,
          description: "Optional lower execution cap. The config AGENT_MAX_TOOL_SEQUENCE_STEPS still applies.",
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!Array.isArray(args.steps)) {
        throw new Error("steps must be an array.");
      }
      const parsedSteps = args.steps
        .map(skillStepFromValue)
        .filter((step): step is { tool: string; arguments: JsonObject } => Boolean(step));
      if (parsedSteps.length === 0) {
        throw new Error("steps contains no executable atomic tool calls.");
      }
      const configuredMax = Math.max(1, Math.min(64, Math.floor(ctx.config.loop.maxToolSequenceSteps)));
      const requestedMax = Math.max(
        1,
        Math.min(configuredMax, Math.floor(optionalNumber(args, "maxSteps", configuredMax))),
      );
      const selectedSteps = parsedSteps.slice(0, requestedMax);
      const invalidMetaTool = selectedSteps.find((step) => SKILL_META_TOOLS.has(step.tool));
      if (invalidMetaTool) {
        throw new Error(`Refusing to execute meta tool ${invalidMetaTool.tool} inside execute_steps.`);
      }
      if (args.dryRun === true) {
        return ok(
          `dry run for ${selectedSteps.length} steps`,
          {
            requestedSteps: parsedSteps.length,
            maxSteps: requestedMax,
            truncated: parsedSteps.length > selectedSteps.length,
            steps: selectedSteps,
          } as unknown as JsonValue,
        );
      }

      const stopOnFailure = args.stopOnFailure !== false;
      const results: Array<{
        step: number;
        tool: string;
        arguments: JsonObject;
        ok: boolean;
        text: string;
      }> = [];
      let success = true;
      for (const [index, step] of selectedSteps.entries()) {
        ctx.bot.ensureConnected();
        const result = await registry.execute(step.tool, step.arguments, ctx);
        results.push({
          step: index + 1,
          tool: step.tool,
          arguments: step.arguments,
          ok: result.ok,
          text: compactText(result.text, 800),
        });
        if (!result.ok) {
          success = false;
          if (stopOnFailure) {
            break;
          }
        }
      }
      const executed = results.length;
      const text = `${success ? "executed" : "failed"} ${executed}/${selectedSteps.length} planned atomic steps${
        parsedSteps.length > selectedSteps.length ? `; truncated from ${parsedSteps.length}` : ""
      }`;
      return {
        ok: success,
        text,
        data: {
          success,
          requestedSteps: parsedSteps.length,
          plannedSteps: selectedSteps.length,
          executedSteps: results,
          stoppedOnFailure: stopOnFailure && !success,
          truncated: parsedSteps.length > selectedSteps.length,
        } as unknown as JsonValue,
      };
    },
  });

  registry.register({
    name: "execute_skill",
    description:
      "Execute a learned skill by replaying its ordered atomic tool calls. Use only after inspecting/querying a skill and confirming its scope matches the current environment.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        dryRun: {
          type: "boolean",
          description: "If true, return the resolved atomic steps without executing them.",
        },
        maxSteps: { type: "number", minimum: 1, maximum: 64 },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const name = requiredString(args, "name");
      const skill = ctx.skills.get(name);
      if (!skill) {
        throw new Error(`Unknown skill: ${name}`);
      }
      const steps = skill.steps
        .map(skillStepFromValue)
        .filter((step): step is { tool: string; arguments: JsonObject } => Boolean(step));
      const maxSteps = Math.max(1, Math.min(64, Math.floor(optionalNumber(args, "maxSteps", steps.length || 1))));
      const selectedSteps = steps.slice(0, maxSteps);
      if (selectedSteps.length === 0) {
        throw new Error(`Skill ${skill.name} has no executable atomic tool steps.`);
      }
      if (args.dryRun === true) {
        return ok(`dry run for skill ${skill.name}`, selectedSteps as unknown as JsonValue);
      }

      const results: Array<{ step: number; tool: string; ok: boolean; text: string }> = [];
      let success = true;
      for (const [index, step] of selectedSteps.entries()) {
        if (SKILL_META_TOOLS.has(step.tool)) {
          success = false;
          results.push({
            step: index + 1,
            tool: step.tool,
            ok: false,
            text: `Refusing to execute meta tool ${step.tool} from a learned skill.`,
          });
          break;
        }
        const result = await registry.execute(step.tool, step.arguments, ctx);
        results.push({
          step: index + 1,
          tool: step.tool,
          ok: result.ok,
          text: result.text,
        });
        if (!result.ok) {
          success = false;
          break;
        }
      }
      await ctx.skills.markAttempt(skill.name, success);
      return ok(
        `${success ? "executed" : "failed"} skill ${skill.name}`,
        {
          skill: skill.name,
          success,
          successCriteria: skill.successCriteria ?? "",
          results,
        } as unknown as JsonValue,
      );
    },
  });

  registry.register({
    name: "mark_skill_attempt",
    description:
      "Update success/failure statistics for a learned skill after external verification. Use this after executing a skill and checking its success criteria.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        success: { type: "boolean" },
        note: { type: "string" },
      },
      required: ["name", "success"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const name = requiredString(args, "name");
      await ctx.skills.markAttempt(name, args.success === true);
      if (typeof args.note === "string" && args.note.trim()) {
        await ctx.memory.addNote({
          text: `Skill ${name} ${args.success === true ? "succeeded" : "failed"}: ${args.note.trim()}`,
          kind: args.success === true ? "lesson" : "failure",
          tags: ["skill", name],
        });
      }
      return ok(`marked skill ${name} as ${args.success === true ? "success" : "failure"}`);
    },
  });

  registry.register({
    name: "schedule_task",
    description: "Create a scheduled task that will call the agent with a prompt later or repeatedly.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        intervalSeconds: { type: "number", minimum: 10 },
        runAt: { type: "string", description: "ISO timestamp for one-shot execution." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.tasks) {
        throw new Error("Task store is not available.");
      }
      const task = await ctx.tasks.add({
        prompt: requiredString(args, "prompt"),
        intervalSeconds: typeof args.intervalSeconds === "number" ? args.intervalSeconds : undefined,
        runAt: typeof args.runAt === "string" ? args.runAt : undefined,
      });
      return ok(`scheduled ${task.id}`, task as unknown as JsonValue);
    },
  });

  registry.register({
    name: "list_tasks",
    description: "List scheduled tasks.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => {
      if (!ctx.tasks) {
        throw new Error("Task store is not available.");
      }
      return ok("scheduled tasks", ctx.tasks.list() as unknown as JsonValue);
    },
  });

  registry.register({
    name: "say",
    description: "Send a chat message in Minecraft.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const message = requiredString(args, "message");
      await ctx.bot.chat(message);
      return ok(`said: ${message}`);
    },
  });

  return registry;
}
