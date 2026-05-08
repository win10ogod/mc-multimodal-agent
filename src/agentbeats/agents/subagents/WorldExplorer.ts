import type OpenAI from "openai";
import type {
  SubAgent,
  SubAgentStep,
  SubAgentStepInput,
} from "../SubAgent";
import { MCU_ACTION_SCHEMA } from "../../McuPrompt";
import { parseMcuActionText, normalizeMcuAction } from "../../McuPolicy";
import { WORLD_EXPLORE_SYSTEM_PROMPT } from "../../prompts/subagents/world_explore";
import { getDebugRecorder } from "../../tools/DebugRecorder";
import { drawCrosshair } from "../../tools/CrosshairOverlay";

export type WorldSubAgentDeps = { client: OpenAI; model: string };

export async function callWorldVlm(
  deps: WorldSubAgentDeps,
  systemPrompt: string,
  input: SubAgentStepInput,
  agentLabel: "world_explore" | "placing" | "mining" | "combat" = "world_explore",
): Promise<SubAgentStep> {
  const userText = `Subgoal: ${input.subgoal.description}\nSuccess: ${input.subgoal.success_criteria}\nRecent history: ${input.history.slice(-5).join(" | ")}`;
  // Overlay a high-contrast crosshair (red+yellow +) at frame centre so the
  // VLM can reliably tell "what is Steve aiming at" — the native MC crosshair
  // is invisible after JPEG compression at 640x360. Applied to ALL world-view
  // subagents (placing/mining/combat/world_explore).
  const augmented = (() => {
    try { return drawCrosshair(input.obs.imageBase64); } catch { return null; }
  })();
  const imgUrl = augmented
    ? `data:image/png;base64,${augmented}`
    : `data:image/jpeg;base64,${input.obs.imageBase64}`;
  const userMsg = [
    { type: "text" as const, text: userText },
    { type: "image_url" as const, image_url: { url: imgUrl } },
  ];
  // Save the frame + prompt to events.jsonl so the dashboard surfaces
  // what the world subagent saw at each step (placing/mining/combat
  // were previously dark — only FastUI events made it to the log).
  const dbg = getDebugRecorder();
  if (dbg.isEnabled()) {
    dbg.record(
      {
        type: `${agentLabel}_call` as any,
        iteration: input.iteration,
        data: {
          subgoal: input.subgoal,
          history: input.history.slice(-5),
          systemPrompt: systemPrompt,
          userText,
        },
      },
      input.obs.imageBase64,
      "jpg",
    );
  }
  try {
    const resp = await deps.client.chat.completions.create({
      model: deps.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg as any },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "mcu_action", schema: MCU_ACTION_SCHEMA, strict: true },
      },
    });
    const text = resp.choices?.[0]?.message?.content ?? "";
    const parsed = parseMcuActionText(text);
    if (!parsed) {
      if (dbg.isEnabled()) {
        dbg.record({ type: `${agentLabel}_response` as any, iteration: input.iteration, data: { rawText: text, parsed: null } });
      }
      return { kind: "subgoal_failed", reason: "VLM returned unparseable action" };
    }
    if (dbg.isEnabled()) {
      dbg.record({ type: `${agentLabel}_response` as any, iteration: input.iteration, data: { parsed } });
    }
    if ((parsed as { task_done?: boolean }).task_done === true) {
      return { kind: "subgoal_done", summary: `${input.subgoal.description} confirmed by VLM` };
    }
    return {
      kind: "act",
      action: normalizeMcuAction(parsed.action),
      holdSteps: parsed.hold_steps ?? 3,
    };
  } catch (e) {
    return { kind: "subgoal_failed", reason: `VLM error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function createWorldExplorer(deps: WorldSubAgentDeps): SubAgent {
  return {
    kind: "world_explore",
    systemPrompt: WORLD_EXPLORE_SYSTEM_PROMPT,
    step: (input) => callWorldVlm(deps, WORLD_EXPLORE_SYSTEM_PROMPT, input),
  };
}
