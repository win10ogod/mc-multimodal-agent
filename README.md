# Minecraft Multimodal Agent

Mineflayer + OpenAI Responses API agent for a human-like Minecraft player. It follows the OpenClaw-style pattern used in the local `../openclaw` reference: each turn builds an active prompt from memory, runs a model/tool loop, stores transcript events, records tool outcomes, and compacts long-running context into memory.

## What It Supports

- Multimodal LLM loop with image input and function tools.
- OpenAI Responses API or Chat Completions API, including OpenAI-compatible base URLs.
- Visual-first control: the model receives a first-person raster frame and acts through screen coordinates.
- Mineflayer movement, looking, digging, placing, crafting, inventory, chat, and pathfinding tools.
- Dynamic item/block catalog with arbitrary user-defined fields.
- Persistent goal trees for autonomous long tasks, plus LevelDB-backed layered memory notes, indexed recall, recent transcript context, pre-compaction durable flushes, and skill snapshots.
- `soul.md` persona file, loaded into every turn.
- Learning new skills from scratch through `record_skill`, stored as paired `.json` and `.md` files.
- Scheduled tasks that can run one-shot or on intervals.
- In-game player guidance through chat, and nearby-player imitation traces.
- Blueprint loading and bottom-up block placement from JSON layer drawings.
- Runtime registry sync for arbitrary server versions and modded item/block names.

## Setup

```bash
cd mc-multimodal-agent
npm install
cp .env.example .env
```

Edit `.env`, then run:

```bash
npm run dev -- start --task "Look around, learn the area, then build blueprints/example-hut.json from the current position."
```

For hard visual planning use `OPENAI_MODEL=gpt-5.5`. For cheaper iteration use `gpt-5.4-mini`.

Use Chat Completions or an OpenAI-compatible API:

```bash
OPENAI_API_MODE=chat
OPENAI_BASE_URL=http://localhost:8000/v1
OPENAI_MODEL=your-vision-tool-model
OPENAI_STRUCTURED_OUTPUTS=true
```

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
VISION_CONTEXT_FRAMES=3
VISION_CONTEXT_YAW_DEG=42
```

`VISION_CONTEXT_FRAMES=3` sends center, left, and right images on the first model
turn of each segment. Screen-coordinate tools still target the restored center
view.

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
