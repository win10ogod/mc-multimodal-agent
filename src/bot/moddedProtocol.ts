import type { AgentConfig } from "../config";

const RECIPE_SKIP_PACKET = [
  "container",
  [
    {
      name: "raw",
      type: "restBuffer",
    },
  ],
];

const MODDED_TOLERANT_MAJOR_VERSIONS = [
  "1.20",
  "1.20.2",
  "1.20.3",
  "1.20.5",
  "1.21",
  "1.21.3",
  "1.21.4",
  "1.21.5",
  "1.21.6",
  "1.21.8",
  "1.21.9",
];

export function buildModdedTolerantCustomPackets(
  config: AgentConfig,
): Record<string, unknown> | undefined {
  if (!config.minecraft.moddedTolerant || !config.minecraft.skipRecipePackets) {
    return undefined;
  }
  return Object.fromEntries(
    MODDED_TOLERANT_MAJOR_VERSIONS.map((majorVersion) => [
      majorVersion,
      {
        play: {
          toClient: {
            types: {
              packet_declare_recipes: RECIPE_SKIP_PACKET,
            },
          },
        },
      },
    ]),
  );
}
