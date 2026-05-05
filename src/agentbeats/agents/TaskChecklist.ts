export type ChecklistStatus = "pending" | "in_progress" | "done" | "blocked";

export type ChecklistItem = {
  id: string;
  description: string;
  status: ChecklistStatus;
  evidence: string;
  parentId?: string;
};

export class TaskChecklist {
  private items: ChecklistItem[] = [];
  private next = 1;

  add(description: string, parentId?: string): ChecklistItem {
    const id = `c${this.next++}`;
    const item: ChecklistItem = { id, description, status: "pending", evidence: "", parentId };
    this.items.push(item);
    return item;
  }
  mark(id: string, status: ChecklistStatus, evidence: string): boolean {
    const it = this.items.find(i => i.id === id);
    if (!it) return false;
    it.status = status; it.evidence = evidence;
    return true;
  }
  read(): ChecklistItem[] { return [...this.items]; }
  allDone(): boolean {
    return this.items.length > 0 && this.items.every(i => i.status === "done");
  }
  format(): string {
    if (this.items.length === 0) return "(empty — start by adding the top-level task)";
    return this.items.map(i => `[${i.status}] ${i.id}: ${i.description}${i.evidence ? ` — ${i.evidence}` : ""}`).join("\n");
  }
}
