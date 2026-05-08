/**
 * Deterministic hotbar slot verifier for the Placing subagent.
 *
 * Walks all 9 hotbar slots in a fixed order, emitting one MCU action
 * per step. For each candidate it does swap-away (only first iteration)
 * → swap-to → settle (1 frame) → read (call hotbarBannerMatch). The
 * swap-away first is needed because we don't know which slot is active
 * at entry; emitting hotbar.<other> guarantees the next swap-to will
 * cause a banner re-render even if the candidate happens to already be
 * active. After the first iteration, active is known (it's the previous
 * candidate) so a single swap-to to a different slot always renders.
 *
 * On match: returns DONE(equippedSlot) without emitting a further
 * action — the caller transitions Placing into the post-equip phase.
 *
 * On full-sweep miss: returns FAIL with structured reportFields the
 * GoalPlanner can react to (code: "hotbar_missing_item", item, ocrTrace).
 */
import type OpenAI from "openai";
import { defaultMcuAction, type McuEnvAction, type McuButtonKey } from "../McuPrompt";
import { hotbarBannerMatch } from "./HotbarOcr";
import { getDebugRecorder } from "./DebugRecorder";

export type HotbarVerifierDeps = {
  client: OpenAI;
  model: string;
};

export type HotbarVerifierAct = {
  kind: "act";
  action: McuEnvAction;
  holdSteps: number;
};

export type HotbarVerifierDone = {
  kind: "done";
  equippedSlot: number;
};

export type HotbarVerifierFail = {
  kind: "fail";
  reason: string;
  reportFields: Record<string, unknown>;
};

export type HotbarVerifierResult = HotbarVerifierAct | HotbarVerifierDone | HotbarVerifierFail;

type InnerPhase = "init" | "swap_away" | "swap_to" | "settle" | "read";

const SETTLE_FRAMES = 1;
const CANDIDATE_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function hotbarAction(slot: number): McuEnvAction {
  const a = defaultMcuAction();
  const key = `hotbar.${slot}` as McuButtonKey;
  (a as Record<McuButtonKey | "camera", unknown>)[key] = 1;
  return a;
}

function noopAction(): McuEnvAction {
  return defaultMcuAction();
}

export class HotbarVerifier {
  private readonly target: string;
  private readonly deps: HotbarVerifierDeps;
  private readonly contextId: string;
  private readonly subgoalDescription: string;
  private cursor = 0;
  private innerPhase: InnerPhase = "init";
  private settleCounter = 0;
  private activeSlot: number | null = null;
  private ocrTrace: Array<{ slot: number; observed: string; match: boolean }> = [];

  constructor(opts: {
    target: string;
    deps: HotbarVerifierDeps;
    contextId: string;
    subgoalDescription: string;
  }) {
    this.target = opts.target;
    this.deps = opts.deps;
    this.contextId = opts.contextId;
    this.subgoalDescription = opts.subgoalDescription;
  }

  private swapAwaySlot(candidate: number): number {
    return (candidate % 9) + 1;
  }

  private emitDebug(action: string, extra: Record<string, unknown>): void {
    const dbg = getDebugRecorder();
    if (!dbg.isEnabled()) return;
    dbg.record({
      type: "hotbar_verifier_step",
      contextId: this.contextId,
      data: {
        target: this.target,
        subgoal: this.subgoalDescription,
        cursor: this.cursor,
        candidateSlot: CANDIDATE_ORDER[this.cursor] ?? null,
        innerPhase: this.innerPhase,
        action,
        activeSlot: this.activeSlot,
        ...extra,
      },
    });
  }

  async nextAction(obsBase64: string): Promise<HotbarVerifierResult> {
    const candidate = CANDIDATE_ORDER[this.cursor];
    if (candidate === undefined) {
      return this.fail();
    }

    if (this.innerPhase === "init") {
      const swapAway = this.swapAwaySlot(candidate);
      this.innerPhase = "swap_away";
      this.activeSlot = swapAway;
      console.log(`[hotbar-verifier] start target=${this.target} swap-away to hotbar.${swapAway}`);
      this.emitDebug(`hotbar.${swapAway}`, { swapAway });
      return { kind: "act", action: hotbarAction(swapAway), holdSteps: 1 };
    }

    if (this.innerPhase === "swap_away") {
      this.innerPhase = "swap_to";
      this.activeSlot = candidate;
      this.emitDebug(`hotbar.${candidate}`, {});
      return { kind: "act", action: hotbarAction(candidate), holdSteps: 1 };
    }

    if (this.innerPhase === "swap_to") {
      this.innerPhase = "settle";
      this.settleCounter = 0;
      this.emitDebug("noop(settle)", { settleCounter: 0 });
      return { kind: "act", action: noopAction(), holdSteps: 1 };
    }

    if (this.innerPhase === "settle") {
      if (this.settleCounter < SETTLE_FRAMES) {
        this.settleCounter += 1;
        this.emitDebug("noop(settle)", { settleCounter: this.settleCounter });
        return { kind: "act", action: noopAction(), holdSteps: 1 };
      }
      this.innerPhase = "read";
      // Fall through to read in same call so we OCR the just-received frame.
    }

    if (this.innerPhase === "read") {
      const result = await hotbarBannerMatch({
        client: this.deps.client,
        model: this.deps.model,
        obsBase64,
        target: this.target,
        candidateLabel: `hotbar.${candidate}`,
      });
      this.ocrTrace.push({ slot: candidate, observed: result.observed, match: result.match });
      this.emitDebug("ocr", { observed: result.observed, match: result.match });
      console.log(`[hotbar-verifier] read hotbar.${candidate} observed=${JSON.stringify(result.observed)} match=${result.match}`);
      if (result.match) {
        console.log(`[hotbar-verifier] DONE equipped=hotbar.${candidate} target=${this.target}`);
        return { kind: "done", equippedSlot: candidate };
      }
      this.cursor += 1;
      if (this.cursor >= CANDIDATE_ORDER.length) {
        console.log(`[hotbar-verifier] FAIL hotbar_missing_item target=${this.target} trace=${JSON.stringify(this.ocrTrace)}`);
        return this.fail();
      }
      const nextCandidate = CANDIDATE_ORDER[this.cursor]!;
      this.innerPhase = "swap_to";
      this.activeSlot = nextCandidate;
      this.emitDebug(`hotbar.${nextCandidate}`, {});
      return { kind: "act", action: hotbarAction(nextCandidate), holdSteps: 1 };
    }

    return this.fail();
  }

  private fail(): HotbarVerifierFail {
    const reason = `hotbar_missing_item: ${this.target}`;
    return {
      kind: "fail",
      reason,
      reportFields: {
        code: "hotbar_missing_item",
        item: this.target,
        ocrTrace: this.ocrTrace,
      },
    };
  }
}
