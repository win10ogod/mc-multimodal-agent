# Minecraft Multimodal Agent

Mineflayer + OpenAI Responses API agent for a human-like Minecraft player. It follows the OpenClaw-style pattern used in the local `../openclaw` reference: each turn builds an active prompt from memory, runs a model/tool loop, stores transcript events, records tool outcomes, and compacts long-running context into memory.

## What It Supports

- Multimodal LLM loop with image input and function tools.
- OpenAI Responses API or Chat Completions API, including OpenAI-compatible base URLs.
- Visual-first control: the model receives a first-person raster frame and acts through screen coordinates.
- Mineflayer movement, looking, digging, placing, crafting, inventory, chat, and pathfinding tools.
- Browser-backed `web_search` tool powered by `agent-browser` for external docs and current public references.
- Dynamic item/block catalog with arbitrary user-defined fields.
- Persistent goal trees for autonomous long tasks, plus LevelDB-backed layered memory notes, indexed recall, recent transcript context, pre-compaction durable flushes, and skill snapshots.
- `soul.md` persona file, loaded into every turn.
- Learning new skills from scratch through `record_skill`, stored as paired `.json` and `.md` files.
- Scheduled tasks that can run one-shot or on intervals.
- In-game player guidance through chat, and nearby-player imitation traces.
- Blueprint loading and bottom-up block placement from `.litematic` files.
- Runtime registry sync for arbitrary server versions and modded item/block names.

## Setup

```bash
cd mc-multimodal-agent
npm install
npx agent-browser install
cp .env.example .env
```

Edit `.env`, then run:

```bash
npm run dev -- start --task "Look around, learn the area, then build blueprints/example-hut.litematic from the current position."
```

For hard visual planning use `OPENAI_MODEL=gpt-5.5`. For cheaper iteration use `gpt-5.4-mini`.

Use Chat Completions or an OpenAI-compatible API:

```bash
OPENAI_API_MODE=chat
OPENAI_BASE_URL=http://localhost:8000/v1
OPENAI_MODEL=your-vision-tool-model
OPENAI_STRUCTURED_OUTPUTS=true
OPENAI_REQUEST_TIMEOUT_MS=120000
OPENAI_MAX_RETRIES=5
OPENAI_RETRY_INITIAL_DELAY_MS=1000
OPENAI_PARALLEL_TOOL_CALLS=true
```

Transient model transport failures such as local server restarts, socket resets,
timeouts, `429`, and `5xx` responses are retried with exponential backoff. If
the provider is still unavailable after retries, the current task is stopped
with a checkpoint instead of crashing the background chat loop.

`web_search` uses the local `agent-browser` CLI to drive a real browser, so it
works across the same Windows/macOS/Linux paths supported by that project. Tune
it with `AGENT_BROWSER_COMMAND`, `AGENT_WEB_SEARCH_ENGINE`,
`AGENT_WEB_SEARCH_TIMEOUT_MS`, and `AGENT_WEB_SEARCH_MAX_RESULTS`. The tool does
not fall back to HTTP scraping; if the browser CLI or Chrome is unavailable it
returns an actionable error.

When structured outputs are enabled, each agent turn is constrained to this shape. Use `tool_call` to execute one tool, or `final` for a user-facing answer:

```json
{
  "action": "tool_call",
  "tool_name": "follow_player",
  "arguments_json": "{\"username\":\"ZINWIN10\",\"range\":3}",
  "tool_calls": [],
  "final_text": ""
}
```

For deterministic work that does not need fresh reasoning between steps, the model can send an ordered batch in one model turn:

```json
{
  "action": "tool_calls",
  "tool_name": "",
  "arguments_json": "{}",
  "tool_calls": [
    { "tool_name": "find_nearby_blocks", "arguments_json": "{\"names\":[\"_log\"],\"match\":\"suffix\",\"count\":3}" },
    { "tool_name": "inventory", "arguments_json": "{}" }
  ],
  "final_text": ""
}
```

For common gathering tasks, `harvest_nearby_blocks` is a one-shot action tool:
it searches loaded nearby blocks, walks to targets, digs them, and reports the
expanded internal steps for logs and skill learning. A typical tree action is
`{"names":["_log"],"match":"suffix","count":3}`.

In this mode the provider does not send OpenAI native `tools`; it sends tool specs in the prompt and uses the schema output as the tool-call transport. This avoids compatible API errors from combining structured output grammar with tool-call grammar.

Compatible models may still include a thought block before the structured JSON; the parser strips it:

```text
<|channel>thought
I need to follow the player.
<channel|>
{"action":"tool_call","tool_name":"follow_player","arguments_json":"{\"username\":\"ZINWIN10\",\"range\":3}","tool_calls":[],"final_text":""}
```

Use an official Minecraft account by setting `MC_AUTH=microsoft`. Use `MC_AUTH=offline` for local/offline servers.

For Fabric/Forge/NeoForge modpacks, try:

```env
MC_VERSION=1.21.1
MC_MODDED_TOLERANT=true
```

This skips parsing server recipe payloads that often contain modded item components unsupported by vanilla Mineflayer protocol definitions. Crafting through the built-in recipe book may be degraded, but joining, chat, visual observation, movement, digging, placement, memory, skills, and scheduling can still work.

## Commands

```bash
npm run dev -- start --task "Collect wood and build a small shelter"
npm run dev -- start --interactive
npm run dev -- start --listen-chat --scheduler
npm run dev -- agentbeats --host 0.0.0.0 --port 9019
npm run dev -- blueprint list
npm run dev -- catalog query oak
npm run dev -- catalog upsert oak_planks visual=tan structural=true
npm run dev -- skills query bridge
npm run dev -- tasks add --interval 3600 --prompt "Check crops and repair the farm"
npm run dev -- tasks list
```

When `--listen-chat` is active, players can guide the agent in Minecraft chat:

```text
!agent follow me and watch how I build this wall
```

Nearby player movement and block changes are recorded to `state/imitation.jsonl`; the agent can turn them into draft skills with `imitation_to_skill`.

## Blueprint Format

Blueprints are JSON files with a `palette` and Y-axis `layers`. Each string row is Z, each character is X.

```json
{
  "name": "example-hut",
  "palette": { "P": "oak_planks", "G": "glass", "D": "oak_door" },
  "layers": [
    ["PPP", "P P", "PPP"],
    ["PGP", "D P", "PPP"]
  ]
}
```

Spaces and `.` are empty cells. Placement starts from the selected anchor and proceeds bottom-up.

## Skills

Skills live in `state/skills/`:

- `skill_name.json` stores trigger, tags, method steps, counters, and success criteria.
- `skill_name.md` stores the human-readable method description and frontmatter.

The model can create or update these through `record_skill`, including skills learned from player demonstrations.

## Autonomous Goals

Long and ambiguous tasks are stored under `state/goals.json` as a persistent goal
tree. The loop injects active goals into every model turn, so a task can survive
turn limits, reconnects, compaction, and process restarts.

The agent uses:

- `goal_plan` to split complex work into subgoals before acting.
- `goal_next` and `goal_list` to resume the correct pending or running step.
- `goal_update` to mark steps running, blocked, done, failed, or cancelled.
- `goal_checkpoint` to save progress after partial work.
- `environment_profile` to persist server/version/modpack context after startup or reconnect.

When `AGENT_ANNOUNCE_PLANS_IN_CHAT=true`, `goal_plan` also prints the current
plan into Minecraft chat. `AGENT_PLAN_CHAT_MAX_LINES` controls how many lines it
may send.

Goals should be marked done only after observation, inventory, recipe, or world
state verifies the result. If the agent cannot make progress, it should mark the
step blocked with concrete blockers instead of repeating the same failed action.

## Backend Flow Logs

Set these in `.env` to see the agent's runtime process in the terminal:

```env
AGENT_LOG_INTERNAL_FLOW=true
AGENT_LOG_TOOL_ARGS=true
AGENT_LOG_TOOL_RESULTS=true
```

The log prefix is `[agent-flow]`. It reports task starts, segment starts, model
turns, tool calls, tool results, expanded `execute_steps`/`execute_skill` inner
steps, checkpoints, and stop reasons. It logs parsed actions and results, not
private model reasoning.

Use these to control batching and visual context:

```env
AGENT_MAX_TOOL_CALLS_PER_TURN=8
AGENT_AUTO_OBSERVE_AFTER_ACTIONS=true
VISION_CONTEXT_FRAMES=3
VISION_CONTEXT_YAW_DEG=42
VISION_CONTEXT_SWEEP=true
```

`OPENAI_PARALLEL_TOOL_CALLS=true` allows compatible Chat Completions and
Responses models to return multiple native tool calls in one model turn. The
runtime still executes them in order and feeds each result back to the model.
`AGENT_AUTO_OBSERVE_AFTER_ACTIONS=true` appends post-action status, navigation
state, and a fresh visual frame to movement, digging, placing, combat, crafting,
and skill-execution tool results, so the next model turn does not have to guess
what changed.

`VISION_CONTEXT_FRAMES=3` sends center, left, and right images on the first model
turn of each segment. Screen-coordinate tools still target the restored center
view. `VISION_CONTEXT_SWEEP=true` means the bot physically turns for those side
images; set it to `false` if you want smoother movement and only the current
center image during active tasks.

Pathfinding skips work when the bot is already close enough to the target, and
`MC_PATHFIND_TIMEOUT_MS=15000` prevents unreachable goals from freezing a task.
The pathfinder Movements policy is configurable through `MC_PATHFIND_*`
settings. By default it follows mineflayer-pathfinder's capable movement model,
adds common scaffold blocks, avoids hostile entity hitboxes, and marks hazards
such as cactus, magma, powder snow, campfires, fire, and lava as high-cost
terrain.
Placement tools do not trust mineflayer's fixed 5 second `blockUpdate` wait;
they send the place action, then verify the target block through world state.
Tune this with `MC_PLACEMENT_TIMEOUT_MS=15000` and `MC_PLACEMENT_RETRIES=2`.

For long movement, prefer non-blocking navigation so the agent can keep seeing
and deciding while the bot walks:

- `pathfind_to_block` / `pathfind_screen` with `background=true` starts walking
  and returns immediately.
- `navigation_start` starts walking to an explicit position and returns
  immediately.
- `navigation_status` reports `running`, `arrived`, `skipped`, `timeout`,
  `reset`, or `stopped`, plus distance and movement state.
- `navigation_stop` cancels the current background path or follow goal.

Use blocking pathfinding only when the next tool must act immediately after
arrival, such as digging one exact target or placing against one exact face.

## AgentBeats Leaderboard

The Minecraft AgentBeats leaderboard expects a Purple Agent A2A service, not a
mineflayer bot joining your own server. This project now includes an adapter:

```bash
npm run dev -- agentbeats --host 0.0.0.0 --port 9019
curl http://127.0.0.1:9019/.well-known/agent-card.json
```

The adapter receives MCU `init` and `obs` JSON messages, sends the base64 frame
to your multimodal OpenAI-compatible model, and returns the leaderboard's env
action format: `forward`, `attack`, `use`, `hotbar.*`, and `camera`.

Useful settings:

```env
OPENAI_API_KEY=...
# API_KEY=... is also accepted for AgentBeats scenario/Amber configs.
OPENAI_API_MODE=chat
OPENAI_MODEL=your-vision-model
OPENAI_BASE_URL=
OPENAI_STRUCTURED_OUTPUTS=true
AGENTBEATS_MODEL_EVERY_N_STEPS=4
AGENTBEATS_DEFAULT_HOLD_STEPS=3
AGENTBEATS_MAX_HOLD_STEPS=12
```

`AGENTBEATS_MODEL_EVERY_N_STEPS` lets one model decision drive several simulator
frames, which makes movement less twitchy and reduces repeated API calls. The
adapter no longer produces heuristic actions without a model response: missing
API credentials, missing observation frames, or model failures are reported as
errors so leaderboard behavior stays model-driven.

For submission packaging, use the included `Dockerfile` and edit
`agentbeats/amber-manifest-purple.json5` to point at your published container
image. The AgentBeats registration page only needs the Amber manifest URL; model
API values are provided later by the leaderboard scenario, not on that page.

For the official Minecraft leaderboard path, fork the leaderboard repo, add
GitHub Actions secrets such as `API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, and
`OPENAI_API_KEY` for the green agent, then put the returned purple agent ID into
`agentbeats/scenario.leaderboard.toml`. The scenario's `env = { ... }` block is
what passes those secrets into the container during the official run. For local
checks with the green agent repository, use `agentbeats/scenario.local.toml`.

## Combat

Combat is split into fast local reflex tools and slower LLM strategy. The model
should use `combat_scan` to inspect threats, then `combat_pulse` for short
low-latency PVE/PVP action loops. `combat_pulse` can equip a weapon, attack,
eat food, and retreat without waiting for a model turn between each tick.

```env
COMBAT_PVE_ENABLED=true
COMBAT_ALLOW_PVP=false
COMBAT_AUTO_DEFENSE=false
COMBAT_SCAN_RANGE=16
COMBAT_ATTACK_RANGE=3.2
COMBAT_LOW_HEALTH=12
COMBAT_CRITICAL_HEALTH=6
```

PVP player targeting is disabled unless `COMBAT_ALLOW_PVP=true`. Optional
`COMBAT_AUTO_DEFENSE=true` runs short PVE defense pulses during background idle
loops, but it is still a baseline survival system, not competitive PVP AI.

## Memory

Long-term memory is stored under `state/memory/leveldb/`. On first startup, old
`state/memory/*.jsonl` notes are migrated into LevelDB and indexed by time, day,
kind, layer, tags, and search terms.

The agent uses:

- `memory_note` for durable facts, player preferences, failures, active goals, and learned lessons.
- `memory_query` for fast recall against the LevelDB indexes.
- `memory_get` to read one exact recalled note.
- `memory_promote` to mark repeatedly useful notes as long-term semantic/procedural memory.
- `memory_status` to inspect the backend.

Before transcript compaction, the loop runs a silent durable-memory flush and
stores high-signal context into LevelDB before writing the compacted summary.

## Visual-Only Boundary

Minecraft APIs expose world state internally, but the LLM-facing localization path is visual: it sees an image, selects screen coordinates, and tools map those pixels back to a ray hit. High-level blueprint execution necessarily uses exact placement coordinates after a blueprint has been accepted as an execution plan.
