import type OpenAI from "openai";
import type { Subtask } from "./types";
import type { CraftAction } from "../../../tools/InventoryProbe";

export type ActionDeps = {
  client: OpenAI;
  model: string;
};

export type ActionInput = {
  subtask: Subtask;
  knownSlots: Array<{ index: number; name?: string; item: string }>;
  obsBase64: string;
};

const SCHEMA = {
  type: "object",
  required: ["action"],
  additionalProperties: true,
  properties: {
    action: { type: "string", enum: ["move", "put", "verify_slots", "done", "fallback_manual"] },
  },
} as const;

const SYS = `You are the Action agent inside a Minecraft GUI control subagent.
You receive ONE concrete subtask + Known slot contents + the current frame, and emit ONE atomic action toward that subtask. 
You do NOT track overall progress, recipes, or completion — those are decided by the Planner.

Subtask kinds you may receive:
- verify_slots { slots }: emit { "action": "verify_slots", "slots": [...], "reason": "..." } to OCR-confirm those slots' contents (cap N <= 4).
- move_one { sourceItem, destSlotIndex }: find sourceItem in Known slot contents (handle naming variants like quartz<->nether_quartz). Emit move { from: <sourceSlotIdx>, to: destSlotIndex, count: "one" }. If sourceItem isn't in Known, emit verify_slots on candidate hotbar slots first.
- move_all { sourceSlotIndex, destSlotIndex }: emit move { from: sourceSlotIndex, to: destSlotIndex, count: "all" }.
- wait_for_output { expectedItem }: ASYNC-OUTPUT GUIs (furnace smelting, brewing stand) need simulator time to tick before the output slot fills. Emit { "action": "wait", "holdSteps": N, "reason": "..." } where N is the noop hold to apply this turn (smelting ~200 ticks/item, brewing ~400; cap N at 60 per call). The next probe re-evaluates and emits verify_slots once expected output should be present.
- click_button { buttonName }: not yet supported — emit fallback_manual.
- verify_state { condition }: emit done.

CRITICAL: choose dest slots that are NOT in Known (occupied) when placing/taking, OR slots whose Known content matches what cursor will hold (will stack). Never overwrite a different item.

Image has YELLOW NUMBERED BADGES at slot corners — read them directly to choose slot indices.

Output strict JSON, one action only:
  { "action": "move", "from": A, "to": B, "count": "one"|"all", "reason": "..." }
  { "action": "verify_slots", "slots": [N1, ...], "reason": "..." }
  { "action": "wait", "holdSteps": N, "reason": "..." }
  { "action": "done", "reason": "..." }
  { "action": "fallback_manual", "reason": "..." }`;

export async function runAction(deps: ActionDeps, input: ActionInput): Promise<CraftAction> {
  const userPayload = {
    subtask: input.subtask,
    known_slots: input.knownSlots,
  };
  const dataUrl = input.obsBase64.startsWith("data:image/")
    ? input.obsBase64
    : `data:image/jpeg;base64,${input.obsBase64}`;
  const body: Record<string, unknown> = {
    model: deps.model,
    temperature: 0,
    max_completion_tokens: 200,
    messages: [
      { role: "system", content: SYS },
      {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify(userPayload) },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "fastui_action_out", schema: SCHEMA, strict: false },
    },
  };
  type Create = typeof deps.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  const resp = await deps.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
    choices: Array<{ message?: { content?: string | null } }>;
  };
  const text = resp.choices[0]?.message?.content ?? "";
  let parsed: any;
  try { parsed = JSON.parse(text); } catch {
    console.warn(`[fastui-action] failed to parse JSON: ${text.slice(0, 200)}`);
    return { action: "fallback_manual", reason: "action LLM returned unparseable JSON" } as CraftAction;
  }
  console.log(`[fastui-action] subtask=${input.subtask.kind} -> ${parsed.action}${parsed.from !== undefined ? ` from=${parsed.from}` : ""}${parsed.to !== undefined ? ` to=${parsed.to}` : ""}`);
  return parsed as CraftAction;
}
