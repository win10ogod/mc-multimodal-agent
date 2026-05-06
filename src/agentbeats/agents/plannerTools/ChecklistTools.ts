import type { PlannerTool } from "./types";
import type { EpisodeState } from "../SubAgent";

export const addChecklistItemTool = (state: EpisodeState): PlannerTool => ({
  name: "add_checklist_item",
  description:
    "Add a concrete, verifiable subtask to the planner's checklist. " +
    "Use to record top-level requirements at the start, AND to insert " +
    "newly-discovered prerequisites. Granularity: each item must be verifiable by inspect_inventory or look_around.",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string" },
      parent_id: { type: "string", description: "Optional. The id of the item this is a prerequisite for." },
    },
    required: ["description"],
    additionalProperties: false,
  },
  async run(_ctx, args) {
    const a = args as { description: string; parent_id?: string };
    const it = state.checklist.add(a.description, a.parent_id);
    return { ok: true, text: `added ${it.id}: ${it.description}` };
  },
});

export const markChecklistItemTool = (state: EpisodeState): PlannerTool => ({
  name: "mark_checklist_item",
  description:
    "Update an item's status. Allowed: in_progress (just dispatched), done (verified by an inspect tool), blocked (sub-agent reported BLOCKED). " +
    "Do NOT mark done based on the sub-agent's self-report alone — verify with inspect_inventory or verify_slots first.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["in_progress", "done", "blocked"] },
      evidence: { type: "string", description: "Cite the inspection result that proves this status, or the sub-agent's BLOCKED reason." },
    },
    required: ["id", "status", "evidence"],
    additionalProperties: false,
  },
  async run(_ctx, args) {
    const a = args as { id: string; status: "in_progress" | "done" | "blocked"; evidence: string };
    const ok = state.checklist.mark(a.id, a.status, a.evidence);
    return ok ? { ok: true, text: `marked ${a.id} as ${a.status}` } : { ok: false, error: `unknown id ${a.id}` };
  },
});

export const readChecklistTool = (state: EpisodeState): PlannerTool => ({
  name: "read_checklist",
  description: "Return the current checklist (id, description, status, evidence per item). Always available.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async run() { return { ok: true, text: state.checklist.format() }; },
});
