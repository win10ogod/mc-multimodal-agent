import { describe, expect, it } from "vitest";
import { createMinecraftToolRegistry, type MinecraftToolContext } from "../src/tools/MinecraftTools";
import { searchWithAgentBrowser } from "../src/web/AgentBrowserSearch";

describe("agent-browser web search", () => {
  it("extracts ranked search results from agent-browser eval output", async () => {
    const result = await searchWithAgentBrowser(
      {
        query: "mineflayer pathfinder GoalNear",
        maxResults: 2,
        timeoutMs: 1000,
        browserCommand: "agent-browser",
        engine: "duckduckgo",
      },
      async (command, args, options) => {
        expect(command).toBe("agent-browser");
        expect(args).toEqual(["batch", "--bail", "--json"]);
        expect(options.stdin).toContain("duckduckgo.com/html/");
        expect(options.stdin).toContain("mineflayer+pathfinder+GoalNear");
        return {
          stdout: [
            "Opened page",
            "AGENT_BROWSER_SEARCH_RESULTS_START",
            JSON.stringify([
              {
                title: "mineflayer-pathfinder",
                url: "https://github.com/PrismarineJS/mineflayer-pathfinder",
                snippet: "A mineflayer plugin for pathfinding.",
              },
              {
                title: "Goals API",
                url: "https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/lib/goals.js",
                snippet: "GoalNear and other goals.",
              },
            ]),
            "AGENT_BROWSER_SEARCH_RESULTS_END",
          ].join("\n"),
          stderr: "",
        };
      },
    );

    expect(result.query).toBe("mineflayer pathfinder GoalNear");
    expect(result.results).toEqual([
      {
        rank: 1,
        title: "mineflayer-pathfinder",
        url: "https://github.com/PrismarineJS/mineflayer-pathfinder",
        snippet: "A mineflayer plugin for pathfinding.",
      },
      {
        rank: 2,
        title: "Goals API",
        url: "https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/lib/goals.js",
        snippet: "GoalNear and other goals.",
      },
    ]);
  });

  it("extracts results from the real agent-browser JSON batch envelope", async () => {
    const result = await searchWithAgentBrowser(
      {
        query: "minecraft wiki crafting table",
        maxResults: 1,
        timeoutMs: 1000,
        browserCommand: "agent-browser",
      },
      async () => ({
        stdout: JSON.stringify([
          {
            command: [
              "eval",
              'return "AGENT_BROWSER_SEARCH_RESULTS_START\\n" + JSON.stringify(items) + "\\nAGENT_BROWSER_SEARCH_RESULTS_END";',
            ],
            success: true,
            result: {
              origin: "https://duckduckgo.com/html/?q=minecraft+wiki+crafting+table",
              result: [
                "AGENT_BROWSER_SEARCH_RESULTS_START",
                JSON.stringify([
                  {
                    title: "Crafting Table",
                    url: "https://minecraft.wiki/w/Crafting_Table",
                    snippet: "A utility block.",
                  },
                ]),
                "AGENT_BROWSER_SEARCH_RESULTS_END",
              ].join("\n"),
            },
          },
        ]),
        stderr: "",
      }),
    );

    expect(result.results).toEqual([
      {
        rank: 1,
        title: "Crafting Table",
        url: "https://minecraft.wiki/w/Crafting_Table",
        snippet: "A utility block.",
      },
    ]);
  });

  it("exposes web_search as a model tool without requiring a Minecraft connection", async () => {
    const registry = createMinecraftToolRegistry();
    const result = await registry.execute(
      "web_search",
      { query: "minecraft wiki crafting table", maxResults: 1 },
      {
        config: {
          webSearch: {
            browserCommand: "agent-browser",
            engine: "duckduckgo",
            timeoutMs: 1000,
            maxResults: 1,
          },
        },
        webSearch: async (params) => ({
          query: params.query,
          engine: "duckduckgo",
          results: [
            {
              rank: 1,
              title: "Crafting Table",
              url: "https://minecraft.wiki/w/Crafting_Table",
              snippet: "A utility block.",
            },
          ],
        }),
      } as unknown as MinecraftToolContext,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain("found 1 web result");
    expect(result.data).toMatchObject({
      query: "minecraft wiki crafting table",
      results: [{ title: "Crafting Table" }],
    });
  });
});
