export type PlannerToolCtx = {
  obsBase64: string;
  contextId: string;
  client: import("openai").default;
  model: string;
};
export type PlannerToolResult = { ok: true; text: string } | { ok: false; error: string };
export interface PlannerTool {
  name: string;
  description: string;
  parameters: object; // JSON schema
  run(ctx: PlannerToolCtx, args: unknown): Promise<PlannerToolResult>;
}
