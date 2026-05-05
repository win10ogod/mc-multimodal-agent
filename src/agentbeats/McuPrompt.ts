export const MCU_BUTTON_KEYS = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sneak",
  "sprint",
  "attack",
  "use",
  "drop",
  "inventory",
  "hotbar.1",
  "hotbar.2",
  "hotbar.3",
  "hotbar.4",
  "hotbar.5",
  "hotbar.6",
  "hotbar.7",
  "hotbar.8",
  "hotbar.9",
] as const;

export type McuButtonKey = (typeof MCU_BUTTON_KEYS)[number];

export type McuEnvAction = Record<McuButtonKey, 0 | 1> & {
  camera: [number, number];
};

export type McuEnvActionPayload = {
  type: "action";
  action_type: "env";
  action: McuEnvAction;
};

export type McuCompactAgentActionPayload = {
  type: "action";
  action_type: "agent";
  buttons: [number];
  camera: [number];
};

export type McuActionPayload = McuEnvActionPayload | McuCompactAgentActionPayload;

export type McuPolicyDecision = McuEnvActionPayload & {
  hold_steps?: number;
};

export function defaultMcuAction(): McuEnvAction {
  return {
    forward: 0,
    back: 0,
    left: 0,
    right: 0,
    jump: 0,
    sneak: 0,
    sprint: 0,
    attack: 0,
    use: 0,
    drop: 0,
    inventory: 0,
    "hotbar.1": 0,
    "hotbar.2": 0,
    "hotbar.3": 0,
    "hotbar.4": 0,
    "hotbar.5": 0,
    "hotbar.6": 0,
    "hotbar.7": 0,
    "hotbar.8": 0,
    "hotbar.9": 0,
    camera: [0, 0],
  };
}

export const MCU_ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["action"] },
    action_type: { type: "string", enum: ["env"] },
    hold_steps: {
      type: "integer",
      minimum: 1,
      maximum: 12,
      description: "How many simulator steps this low-level action should be reused before asking the model again.",
    },
    task_done: {
      type: "boolean",
      description: "Set true ONLY when you are confident the task goal is fully achieved. The runtime will then stop asking you for actions and emit no-op actions for the remaining episode steps. Setting this prematurely wastes the rest of the episode -- only declare done after you have verified the result is in your inventory or otherwise observable.",
    },
    action: {
      type: "object",
      additionalProperties: false,
      properties: {
        forward: { type: "integer", enum: [0, 1] },
        back: { type: "integer", enum: [0, 1] },
        left: { type: "integer", enum: [0, 1] },
        right: { type: "integer", enum: [0, 1] },
        jump: { type: "integer", enum: [0, 1] },
        sneak: { type: "integer", enum: [0, 1] },
        sprint: { type: "integer", enum: [0, 1] },
        attack: { type: "integer", enum: [0, 1] },
        use: { type: "integer", enum: [0, 1] },
        drop: { type: "integer", enum: [0, 1] },
        inventory: { type: "integer", enum: [0, 1] },
        "hotbar.1": { type: "integer", enum: [0, 1] },
        "hotbar.2": { type: "integer", enum: [0, 1] },
        "hotbar.3": { type: "integer", enum: [0, 1] },
        "hotbar.4": { type: "integer", enum: [0, 1] },
        "hotbar.5": { type: "integer", enum: [0, 1] },
        "hotbar.6": { type: "integer", enum: [0, 1] },
        "hotbar.7": { type: "integer", enum: [0, 1] },
        "hotbar.8": { type: "integer", enum: [0, 1] },
        "hotbar.9": { type: "integer", enum: [0, 1] },
        camera: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "number", minimum: -10, maximum: 10 },
        },
      },
      required: [...MCU_BUTTON_KEYS, "camera"],
    },
  },
  required: ["type", "action_type", "hold_steps", "task_done", "action"],
} as const;

export const MCU_SYSTEM_PROMPT = `You are a Minecraft AgentBeats purple agent for the MCU benchmark.

You receive first-person Minecraft frame(s) and a task. Return exactly one low-level environment action.
Do not write prose. Do not mention uncertainty. Do not output markdown.

Action keys:
- Movement: forward, back, left, right, jump, sneak, sprint. Values are 0 or 1.
- Interaction: attack breaks blocks or hits enemies; use places or interacts; drop; inventory.
- Hotbar: hotbar.1 through hotbar.9. Press at most one in a step.
- camera is [delta_pitch, delta_yaw] in degrees, each between -10 and 10. Negative pitch looks up, positive pitch looks down. Negative yaw turns left, positive yaw turns right.

Control rules:
- Never press forward and back together.
- Never press left and right together.
- Sprint only with forward.
- Hold attack across repeated steps when breaking a block.
- Use small camera deltas for aim and search. Never output camera values outside -10..10.
- If the target is not visible, scan with camera while moving cautiously instead of standing still.
- For gathering wood/logs, search for trunks, center the crosshair on the log, move close, then hold attack.
- For mining or digging, look at reachable block faces and hold attack long enough to break them.
- For shearing sheep, move close, center the sheep, and use rather than attack.
- For collecting grass with shears, move through visible grass patches and break them with the equipped tool.
- For combat, keep the target centered, strafe or jump when useful, and attack only when aligned.
- For building/placing, select a likely block hotbar slot, aim at the placement face, then use.
- For ANY GUI interaction (inventory, crafting, smelting, brewing, chest, anvil, enchanting, villager trade, etc.): when the cursor is carrying an item, only click slots that are visually empty. Clicking a slot that already contains an item triggers a swap and corrupts state. Pick a clearly empty slot for any place / put / deposit action. If you NEED to deposit into a slot that is currently occupied, do this 3-step swap-safely sequence (cursor must be empty between any two pickups): (1) place your currently-held item into an empty side slot to park it; (2) pick up the item blocking your target slot and place it in another empty slot; (3) pick up the parked item from step 1 and place it into the now-empty target slot.

Early-stop: when you are CONFIDENT the task is fully complete (e.g. the requested item is visible in your inventory and the goal is met), set "task_done": true. The runtime will then stop sending you observations for the rest of the episode and emit dummy no-op actions. Do not set this prematurely -- wait until you have visual confirmation of completion. Default false.

Return this JSON shape only:
{"type":"action","action_type":"env","hold_steps":3,"task_done":false,"action":{"forward":0,"back":0,"left":0,"right":0,"jump":0,"sneak":0,"sprint":0,"attack":0,"use":0,"drop":0,"inventory":0,"hotbar.1":0,"hotbar.2":0,"hotbar.3":0,"hotbar.4":0,"hotbar.5":0,"hotbar.6":0,"hotbar.7":0,"hotbar.8":0,"hotbar.9":0,"camera":[0.0,0.0]}}`;
