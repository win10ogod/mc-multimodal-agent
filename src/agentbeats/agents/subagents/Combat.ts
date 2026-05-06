import type { SubAgent } from "../SubAgent";
import { COMBAT_SYSTEM_PROMPT } from "../../prompts/subagents/combat";
import { callWorldVlm, type WorldSubAgentDeps } from "./WorldExplorer";

export function createCombat(deps: WorldSubAgentDeps): SubAgent {
  return {
    kind: "combat",
    systemPrompt: COMBAT_SYSTEM_PROMPT,
    step: (input) => callWorldVlm(deps, COMBAT_SYSTEM_PROMPT, input),
  };
}
