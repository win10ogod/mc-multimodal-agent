import { readJsonFile, writeJsonFile } from "../utils/fs";
import { compactText, nowIso } from "../utils/misc";

export type GoalStatus = "pending" | "running" | "blocked" | "done" | "failed" | "cancelled";

export type GoalNode = {
  id: string;
  rootId: string;
  parentId?: string;
  title: string;
  description?: string;
  status: GoalStatus;
  priority: number;
  order: number;
  successCriteria?: string;
  blockers: string[];
  notes: string[];
  verification?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type GoalFile = {
  schemaVersion: 1;
  goals: GoalNode[];
};

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampPriority(value: unknown, fallback = 0.5): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function activeStatus(status: GoalStatus): boolean {
  return status === "pending" || status === "running" || status === "blocked";
}

export class GoalStore {
  private file: GoalFile = { schemaVersion: 1, goals: [] };

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    this.file = await readJsonFile<GoalFile>(this.filePath, { schemaVersion: 1, goals: [] });
  }

  list(params: { rootId?: string; status?: GoalStatus; includeDone?: boolean } = {}): GoalNode[] {
    return this.file.goals
      .filter((goal) => !params.rootId || goal.rootId === params.rootId)
      .filter((goal) => !params.status || goal.status === params.status)
      .filter((goal) => params.includeDone === true || activeStatus(goal.status))
      .sort((a, b) => a.rootId.localeCompare(b.rootId) || a.order - b.order || b.priority - a.priority);
  }

  get(id: string): GoalNode | undefined {
    return this.file.goals.find((goal) => goal.id === id);
  }

  async ensureRoot(title: string, description?: string): Promise<GoalNode> {
    const normalized = normalizeTitle(title);
    if (!normalized) {
      throw new Error("Goal title cannot be empty.");
    }
    const existing = this.file.goals.find(
      (goal) => !goal.parentId && activeStatus(goal.status) && goal.title === normalized,
    );
    if (existing) {
      return existing;
    }
    const now = nowIso();
    const root: GoalNode = {
      id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      rootId: "",
      title: normalized,
      description: description?.trim() || undefined,
      status: "running",
      priority: 1,
      order: this.nextOrder(),
      blockers: [],
      notes: [],
      createdAt: now,
      updatedAt: now,
    };
    root.rootId = root.id;
    this.file.goals.push(root);
    await this.save();
    return root;
  }

  async createPlan(params: {
    task: string;
    goals: Array<{
      title: string;
      description?: string;
      successCriteria?: string;
      priority?: number;
    }>;
  }): Promise<{ root: GoalNode; goals: GoalNode[] }> {
    const root = await this.ensureRoot(params.task);
    const created: GoalNode[] = [];
    const existingTitles = new Set(
      this.file.goals
        .filter((goal) => goal.rootId === root.rootId && goal.parentId === root.id)
        .map((goal) => goal.title),
    );
    for (const item of params.goals) {
      const title = normalizeTitle(item.title);
      if (!title || existingTitles.has(title)) {
        continue;
      }
      existingTitles.add(title);
      const now = nowIso();
      const node: GoalNode = {
        id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        rootId: root.rootId,
        parentId: root.id,
        title,
        description: item.description?.trim() || undefined,
        status: "pending",
        priority: clampPriority(item.priority, 0.5),
        order: this.nextOrder(),
        successCriteria: item.successCriteria?.trim() || undefined,
        blockers: [],
        notes: [],
        createdAt: now,
        updatedAt: now,
      };
      this.file.goals.push(node);
      created.push(node);
    }
    await this.save();
    return { root, goals: created };
  }

  async update(params: {
    id: string;
    status?: GoalStatus;
    note?: string;
    verification?: string;
    blockers?: string[];
  }): Promise<GoalNode> {
    const goal = this.get(params.id);
    if (!goal) {
      throw new Error(`Unknown goal: ${params.id}`);
    }
    const now = nowIso();
    if (params.status) {
      goal.status = params.status;
      if (params.status === "done" || params.status === "failed" || params.status === "cancelled") {
        goal.completedAt = now;
      } else {
        goal.completedAt = undefined;
      }
    }
    if (params.note?.trim()) {
      goal.notes.push(`${now}: ${params.note.trim()}`);
    }
    if (params.verification?.trim()) {
      goal.verification = params.verification.trim();
    }
    if (params.blockers) {
      goal.blockers = params.blockers.map((item) => item.trim()).filter(Boolean);
      if (goal.blockers.length > 0 && goal.status !== "done") {
        goal.status = "blocked";
      }
    }
    goal.updatedAt = now;
    await this.save();
    return goal;
  }

  next(rootId?: string): GoalNode | undefined {
    const candidates = this.file.goals
      .filter((goal) => goal.parentId)
      .filter((goal) => !rootId || goal.rootId === rootId)
      .filter((goal) => goal.status === "running" || goal.status === "pending")
      .sort((a, b) => {
        const statusScore = (goal: GoalNode) => (goal.status === "running" ? 0 : 1);
        return statusScore(a) - statusScore(b) || b.priority - a.priority || a.order - b.order;
      });
    return candidates[0];
  }

  async checkpoint(params: { rootId?: string; note: string }): Promise<GoalNode> {
    const note = params.note.trim();
    if (!note) {
      throw new Error("Checkpoint note cannot be empty.");
    }
    const root =
      (params.rootId ? this.get(params.rootId) : undefined) ??
      this.file.goals
        .filter((goal) => !goal.parentId && activeStatus(goal.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!root) {
      throw new Error("No active root goal to checkpoint.");
    }
    return this.update({ id: root.id, note });
  }

  buildPromptSection(focus = ""): string {
    const activeRoots = this.file.goals
      .filter((goal) => !goal.parentId && activeStatus(goal.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 4);
    if (activeRoots.length === 0) {
      return "No active goal tree. For complex tasks, create one with goal_plan before executing.";
    }
    const focusLower = focus.toLowerCase();
    return activeRoots
      .map((root) => {
        const children = this.file.goals
          .filter((goal) => goal.rootId === root.rootId && goal.parentId)
          .filter(
            (goal) =>
              activeStatus(goal.status) ||
              (focusLower && `${goal.title} ${goal.description ?? ""}`.toLowerCase().includes(focusLower)),
          )
          .sort((a, b) => a.order - b.order)
          .slice(0, 12);
        const childText =
          children.length > 0
            ? children
                .map((goal) => {
                  const blockers = goal.blockers.length > 0 ? ` blockers=${goal.blockers.join("; ")}` : "";
                  const criteria = goal.successCriteria ? ` criteria=${compactText(goal.successCriteria, 120)}` : "";
                  return `  - ${goal.id} [${goal.status} p=${goal.priority.toFixed(2)}] ${compactText(goal.title, 140)}${criteria}${blockers}`;
                })
                .join("\n")
            : "  - No subgoals yet.";
        const latestNote = root.notes.at(-1);
        return [
          `- ${root.id} [${root.status}] ${compactText(root.title, 180)}`,
          latestNote ? `  checkpoint=${compactText(latestNote, 240)}` : "",
          childText,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");
  }

  private nextOrder(): number {
    return this.file.goals.reduce((max, goal) => Math.max(max, goal.order), 0) + 1;
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.filePath, this.file);
  }
}
