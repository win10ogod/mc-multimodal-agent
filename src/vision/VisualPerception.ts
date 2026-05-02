import { PNG } from "pngjs";
import { Vec3 } from "vec3";
import type { AgentConfig } from "../config";
import type { MinecraftBot, ScreenPlacementHit } from "../bot/MinecraftBot";
import type { Vec3Like } from "../types";
import { clamp } from "../utils/misc";

const AIR_NAMES = new Set(["air", "cave_air", "void_air"]);

export type VisualFrame = {
  width: number;
  height: number;
  dataUrl: string;
  text: string;
  capturedAt: string;
  visibleBlocks: string[];
  visibleTargets: VisualTarget[];
};

export type VisualTarget = {
  blockName: string;
  screen: { x: number; y: number };
  screenBox: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };
  blockPosition: Vec3Like;
  previousPosition?: Vec3Like;
  distance: number;
  samples: number;
};

type FramePose = {
  position: Vec3Like;
  yaw: number;
  pitch: number;
};

type Rgb = [number, number, number];

function floorVec(pos: Vec3Like): Vec3Like {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

function sameBlock(a: Vec3Like | undefined, b: Vec3Like): boolean {
  return Boolean(a && a.x === b.x && a.y === b.y && a.z === b.z);
}

function normalizeAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) {
    angle -= Math.PI * 2;
  }
  while (angle < -Math.PI) {
    angle += Math.PI * 2;
  }
  return angle;
}

function rayDirection(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return new Vec3(-Math.sin(yaw) * cosPitch, -Math.sin(pitch), -Math.cos(yaw) * cosPitch);
}

function colorByName(name: string): Rgb {
  if (name.includes("grass") || name.includes("leaves") || name.includes("moss")) {
    return [79, 143, 62];
  }
  if (name.includes("dirt") || name.includes("mud")) {
    return [118, 83, 50];
  }
  if (name.includes("sand")) {
    return [211, 194, 133];
  }
  if (name.includes("stone") || name.includes("cobble") || name.includes("andesite")) {
    return [128, 128, 128];
  }
  if (name.includes("deepslate")) {
    return [72, 72, 78];
  }
  if (name.includes("oak") || name.includes("spruce") || name.includes("birch")) {
    return [151, 107, 62];
  }
  if (name.includes("water")) {
    return [48, 92, 181];
  }
  if (name.includes("lava") || name.includes("fire")) {
    return [238, 86, 31];
  }
  if (name.includes("glass")) {
    return [160, 210, 220];
  }
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return [80 + (hash & 95), 80 + ((hash >> 8) & 95), 80 + ((hash >> 16) & 95)];
}

function blockMatches(name: string, needles: string[], mode: string): boolean {
  const normalized = name.toLowerCase();
  const terms = needles.map((item) => item.toLowerCase());
  if (terms.length === 0) {
    return true;
  }
  if (mode === "exact") {
    return terms.includes(normalized);
  }
  if (mode === "suffix") {
    return terms.some((term) => normalized.endsWith(term));
  }
  return terms.some((term) => normalized.includes(term));
}

function shade(color: Rgb, distance: number, maxDistance: number): Rgb {
  const factor = clamp(1 - distance / (maxDistance * 1.25), 0.35, 1);
  return [
    Math.round(color[0] * factor),
    Math.round(color[1] * factor),
    Math.round(color[2] * factor),
  ];
}

export class VisualPerception {
  private lastHits: Array<ScreenPlacementHit | undefined> = [];
  private lastFramePose?: FramePose;

  constructor(
    private readonly mc: MinecraftBot,
    private readonly config: AgentConfig,
  ) {}

  capture(): VisualFrame {
    const width = this.config.vision.width;
    const height = this.config.vision.height;
    const sampleWidth = this.config.vision.sampleWidth;
    const sampleHeight = this.config.vision.sampleHeight;
    const png = new PNG({ width, height });
    const hits: Array<ScreenPlacementHit | undefined> = new Array(sampleWidth * sampleHeight);
    const blockWidth = Math.ceil(width / sampleWidth);
    const blockHeight = Math.ceil(height / sampleHeight);
    const hFov = (this.config.vision.horizontalFovDeg * Math.PI) / 180;
    const vFov = hFov * (height / width);
    const bot = this.mc.raw;
    const framePose = this.currentPose();

    for (let sy = 0; sy < sampleHeight; sy += 1) {
      for (let sx = 0; sx < sampleWidth; sx += 1) {
        const nx = (sx + 0.5) / sampleWidth;
        const ny = (sy + 0.5) / sampleHeight;
        const yaw = bot.entity.yaw + (nx - 0.5) * hFov;
        const pitch = clamp(bot.entity.pitch + (ny - 0.5) * vFov, -1.55, 1.55);
        const hit = this.castRay(yaw, pitch);
        hits[sy * sampleWidth + sx] = hit;
        const color = hit
          ? shade(colorByName(hit.blockName), hit.distance, this.config.vision.maxDistance)
          : this.skyColor(ny);
        this.fillRect(png, sx * blockWidth, sy * blockHeight, blockWidth, blockHeight, color);
      }
    }

    this.overlayEntities(png, hFov, vFov);
    this.lastHits = hits;
    this.lastFramePose = framePose;
    const visibleBlocks = Array.from(
      new Set(hits.flatMap((hit) => (hit?.blockName ? [hit.blockName] : []))),
    ).sort();
    const visibleTargets = this.findVisibleTargets([], "contains", 12);
    const base64 = PNG.sync.write(png).toString("base64");
    return {
      width,
      height,
      dataUrl: `data:image/png;base64,${base64}`,
      capturedAt: new Date().toISOString(),
      visibleBlocks,
      visibleTargets,
      text: [
        `Visual frame ${width}x${height}; origin is top-left; x increases right, y increases down.`,
        "Use screen-coordinate tools for looking, digging, placing, and pathfinding to visible targets.",
        `Visible block names sampled from pixels: ${visibleBlocks.slice(0, 24).join(", ") || "none"}.`,
        `Nearest visible targets: ${
          visibleTargets
            .slice(0, 8)
            .map((target) => `${target.blockName}@(${target.screen.x},${target.screen.y}) d=${target.distance.toFixed(1)}`)
            .join(", ") || "none"
        }.`,
        this.mc.statusSummary(),
      ].join("\n"),
    };
  }

  findVisibleTargets(names: string[], match = "contains", count = 12): VisualTarget[] {
    const groups = new Map<
      string,
      {
        hit: ScreenPlacementHit;
        hitSx: number;
        hitSy: number;
        minSx: number;
        maxSx: number;
        minSy: number;
        maxSy: number;
        sxTotal: number;
        syTotal: number;
        samples: number;
      }
    >();
    const sampleWidth = this.config.vision.sampleWidth;
    const sampleHeight = this.config.vision.sampleHeight;
    for (let sy = 0; sy < sampleHeight; sy += 1) {
      for (let sx = 0; sx < sampleWidth; sx += 1) {
        const hit = this.lastHits[sy * sampleWidth + sx];
        if (!hit || !blockMatches(hit.blockName, names, match)) {
          continue;
        }
        const key = `${hit.blockPosition.x},${hit.blockPosition.y},${hit.blockPosition.z}`;
        const existing = groups.get(key);
        if (existing) {
          existing.sxTotal += sx + 0.5;
          existing.syTotal += sy + 0.5;
          existing.minSx = Math.min(existing.minSx, sx);
          existing.maxSx = Math.max(existing.maxSx, sx);
          existing.minSy = Math.min(existing.minSy, sy);
          existing.maxSy = Math.max(existing.maxSy, sy);
          existing.samples += 1;
          if (hit.distance < existing.hit.distance) {
            existing.hit = hit;
            existing.hitSx = sx;
            existing.hitSy = sy;
          }
        } else {
          groups.set(key, {
            hit,
            hitSx: sx,
            hitSy: sy,
            minSx: sx,
            maxSx: sx,
            minSy: sy,
            maxSy: sy,
            sxTotal: sx + 0.5,
            syTotal: sy + 0.5,
            samples: 1,
          });
        }
      }
    }

    return [...groups.values()]
      .map((group) => {
        const minX = Math.floor((group.minSx / sampleWidth) * this.config.vision.width);
        const maxX = Math.ceil(((group.maxSx + 1) / sampleWidth) * this.config.vision.width);
        const minY = Math.floor((group.minSy / sampleHeight) * this.config.vision.height);
        const maxY = Math.ceil(((group.maxSy + 1) / sampleHeight) * this.config.vision.height);
        return {
          blockName: group.hit.blockName,
          screen: {
            x: Math.round(((group.hitSx + 0.5) / sampleWidth) * this.config.vision.width),
            y: Math.round(((group.hitSy + 0.5) / sampleHeight) * this.config.vision.height),
          },
          screenBox: {
            minX,
            minY,
            maxX,
            maxY,
            width: maxX - minX,
            height: maxY - minY,
          },
          blockPosition: group.hit.blockPosition,
          previousPosition: group.hit.previousPosition,
          distance: group.hit.distance,
          samples: group.samples,
        };
      })
      .sort((a, b) => a.distance - b.distance || b.samples - a.samples)
      .slice(0, Math.max(1, Math.min(64, count)));
  }

  hitFromScreen(x: number, y: number): ScreenPlacementHit | undefined {
    if (this.screenFrameStaleReason()) {
      return undefined;
    }
    const sx = clamp(
      Math.floor((x / this.config.vision.width) * this.config.vision.sampleWidth),
      0,
      this.config.vision.sampleWidth - 1,
    );
    const sy = clamp(
      Math.floor((y / this.config.vision.height) * this.config.vision.sampleHeight),
      0,
      this.config.vision.sampleHeight - 1,
    );
    return this.lastHits[sy * this.config.vision.sampleWidth + sx];
  }

  screenFrameStaleReason(): string | undefined {
    if (!this.lastFramePose) {
      return undefined;
    }
    const current = this.currentPose();
    const dx = current.position.x - this.lastFramePose.position.x;
    const dy = current.position.y - this.lastFramePose.position.y;
    const dz = current.position.z - this.lastFramePose.position.z;
    const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (moved > 0.75) {
      return `bot moved ${moved.toFixed(2)} blocks since the visual frame was captured`;
    }

    const hFovDeg = this.config.vision.horizontalFovDeg;
    const vFovDeg = hFovDeg * (this.config.vision.height / this.config.vision.width);
    const yawTolerance = (Math.PI / 180) * Math.max(2, (hFovDeg / this.config.vision.sampleWidth) * 1.5);
    const pitchTolerance = (Math.PI / 180) * Math.max(2, (vFovDeg / this.config.vision.sampleHeight) * 1.5);
    const yawDrift = Math.abs(normalizeAngle(current.yaw - this.lastFramePose.yaw));
    const pitchDrift = Math.abs(current.pitch - this.lastFramePose.pitch);
    if (yawDrift > yawTolerance) {
      return `camera yaw changed ${((yawDrift * 180) / Math.PI).toFixed(1)} degrees since the visual frame was captured`;
    }
    if (pitchDrift > pitchTolerance) {
      return `camera pitch changed ${((pitchDrift * 180) / Math.PI).toFixed(1)} degrees since the visual frame was captured`;
    }
    return undefined;
  }

  screenToDelta(x: number, y: number): { yawDeltaDeg: number; pitchDeltaDeg: number } {
    const hFov = this.config.vision.horizontalFovDeg;
    const vFov = hFov * (this.config.vision.height / this.config.vision.width);
    return {
      yawDeltaDeg: ((x / this.config.vision.width) - 0.5) * hFov,
      pitchDeltaDeg: ((y / this.config.vision.height) - 0.5) * vFov,
    };
  }

  private castRay(yaw: number, pitch: number): ScreenPlacementHit | undefined {
    const origin = this.mc.eyePosition();
    const direction = rayDirection(yaw, pitch);
    let previous: Vec3Like | undefined = floorVec(origin);
    let lastChecked: Vec3Like | undefined;
    const max = this.config.vision.maxDistance;
    for (let distance = 0.25; distance <= max; distance += 0.25) {
      const point = new Vec3(
        origin.x + direction.x * distance,
        origin.y + direction.y * distance,
        origin.z + direction.z * distance,
      );
      const blockPos = floorVec(point);
      if (sameBlock(lastChecked, blockPos)) {
        continue;
      }
      lastChecked = blockPos;
      const block = this.mc.raw.blockAt(new Vec3(blockPos.x, blockPos.y, blockPos.z));
      if (!block || AIR_NAMES.has(block.name)) {
        previous = blockPos;
        continue;
      }
      return {
        blockName: block.name,
        blockPosition: blockPos,
        previousPosition: previous,
        distance,
      };
    }
    return undefined;
  }

  private currentPose(): FramePose {
    const bot = this.mc.raw;
    const pos = bot.entity.position;
    return {
      position: { x: pos.x, y: pos.y, z: pos.z },
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
    };
  }

  private skyColor(ny: number): Rgb {
    if (ny < 0.52) {
      return [112, 166, 235];
    }
    return [80, 96, 112];
  }

  private fillRect(png: PNG, x: number, y: number, w: number, h: number, color: Rgb): void {
    const minX = Math.max(0, x);
    const minY = Math.max(0, y);
    const maxX = Math.min(png.width, x + w);
    const maxY = Math.min(png.height, y + h);
    for (let py = minY; py < maxY; py += 1) {
      for (let px = minX; px < maxX; px += 1) {
        const idx = (png.width * py + px) << 2;
        png.data[idx] = color[0];
        png.data[idx + 1] = color[1];
        png.data[idx + 2] = color[2];
        png.data[idx + 3] = 255;
      }
    }
  }

  private overlayEntities(png: PNG, hFov: number, vFov: number): void {
    const bot = this.mc.raw;
    const eye = this.mc.eyePosition();
    for (const entity of Object.values(bot.entities)) {
      if (!entity.position || entity === bot.entity) {
        continue;
      }
      const dx = entity.position.x - eye.x;
      const dy = entity.position.y - eye.y;
      const dz = entity.position.z - eye.z;
      const horizontal = Math.sqrt(dx * dx + dz * dz);
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance <= 0.1 || distance > this.config.vision.maxDistance) {
        continue;
      }
      const yawTo = Math.atan2(-dx, -dz);
      const pitchTo = -Math.atan2(dy, horizontal);
      const yawDelta = normalizeAngle(yawTo - bot.entity.yaw);
      const pitchDelta = pitchTo - bot.entity.pitch;
      if (Math.abs(yawDelta) > hFov / 2 || Math.abs(pitchDelta) > vFov / 2) {
        continue;
      }
      const x = Math.round((0.5 + yawDelta / hFov) * png.width);
      const y = Math.round((0.5 + pitchDelta / vFov) * png.height);
      const size = Math.max(4, Math.round(18 / Math.max(1, distance)));
      this.fillRect(png, x - size, y - size, size * 2, size * 2, [220, 64, 64]);
    }
  }
}
