---
name: collect_oak_logs
trigger: "collect wood"
tags: ["auto", "mining", "wood", "survival"]
scope: {"server":"localhost:25565","version":"1.21.1","auth":"offline","moddedTolerant":true,"modded_tolerant":true}
successCriteria: "Inventory contains at least one oak_log."
successes: 0
attempts: 0
---

# collect_oak_logs

## Summary

Approaches a visible oak tree, breaks the trunk logs using screen coordinates, and collects the drops. This skill assumes the agent is close to a tree and can see the logs in the visual frame.

## Trigger

collect wood

## Scope

```json
{
  "server": "localhost:25565",
  "version": "1.21.1",
  "auth": "offline",
  "moddedTolerant": true,
  "modded_tolerant": true
}
```

## Preconditions

- Agent must be within pathfinding range of an oak tree.
- Agent must have clear line of sight to the tree trunk.

## Method

1. observe

   Arguments: `{}`
2. pathfind_screen

   Arguments: `{"x":160,"y":90,"range":2}`
3. look_screen

   Arguments: `{"x":160,"y":55}`
4. dig_screen

   Arguments: `{"x":160,"y":55}`
5. inventory

   Arguments: `{}`
6. dig_screen

   Arguments: `{"x":160,"y":90}`
7. inventory

   Arguments: `{}`

## Success Criteria

Inventory contains at least one oak_log.

## Failure Handling

- No oak_log visible in the initial observation.
- dig_screen fails to break the block (e.g., out of reach or incorrect tool).

## Raw Steps

```json
[
  {
    "description": "Observe surroundings to identify visible blocks and find oak_log.",
    "tool": "observe",
    "arguments": {},
    "verification": "result contains 'oak_log' in visible block names"
  },
  {
    "description": "Move towards the detected oak log using screen coordinates.",
    "tool": "pathfind_screen",
    "arguments": {
      "x": 160,
      "y": 90,
      "range": 2
    },
    "verification": "ok is true"
  },
  {
    "description": "Look at the specific log block to ensure accurate targeting.",
    "tool": "look_screen",
    "arguments": {
      "x": 160,
      "y": 55
    }
  },
  {
    "description": "Break the first oak log.",
    "tool": "dig_screen",
    "arguments": {
      "x": 160,
      "y": 55
    },
    "verification": "result contains 'oak_log'"
  },
  {
    "description": "Collect dropped items.",
    "tool": "inventory",
    "arguments": {}
  },
  {
    "description": "Break a second oak log if available nearby.",
    "tool": "dig_screen",
    "arguments": {
      "x": 160,
      "y": 90
    }
  },
  {
    "description": "Collect dropped items.",
    "tool": "inventory",
    "arguments": {}
  }
]
```
