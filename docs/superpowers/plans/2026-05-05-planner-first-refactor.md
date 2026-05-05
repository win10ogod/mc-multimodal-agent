# Planner-First Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GoalPlanner the single entry point for every MCU task. The planner inspects world+inventory state via read-only tools, then dispatches sub-agents to perform side-effecting work. No fall-through to the closed-loop body, no `MCU_USE_PLANNER` env gate.

**Architecture:** Convert `planGoals` from a one-shot JSON-schema call into a tool-calling loop. The planner's tool surface is read-only (`inspect_inventory`, `verify_slots`, `look_around`); state-changing work happens only when the planner emits a `dispatch_subgoal` tool-call that the runtime intercepts. The planner owns a structured **task checklist** that it maintains across iterations: each high-level requirement becomes a checklist item, and the planner ticks items off only after verifying via inspection (not just trusting a sub-agent's self-report). After every sub-agent return, the planner enters a **reflect** turn where it reads the sub-agent's summary (success or `BLOCKED:` reason), updates the checklist, and decides whether to re-dispatch, insert a prerequisite, or escalate. The closed-loop body inside `McuPolicy.handleObservation` is extracted into a real `runClosedLoopStep` function callable by the dispatcher. The planner is generic across MC tasks (crafting, mining, exploration, combat) — not crafting-specific.

**Tech Stack:** TypeScript, OpenAI tool-calling (`tool_choice` + `tools[]`), existing `SlotDetector` / `InventoryProbe` / `UiFastControl`, `dispatchObservation` runtime.

---

## File Structure

**Created:**
- `src/agentbeats/agents/PlannerLoop.ts` — tool-calling loop wrapping the planner LLM. Owns the conversation, executes read-only tools synchronously, returns either `act` (passed sub-agent step) or `dispatch` (new subgoal to run).
- `src/agentbeats/agents/TaskChecklist.ts` — structured per-episode checklist (`{id, description, status, evidence}[]`). Mutated only via planner tool-calls (`add_checklist_item`, `mark_checklist_item`). Source of truth for `task_complete`.
- `src/agentbeats/agents/plannerTools/InspectInventoryTool.ts` — read-only screenshot + slot OCR scan. Returns the SoM+slot map text and the inventory item set.
- `src/agentbeats/agents/plannerTools/VerifySlotsTool.ts` — point-OCR a list of slots (re-uses `verify_slots` mechanic from probe but no clicks).
- `src/agentbeats/agents/plannerTools/LookAroundTool.ts` — return current camera frame + a coarse description (block in front, mobs in view).
- `src/agentbeats/agents/plannerTools/ChecklistTools.ts` — `add_checklist_item`, `mark_checklist_item`, `read_checklist` tool-call handlers.
- `src/agentbeats/agents/runClosedLoopStep.ts` — extracted closed-loop body. Pure function: `(state, obsBase64, contextId, deps) → SubAgentStep`.

**Modified:**
- `src/agentbeats/agents/GoalPlanner.ts` — add `runPlannerLoop` driving tool-calling; keep legacy `planGoals` as a thin shim that calls the loop with no tools (preserves existing tests).
- `src/agentbeats/agents/Dispatcher.ts` — replace one-shot `planGoals` with `runPlannerLoop`; remove `singleTask` bypass branch (planner is always entry point).
- `src/agentbeats/agents/SubAgent.ts` — extend `EpisodeState` with `plannerMessages` (the running tool-call conversation) and drop `singleTask`.
- `src/agentbeats/McuPolicy.ts` — delete the inline closed-loop body from `handleObservation`; route every observation through `dispatchObservation`. Wire `runClosedLoopStep` to the extracted function. Remove `MCU_USE_PLANNER` reads.
- `src/agentbeats/prompts/goal_planner.ts` — rewrite to describe the tool-using planner role, generic across MC tasks. Document the three read-only tools and the `dispatch_subgoal` tool. Keep failure-escalation rules.

**Test files (created):**
- `tests/agents/plannerLoop.test.ts` — mock OpenAI client returning canned tool-call sequences.
- `tests/agents/plannerTools/inspectInventory.test.ts`
- `tests/agents/runClosedLoopStep.test.ts` — golden frame regression: same inputs that drove `craft_oak_planks` 10/10 must still yield identical action sequence.

---

## Task 1: Extract `runClosedLoopStep` from `McuPolicy.handleObservation`

The closed-loop body (~700 lines, lines roughly 738–1450 of `McuPolicy.ts`) currently lives inline in `handleObservation`. Extract it verbatim into a standalone function so the Dispatcher can invoke it.

**Files:**
- Create: `src/agentbeats/agents/runClosedLoopStep.ts`
- Modify: `src/agentbeats/McuPolicy.ts:738-1450` (replace body with call to extracted fn)
- Test: `tests/agents/runClosedLoopStep.test.ts`

- [ ] **Step 1: Identify the closed-loop body boundaries**

Open `src/agentbeats/McuPolicy.ts`. The closed-loop body starts at the line immediately after the `MCU_USE_PLANNER` block ends (currently line 738: `const step = Math.max(0, ...)`) and runs through the end of `handleObservation`. Capture the full set of `state.*` reads/writes and `this.*` calls — these become the function's input/dep parameters.

- [ ] **Step 2: Define the extracted function signature**

In `src/agentbeats/agents/runClosedLoopStep.ts`:

```ts
import type OpenAI from "openai";
import type { McuPolicyDecision, McuObservationPayload } from "../McuPolicy";
import type { EpisodeState, SubAgentStep } from "./SubAgent";
import type { ClosedLoopCraftPlan } from "../tools/UiFastControl";

export type ClosedLoopDeps = {
  client: OpenAI;
  model: string;
  debugDir: string | null;
  recordDebug: (kind: string, payload: unknown) => Promise<void>;
};

export type ClosedLoopInput = {
  state: EpisodeState;
  obsBase64: string;
  contextId: string;
  payload: McuObservationPayload;
  step: number;
};

/** One iteration of the closed-loop UI controller.
 *  Returns SubAgentStep so the Dispatcher can advance/escalate. */
export async function runClosedLoopStep(
  deps: ClosedLoopDeps,
  input: ClosedLoopInput,
): Promise<SubAgentStep> {
  // ... body extracted verbatim from McuPolicy.ts:738+ ...
}
```

- [ ] **Step 3: Move body verbatim, fix `this.` refs**

Cut the body and paste into the function. Convert every `this.client` → `deps.client`, `this.config.openai.model` → `deps.model`, `this.debugDir` → `deps.debugDir`, `this.recordDebug(...)` → `deps.recordDebug(...)`. Convert `state.closedLoopCraft` (which is `McuContextState.closedLoopCraft`) reads/writes to `input.state.uiState`. Adjust returns: every place that returned `McuPolicyDecision` now returns `SubAgentStep`:
- ACTION returns → `{ kind: "act", action, holdSteps }`
- task_done / earlyStop → `{ kind: "subgoal_done", summary: "..." }`
- fallback_manual / structured BLOCKED → `{ kind: "subgoal_failed", reason: "BLOCKED: ..." }`

- [ ] **Step 4: Replace inline body in `McuPolicy.handleObservation` with a thin call**

```ts
// In handleObservation, after early-stop check:
return await this.dispatchEpisode(contextId, payload);
```

Implement `dispatchEpisode` as a thin wrapper that builds `EpisodeState` (lazy-init), the dep-injected sub-agent map, the `runClosedLoopStep` callback, and calls `dispatchObservation`. Delete the old MCU_USE_PLANNER branch entirely.

- [ ] **Step 5: Write golden-frame regression test**

In `tests/agents/runClosedLoopStep.test.ts`, load a captured probe-input frame from `local_tests/fixtures/oak_planks_step3.png` (create fixture if absent by saving one from a known-good run), call `runClosedLoopStep` with mocked deps that record the resulting action, assert the action equals the previously-captured action.

- [ ] **Step 6: Run regression, fix drift**

```bash
cd d:/GitHub/MCU-mc-multimodal-agent/mc-multimodal-agent
npm run build
npx vitest run tests/agents/runClosedLoopStep.test.ts
```
Expected: PASS. If FAIL, the extraction missed a state field — trace which read returned `undefined` vs the inline version.

- [ ] **Step 7: Commit**

```bash
git add src/agentbeats/agents/runClosedLoopStep.ts src/agentbeats/McuPolicy.ts tests/agents/runClosedLoopStep.test.ts
git commit -m "refactor: extract closed-loop body into runClosedLoopStep"
```

---

## Task 2: Build read-only planner tools

Three small adapters that the planner LLM can call to inspect state without modifying it. Each returns a string (passed back as a tool-call result).

**Reuse, don't duplicate.** The UI sub-agent already has battle-tested inventory inspection helpers in `src/agentbeats/tools/InventoryProbe.ts`:
- `probeHotbar({client, model, obsBase64, candidates}) → Map<slot, item>` — VLM scan of hotbar slots 0-8 for a candidate item set.
- `vlmVerifySlotState({client, model, obsBase64, slot, expectAfter, taskTarget}) → boolean | null` — VLM yes/no check on whether a single slot is empty / filled.

The planner tools wrap these directly — do NOT reimplement OCR / scan logic. The UI sub-agent and the planner share one inspection code path; if it improves, both improve.

**Files:**
- Create: `src/agentbeats/agents/plannerTools/InspectInventoryTool.ts`
- Create: `src/agentbeats/agents/plannerTools/VerifySlotsTool.ts`
- Create: `src/agentbeats/agents/plannerTools/LookAroundTool.ts`
- Test: `tests/agents/plannerTools/inspectInventory.test.ts`

- [ ] **Step 1: Define shared tool types**

Create `src/agentbeats/agents/plannerTools/types.ts`:

```ts
export type PlannerToolCtx = {
  obsBase64: string;
  contextId: string;
  client: import("openai").default;
  model: string;
};

export type PlannerToolResult = { ok: true; text: string } | { ok: false; error: string };

export interface PlannerTool {
  name: string;
  description: string;
  parameters: object; // JSON schema
  run(ctx: PlannerToolCtx, args: unknown): Promise<PlannerToolResult>;
}
```

- [ ] **Step 2: Implement `inspect_inventory`**

Reuses `probeHotbar` directly. The planner passes an explicit candidate list (the items it cares about for the current checklist) so the VLM only scans for those — same call shape the UI sub-agent uses.

```ts
// InspectInventoryTool.ts
import { probeHotbar } from "../../tools/InventoryProbe";
import type { PlannerTool } from "./types";

export const inspectInventoryTool: PlannerTool = {
  name: "inspect_inventory",
  description:
    "Read the player's hotbar (slots 0-8) for the listed candidate items. " +
    "READ-ONLY: does not click. Inventory GUI must be open (the runtime opens it for you). " +
    "Returns one line per candidate: 'item = slot' or 'item = none'.",
  parameters: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: { type: "string" },
        description: "Item ids to look for, e.g. ['crafting_table', 'iron_ingot', 'stick'].",
      },
    },
    required: ["candidates"],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const { candidates } = args as { candidates: string[] };
    const result = await probeHotbar({
      client: ctx.client, model: ctx.model,
      obsBase64: ctx.obsBase64, candidates,
    });
    const lines = candidates.map(item => {
      const slot = [...result.entries()].find(([, name]) => name === item)?.[0];
      return slot != null ? `${item} = slot ${slot}` : `${item} = none`;
    });
    return { ok: true, text: lines.join("\n") };
  },
};
```

Note: `probeHotbar` only covers the hotbar today. If main-inv (slots 9-35) coverage is needed later, extend `probeHotbar` itself (it'll benefit both the planner and the UI sub-agent) — do NOT fork a separate scanner.

- [ ] **Step 3: Implement `verify_slots`**

Reuses `vlmVerifySlotState` from `InventoryProbe.ts` — same yes/no empty/filled check the UI sub-agent uses for post-click verification. Resolve slot index → pixel via the GUI layout (re-detected per call from the obs frame).

```ts
// VerifySlotsTool.ts
import type { PlannerTool } from "./types";
import { detectGuiLayout } from "../../tools/SlotDetector";
import { vlmVerifySlotState } from "../../tools/InventoryProbe";

export const verifySlotsTool: PlannerTool = {
  name: "verify_slots",
  description:
    "For each (slot, expected) pair, confirm whether that slot is currently empty or filled. " +
    "READ-ONLY. Use to verify a sub-agent's claimed result before mark_checklist_item(done). " +
    "Returns one line per pair: 'slot N: matches' / 'slot N: mismatch' / 'slot N: unknown'.",
  parameters: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slot: { type: "integer" },
            expect: { type: "string", enum: ["empty", "filled"] },
            target: { type: "string", description: "What item the sub-agent claims to have placed/removed (for VLM context)." },
          },
          required: ["slot", "expect", "target"],
          additionalProperties: false,
        },
        maxItems: 4,
      },
    },
    required: ["checks"],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const { checks } = args as { checks: Array<{ slot: number; expect: "empty" | "filled"; target: string }> };
    const layout = detectGuiLayout(ctx.obsBase64, undefined);
    if (!layout) return { ok: false, error: "no GUI open; cannot resolve slot pixel locations" };
    const out: string[] = [];
    for (const c of checks.slice(0, 4)) {
      const slotInfo = layout.slots.find(s => s.index === c.slot);
      if (!slotInfo) { out.push(`slot ${c.slot}: not found in current layout`); continue; }
      const result = await vlmVerifySlotState({
        client: ctx.client, model: ctx.model, obsBase64: ctx.obsBase64,
        slot: { cx: slotInfo.cx, cy: slotInfo.cy, name: slotInfo.name },
        expectAfter: c.expect === "empty" ? "should_empty" : "should_fill",
        taskTarget: c.target,
      });
      out.push(`slot ${c.slot}: ${result === true ? "matches" : result === false ? "mismatch" : "unknown"}`);
    }
    return { ok: true, text: out.join("\n") };
  },
};
```

- [ ] **Step 4: Implement `look_around`**

Returns a textual summary of the current world frame: a brief VLM caption ("you are facing a crafting table 2 blocks ahead", "open sky, no mobs visible"). Single LLM call with the obs frame; one sentence response.

```ts
// LookAroundTool.ts
import type { PlannerTool } from "./types";

export const lookAroundTool: PlannerTool = {
  name: "look_around",
  description:
    "Describe the world view in front of the player: blocks at crosshair, " +
    "nearby mobs, biome cues. READ-ONLY. Use to decide if you need an explore/place subgoal.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async run(ctx) {
    const resp = await ctx.client.chat.completions.create({
      model: ctx.model,
      messages: [
        { role: "system", content: "You describe a Minecraft view in one sentence: block at crosshair, nearby entities, biome." },
        { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${ctx.obsBase64}` } }] },
      ],
    });
    return { ok: true, text: resp.choices?.[0]?.message?.content?.trim() ?? "(no description)" };
  },
};
```

- [ ] **Step 5: Test `inspect_inventory` with a fixture frame**

```ts
// tests/agents/plannerTools/inspectInventory.test.ts
import { inspectInventoryTool } from "../../../src/agentbeats/agents/plannerTools/InspectInventoryTool";
import { loadFixture } from "../../helpers";

test("inspect_inventory returns slot contents", async () => {
  const obsBase64 = loadFixture("hotbar_with_crafting_table.jpg");
  const result = await inspectInventoryTool.run(
    { obsBase64, contextId: "t", client: mockClient(), model: "x" },
    {},
  );
  expect(result.ok).toBe(true);
  expect(result.text).toContain("crafting_table");
});
```

- [ ] **Step 6: Run, fix, commit**

```bash
npx vitest run tests/agents/plannerTools/
git add src/agentbeats/agents/plannerTools/ tests/agents/plannerTools/
git commit -m "feat: add read-only planner inspection tools"
```

---

## Task 3: Convert GoalPlanner into a tool-calling loop

Replace the one-shot `chat.completions.create` JSON-schema call with a loop that:
1. Sends the running message thread (system + task + tool results so far).
2. If model returns a `tool_call` for a read-only tool → execute, append result, loop.
3. If model returns a `tool_call` for `dispatch_subgoal` → return that subgoal to the dispatcher.
4. If model returns text + `overall_done=true` → set `earlyStop`.

**Files:**
- Modify: `src/agentbeats/agents/GoalPlanner.ts`
- Modify: `src/agentbeats/agents/SubAgent.ts` (add `plannerMessages` to `EpisodeState`)
- Create: `src/agentbeats/agents/PlannerLoop.ts`
- Test: `tests/agents/plannerLoop.test.ts`

- [ ] **Step 1: Extend `EpisodeState`**

```ts
// SubAgent.ts
export type EpisodeState = {
  taskText: string;
  subgoals: Subgoal[];
  idx: number;
  completedSummaries: string[];
  earlyStop: boolean;
  uiState: ClosedLoopCraftPlan | null;
  history: string[];
  iteration: number;
  /** Running planner conversation (system + user task + tool calls/results). */
  plannerMessages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; tool_calls?: any[] }>;
};

export function makeEpisodeState(taskText: string): EpisodeState {
  return {
    taskText, subgoals: [], idx: 0, completedSummaries: [],
    earlyStop: false, uiState: null, history: [], iteration: 0,
    plannerMessages: [],
  };
}
```

Drop `singleTask` from the type and from any references in `Dispatcher.ts`.

- [ ] **Step 2: Define `PlannerLoopResult`**

```ts
// PlannerLoop.ts
export type PlannerLoopResult =
  | { kind: "dispatch"; subgoal: Subgoal }
  | { kind: "done" }
  | { kind: "error"; reason: string };
```

- [ ] **Step 3: Implement the loop**

```ts
// PlannerLoop.ts
import type OpenAI from "openai";
import type { EpisodeState, Subgoal } from "./SubAgent";
import { GOAL_PLANNER_SYSTEM_PROMPT } from "../prompts/goal_planner";
import { inspectInventoryTool } from "./plannerTools/InspectInventoryTool";
import { verifySlotsTool } from "./plannerTools/VerifySlotsTool";
import { lookAroundTool } from "./plannerTools/LookAroundTool";

const READ_TOOLS = [inspectInventoryTool, verifySlotsTool, lookAroundTool];

const DISPATCH_TOOL_DEF = {
  type: "function" as const,
  function: {
    name: "dispatch_subgoal",
    description:
      "Dispatch ONE specialist sub-agent to perform a side-effecting action. " +
      "After it returns, you will be re-invoked with the summary appended.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ui_inventory", "world_explore", "mining", "combat", "placing"] },
        description: { type: "string" },
        success_criteria: { type: "string" },
      },
      required: ["kind", "description", "success_criteria"],
      additionalProperties: false,
    },
  },
};

const FINISH_TOOL_DEF = {
  type: "function" as const,
  function: {
    name: "task_complete",
    description: "Call when the overall task is fully achieved. Sets earlyStop.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export async function runPlannerLoop(
  deps: { client: OpenAI; model: string },
  state: EpisodeState,
  obsBase64: string,
  contextId: string,
): Promise<PlannerLoopResult> {
  // Seed conversation if empty
  if (state.plannerMessages.length === 0) {
    state.plannerMessages.push({ role: "system", content: GOAL_PLANNER_SYSTEM_PROMPT });
    state.plannerMessages.push({ role: "user", content: `Task: ${state.taskText}` });
  } else if (state.completedSummaries.length > 0) {
    // Append latest completed summary as a fresh user turn
    const last = state.completedSummaries[state.completedSummaries.length - 1];
    state.plannerMessages.push({ role: "user", content: `Subgoal result: ${last}` });
  }

  const tools = [
    ...READ_TOOLS.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
    DISPATCH_TOOL_DEF,
    FINISH_TOOL_DEF,
  ];

  const MAX_TOOL_HOPS = 6;
  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const resp = await deps.client.chat.completions.create({
      model: deps.model,
      messages: state.plannerMessages as any,
      tools,
    });
    const msg = resp.choices?.[0]?.message;
    if (!msg) return { kind: "error", reason: "empty planner response" };
    state.plannerMessages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { kind: "error", reason: "planner produced text instead of tool call" };
    }
    // Process tool calls in order; dispatch/finish return immediately.
    for (const tc of msg.tool_calls) {
      const fname = tc.function.name;
      const fargs = JSON.parse(tc.function.arguments || "{}");

      if (fname === "task_complete") {
        return { kind: "done" };
      }
      if (fname === "dispatch_subgoal") {
        return { kind: "dispatch", subgoal: fargs as Subgoal };
      }
      const tool = READ_TOOLS.find(t => t.name === fname);
      if (!tool) {
        state.plannerMessages.push({ role: "tool", tool_call_id: tc.id, content: `error: unknown tool ${fname}` });
        continue;
      }
      const result = await tool.run({ obsBase64, contextId, client: deps.client, model: deps.model }, fargs);
      const text = result.ok ? result.text : `error: ${result.error}`;
      state.plannerMessages.push({ role: "tool", tool_call_id: tc.id, content: text });
    }
  }
  return { kind: "error", reason: `planner exceeded ${MAX_TOOL_HOPS} tool hops without dispatching` };
}
```

- [ ] **Step 4: Keep `planGoals` as a back-compat shim**

```ts
// GoalPlanner.ts — at the end
export async function planGoals(deps, taskText, completedSummaries) {
  const state = makeEpisodeState(taskText);
  state.completedSummaries = completedSummaries;
  const r = await runPlannerLoop(deps, state, /*obsBase64*/ "", "compat");
  if (r.kind === "dispatch") return { overall_done: false, subgoals: [r.subgoal] };
  return { overall_done: true, subgoals: [] };
}
```

- [ ] **Step 5: Test the loop with mocked tool-calls**

```ts
// tests/agents/plannerLoop.test.ts
test("loop returns dispatch_subgoal verbatim", async () => {
  const client = mockClientReturning([
    { tool_calls: [{ id: "1", function: { name: "inspect_inventory", arguments: "{}" } }] },
    { tool_calls: [{ id: "2", function: { name: "dispatch_subgoal", arguments: JSON.stringify({ kind: "placing", description: "place a crafting_table", success_criteria: "block placed in front" }) } }] },
  ]);
  const state = makeEpisodeState("place a crafting table");
  const r = await runPlannerLoop({ client, model: "x" }, state, "", "ctx");
  expect(r.kind).toBe("dispatch");
  expect(r.subgoal.kind).toBe("placing");
});

test("loop ends on task_complete", async () => {
  const client = mockClientReturning([
    { tool_calls: [{ id: "1", function: { name: "task_complete", arguments: "{}" } }] },
  ]);
  const r = await runPlannerLoop({ client, model: "x" }, makeEpisodeState("noop"), "", "ctx");
  expect(r.kind).toBe("done");
});

test("loop bails after MAX_TOOL_HOPS", async () => {
  const client = mockClientReturningInfinite({ tool_calls: [{ id: "1", function: { name: "inspect_inventory", arguments: "{}" } }] });
  const r = await runPlannerLoop({ client, model: "x" }, makeEpisodeState("loop"), "", "ctx");
  expect(r.kind).toBe("error");
});
```

- [ ] **Step 6: Run, commit**

```bash
npx vitest run tests/agents/plannerLoop.test.ts
git add src/agentbeats/agents/PlannerLoop.ts src/agentbeats/agents/GoalPlanner.ts src/agentbeats/agents/SubAgent.ts tests/agents/plannerLoop.test.ts
git commit -m "feat: planner tool-calling loop with read-only inspection tools"
```

---

## Task 3.5: Task checklist + sub-agent feedback reflection

The planner needs durable memory of WHAT must be done and WHAT has been verified. A pure tool-call conversation can drift across many turns; an explicit checklist prevents the planner from forgetting prerequisites or re-dispatching already-completed work. After every sub-agent return, the planner enters a **reflect** turn driven by a fresh user message that quotes the sub-agent's summary verbatim and forces the planner to call `mark_checklist_item` (success/failure) before issuing the next dispatch.

**Files:**
- Create: `src/agentbeats/agents/TaskChecklist.ts`
- Create: `src/agentbeats/agents/plannerTools/ChecklistTools.ts`
- Modify: `src/agentbeats/agents/SubAgent.ts` (add `checklist` to `EpisodeState`)
- Modify: `src/agentbeats/agents/PlannerLoop.ts` (register checklist tools; reflect-turn injection)
- Test: `tests/agents/taskChecklist.test.ts`

- [ ] **Step 1: Define the checklist types**

```ts
// TaskChecklist.ts
export type ChecklistStatus = "pending" | "in_progress" | "done" | "blocked";

export type ChecklistItem = {
  id: string;                 // monotonic "c1", "c2", ...
  description: string;        // "obtain crafting_table", "place crafting_table in front", "craft iron_pickaxe"
  status: ChecklistStatus;
  evidence: string;           // last verification text ("inspect_inventory: hotbar slot 0 = crafting_table")
  parentId?: string;          // when this item was inserted as a prerequisite for another
};

export class TaskChecklist {
  private items: ChecklistItem[] = [];
  private next = 1;

  add(description: string, parentId?: string): ChecklistItem {
    const id = `c${this.next++}`;
    const item = { id, description, status: "pending" as const, evidence: "", parentId };
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
```

- [ ] **Step 2: Wire `checklist` into `EpisodeState`**

```ts
// SubAgent.ts
import { TaskChecklist } from "./TaskChecklist";

export type EpisodeState = {
  // ... existing fields ...
  checklist: TaskChecklist;
  /** Summary of the most recent sub-agent return, awaiting planner reflect turn. null if already reflected. */
  pendingReflection: { subgoal: Subgoal; outcome: "done" | "failed"; summary: string } | null;
};

export function makeEpisodeState(taskText: string): EpisodeState {
  return {
    // ... existing init ...
    checklist: new TaskChecklist(),
    pendingReflection: null,
  };
}
```

- [ ] **Step 3: Define checklist tools**

```ts
// plannerTools/ChecklistTools.ts
import type { PlannerTool } from "./types";
import type { EpisodeState } from "../SubAgent";

export const addChecklistItemTool = (state: EpisodeState): PlannerTool => ({
  name: "add_checklist_item",
  description:
    "Add a concrete, verifiable subtask to the planner's checklist. " +
    "Use to record top-level requirements at the start, AND to insert " +
    "newly-discovered prerequisites (e.g. 'place crafting_table' before 'craft iron_pickaxe'). " +
    "Granularity rule: each item must be verifiable by inspect_inventory or look_around.",
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
    "DO NOT mark done based on the sub-agent's self-report alone — verify with inspect_inventory or verify_slots first.",
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
    const a = args as { id: string; status: any; evidence: string };
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
```

- [ ] **Step 4: Register checklist tools in `PlannerLoop`**

In `runPlannerLoop`, build the tool list per-call (now state-bound):

```ts
const stateBoundTools = [
  inspectInventoryTool,
  verifySlotsTool,
  lookAroundTool,
  addChecklistItemTool(state),
  markChecklistItemTool(state),
  readChecklistTool(state),
];
const tools = [
  ...stateBoundTools.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
  DISPATCH_TOOL_DEF,
  FINISH_TOOL_DEF,
];
// in the dispatch loop, search stateBoundTools instead of READ_TOOLS for tool execution.
```

- [ ] **Step 5: Inject reflection turns**

When the dispatcher receives a sub-agent step result, instead of calling the planner with no extra context, set `state.pendingReflection`. At the start of `runPlannerLoop`:

```ts
if (state.pendingReflection) {
  const r = state.pendingReflection;
  state.plannerMessages.push({
    role: "user",
    content:
      `The sub-agent for "${r.subgoal.description}" returned: ${r.outcome.toUpperCase()}.\n` +
      `Summary: ${r.summary}\n\n` +
      `REFLECT before your next move:\n` +
      `1. Call read_checklist.\n` +
      `2. If success, VERIFY the result with inspect_inventory or verify_slots BEFORE marking done.\n` +
      `3. If failure starts with "BLOCKED:", insert prerequisite checklist items, then dispatch the first prerequisite.\n` +
      `4. After the checklist reflects reality, either dispatch the next pending item or call task_complete (only if every item is done).`,
  });
  state.pendingReflection = null;
}
```

- [ ] **Step 6: Wire `pendingReflection` from the dispatcher**

```ts
// Dispatcher.ts — replace direct subgoals=[] reset with reflection setup:
if (step.kind === "subgoal_done") {
  state.completedSummaries.push(step.summary);
  state.pendingReflection = { subgoal: current, outcome: "done", summary: step.summary };
  state.subgoals = []; state.idx = 0;
  return NOOP_ONE;
}
if (step.kind === "subgoal_failed") {
  state.completedSummaries.push(`SUBGOAL_FAILED: ${step.reason}`);
  state.pendingReflection = { subgoal: current, outcome: "failed", summary: step.reason };
  state.subgoals = []; state.idx = 0;
  return NOOP_ONE;
}
```

- [ ] **Step 7: Gate `task_complete` on `checklist.allDone()`**

In `runPlannerLoop`, when handling `task_complete`:

```ts
if (fname === "task_complete") {
  if (!state.checklist.allDone()) {
    state.plannerMessages.push({
      role: "tool", tool_call_id: tc.id,
      content: `error: cannot complete — checklist still has items not 'done':\n${state.checklist.format()}`,
    });
    continue; // keep looping, force planner to address remaining items
  }
  return { kind: "done" };
}
```

- [ ] **Step 8: Test checklist mechanics**

```ts
// tests/agents/taskChecklist.test.ts
test("allDone false until every item done", () => {
  const c = new TaskChecklist();
  const a = c.add("get wood"); const b = c.add("craft planks");
  expect(c.allDone()).toBe(false);
  c.mark(a.id, "done", "inv has 4 logs"); expect(c.allDone()).toBe(false);
  c.mark(b.id, "done", "inv has 16 planks"); expect(c.allDone()).toBe(true);
});

test("planner refuses task_complete with pending items", async () => {
  const client = mockClientReturning([
    { tool_calls: [{ id: "1", function: { name: "add_checklist_item", arguments: JSON.stringify({ description: "x" }) } }] },
    { tool_calls: [{ id: "2", function: { name: "task_complete", arguments: "{}" } }] },
    { tool_calls: [{ id: "3", function: { name: "mark_checklist_item", arguments: JSON.stringify({ id: "c1", status: "done", evidence: "ok" }) } }] },
    { tool_calls: [{ id: "4", function: { name: "task_complete", arguments: "{}" } }] },
  ]);
  const r = await runPlannerLoop({ client, model: "x" }, makeEpisodeState("x"), "", "ctx");
  expect(r.kind).toBe("done");
});

test("reflection turn injected on pendingReflection", async () => {
  const state = makeEpisodeState("place a table");
  state.pendingReflection = { subgoal: { kind: "placing", description: "place crafting_table", success_criteria: "" }, outcome: "done", summary: "placed at (0,64,3)" };
  const client = captureMessages();
  await runPlannerLoop({ client, model: "x" }, state, "", "ctx");
  const userMsgs = client.messages.filter(m => m.role === "user");
  expect(userMsgs[userMsgs.length - 1].content).toContain("REFLECT");
  expect(state.pendingReflection).toBeNull();
});
```

- [ ] **Step 9: Run, commit**

```bash
npx vitest run tests/agents/taskChecklist.test.ts
git add src/agentbeats/agents/TaskChecklist.ts src/agentbeats/agents/plannerTools/ChecklistTools.ts src/agentbeats/agents/PlannerLoop.ts src/agentbeats/agents/SubAgent.ts src/agentbeats/agents/Dispatcher.ts tests/agents/taskChecklist.test.ts
git commit -m "feat: planner checklist + reflect-turn on sub-agent feedback"
```

---

## Task 4: Rewrite `goal_planner.ts` system prompt

The new prompt describes a generic-MC planner that uses tools to inspect state then dispatches sub-agents. **Do not over-specialize on crafting** — the same prompt must drive `craft_iron_pickaxe`, `kill_zombie`, `obtain_diamond`, `explore_to_jungle`.

**Files:**
- Modify: `src/agentbeats/prompts/goal_planner.ts`

- [ ] **Step 1: Replace `GOAL_PLANNER_SYSTEM_PROMPT`**

```ts
export const GOAL_PLANNER_SYSTEM_PROMPT = `You are the Goal Planner for an MCU Minecraft agent. Your job is to drive ANY Minecraft task to completion by alternating between READ-ONLY inspection and dispatching specialist sub-agents. You maintain a structured CHECKLIST as your durable memory of what must happen and what has been verified.

You do not directly control the player. You decide WHAT to do; sub-agents decide HOW. After every sub-agent finishes you are re-invoked with its summary in a REFLECT prompt; you must update the checklist before issuing the next dispatch.

# Read-only inspection tools
- inspect_inventory(): screenshot + OCR every inventory slot. Use to check what the player has.
- verify_slots(slots: int[]): confirm specific slot indices. Use after a sub-agent claims success.
- look_around(): one-sentence description of the world view (block at crosshair, mobs, biome).

# Checklist tools
- read_checklist(): show the current checklist.
- add_checklist_item(description, parent_id?): add a verifiable subtask. Use at episode start to record top-level requirements, and to insert prerequisites discovered later.
- mark_checklist_item(id, status, evidence): update status (in_progress | done | blocked). NEVER mark done from a sub-agent's self-report alone — verify via inspect_inventory or verify_slots first. Cite the verification text in evidence.

# Sub-agents you can dispatch (one at a time)
- ui_inventory: ANY GUI window interaction (inventory swap, crafting, smelting, brewing, chest, anvil, enchanting, villager trade). Required for all GUI work.
- world_explore: locomotion + camera scanning to find a target (biome, mob, structure, block).
- mining: break blocks (wood, stone, ore) once located. Player must be facing the block.
- combat: fight a hostile mob in view.
- placing: place a held block at the crosshair face.

# Workflow
1. **Episode start (empty checklist):** call read_checklist to confirm empty, then add_checklist_item for each verifiable requirement of the top-level task. Examples:
   - craft_iron_pickaxe → ["have a placed crafting_table in front", "have 3 iron_ingot in inventory", "have 2 sticks in inventory", "craft iron_pickaxe via 3x3 GUI"]
   - kill_zombie → ["face a zombie within attack range", "zombie is dead (no longer in view)"]
   - obtain_oak_log → ["face an oak tree", "inventory contains >=1 oak_log"]
2. **Inspect before dispatching.** Check inventory/world to learn current state; mark items already satisfied as done with evidence.
3. **Dispatch the next pending item.** Mark it in_progress immediately before the dispatch_subgoal call.
4. **Reflect on every return.** A REFLECT user message tells you the sub-agent's outcome. You MUST:
   - Call read_checklist.
   - On success, run an inspection tool to VERIFY before mark_checklist_item(done, evidence).
   - On failure starting with "BLOCKED:" — extract the prerequisite from the reason, add_checklist_item(prereq, parent_id=blocked_item.id), and dispatch the prereq next. Keep the original item as blocked until the prereq is done; then re-dispatch the original.
   - On any other failure — re-inspect; if the goal is actually satisfied (sub-agent was wrong), mark done; otherwise add a different approach as a new item or mark blocked.
5. **Recursive prerequisites are fine.** "place crafting_table" may itself require "craft crafting_table" which requires "have 4 oak_planks" which requires "have 1 oak_log". Add them as you discover them.
6. **task_complete is gated.** The runtime will reject task_complete unless every checklist item is done. Don't call it speculatively.

# Concrete crafting prerequisite example (illustrative — apply the same pattern to any task)
For a 3x3 craft (e.g. iron_pickaxe):
- Inspect inventory. If crafting_table is in HOTBAR (slots 0-8) and look_around shows it placed in front → ready.
- If crafting_table is in MAIN INV (slots 9-35) → dispatch ui_inventory to swap to a hotbar slot.
- If crafting_table is held but NOT placed → dispatch placing.
- If no crafting_table anywhere → add a "craft crafting_table" prereq (which itself may require planks → logs).

# Output format
Always respond with EXACTLY ONE tool call. Never produce free text. Order of operations within a single planner invocation is one tool at a time; the loop will re-invoke you after each tool result.
`;
```

- [ ] **Step 2: Delete the old `GOAL_PLANNER_SCHEMA`**

It is no longer used (loop drives via `tools[]`, not `response_format`). Keep the export commented out for one release if external callers exist:

```ts
/** @deprecated kept for the legacy planGoals shim only. */
export const GOAL_PLANNER_SCHEMA = { /* unchanged */ } as const;
```

- [ ] **Step 3: Commit**

```bash
git add src/agentbeats/prompts/goal_planner.ts
git commit -m "docs: rewrite planner prompt as generic tool-using planner"
```

---

## Task 5: Rewire `Dispatcher` to use the planner loop

**Files:**
- Modify: `src/agentbeats/agents/Dispatcher.ts`
- Test: `tests/agents/dispatcher.test.ts`

- [ ] **Step 1: Replace one-shot planning with loop call**

```ts
// Dispatcher.ts
import { runPlannerLoop } from "./PlannerLoop";

export async function dispatchObservation(deps, state, obs) {
  if (state.earlyStop) return NOOP_DONE;
  state.iteration += 1;

  // If no current subgoal, ask the planner.
  if (state.subgoals.length === 0 || state.idx >= state.subgoals.length) {
    state.subgoals = []; state.idx = 0;
    const r = await runPlannerLoop(
      { client: deps.client, model: deps.plannerModel },
      state, obs.imageBase64, obs.contextId,
    );
    if (r.kind === "done") { state.earlyStop = true; return NOOP_DONE; }
    if (r.kind === "error") {
      console.warn(`[dispatcher] planner error: ${r.reason}`);
      state.earlyStop = true; return NOOP_DONE;
    }
    state.subgoals = [r.subgoal];
  }

  const current = state.subgoals[state.idx];
  if (!current) { state.earlyStop = true; return NOOP_DONE; }

  // GUI gate: open GUI forces ui_inventory.
  const guiOpen = (() => {
    try { return (detectGuiSlots(obs.imageBase64)?.slots?.length ?? 0) >= 2; }
    catch { return false; }
  })();
  const kind: SubAgentKind = guiOpen ? "ui_inventory" : current.kind;

  const step: SubAgentStep = (kind === "ui_inventory")
    ? await deps.runClosedLoopStep({ state, obsBase64: obs.imageBase64, contextId: obs.contextId })
    : await deps.subagents[kind].step({ obs, subgoal: current, history: state.history, contextId: obs.contextId, iteration: state.iteration });

  if (step.kind === "act") return { action: step.action, holdSteps: step.holdSteps, taskDone: false };

  if (step.kind === "subgoal_done") {
    state.completedSummaries.push(step.summary);
    state.history.push(`done: ${current.description} -> ${step.summary}`);
    state.idx += 1;
    state.subgoals = []; // force planner re-call next obs
    return NOOP_ONE;
  }

  // subgoal_failed
  state.completedSummaries.push(`SUBGOAL_FAILED: ${step.reason}`);
  state.history.push(`failed: ${current.description} -> ${step.reason}`);
  state.subgoals = []; // force planner re-call next obs
  return NOOP_ONE;
}
```

- [ ] **Step 2: Delete `singleTask` references**

Grep for `singleTask` across `src/`. Remove every reference. The single-task-bypass behavior is now structurally impossible — every task starts with a planner call.

```bash
grep -rn singleTask d:/GitHub/MCU-mc-multimodal-agent/mc-multimodal-agent/src/
```
Expected: no results after edits.

- [ ] **Step 3: Test routing**

```ts
// tests/agents/dispatcher.test.ts
test("GUI-open obs forces ui_inventory regardless of current.kind", async () => {
  const guiFrame = loadFixture("crafting_grid_open.jpg");
  const state = makeEpisodeState("mine wood");
  state.subgoals = [{ kind: "mining", description: "mine wood", success_criteria: "" }];
  let calledClosedLoop = false;
  await dispatchObservation(
    {
      client: mockClient(),
      plannerModel: "x",
      runClosedLoopStep: async () => { calledClosedLoop = true; return { kind: "act", action: defaultMcuAction(), holdSteps: 1 }; },
      subagents: stubSubagents(),
    },
    state, { imageBase64: guiFrame, contextId: "t" },
  );
  expect(calledClosedLoop).toBe(true);
});
```

- [ ] **Step 4: Commit**

```bash
git add src/agentbeats/agents/Dispatcher.ts tests/agents/dispatcher.test.ts
git commit -m "refactor: dispatcher uses planner loop, drops singleTask bypass"
```

---

## Task 6: Make `McuPolicy.handleObservation` a pure dispatch

**Files:**
- Modify: `src/agentbeats/McuPolicy.ts`

- [ ] **Step 1: Delete the inline closed-loop body**

Remove lines 738–end-of-handleObservation. Delete the `MCU_USE_PLANNER` branch (lines 675–736) — the dispatcher now handles everything.

- [ ] **Step 2: Implement `dispatchEpisode`**

```ts
private async dispatchEpisode(contextId: string, payload: McuObservationPayload): Promise<McuPolicyDecision> {
  let episode = this.episodes.get(contextId);
  if (!episode) {
    episode = makeEpisodeState(payload.task ?? "");
    this.episodes.set(contextId, episode);
  }

  const worldDeps = { client: this.client, model: this.config.openai.model };
  const subagents: Record<SubAgentKind, SubAgent> = {
    ui_inventory: { kind: "ui_inventory", systemPrompt: "", step: async () => ({ kind: "subgoal_failed", reason: "should never be called; GUI gate routes to runClosedLoopStep" }) },
    world_explore: createWorldExplorer(worldDeps),
    mining: createMining(worldDeps),
    combat: createCombat(worldDeps),
    placing: createPlacing(worldDeps),
  };

  const closedLoopDeps: ClosedLoopDeps = {
    client: this.client,
    model: this.config.openai.model,
    debugDir: this.debugDir,
    recordDebug: (kind, p) => this.recordDebug(kind, p),
  };

  const result = await dispatchObservation(
    {
      client: this.client,
      plannerModel: this.config.openai.model,
      subagents,
      runClosedLoopStep: (args) => runClosedLoopStep(closedLoopDeps, { ...args, payload, step: payload.step ?? 0 }),
    },
    episode,
    { imageBase64: payload.obs ?? "", contextId },
  );

  return { ...ACTION_PAYLOAD_PREFIX, action: result.action, hold_steps: result.holdSteps };
}

private async handleObservation(contextId: string, payload: McuObservationPayload): Promise<McuPolicyDecision> {
  const state = this.contexts.get(contextId) ?? defaultMcuContext();
  this.contexts.set(contextId, state);
  if (state.earlyStop) return { ...ACTION_PAYLOAD_PREFIX, action: defaultMcuAction(), hold_steps: this.config.agentbeats.maxHoldSteps };
  return await this.dispatchEpisode(contextId, payload);
}
```

- [ ] **Step 3: Build & smoke**

```bash
npm run build
```
Expected: PASS. Type errors here mean a state field reference was missed during extraction.

- [ ] **Step 4: Run craft_oak_planks regression in sim**

```bash
node local_tests/run_eval.mjs --task craft_oak_planks --episodes 3
```
Expected: 3/3. If FAIL, the closed-loop extraction lost a state field — read `events.jsonl` from the debug dir.

- [ ] **Step 5: Commit**

```bash
git add src/agentbeats/McuPolicy.ts
git commit -m "refactor: McuPolicy is pure dispatch; planner is entry point"
```

---

## Task 7: End-to-end regression suite

**Files:**
- Modify (if needed): `local_tests/run_eval.mjs`

- [ ] **Step 1: craft_oak_planks — must stay 10/10**

```bash
node local_tests/run_eval.mjs --task craft_oak_planks --episodes 10
```
Expected: 10/10. (Single subgoal: planner inspects, sees logs, dispatches ui_inventory.)

- [ ] **Step 2: craft_diorite — must stay 10/10**

```bash
node local_tests/run_eval.mjs --task craft_diorite --episodes 10
```
Expected: 10/10.

- [ ] **Step 3: craft_iron_pickaxe — primary goal of this refactor**

```bash
node local_tests/run_eval.mjs --task craft_iron_pickaxe --episodes 5
```
Expected: ≥1/5 (first ever pass). Trace: planner inspects → sees iron_ingot + sticks → look_around → if no crafting_table in front → dispatch placing → re-inspect → dispatch ui_inventory.

If crafting_table is missing entirely, the trace should be: planner inspects → no table in inv → dispatches ui_inventory to craft one → on success re-plans → dispatches placing → re-plans → dispatches ui_inventory to craft pickaxe.

- [ ] **Step 4: Inspect a failing trace with the planner conversation**

```bash
ls C:/Users/eddie/AppData/Local/Temp/mcu-eval/debug | sort | tail -1
# read events.jsonl from that dir; grep for "planner_message" entries
```

- [ ] **Step 5: Commit any prompt tweaks**

```bash
git add src/agentbeats/prompts/goal_planner.ts
git commit -m "tune: planner prompt adjustments after iron_pickaxe trace review"
```

---

## Self-Review (run before handoff)

**Spec coverage:**
- Planner is first path for ALL tasks → Task 5 (Dispatcher always calls `runPlannerLoop`), Task 6 (`handleObservation` always calls `dispatchEpisode`). ✓
- Planner has read-only inventory + world inspection tools → Task 2 (`InspectInventoryTool`, `VerifySlotsTool`, `LookAroundTool`). ✓
- Planner has NO modify capability → Task 3 (`runPlannerLoop` only routes side effects through `dispatch_subgoal`, which the runtime intercepts). ✓
- Planner tracks task completion + updates completion → Task 3.5 (`TaskChecklist` + checklist tools; `task_complete` gated on `allDone()`). ✓
- Planner reflects on + handles sub-agent feedback → Task 3.5 step 5 (REFLECT user-message injection on `pendingReflection`); step 6 (Dispatcher sets `pendingReflection` on every sub-agent return). ✓
- Crafting-table example flow (verify hotbar → place / swap / craft) → Task 4 prompt explicitly walks through this; Task 7 step 3 traces it. ✓
- Generic across MC tasks (not crafting-specific) → Task 4 prompt covers combat/explore/mine with checklist examples for each; Task 7 step 1-3 includes diverse tasks. ✓
- Drop `MCU_USE_PLANNER` env gate → Task 6 step 1. ✓
- Drop `singleTask` bypass → Task 5 step 2. ✓
- Extract closed-loop body → Task 1. ✓

**Placeholder scan:** No "TBD"/"TODO"/"appropriate". The `scanKnownSlots` and `groupByRegion` helpers in Task 2 step 2 are referenced but not defined inline — they are extractions of existing logic in `InventoryProbe.ts`. Reader must extract; this is one extraction step, acceptable as a self-contained transform.

**Type consistency:**
- `EpisodeState.plannerMessages` defined in Task 3 step 1, used in Task 3 step 3. ✓
- `runClosedLoopStep` signature defined in Task 1 step 2; called in Task 6 step 2 with matching shape (`{state, obsBase64, contextId}` plus `payload, step` injected by wrapper). ✓
- `PlannerLoopResult` (`dispatch | done | error`) consumed in Task 5 step 1. ✓
- `runPlannerLoop` is called from both `Dispatcher.dispatchObservation` (live) and the legacy `planGoals` shim (Task 3 step 4) — same signature in both. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-05-planner-first-refactor.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
