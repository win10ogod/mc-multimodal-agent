import type { Bot } from "mineflayer";
import { appendJsonl, readJsonl } from "../utils/fs";
import { compactText, nowIso } from "../utils/misc";

export type ImitationEvent = {
  time: string;
  type: "player_move" | "block_update" | "chat_guidance";
  player?: string;
  text?: string;
  data: Record<string, unknown>;
};

export class ImitationObserver {
  private active = false;
  private lastMoveAt = new Map<string, number>();
  private detachCurrent?: () => void;

  constructor(
    private readonly filePath: string,
    private readonly opts: {
      range: number;
      minMoveIntervalMs: number;
    },
  ) {}

  attach(bot: Bot): void {
    this.detach();
    this.active = true;
    const onEntityMoved = (entity: any): void => {
      if (!this.isPlayerEntity(bot, entity)) {
        return;
      }
      const username = this.entityUsername(entity);
      if (!username) {
        return;
      }
      const now = Date.now();
      const last = this.lastMoveAt.get(username) ?? 0;
      if (now - last < this.opts.minMoveIntervalMs) {
        return;
      }
      this.lastMoveAt.set(username, now);
      void this.record({
        type: "player_move",
        player: username,
        data: {
          position: {
            x: Number(entity.position.x.toFixed(2)),
            y: Number(entity.position.y.toFixed(2)),
            z: Number(entity.position.z.toFixed(2)),
          },
          yaw: entity.yaw,
          pitch: entity.pitch,
        },
      });
    };
    const onBlockUpdate = (oldBlock: any, newBlock: any): void => {
      const pos = newBlock?.position ?? oldBlock?.position;
      if (!pos || bot.entity.position.distanceTo(pos) > this.opts.range) {
        return;
      }
      void this.record({
        type: "block_update",
        data: {
          old: oldBlock?.name,
          next: newBlock?.name,
          position: { x: pos.x, y: pos.y, z: pos.z },
        },
      });
    };
    const onEnd = (): void => this.detach();
    bot.on("entityMoved", onEntityMoved);
    bot.on("blockUpdate", onBlockUpdate);
    bot.once("end", onEnd);
    this.detachCurrent = () => {
      bot.removeListener("entityMoved", onEntityMoved);
      bot.removeListener("blockUpdate", onBlockUpdate);
      bot.removeListener("end", onEnd);
    };
  }

  detach(): void {
    this.detachCurrent?.();
    this.detachCurrent = undefined;
    this.active = false;
  }

  async record(params: Omit<ImitationEvent, "time">): Promise<void> {
    await appendJsonl(this.filePath, {
      time: nowIso(),
      ...params,
    });
  }

  async recent(limit = 40): Promise<ImitationEvent[]> {
    return readJsonl<ImitationEvent>(this.filePath, limit);
  }

  async buildPromptSection(): Promise<string> {
    const events = await this.recent(20);
    if (events.length === 0) {
      return "No nearby player actions observed yet.";
    }
    return events
      .map((event) => {
        const who = event.player ? `${event.player} ` : "";
        return `- ${event.time} ${who}${event.type}: ${compactText(JSON.stringify(event.data), 180)}`;
      })
      .join("\n");
  }

  async summarizeForSkill(name: string): Promise<{ description: string; steps: unknown[] }> {
    const events = await this.recent(80);
    return {
      description: [
        `Imitation-derived skill candidate: ${name}.`,
        "Built from recent nearby player movement and block update observations.",
        "Review and refine before relying on it in a new environment.",
      ].join(" "),
      steps: events.map((event) => ({
        time: event.time,
        type: event.type,
        player: event.player,
        data: event.data,
      })),
    };
  }

  private isPlayerEntity(bot: Bot, entity: any): boolean {
    if (!entity || entity === bot.entity) {
      return false;
    }
    const username = this.entityUsername(entity);
    if (!username || username === bot.username) {
      return false;
    }
    if (!entity.position || bot.entity.position.distanceTo(entity.position) > this.opts.range) {
      return false;
    }
    return entity.type === "player" || Boolean(username);
  }

  private entityUsername(entity: any): string | undefined {
    return typeof entity.username === "string" && entity.username.trim()
      ? entity.username.trim()
      : undefined;
  }
}
