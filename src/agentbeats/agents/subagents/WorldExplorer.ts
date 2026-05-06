import type OpenAI from "openai";
import type {
  SubAgent,
  SubAgentStep,
  SubAgentStepInput,
} from "../SubAgent";
import { MCU_ACTION_SCHEMA } from "../../McuPrompt";
import { parseMcuActionText, normalizeMcuAction } from "../../McuPolicy";
import { WORLD_EXPLORE_SYSTEM_PROMPT } from "../../prompts/subagents/world_explore";

export type WorldSubAgentDeps = { client: OpenAI; model: string };

export async function callWorldVlm(
  deps: WorldSubAgentDeps,
  systemPrompt: string,
  input: SubAgentStepInput,
): Promise<SubAgentStep> {
  const userMsg = [
    { type: "text" as const, text:
      `Subgoal: ${input.subgoal.description}\nSuccess: ${input.subgoal.success_criteria}\nRecent history: ${input.history.slice(-5).join(" | ")}` },
    { type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${input.obs.imageBase64}` } },
  ];
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
      return { kind: "subgoal_failed", reason: "VLM returned unparseable action" };
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
