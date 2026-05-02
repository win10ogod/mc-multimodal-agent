import type { AgentConfig } from "../config";
import type { VisionApi } from "../bot/BotApi";
import type { ScreenPlacementHit } from "../bot/MinecraftBot";
import type { VisualFrame, VisualTarget } from "../vision/VisualPerception";
import type { McuVirtualBot } from "../bot/McuVirtualBot";

/**
 * Vision adapter for MCU mode. The MCU eval pipeline already supplies the
 * agent with a rendered first-person frame; this stub forwards that frame
 * verbatim and provides best-effort camera-delta arithmetic. Ray-cast based
 * helpers (hitFromScreen, findVisibleTargets) cannot work without a
 * Mineflayer world model and return empty results — the LLM must reason from
 * pixels.
 */
export class McuVisionStub implements VisionApi {
  constructor(
    private readonly bot: McuVirtualBot,
    private readonly config: AgentConfig,
  ) {}

  capture(): VisualFrame {
    const width = this.config.vision.width;
    const height = this.config.vision.height;
    const frame = this.bot.getLatestFrame();
    const dataUrl = frame
      ? frame.startsWith("data:image/")
        ? frame
        : `data:image/jpeg;base64,${frame}`
      : "";
    return {
      width,
      height,
      dataUrl,
      capturedAt: new Date().toISOString(),
      visibleBlocks: [],
      visibleTargets: [],
      text: [
        `MCU first-person frame ${width}x${height}; origin top-left.`,
        "Visible-block sampling and ray-cast helpers are unavailable in MCU mode; reason from the image directly.",
        this.bot.statusSummary(),
      ].join("\n"),
    };
  }

  findVisibleTargets(_names: string[], _match = "contains", _count = 12): VisualTarget[] {
    return [];
  }

  hitFromScreen(_x: number, _y: number): ScreenPlacementHit | undefined {
    return undefined;
  }

  screenToDelta(x: number, y: number): { yawDeltaDeg: number; pitchDeltaDeg: number } {
    const hFov = this.config.vision.horizontalFovDeg;
    const vFov = hFov * (this.config.vision.height / this.config.vision.width);
    return {
      yawDeltaDeg: (x / this.config.vision.width - 0.5) * hFov,
      pitchDeltaDeg: (y / this.config.vision.height - 0.5) * vFov,
    };
  }
}
