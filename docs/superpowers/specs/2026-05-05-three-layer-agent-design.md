# Three-Layer Agent Architecture for MCU Benchmark Wrapper

**Status:** Approved (2026-05-05)
**Scope:** `d:\GitHub\MCU-mc-multimodal-agent\mc-multimodal-agent\src\agentbeats\`

## 1. Motivation

The current single-policy loop scores 0/10 on long-horizon MCU tasks. One LLM call per frame cannot
hold both global goal state ("I am 3 steps into a 6-step recipe") and frame-level perception
("the cursor is currently 12 px above slot 4"). The benchmark leaderboard is judged on long-horizon
tasks (e.g. *kill ender dragon*), so a flat policy is insufficient.

We split the agent into three layers, matching the existing decomposition of context that already
emerged organically: a **Goal Planner** that owns the task plan, **Specialist Sub-Agents** that own
one phase of execution each, and **Tools** (CV / IBVS / probe) that own pixel-level work.

## 2. Goals & Non-Goals

**Goals**
- Long-horizon tasks (multi-subgoal) score above zero.
- Single-task episodes (e.g. `craft_oak_planks`) keep current 10/10 reliability — no regression.
- All inventory / GUI interaction routes through the closed-loop **FastUIInteraction** sub-agent;
  free-form VLM action sampling is forbidden inside any open GUI window.
- Idle / `task_done` early-stop is decided once at the planner layer, not per-frame.

**Non-Goals**
- We are not introducing a learned planner or RL training loop.
- We are not touching the green agent (judge) or the simulator.
- We are not building cross-episode memory.

## 3. Layered Architecture

```
                ┌──────────────────────────────────────────┐
                │  GoalPlanner (LLM call, goal-specific)   │
                │  - sees: taskText, completed summaries   │
                │  - emits: ordered Subgoal[]              │
                │  - never sees raw obs frames             │
                └───────────────┬──────────────────────────┘
                                │ dispatch one Subgoal at a time
                ┌───────────────▼──────────────────────────┐
                │  SubAgent (LLM call, task-oriented)      │
                │  kinds: ui_inventory | world_explore |   │
                │         mining | combat | placing        │
                │  - own scoped system prompt              │
                │  - sees: obs frame, subgoal, history     │
                │  - emits: act(env action) | subgoal_done │
                └───────────────┬──────────────────────────┘
                                │ uses
                ┌───────────────▼──────────────────────────┐
                │  Tools (no LLM)                          │
                │  SlotDetector, InventoryProbe (LLM-tool),│
                │  UiFastControl (IBVS), DebugRecorder     │
                └──────────────────────────────────────────┘
```

### 3.1 GoalPlanner

- Own system prompt at `prompts/goal_planner.ts`.
- Inputs: `taskText`, `completedSummaries[]` (one per finished subgoal).
- Output schema:
  ```ts
  type PlannerOutput = {
    subgoals: Array<{
      kind: SubAgentKind;
      description: string;        // e.g. "Mine 3 oak logs"
      success_criteria: string;   // e.g. "inventory shows >= 3 oak_log"
    }>;
    overall_done: boolean;        // when true => state.earlyStop
  };
  ```
- Called at:
  1. **Episode start** (mandatory, 1 call).
  2. **After every `subgoal_done`** — planner sees the new summary, may shorten / extend / re-order
     remaining subgoals, or set `overall_done`.
- **Single-task bypass:** if first plan returns `subgoals.length === 1`, set `state.singleTask = true`
  and skip subsequent planner calls until either the lone sub-agent reports done (then `earlyStop`)
  or it fails (then one re-plan).

### 3.2 SubAgent contract

```ts
type SubAgentKind = "ui_inventory" | "world_explore" | "mining" | "combat" | "placing";

interface SubAgent {
  kind: SubAgentKind;
  systemPrompt: string;
  step(opts: {
    obs: { imageBase64: string; inventory?: unknown };
    subgoal: { description: string; success_criteria: string };
    history: string[];           // recent self-observations, capped
    layout?: GuiLayout | null;   // only for ui_inventory
    contextId: string;
    iteration: number;
  }): Promise<SubAgentStep>;
}

type SubAgentStep =
  | { kind: "act"; action: McuEnvAction; holdSteps: number }
  | { kind: "subgoal_done"; summary: string }
  | { kind: "subgoal_failed"; reason: string };
```

**Routing rule (hard):** the dispatcher inspects the obs frame with `SlotDetector`. If a GUI window
with ≥ 2 slots is detected, dispatch is forced to `FastUIInteraction` regardless of which subgoal
kind the planner picked. This prevents the world sub-agents from ever clicking inside a GUI by
accident — known to corrupt state.

### 3.3 Sub-agent implementations

| Kind | Backing module | Behavior |
|---|---|---|
| `ui_inventory` | `FastUIInteraction.ts` (wraps existing `UiFastControl` + `InventoryProbe`) | Closed-loop probe → IBVS → click → CV verify. Already proven 10/10 on planks. |
| `world_explore` | `WorldExplorer.ts` | Free-look + locomotion to find a target biome/structure. |
| `mining` | `Mining.ts` | Aim crosshair at a block face, hold attack until break, repeat. |
| `combat` | `Combat.ts` | Center target, strafe, attack on alignment. |
| `placing` | `Placing.ts` | Aim at face, `use` to place. |

The four world sub-agents share the existing `McuPrompt.ts` schema but each gets its own scoped
system prompt with rules trimmed to that phase (e.g. mining sub-agent's prompt does not mention
inventory at all).

### 3.4 Tools

Move existing modules under `tools/`:
- `tools/SlotDetector.ts`
- `tools/InventoryProbe.ts` (this is itself an LLM call, but used as a tool by FastUIInteraction)
- `tools/UiFastControl.ts`
- `tools/DebugRecorder.ts`

These keep their current public surface; only import paths change.

## 4. File / Folder Layout

```
src/agentbeats/
├─ McuPolicy.ts               # thin dispatcher (was the giant policy)
├─ McuPrompt.ts               # MCU action schema (unchanged)
├─ agents/
│  ├─ GoalPlanner.ts
│  ├─ SubAgent.ts             # interface + types
│  ├─ Dispatcher.ts           # routing logic, GUI detection gate
│  └─ subagents/
│     ├─ FastUIInteraction.ts
│     ├─ WorldExplorer.ts
│     ├─ Mining.ts
│     ├─ Combat.ts
│     └─ Placing.ts
├─ prompts/
│  ├─ goal_planner.ts
│  └─ subagents/
│     ├─ ui_inventory.ts
│     ├─ world_explore.ts
│     ├─ mining.ts
│     ├─ combat.ts
│     └─ placing.ts
└─ tools/
   ├─ SlotDetector.ts
   ├─ InventoryProbe.ts
   ├─ UiFastControl.ts
   ├─ DebugRecorder.ts
   ├─ SlotMarker.ts
   └─ InventoryLayouts.ts
```

## 5. Dispatch Flow

```ts
// per-episode state
type EpisodeState = {
  taskText: string;
  subgoals: Subgoal[];
  idx: number;
  completedSummaries: string[];
  singleTask: boolean;
  earlyStop: boolean;
  uiState?: ClosedLoopCraftPlan;        // FastUIInteraction's IBVS state
  history: string[];
};

async function handleObservation(obs, state) {
  if (state.earlyStop) return NOOP_ACTION_WITH_TASK_DONE;

  if (state.subgoals.length === 0) {
    const out = await GoalPlanner.plan(state.taskText, []);
    state.subgoals = out.subgoals;
    state.singleTask = out.subgoals.length === 1;
    if (out.overall_done) { state.earlyStop = true; return NOOP; }
  }

  const current = state.subgoals[state.idx];
  const guiOpen = SlotDetector.detect(obs).slots.length >= 2;
  const kind = guiOpen ? "ui_inventory" : current.kind;
  const subagent = subagents[kind];

  const step = await subagent.step({ obs, subgoal: current, history: state.history, layout: state.uiState?.sessionLayout, ... });

  if (step.kind === "act") return wrap(step.action, step.holdSteps);

  if (step.kind === "subgoal_done") {
    state.completedSummaries.push(step.summary);
    state.idx++;
    if (state.idx >= state.subgoals.length) {
      if (state.singleTask) { state.earlyStop = true; return NOOP; }
      const out = await GoalPlanner.plan(state.taskText, state.completedSummaries);
      if (out.overall_done) { state.earlyStop = true; return NOOP; }
      state.subgoals = out.subgoals;                            // replace queue
      state.idx = 0;
    }
    return NOOP_ONE_FRAME;   // resume next obs with new subgoal
  }

  if (step.kind === "subgoal_failed") {
    // one re-plan attempt
    const out = await GoalPlanner.plan(state.taskText, [...state.completedSummaries, `FAILED: ${step.reason}`]);
    state.subgoals = out.subgoals; state.idx = 0;
    return NOOP_ONE_FRAME;
  }
}
```

## 6. Integration with existing `handleObservation`

Today `McuPolicy.ts` does perception + decision + action in one function. The refactor:

1. Extract the existing closed-loop body (probe → servo → verify) into
   `agents/subagents/FastUIInteraction.ts`. Keep the `ClosedLoopCraftPlan` state on
   `EpisodeState.uiState`. Public `step()` wraps one iteration.
2. Extract the existing free-form VLM call (`MCU_SYSTEM_PROMPT` + `MCU_ACTION_SCHEMA`) into the four
   world sub-agents. Each gets a *trimmed* prompt (only the relevant verbs).
3. `McuPolicy.handleObservation` becomes the dispatcher loop in §5. No business logic remains in it.
4. Existing fields the runtime already reads from policy state (`earlyStop`, `task_done`) keep
   the same names so the outer agent server is untouched.

## 7. Error Handling

| Failure | Layer | Response |
|---|---|---|
| GUI sub-agent IBVS hits `maxIterations` | FastUIInteraction | emit `subgoal_failed` |
| World sub-agent gets stuck (no progress for N obs) | sub-agent | emit `subgoal_failed` (heuristic: same camera bucket + no inventory delta for 30 frames) |
| Planner returns invalid JSON | GoalPlanner | one retry with stricter prompt; on second failure, fall back to single `ui_inventory` subgoal with the raw task text as description |
| Slot detector throws | dispatcher | treat as `guiOpen = false` |

`subgoal_failed` triggers exactly **one** re-plan; a second failure on the same subgoal kind sets
`earlyStop = true` and ends the episode rather than burning tokens on a broken loop.

## 8. Testing Plan

Regression order — each must pass before moving on:

1. `craft_oak_planks` — must keep 10/10 (single-task bypass; FastUIInteraction unchanged).
2. `craft_diorite` — multi-ingredient, exercises generalized probe.
3. A two-stage long-horizon task (gather wood → craft planks) — exercises planner + cross-sub-agent
   handoff. This is the smallest test that distinguishes the new architecture from the old.
4. Long-horizon leaderboard task (e.g. `obtain_iron_pickaxe`).

Per-layer unit tests:
- `GoalPlanner.plan()` with mocked LLM returning canned plans.
- `Dispatcher` routing test: synthetic obs with detected slots → must route to `ui_inventory` even
  when current subgoal kind is `mining`.
- `FastUIInteraction.step()` already covered by existing closed-loop tests.

## 9. Migration Steps (high level — detailed plan in writing-plans output)

1. Create new folders, move existing files into `tools/` (no behavior change).
2. Add `agents/SubAgent.ts` interface + `agents/Dispatcher.ts` skeleton.
3. Extract closed-loop into `FastUIInteraction.ts`; route all current calls through it. Verify
   `craft_oak_planks` still 10/10.
4. Add `GoalPlanner.ts` with single-task bypass active by default. Verify still 10/10.
5. Split free-form VLM into the four world sub-agents.
6. Wire planner re-plan + `earlyStop`. Run long-horizon test.

## 10. Open Questions (deferred, not blocking)

- Should `completedSummaries` be capped (token budget) for very long episodes? — defer until we
  have a long-horizon trace to measure.
- Do we need a `crafting` sub-agent kind separate from `ui_inventory`? — no; FastUIInteraction's
  probe is task-agnostic, the subgoal description carries the recipe.
