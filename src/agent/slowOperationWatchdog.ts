export type SlowOperationEvent = {
  label: string;
  elapsedMs: number;
  [key: string]: unknown;
};

export async function runWithSlowOperationWatchdog<T>(params: {
  label: string;
  thresholdMs: number;
  intervalMs?: number;
  snapshot?: () => Record<string, unknown>;
  log: (event: SlowOperationEvent) => void;
  action: () => Promise<T>;
}): Promise<T> {
  const thresholdMs = Math.max(0, Math.floor(params.thresholdMs));
  if (thresholdMs <= 0) {
    return params.action();
  }
  const intervalMs = Math.max(1, Math.floor(params.intervalMs ?? thresholdMs));
  const startedAt = Date.now();
  let completed = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      if (completed) {
        return;
      }
      const snapshot = params.snapshot?.() ?? {};
      params.log({
        label: params.label,
        elapsedMs: Date.now() - startedAt,
        ...snapshot,
      });
      schedule(intervalMs);
    }, delayMs);
    timer.unref?.();
  };

  schedule(thresholdMs);
  try {
    return await params.action();
  } finally {
    completed = true;
    if (timer) {
      clearTimeout(timer);
    }
  }
}
