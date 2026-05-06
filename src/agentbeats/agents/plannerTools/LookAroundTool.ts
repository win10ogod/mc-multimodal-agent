import type { PlannerTool } from "./types";

export const lookAroundTool: PlannerTool = {
  name: "look_around",
  description:
    "Describe the world view in front of the player: blocks at crosshair, " +
    "nearby mobs, biome cues. READ-ONLY.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async run(ctx) {
    const dataUrl = ctx.obsBase64.startsWith("data:image/") ? ctx.obsBase64 : `data:image/jpeg;base64,${ctx.obsBase64}`;
    const body: Record<string, unknown> = {
      model: ctx.model,
      temperature: 0,
      max_completion_tokens: 80,
      messages: [
        { role: "system", content: "You describe a Minecraft view in one sentence: block at crosshair, nearby entities, biome." },
        { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl, detail: "low" } }] },
      ],
    };
    type Create = typeof ctx.client.chat.completions.create;
    type CreateParams = Parameters<Create>[0];
    try {
      const resp = await ctx.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & { choices: Array<{ message?: { content?: string | null } }> };
      const text = resp.choices?.[0]?.message?.content?.trim() ?? "(no description)";
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
