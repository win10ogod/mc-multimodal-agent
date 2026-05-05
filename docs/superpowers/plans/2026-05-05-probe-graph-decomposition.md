# Probe Plan-Step Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Decompose the closed-loop into a Planner (owns step list, observes results, decides done) + a single-step Action agent. Planner re-runs after every chain-end to tick checkboxes; Action only ever does ONE step per call, with a tiny prompt and no plan visibility.

**Architecture (two agents; Planner orchestrates):**
```
recipe_lookup
   │ (rule-based seed of initial Subtask[])
   ▼
[PLANNER] LLM observes frame + Known + current Subtask[]:
   │   - applies step_updates (ticks [x] based on what it sees)
   │   - returns { all_done } OR { next_subtask_idx }
   ▼
   ├─ all_done=true → emit subgoal_done
   │
   └─ pick next [ ] subtask
       ▼
   [ACTION] LLM (slim prompt, ONE subtask only):
      in: { subtask, Known, frame }
      out: concrete move/verify_slots/done-for-this-step
       ▼
   runtime executes click chain → verify
       ▼
   loop back to PLANNER on chain-end (no chain pending)
```

**Two LLM agents:**
- **Planner** — sees full step list + frame + Known. Owns checklist. Decides what to do next OR done. Runs once per chain-end.
- **Action** — sees ONE subtask + Known + frame. Returns ONE atomic move (or verify_slots / fallback). Cannot see the rest of the plan, cannot judge completion. Runs once per dispatched subtask.

**Why two:** Action's narrow context kills hallucinated cross-step assumptions; Planner has the bird's-eye view to update the checklist correctly.

**Tech Stack:** TypeScript, OpenAI Chat Completions, existing `SlotMemory` / `lookupRecipe` / `vlmVerifySlotState`.

---

## File Structure

**Created:**
- `src/agentbeats/agents/probeRoles/PlanJudge.ts` — merged plan-builder + completion-judge. Run at recipe_lookup (build) AND post-take (judge + re-plan). In: `recipeInfo + Known + frame + currentPlan?`. Out: `{ subtasks: Subtask[]; all_done: boolean }`.
- `src/agentbeats/agents/probeRoles/SubtaskActioner.ts` — per-subtask LLM. In: ONE subtask + Known + frame. Out: concrete `move` / `verify_slots`.
- `src/agentbeats/agents/probeRoles/types.ts` — shared `Subtask` / `PlanJudgeResult` types.

**Modified:**
- `src/agentbeats/tools/UiFastControl.ts` — extend `ClosedLoopCraftPlan` with `subtasks: Subtask[]`, `subtaskIdx: number`, `judgeAfterChain: boolean`.
- `src/agentbeats/agents/runClosedLoopStep.ts` — replace single `probeNextCraftAction` call with state-machine that picks the right role per phase.
- `src/agentbeats/tools/InventoryProbe.ts` — keep `probeNextCraftAction` as a back-compat shim that calls `SubtaskActioner` under the hood; deprecate placement-plan rendering.

---

## Subtask shape

```ts
export type Subtask =
  | { kind: "verify_ingredients"; candidates: string[] }
  | { kind: "place_step"; ingredient: string; destSlotIndex: number }
  | { kind: "take_result"; targetItem: string }
  | { kind: "swap_to_hotbar"; item: string; toHotbarIndex: number };
```

Resolution rule: the Action agent emits the abstract subtask args (ingredient name, dest cell), and the runtime's `resolveSubtask()` translates `ingredient` → source slot index by looking it up in `slotMemory`. Slot index is NEVER hallucinated by the Action agent.

## Judge contract

Judge fires AFTER:
- Every chain-end where `pc.actionKind === "place_all"` AND source was a `result` slot (i.e. a take from result completed).
- Optionally: every N successful place steps (defensive).

Judge prompt (~150 tokens):
```
Task target: {target}
Subtasks (current state):
- [x] verify ingredients
- [x] place oak_log at slot 2
- [ ] take oak_planks from result
- [ ] confirm oak_planks in regular inv

Known slot contents (post-action):
  slot 8 = oak_planks
  slot 38 = oak_log
  slot 2 = (empty)

Last action: place_all 7→8 OK

Return JSON: { "all_done": bool, "updated_step_list": [{text, done}, ...] }
```

Returns boolean + updated checklist. Runtime overwrites `plan.subtasks` and emits `subgoal_done` if `all_done=true`.

## Action agent prompt slim-down

Action prompt has NO placement plan, NO recipe block (recipe is the Planner's job). Action sees:
- ONE subtask line
- Known slot contents
- Frame
- Action options (move / verify_slots / fallback_manual)

Roughly 30% the size of current probe prompt.

---

## Task 1: Subtask types + ClosedLoopCraftPlan extension

**Files:**
- Create: `src/agentbeats/agents/probeRoles/types.ts`
- Modify: `src/agentbeats/tools/UiFastControl.ts`

- [ ] **Step 1**: Create `probeRoles/types.ts` with `Subtask` union + `JudgeResult` + `ChecklistItem`.
- [ ] **Step 2**: Add `subtasks?: Subtask[]; subtaskIdx: number; judgeAfterChain: boolean; checklist?: ChecklistItem[]` to `ClosedLoopCraftPlan` (`UiFastControl.ts:460+`).
- [ ] **Step 3**: Update `planClosedLoopCraft` (`UiFastControl.ts:652+`) to initialize new fields.
- [ ] **Step 4**: Build, commit `feat(probe-graph): subtask types + plan-state extension`.

---

## Task 2: PlanJudge agent (merged plan-builder + completion-judge)

**Files:**
- Create: `src/agentbeats/agents/probeRoles/PlanJudge.ts`

- [ ] **Step 1**: Function `runPlanJudge(deps, args): Promise<PlanJudgeResult>` where args = `{ recipeInfo, knownSlots, frameBase64, currentPlan?: Subtask[], lastActionSummary?: string }`. Single LLM call with vision.
  - System: "You build and judge a step list for a Minecraft crafting subtask. On first call, propose ordered subtasks. On subsequent calls, observe the result and update which steps are [x]. Return all_done=true once the recipe target is in regular inventory."
  - User: recipe target + ingredient list + grid + Known + (currentPlan if any) + (lastActionSummary if any).
  - Returns: `{ subtasks: Subtask[], all_done: boolean }`.
- [ ] **Step 2**: Wire two trigger points in `runClosedLoopStep`:
  - (a) Just after `recipe_lookup` resolves: call PlanJudge with `currentPlan=undefined` to build initial subtasks. Store on `plan.subtasks`.
  - (b) Matched-verify path: if `pc.actionKind === "place_all"` AND source slot's `role === "result"`, set `plan.judgeAfterChain = true`. After the entire chain drains (no more `pendingChain`), invoke PlanJudge with `currentPlan=plan.subtasks` and `lastActionSummary` = last 1-2 closedLoopHistory lines. Replace `plan.subtasks` with the result.
- [ ] **Step 3**: If `result.all_done`, emit `{ kind: "subgoal_done", summary: "PlanJudge: all subtasks done" }` and clear plan.
- [ ] **Step 4**: Build, commit `feat(probe-graph): PlanJudge owns plan + completion check`.

---

## Task 3: SubtaskActioner LLM (slim Action prompt)

**Files:**
- Create: `src/agentbeats/agents/probeRoles/SubtaskActioner.ts`
- Modify: `src/agentbeats/tools/InventoryProbe.ts`

- [ ] **Step 1**: Implement `actionForSubtask(deps, subtask, knownSlots, frameBase64): Promise<CraftAction>` — slim prompt with ONE subtask + Known + frame.
- [ ] **Step 2**: Modify `runClosedLoopStep` probe-call site: when `plan.subtasks` exists and not all done, call `SubtaskActioner` with the first `[ ]` subtask in `plan.subtasks` instead of legacy `probeNextCraftAction`.
- [ ] **Step 3**: Keep legacy `probeNextCraftAction` as a fallback for tasks without resolved recipe (before recipe_lookup fires).
- [ ] **Step 4**: Build, run craft_oak_planks regression — must close loop in ≤10 probes (was 32).
- [ ] **Step 5**: Commit `feat(probe-graph): slim SubtaskActioner replaces monolithic probe in resolved-recipe path`.

---

## Task 4: Regression sweep

- [ ] **Step 1**: craft_oak_planks 3 episodes — sim_score ≥ 1/10 each, probes ≤ 12.
- [ ] **Step 2**: craft_diorite (multi-ingredient) — sim_score ≥ 1/10 in ≥1/3 episodes.
- [ ] **Step 3**: craft_iron_pickaxe (3x3, requires placed crafting_table) — verify Planner correctly issues BLOCKED escalation when no 3x3 GUI available.

---

## Self-Review

**Spec coverage:**
- 2-role split: PlanJudge (Task 2), Actioner (Task 3). ✓
- Plan + Judge merged in one agent that observes result and updates plan: Task 2 step 1. ✓
- Judge fires only when crafter output taken to inventory: explicit gate on `place_all` from `role==="result"` (Task 2 step 2b). ✓
- No prompt pollution in Action agent: Subtask Actioner prompt has no recipe / placement plan (Task 3 step 1). ✓

**Type consistency:**
- `Subtask` + `PlanJudgeResult` defined Task 1, consumed Tasks 2/3. ✓
- `RecipeInfo` reused from existing `UiFastControl.ts` exports. ✓

**Placeholder scan:** No TBD/TODO. Each step has concrete file:line targets and signature.

---

## Execution

Subagent-driven, one task per dispatch.
