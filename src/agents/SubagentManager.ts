import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../config";
import { createModelProvider, type ModelProvider } from "../openai/ModelProvider";
import { readJsonFile, writeJsonFile } from "../utils/fs";
import { compactText } from "../utils/misc";

export type SubagentRunStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";
export type SubagentContextMode = "isolated" | "fork";
export type SubagentMessageRole = "parent" | "subagent" | "system";
export type SubagentMessageType = "message" | "steer" | "handoff";
export type SubagentEventType =
  | "spawned"
  | "message"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "stale_recovered";

export type SubagentMessage = {
  id: string;
  role: SubagentMessageRole;
  type: SubagentMessageType;
  text: string;
  createdAt: string;
};

export type SubagentEvent = {
  type: SubagentEventType;
  at: string;
  text?: string;
};

export type SubagentHandoff = {
  summary: string;
  completedAt: string;
};

export type SubagentRun = {
  id: string;
  agentId?: string;
  parentRunId?: string;
  parentTask?: string;
  label?: string;
  role: string;
  task: string;
  status: SubagentRunStatus;
  contextMode: SubagentContextMode;
  forkedContext?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  cleanup?: string;
  runTimeoutMs?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  result?: string;
  error?: string;
  cancelReason?: string;
  handoff?: SubagentHandoff;
  messages: SubagentMessage[];
  events: SubagentEvent[];
};

export type SubagentSpawnInput = {
  agentId?: string;
  parentRunId?: string;
  parentTask?: string;
  label?: string;
  role?: string;
  task: string;
  contextMode?: SubagentContextMode;
  forkedContext?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  cleanup?: string;
  runTimeoutMs?: number;
};

export type SubagentSendOptions = {
  role?: SubagentMessageRole;
  type?: SubagentMessageType;
};

export type SubagentRunnerControls = {
  signal: AbortSignal;
  messages: () => SubagentMessage[];
  waitForMessage: (afterIndex?: number, timeoutMs?: number) => Promise<SubagentMessage | undefined>;
  appendMessage: (text: string, options?: SubagentSendOptions) => Promise<SubagentMessage>;
};

export type SubagentRunner = (run: SubagentRun, controls: SubagentRunnerControls) => Promise<string>;

type SubagentStoreFile = {
  schemaVersion: 1 | 2;
  runs: SubagentRun[];
};

type MessageWaiter = {
  afterIndex: number;
  resolve: (message: SubagentMessage | undefined) => void;
  timeout?: NodeJS.Timeout;
  abort?: () => void;
};

const TERMINAL_STATUSES = new Set<SubagentRunStatus>(["completed", "failed", "cancelled", "timed_out"]);

function nowIso(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function defaultStore(): SubagentStoreFile {
  return { schemaVersion: 2, runs: [] };
}

function cleanText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function finitePositiveMs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function cloneMessage(message: SubagentMessage): SubagentMessage {
  return { ...message };
}

function cloneEvent(event: SubagentEvent): SubagentEvent {
  return { ...event };
}

function cloneRun(run: SubagentRun): SubagentRun {
  return {
    ...run,
    messages: run.messages.map(cloneMessage),
    events: run.events.map(cloneEvent),
    handoff: run.handoff ? { ...run.handoff } : undefined,
  };
}

function terminal(status: SubagentRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function normalizeRun(raw: Partial<SubagentRun>): SubagentRun {
  const timestamp = nowIso();
  const status =
    raw.status === "completed" ||
    raw.status === "failed" ||
    raw.status === "cancelled" ||
    raw.status === "timed_out" ||
    raw.status === "running"
      ? raw.status
      : "failed";
  return {
    id: cleanText(raw.id) ?? `subagent_${randomUUID().slice(0, 8)}`,
    agentId: cleanText(raw.agentId),
    parentRunId: cleanText(raw.parentRunId),
    parentTask: cleanText(raw.parentTask),
    label: cleanText(raw.label),
    role: cleanText(raw.role) ?? "planner",
    task: cleanText(raw.task) ?? "(missing task)",
    status,
    contextMode: raw.contextMode === "fork" ? "fork" : "isolated",
    forkedContext: cleanText(raw.forkedContext),
    model: cleanText(raw.model),
    thinking: cleanText(raw.thinking),
    mode: cleanText(raw.mode),
    cleanup: cleanText(raw.cleanup),
    runTimeoutMs: finitePositiveMs(raw.runTimeoutMs),
    createdAt: cleanText(raw.createdAt) ?? timestamp,
    updatedAt: cleanText(raw.updatedAt) ?? timestamp,
    startedAt: cleanText(raw.startedAt),
    endedAt: cleanText(raw.endedAt),
    result: cleanText(raw.result),
    error: cleanText(raw.error),
    cancelReason: cleanText(raw.cancelReason),
    handoff: raw.handoff
      ? {
          summary: cleanText(raw.handoff.summary) ?? "",
          completedAt: cleanText(raw.handoff.completedAt) ?? timestamp,
        }
      : undefined,
    messages: Array.isArray(raw.messages) ? raw.messages.map((message) => ({ ...message })) : [],
    events: Array.isArray(raw.events) ? raw.events.map((event) => ({ ...event })) : [],
  };
}

function reasoningEffort(value: string | undefined): AgentConfig["openai"]["reasoningEffort"] | undefined {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SubagentManager {
  private runs = new Map<string, SubagentRun>();
  private pending = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private messageWaiters = new Map<string, Set<MessageWaiter>>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly runner: SubagentRunner,
  ) {}

  async load(): Promise<void> {
    const file = await readJsonFile<SubagentStoreFile>(this.filePath, defaultStore());
    const timestamp = nowIso();
    let changed = false;
    const runs = (file.runs ?? []).map((raw) => {
      const run = normalizeRun(raw);
      if (run.status === "running") {
        changed = true;
        return {
          ...run,
          status: "failed" as const,
          error: "stale running subagent recovered after restart",
          endedAt: timestamp,
          updatedAt: timestamp,
          events: [...run.events, { type: "stale_recovered" as const, at: timestamp, text: "Marked failed after restart." }],
        };
      }
      return run;
    });
    this.runs = new Map(runs.map((run) => [run.id, run]));
    if (changed) {
      await this.save();
    }
  }

  list(): SubagentRun[] {
    return [...this.runs.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((run) => cloneRun(run));
  }

  get(id: string): SubagentRun | undefined {
    const run = this.runs.get(id);
    return run ? cloneRun(run) : undefined;
  }

  async spawn(input: SubagentSpawnInput): Promise<SubagentRun> {
    const task = input.task.trim();
    if (!task) {
      throw new Error("subagent task must be non-empty.");
    }
    const timestamp = nowIso();
    const contextMode = input.contextMode === "fork" ? "fork" : "isolated";
    const run: SubagentRun = {
      id: `subagent_${randomUUID().slice(0, 8)}`,
      agentId: cleanText(input.agentId),
      parentRunId: cleanText(input.parentRunId),
      parentTask: cleanText(input.parentTask),
      label: cleanText(input.label),
      role: cleanText(input.role) ?? "planner",
      task,
      status: "running",
      contextMode,
      forkedContext: contextMode === "fork" ? cleanText(input.forkedContext) : undefined,
      model: cleanText(input.model),
      thinking: cleanText(input.thinking),
      mode: cleanText(input.mode),
      cleanup: cleanText(input.cleanup),
      runTimeoutMs: finitePositiveMs(input.runTimeoutMs),
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      messages: [],
      events: [{ type: "spawned", at: timestamp }],
    };
    this.runs.set(run.id, run);
    await this.save();
    const pending = this.execute(run.id);
    this.pending.set(run.id, pending);
    pending.finally(() => this.pending.delete(run.id)).catch(() => undefined);
    return cloneRun(run);
  }

  async send(id: string, text: string, options: SubagentSendOptions = {}): Promise<SubagentMessage> {
    const run = this.runs.get(id);
    if (!run) {
      throw new Error(`Unknown subagent: ${id}`);
    }
    if (run.status !== "running") {
      throw new Error(`Cannot send to subagent ${id} because it is ${run.status}.`);
    }
    const message = await this.appendMessage(id, text, {
      role: options.role ?? "parent",
      type: options.type ?? "message",
    });
    return message;
  }

  async cancel(id: string, reason = "cancelled by parent"): Promise<SubagentRun> {
    const run = this.runs.get(id);
    if (!run) {
      throw new Error(`Unknown subagent: ${id}`);
    }
    if (terminal(run.status)) {
      return cloneRun(run);
    }
    const timestamp = nowIso();
    this.runs.set(id, {
      ...run,
      status: "cancelled",
      cancelReason: reason,
      endedAt: timestamp,
      updatedAt: timestamp,
      events: [...run.events, { type: "cancelled", at: timestamp, text: reason }],
    });
    this.resolveMessageWaiters(id, undefined);
    this.controllers.get(id)?.abort();
    await this.save();
    const pending = this.pending.get(id);
    if (pending) {
      await Promise.race([pending.catch(() => undefined), sleep(500)]);
    }
    return cloneRun(this.runs.get(id) ?? run);
  }

  async waitFor(id: string, timeoutMs = 60_000): Promise<SubagentRun | undefined> {
    const run = this.runs.get(id);
    if (!run || run.status !== "running" || timeoutMs <= 0) {
      return run ? cloneRun(run) : undefined;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return cloneRun(run);
    }
    await Promise.race([
      pending,
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, timeoutMs))),
    ]);
    const latest = this.runs.get(id);
    return latest ? cloneRun(latest) : undefined;
  }

  private async execute(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") {
      return;
    }
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const timeout = run.runTimeoutMs
      ? setTimeout(() => {
          this.markTimedOut(id).catch((error) => {
            console.warn(`[subagent] failed to mark timeout for ${id}: ${errorText(error)}`);
          });
        }, run.runTimeoutMs)
      : undefined;

    try {
      const result = await this.runner(cloneRun(run), {
        signal: controller.signal,
        messages: () => this.messagesFor(id),
        waitForMessage: (afterIndex = 0, timeoutMs = 60_000) =>
          this.waitForMessage(id, afterIndex, timeoutMs, controller.signal),
        appendMessage: (text, options = {}) =>
          this.appendMessage(id, text, {
            role: options.role ?? "subagent",
            type: options.type ?? "message",
          }),
      });
      const latest = this.runs.get(id);
      if (!latest || latest.status !== "running") {
        return;
      }
      const timestamp = nowIso();
      const summary = result.trim();
      this.runs.set(id, {
        ...latest,
        status: "completed",
        result: summary,
        handoff: {
          summary,
          completedAt: timestamp,
        },
        endedAt: timestamp,
        updatedAt: timestamp,
        events: [...latest.events, { type: "completed", at: timestamp, text: compactText(summary, 240) }],
      });
    } catch (error) {
      const latest = this.runs.get(id);
      if (latest?.status === "running") {
        const timestamp = nowIso();
        this.runs.set(id, {
          ...latest,
          status: "failed",
          error: errorText(error),
          endedAt: timestamp,
          updatedAt: timestamp,
          events: [...latest.events, { type: "failed", at: timestamp, text: compactText(errorText(error), 240) }],
        });
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.controllers.delete(id);
      this.resolveMessageWaiters(id, undefined);
      await this.save();
    }
  }

  private async markTimedOut(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") {
      return;
    }
    const timestamp = nowIso();
    this.runs.set(id, {
      ...run,
      status: "timed_out",
      error: `subagent timed out after ${run.runTimeoutMs ?? 0}ms`,
      endedAt: timestamp,
      updatedAt: timestamp,
      events: [...run.events, { type: "timed_out", at: timestamp, text: `Timed out after ${run.runTimeoutMs ?? 0}ms.` }],
    });
    this.resolveMessageWaiters(id, undefined);
    this.controllers.get(id)?.abort();
    await this.save();
  }

  private messagesFor(id: string): SubagentMessage[] {
    return (this.runs.get(id)?.messages ?? []).map(cloneMessage);
  }

  private async appendMessage(id: string, text: string, options: Required<SubagentSendOptions>): Promise<SubagentMessage> {
    const run = this.runs.get(id);
    if (!run) {
      throw new Error(`Unknown subagent: ${id}`);
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("subagent message must be non-empty.");
    }
    const timestamp = nowIso();
    const message: SubagentMessage = {
      id: `submsg_${randomUUID().slice(0, 8)}`,
      role: options.role,
      type: options.type,
      text: trimmed,
      createdAt: timestamp,
    };
    this.runs.set(id, {
      ...run,
      messages: [...run.messages, message],
      updatedAt: timestamp,
      events: [...run.events, { type: "message", at: timestamp, text: compactText(trimmed, 240) }],
    });
    this.notifyMessageWaiters(id);
    await this.save();
    return cloneMessage(message);
  }

  private waitForMessage(
    id: string,
    afterIndex: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<SubagentMessage | undefined> {
    const run = this.runs.get(id);
    const index = Math.max(0, Math.floor(afterIndex));
    if (run && run.messages.length > index) {
      return Promise.resolve(cloneMessage(run.messages[index]));
    }
    if (signal.aborted) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const waiter: MessageWaiter = { afterIndex: index, resolve };
      const cleanup = () => {
        if (waiter.timeout) {
          clearTimeout(waiter.timeout);
        }
        if (waiter.abort) {
          signal.removeEventListener("abort", waiter.abort);
        }
        this.messageWaiters.get(id)?.delete(waiter);
      };
      waiter.resolve = (message) => {
        cleanup();
        resolve(message);
      };
      waiter.timeout = setTimeout(() => waiter.resolve(undefined), Math.max(1, timeoutMs));
      waiter.abort = () => waiter.resolve(undefined);
      signal.addEventListener("abort", waiter.abort, { once: true });
      const waiters = this.messageWaiters.get(id) ?? new Set<MessageWaiter>();
      waiters.add(waiter);
      this.messageWaiters.set(id, waiters);
    });
  }

  private notifyMessageWaiters(id: string): void {
    const run = this.runs.get(id);
    if (!run) {
      return;
    }
    for (const waiter of [...(this.messageWaiters.get(id) ?? [])]) {
      if (run.messages.length > waiter.afterIndex) {
        waiter.resolve(cloneMessage(run.messages[waiter.afterIndex]));
      }
    }
  }

  private resolveMessageWaiters(id: string, message: SubagentMessage | undefined): void {
    for (const waiter of [...(this.messageWaiters.get(id) ?? [])]) {
      waiter.resolve(message ? cloneMessage(message) : undefined);
    }
    this.messageWaiters.delete(id);
  }

  private async save(): Promise<void> {
    this.saveChain = this.saveChain.then(
      () =>
        writeJsonFile(this.filePath, {
          schemaVersion: 2,
          runs: this.list(),
        } satisfies SubagentStoreFile),
      () =>
        writeJsonFile(this.filePath, {
          schemaVersion: 2,
          runs: this.list(),
        } satisfies SubagentStoreFile),
    );
    await this.saveChain;
  }
}

export function createModelSubagentRunner(config: AgentConfig, provider?: ModelProvider): SubagentRunner {
  const defaultProvider = provider ?? createModelProvider(config);
  return async (run, controls) => {
    await controls.waitForMessage(run.messages.length, 250);
    if (controls.signal.aborted) {
      throw new Error("subagent aborted before model call");
    }
    const messages = controls.messages();
    const effort = reasoningEffort(run.thinking);
    const modelProvider =
      provider || (!run.model && !effort)
        ? defaultProvider
        : createModelProvider({
            ...config,
            openai: {
              ...config.openai,
              model: run.model ?? config.openai.model,
              reasoningEffort: effort ?? config.openai.reasoningEffort,
            },
          });
    const messageSection =
      messages.length > 0
        ? messages
            .map((message) => `- ${message.createdAt} ${message.role}/${message.type}: ${message.text}`)
            .join("\n")
        : "No parent steering messages yet.";
    const turn = await modelProvider.start({
      instructions: [
        "You are a background Minecraft planning subagent.",
        "You are model-only and cannot act in the Minecraft world.",
        "Return concise, actionable findings for the parent agent.",
        "Prefer concrete coordinates, material counts, risks, or next tool calls when the task asks for planning.",
        "If forked context is provided, treat it as a snapshot that may be stale by the time the parent reads your handoff.",
      ].join("\n"),
      text: [
        `role=${run.role}`,
        run.agentId ? `agent_id=${run.agentId}` : "",
        run.label ? `label=${run.label}` : "",
        run.parentRunId ? `parent_run_id=${run.parentRunId}` : "",
        `context=${run.contextMode}`,
        run.model ? `model=${run.model}` : "",
        run.thinking ? `thinking=${run.thinking}` : "",
        "",
        "<task>",
        run.task,
        "</task>",
        run.contextMode === "fork" && run.forkedContext
          ? ["", "<forked_context>", run.forkedContext, "</forked_context>"].join("\n")
          : "",
        "",
        "<messages>",
        messageSection,
        "</messages>",
      ]
        .filter(Boolean)
        .join("\n"),
      tools: [],
    });
    return turn.text.trim() || JSON.stringify(turn.toolCalls);
  };
}
