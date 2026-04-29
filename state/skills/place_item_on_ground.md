---
name: place_item_on_ground
trigger: "Place a held item on the ground at a nearby location."
tags: ["auto", "minecraft", "1.21.1", "placement", "inventory", "vision"]
scope: {"server":"localhost:25565","version":"1.21.1","auth":"offline","moddedTolerant":true,"modded_tolerant":true}
successCriteria: "The item is successfully placed on the ground and is visible in the world."
successes: 0
attempts: 0
---

# place_item_on_ground

## Summary

Equip an item and place it on the ground using screen-coordinate targeting. Includes basic navigation to find a suitable placement surface if initial attempts fail.

## Trigger

Place a held item on the ground at a nearby location.

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

- Agent must hold the target item.
- Agent must have a clear view of a placeable surface (grass, dirt, etc.) within reach.
- No obstruction between agent and placement surface.

## Method

1. equip_item

   Arguments: `{"name":"{{item_name}}"}`
2. observe

   Arguments: `{}`
3. place_screen

   Arguments: `{"x":160,"y":100}`

## Success Criteria

The item is successfully placed on the ground and is visible in the world.

## Failure Handling

- No suitable ground detected within visual range.
- Obstruction prevents placement.
- Item is not equipable.

## Raw Steps

```json
[
  {
    "tool": "equip_item",
    "arguments": {
      "name": "{{item_name}}"
    },
    "verification": {
      "check": "held_item_is",
      "value": "{{item_name}}"
    }
  },
  {
    "tool": "observe",
    "arguments": {},
    "verification": {
      "check": "can_place_on_screen",
      "region": "center_bottom",
      "block_type": "solid_ground"
    }
  },
  {
    "tool": "place_screen",
    "arguments": {
      "x": 160,
      "y": 100
    },
    "on_failure": [
      {
        "tool": "move",
        "arguments": {
          "direction": "forward",
          "durationMs": 1000
        }
      },
      {
        "tool": "turn",
        "arguments": {
          "yawDeltaDeg": 90,
          "pitchDeltaDeg": 0
        }
      },
      {
        "tool": "observe",
        "arguments": {}
      },
      {
        "tool": "place_screen",
        "arguments": {
          "x": 160,
          "y": 100
        }
      }
    ]
  }
]
```
