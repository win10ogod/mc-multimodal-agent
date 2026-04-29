import type { SessionLoopState } from "../types";
import { digest } from "../utils/misc";

export type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      count: number;
      message: string;
    };

export type LoopDetectionConfig = {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  criticalThreshold: number;
};

export const defaultLoopDetectionConfig: LoopDetectionConfig = {
  enabled: true,
  historySize: 30,
  warningThreshold: 8,
  criticalThreshold: 16,
};

export function hashToolCall(toolName: string, args: unknown): string {
  return `${toolName}:${digest(args)}`;
}

export function detectToolCallLoop(
  state: SessionLoopState,
  toolName: string,
  args: unknown,
  config = defaultLoopDetectionConfig,
): LoopDetectionResult {
  if (!config.enabled) {
    return { stuck: false };
  }
  const currentHash = hashToolCall(toolName, args);
  const matching = state.toolCallHistory.filter(
    (entry) => entry.toolName === toolName && entry.argsHash === currentHash,
  );
  const noProgress = matching.filter(
    (entry) => entry.resultHash && entry.resultHash === matching.at(-1)?.resultHash,
  );
  const count = Math.max(matching.length, noProgress.length);
  if (count >= config.criticalThreshold) {
    return {
      stuck: true,
      level: "critical",
      count,
      message: `CRITICAL: ${toolName} repeated the same arguments ${count} times. Stop retrying and choose a different plan.`,
    };
  }
  if (count >= config.warningThreshold) {
    return {
      stuck: true,
      level: "warning",
      count,
      message: `WARNING: ${toolName} has repeated the same arguments ${count} times. If there is no progress, change strategy.`,
    };
  }
  return { stuck: false };
}

export function recordToolCall(
  state: SessionLoopState,
  toolName: string,
  args: unknown,
  callId: string | undefined,
  config = defaultLoopDetectionConfig,
): void {
  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, args),
    callId,
    timestamp: Date.now(),
  });
  while (state.toolCallHistory.length > config.historySize) {
    state.toolCallHistory.shift();
  }
}

export function recordToolOutcome(
  state: SessionLoopState,
  toolName: string,
  args: unknown,
  callId: string | undefined,
  result: unknown,
): void {
  const argsHash = hashToolCall(toolName, args);
  for (let index = state.toolCallHistory.length - 1; index >= 0; index -= 1) {
    const entry = state.toolCallHistory[index];
    if (!entry || entry.toolName !== toolName || entry.argsHash !== argsHash) {
      continue;
    }
    if (callId && entry.callId !== callId) {
      continue;
    }
    entry.resultHash = digest(result);
    return;
  }
}
