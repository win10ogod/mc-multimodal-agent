import { readJsonFile, writeJsonFile } from "../utils/fs";
import { nowIso } from "../utils/misc";

export type ScheduledTask = {
  id: string;
  prompt: string;
  enabled: boolean;
  intervalSeconds?: number;
  runAt?: string;
  nextRunAt: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
};

type TaskFile = {
  schemaVersion: 1;
  tasks: ScheduledTask[];
};

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export class TaskStore {
  private file: TaskFile = { schemaVersion: 1, tasks: [] };

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    this.file = await readJsonFile<TaskFile>(this.filePath, {
      schemaVersion: 1,
      tasks: [],
    });
  }

  list(): ScheduledTask[] {
    return this.file.tasks.slice().sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  async add(params: {
    prompt: string;
    intervalSeconds?: number;
    runAt?: string;
    enabled?: boolean;
  }): Promise<ScheduledTask> {
    if (!params.prompt.trim()) {
      throw new Error("Scheduled task prompt cannot be empty.");
    }
    if (!params.intervalSeconds && !params.runAt) {
      throw new Error("Scheduled task requires intervalSeconds or runAt.");
    }
    const now = new Date();
    const runAt = params.runAt ? new Date(params.runAt) : addSeconds(now, params.intervalSeconds ?? 60);
    const task: ScheduledTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      prompt: params.prompt.trim(),
      enabled: params.enabled ?? true,
      intervalSeconds: params.intervalSeconds,
      runAt: params.runAt,
      nextRunAt: runAt.toISOString(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.file.tasks.push(task);
    await this.save();
    return task;
  }

  due(now = new Date()): ScheduledTask[] {
    return this.file.tasks.filter(
      (task) => task.enabled && new Date(task.nextRunAt).getTime() <= now.getTime(),
    );
  }

  async markRun(id: string, now = new Date()): Promise<void> {
    const task = this.file.tasks.find((item) => item.id === id);
    if (!task) {
      return;
    }
    task.lastRunAt = now.toISOString();
    task.updatedAt = nowIso();
    if (task.intervalSeconds && task.intervalSeconds > 0) {
      task.nextRunAt = addSeconds(now, task.intervalSeconds).toISOString();
    } else {
      task.enabled = false;
      task.nextRunAt = now.toISOString();
    }
    await this.save();
  }

  async remove(id: string): Promise<boolean> {
    const before = this.file.tasks.length;
    this.file.tasks = this.file.tasks.filter((task) => task.id !== id);
    await this.save();
    return this.file.tasks.length !== before;
  }

  buildPromptSection(): string {
    const tasks = this.list().slice(0, 20);
    if (tasks.length === 0) {
      return "No scheduled tasks.";
    }
    return tasks
      .map(
        (task) =>
          `- ${task.id} enabled=${task.enabled} next=${task.nextRunAt} interval=${
            task.intervalSeconds ?? "once"
          }: ${task.prompt}`,
      )
      .join("\n");
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.filePath, this.file);
  }
}
