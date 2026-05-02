import type { McuActionIntent } from "../bot/McuVirtualBot";
import {
  defaultMcuAction,
  MCU_BUTTON_KEYS,
  type McuButtonKey,
  type McuEnvAction,
} from "./McuPrompt";

const FRAME_MS = 50;
const MAX_LOOK_STEP_DEG = 10;
const MAX_LOOK_FRAMES = 32;
const SAFETY_QUEUE_CAP = 256;

export type CompiledStep = {
  action: McuEnvAction;
  holdSteps: number;
  source: McuActionIntent["kind"] | "idle";
};

function durationToFrames(ms: number, fallback = 1): number {
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return Math.max(1, Math.ceil(ms / FRAME_MS));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function withButton(key: McuButtonKey, base?: McuEnvAction): McuEnvAction {
  const action = base ?? defaultMcuAction();
  action[key] = 1;
  return action;
}

function withCamera(yawDeg: number, pitchDeg: number): McuEnvAction {
  const action = defaultMcuAction();
  action.camera = [pitchDeg, yawDeg];
  return action;
}

function compileLook(yawDeg: number, pitchDeg: number, source: McuActionIntent["kind"]): CompiledStep[] {
  let yawLeft = yawDeg;
  let pitchLeft = pitchDeg;
  const out: CompiledStep[] = [];
  while ((Math.abs(yawLeft) > 0.25 || Math.abs(pitchLeft) > 0.25) && out.length < MAX_LOOK_FRAMES) {
    const dy = clamp(yawLeft, -MAX_LOOK_STEP_DEG, MAX_LOOK_STEP_DEG);
    const dp = clamp(pitchLeft, -MAX_LOOK_STEP_DEG, MAX_LOOK_STEP_DEG);
    out.push({ action: withCamera(dy, dp), holdSteps: 1, source });
    yawLeft -= dy;
    pitchLeft -= dp;
  }
  return out;
}

export class McuIntentCompiler {
  private readonly queue: CompiledStep[] = [];

  enqueueIntents(intents: McuActionIntent[]): void {
    for (const intent of intents) {
      if (this.queue.length >= SAFETY_QUEUE_CAP) break;
      for (const step of this.compile(intent)) {
        this.queue.push(step);
        if (this.queue.length >= SAFETY_QUEUE_CAP) break;
      }
    }
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  next(): CompiledStep | undefined {
    return this.queue.shift();
  }

  clear(): void {
    this.queue.length = 0;
  }

  /**
   * Translate one high-level intent into one or more MCU button-action steps.
   * Mappings are best-effort macros; the model is expected to refine via
   * tool calls and direct MCU action JSONs when the macro is too coarse.
   */
  private compile(intent: McuActionIntent): CompiledStep[] {
    switch (intent.kind) {
      case "move": {
        const base = defaultMcuAction();
        base[intent.direction] = 1;
        if (intent.sprint && intent.direction === "forward") base.sprint = 1;
        if (intent.sneak) base.sneak = 1;
        if (intent.jump) base.jump = 1;
        return [{ action: base, holdSteps: durationToFrames(intent.durationMs, 4), source: intent.kind }];
      }

      case "stopMovement":
      case "stopNavigation":
        return [{ action: defaultMcuAction(), holdSteps: 1, source: intent.kind }];

      case "look":
        return compileLook(intent.yawDeltaDeg, intent.pitchDeltaDeg, intent.kind);

      case "goto":
        // Without a server, we cannot pathfind. Emit a forward sprint pulse so
        // the agent at least makes progress while it observes the next frame.
        return [
          {
            action: { ...defaultMcuAction(), forward: 1, sprint: 1 },
            holdSteps: 4,
            source: intent.kind,
          },
        ];

      case "useHeld":
        return [{ action: withButton("use"), holdSteps: durationToFrames(intent.durationMs, 5), source: intent.kind }];

      case "activateBlock":
      case "openWindow":
        return [{ action: withButton("use"), holdSteps: 2, source: intent.kind }];

      case "dig":
      case "attackEntity":
        return [{ action: withButton("attack"), holdSteps: 30, source: intent.kind }];

      case "place":
        return [{ action: withButton("use"), holdSteps: 2, source: intent.kind }];

      case "eat":
        return [{ action: withButton("use"), holdSteps: 32, source: intent.kind }];

      case "craft":
      case "closeWindow":
        return [{ action: withButton("inventory"), holdSteps: 1, source: intent.kind }];

      case "clickSlot":
        // Without inventory mouse coords we cannot place items in specific
        // slots. Emit one click of the correct mouse button and rely on the
        // model to position the cursor next obs.
        return [
          {
            action: withButton(intent.mouseButton === 1 ? "use" : "attack"),
            holdSteps: 1,
            source: intent.kind,
          },
        ];

      case "transferWindow":
        return [{ action: withButton("attack"), holdSteps: 1, source: intent.kind }];

      case "setHotbar":
      case "equip": {
        const slotZeroIndexed = intent.kind === "setHotbar" ? intent.slot : 0;
        const slot = clamp(slotZeroIndexed + (intent.kind === "setHotbar" ? 1 : 1), 1, 9);
        return [{ action: withButton(`hotbar.${slot}` as McuButtonKey), holdSteps: 1, source: intent.kind }];
      }

      case "equipBestWeapon":
        return [{ action: withButton("hotbar.1"), holdSteps: 1, source: intent.kind }];

      case "follow":
      case "retreat":
      case "combatPulse":
        return [{ action: defaultMcuAction(), holdSteps: 1, source: intent.kind }];

      case "buildBlueprint":
      case "say":
        // No MCU mapping; produce an idle frame so the wrapper still emits a
        // valid action.
        return [{ action: defaultMcuAction(), holdSteps: 1, source: intent.kind }];
    }
  }
}

/**
 * Sanity check used by tests: every intent kind we accept produces at least
 * one valid CompiledStep with all button keys populated.
 */
export function compiledStepIsValid(step: CompiledStep): boolean {
  for (const key of MCU_BUTTON_KEYS) {
    if (step.action[key] !== 0 && step.action[key] !== 1) return false;
  }
  if (!Array.isArray(step.action.camera) || step.action.camera.length !== 2) return false;
  return Number.isFinite(step.action.camera[0]) && Number.isFinite(step.action.camera[1]);
}
