import type { SubAgent } from "../SubAgent";
import { PLACING_SYSTEM_PROMPT } from "../../prompts/subagents/placing";
import { callWorldVlm, type WorldSubAgentDeps } from "./WorldExplorer";

export function createPlacing(deps: WorldSubAgentDeps): SubAgent {
  return {
    kind: "placing",
    systemPrompt: PLACING_SYSTEM_PROMPT,
    step: (input) => callWorldVlm(deps, PLACING_SYSTEM_PROMPT, input, "placing"),
  };
}
