import type { SubAgent } from "../SubAgent";
import { MINING_SYSTEM_PROMPT } from "../../prompts/subagents/mining";
import { callWorldVlm, type WorldSubAgentDeps } from "./WorldExplorer";

export function createMining(deps: WorldSubAgentDeps): SubAgent {
  return {
    kind: "mining",
    systemPrompt: MINING_SYSTEM_PROMPT,
    step: (input) => callWorldVlm(deps, MINING_SYSTEM_PROMPT, input),
  };
}
