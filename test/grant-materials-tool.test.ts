import { describe, expect, it } from "vitest";
import { createMinecraftToolRegistry, type MinecraftToolContext } from "../src/tools/MinecraftTools";

function context(config: Partial<MinecraftToolContext["config"]["minecraft"]> = {}): MinecraftToolContext {
  const sent: string[] = [];
  return {
    config: {
      minecraft: {
        username: "OpenClawMC",
        allowCommandMaterials: false,
        commandMaterialMaxCount: 128,
        commandMaterialAllowedItems: ["oak_log", "oak_planks", "cobblestone"],
        ...config,
      },
    },
    bot: {
      chat: async (message: string) => {
        sent.push(message);
      },
    },
    sent,
  } as unknown as MinecraftToolContext & { sent: string[] };
}

describe("grant_materials tool", () => {
  it("refuses command grants unless explicitly enabled", async () => {
    const registry = createMinecraftToolRegistry();
    const ctx = context();

    const result = await registry.execute(
      "grant_materials",
      { items: [{ name: "oak_log", count: 8 }], reason: "blueprint preflight" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("disabled");
    expect((ctx as unknown as { sent: string[] }).sent).toEqual([]);
  });

  it("grants whitelisted materials with minecraft give commands", async () => {
    const registry = createMinecraftToolRegistry();
    const ctx = context({ allowCommandMaterials: true });

    const result = await registry.execute(
      "grant_materials",
      {
        items: [
          { name: "oak_log", count: 8 },
          { name: "minecraft:oak_planks", count: 65 },
        ],
        reason: "blueprint preflight",
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain("granted 73 command material");
    expect((ctx as unknown as { sent: string[] }).sent).toEqual([
      "/give OpenClawMC minecraft:oak_log 8",
      "/give OpenClawMC minecraft:oak_planks 64",
      "/give OpenClawMC minecraft:oak_planks 1",
    ]);
    expect(result.data).toMatchObject({
      granted: [
        { name: "oak_log", count: 8 },
        { name: "oak_planks", count: 65 },
      ],
    });
  });

  it("rejects non-whitelisted or excessive material grants", async () => {
    const registry = createMinecraftToolRegistry();
    const ctx = context({ allowCommandMaterials: true, commandMaterialMaxCount: 64 });

    const forbidden = await registry.execute(
      "grant_materials",
      { items: [{ name: "diamond_block", count: 1 }], reason: "not a build material" },
      ctx,
    );
    const excessive = await registry.execute(
      "grant_materials",
      { items: [{ name: "oak_log", count: 65 }], reason: "too much" },
      ctx,
    );

    expect(forbidden.ok).toBe(false);
    expect(forbidden.text).toContain("not allowed");
    expect(excessive.ok).toBe(false);
    expect(excessive.text).toContain("exceeds max");
    expect((ctx as unknown as { sent: string[] }).sent).toEqual([]);
  });

  it("allows safe wooden blueprint detail blocks without granting valuables", async () => {
    const registry = createMinecraftToolRegistry();
    const ctx = context({ allowCommandMaterials: true, commandMaterialAllowedItems: [] });

    const granted = await registry.execute(
      "grant_materials",
      { items: [{ name: "oak_stairs", count: 4 }], reason: "wooden blueprint detail" },
      ctx,
    );
    const denied = await registry.execute(
      "grant_materials",
      { items: [{ name: "bedrock", count: 1 }], reason: "unsafe" },
      ctx,
    );

    expect(granted.ok).toBe(true);
    expect((ctx as unknown as { sent: string[] }).sent).toEqual(["/give OpenClawMC minecraft:oak_stairs 4"]);
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("not allowed");
  });
});
