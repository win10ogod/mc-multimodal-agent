#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { assertRunnableConfig, loadConfig } from "./config";
import { parseKeyValuePairs } from "./utils/misc";
import { sleep } from "./utils/misc";

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function runBackgroundTask(label: string, action: () => Promise<string>): Promise<string | undefined> {
  try {
    const result = await action();
    console.log(result);
    return result;
  } catch (error) {
    console.error(`${label} failed: ${errorMessage(error)}`);
    return undefined;
  }
}

function stoppedBecauseDisconnected(result: string | undefined): boolean {
  return Boolean(
    result?.includes("Minecraft bot left the game") ||
      result?.includes("Minecraft bot is not in game") ||
      result?.includes("keepAliveError"),
  );
}

async function makeAgent() {
  const { AgentLoop } = await import("./agent/AgentLoop");
  const { MinecraftBot } = await import("./bot/MinecraftBot");
  const { ItemCatalog } = await import("./knowledge/ItemCatalog");
  const { MemoryStore } = await import("./memory/MemoryStore");
  const { GoalStore } = await import("./goals/GoalStore");
  const { TranscriptStore } = await import("./memory/TranscriptStore");
  const { SkillLibrary } = await import("./skills/SkillLibrary");
  const { createMinecraftToolRegistry } = await import("./tools/MinecraftTools");
  const { VisualPerception } = await import("./vision/VisualPerception");
  const { TaskStore } = await import("./tasks/TaskStore");
  const { ImitationObserver } = await import("./learning/ImitationObserver");
  const config = loadConfig();
  assertRunnableConfig(config);
  const catalog = new ItemCatalog(config.paths.itemCatalog, config.minecraft.version);
  await catalog.load();
  const memory = new MemoryStore(config.paths.memory);
  await memory.init();
  const goals = new GoalStore(config.paths.goals);
  await goals.load();
  const skills = new SkillLibrary(config.paths.skills);
  await skills.load();
  const transcript = new TranscriptStore(config.paths.transcript);
  const tasks = new TaskStore(config.paths.tasks);
  await tasks.load();
  const bot = new MinecraftBot(config);
  await bot.connect();
  catalog.syncRuntimeRegistry(bot.runtimeRegistrySnapshot());
  await memory.addNote({
    kind: "environment",
    layer: "semantic",
    source: "system",
    importance: 0.7,
    text: `Startup environment profile: ${JSON.stringify({
      server: `${config.minecraft.host}:${config.minecraft.port}`,
      version: bot.raw.version,
      auth: config.minecraft.auth,
      moddedTolerant: config.minecraft.moddedTolerant,
      recipeSource: bot.recipeCatalog("", 1).source,
      recipePacketsSkipped: bot.recipeCatalog("", 1).skippedByConfig,
      registry: {
        items: bot.runtimeRegistrySnapshot().items.length,
        blocks: bot.runtimeRegistrySnapshot().blocks.length,
      },
    })}`,
    tags: ["environment", "startup", bot.raw.version, config.minecraft.moddedTolerant ? "modded" : "vanilla"],
    scope: {
      server: `${config.minecraft.host}:${config.minecraft.port}`,
      version: bot.raw.version,
    },
  });
  const imitation = config.imitation.enabled
    ? new ImitationObserver(config.paths.imitation, {
        range: config.imitation.range,
        minMoveIntervalMs: config.imitation.minMoveIntervalMs,
      })
    : undefined;
  imitation?.attach(bot.raw);
  const vision = new VisualPerception(bot, config);
  const tools = createMinecraftToolRegistry();
  const loop = new AgentLoop({
    config,
    bot,
    vision,
    tools,
    catalog,
    memory,
    goals,
    skills,
    transcript,
    tasks,
    imitation,
  });
  return { bot, loop, tasks, config, catalog, memory, goals, imitation };
}

type AgentSession = Awaited<ReturnType<typeof makeAgent>>;

async function ensureBotInGame(session: AgentSession, reason: string): Promise<void> {
  if (session.bot.isConnected()) {
    return;
  }
  const { config, bot, catalog, memory, imitation } = session;
  if (!config.minecraft.autoReconnect) {
    throw new Error(`Minecraft bot left the game: ${bot.connectionSummary()}`);
  }
  const attempts = Math.max(1, config.minecraft.reconnectAttempts);
  const delayMs = Math.max(250, config.minecraft.reconnectDelayMs);
  console.error(`Minecraft bot is not in game during ${reason}: ${bot.connectionSummary()}`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      console.error(`Reconnecting Minecraft bot (${attempt}/${attempts})...`);
      await bot.connect();
      catalog.syncRuntimeRegistry(bot.runtimeRegistrySnapshot());
      await memory.addNote({
        kind: "environment",
        layer: "episodic",
        source: "system",
        importance: 0.75,
        text: `Reconnected Minecraft bot as ${bot.raw.username} on ${bot.raw.version}. Connection: ${bot.connectionSummary()}`,
        tags: ["environment", "reconnect", bot.raw.version],
        scope: {
          server: `${config.minecraft.host}:${config.minecraft.port}`,
          version: bot.raw.version,
        },
      });
      imitation?.attach(bot.raw);
      console.log(`Reconnected Minecraft bot as ${bot.raw.username} on ${bot.raw.version}.`);
      return;
    } catch (error) {
      console.error(`Reconnect attempt ${attempt} failed: ${errorMessage(error)}`);
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }
  throw new Error(`Minecraft bot could not reconnect after ${attempts} attempts.`);
}

async function runReconnectableBackgroundTask(
  session: AgentSession,
  label: string,
  action: () => Promise<string>,
): Promise<void> {
  const result = await runBackgroundTask(label, action);
  if (!session.bot.isConnected()) {
    const shouldRetry = !result || stoppedBecauseDisconnected(result);
    await ensureBotInGame(session, label);
    if (shouldRetry) {
      await runBackgroundTask(`${label} retry after reconnect`, action);
    }
  }
}

async function commandStart(args: string[]): Promise<void> {
  const interactive = hasFlag(args, "--interactive");
  const listenChat = hasFlag(args, "--listen-chat");
  const runScheduler = hasFlag(args, "--scheduler");
  const task = takeOption(args, "--task") ?? args.join(" ").trim();
  const session = await makeAgent();
  const { bot, loop, tasks } = session;
  try {
    if (listenChat || runScheduler) {
      console.log("Background mode active. Press Ctrl+C to stop.");
      if (task) {
        await runReconnectableBackgroundTask(session, "initial background task", () => loop.runTask(task));
      }
      while (true) {
        await ensureBotInGame(session, "background loop");
        if (listenChat) {
          const guidance = bot.drainGuidance();
          for (const item of guidance) {
            console.log(`chat guidance from ${item.username}: ${item.message}`);
            await runReconnectableBackgroundTask(session, `chat guidance from ${item.username}`, () =>
              loop.runChatGuidance(item),
            );
          }
        }
        if (runScheduler) {
          for (const due of tasks.due()) {
            console.log(`running scheduled task ${due.id}`);
            await runReconnectableBackgroundTask(session, `scheduled task ${due.id}`, async () => {
              const answer = await loop.runTask(due.prompt);
              if (!stoppedBecauseDisconnected(answer)) {
                await tasks.markRun(due.id);
              }
              return answer;
            });
          }
        }
        await sleep(2000);
      }
    }
    if (interactive) {
      const rl = readline.createInterface({ input, output });
      console.log("Interactive mode. Type a task, or /exit.");
      while (true) {
        const line = (await rl.question("> ")).trim();
        if (!line || line === "/exit") {
          break;
        }
        const answer = await loop.runTask(line);
        console.log(answer);
      }
      rl.close();
      return;
    }
    if (!task) {
      throw new Error("Missing task. Use --task \"...\" or --interactive.");
    }
    const answer = await loop.runTask(task);
    console.log(answer);
  } finally {
    bot.disconnect();
  }
}

async function commandBlueprint(args: string[]): Promise<void> {
  const { listBlueprints } = await import("./blueprint/Blueprint");
  const sub = args.shift() ?? "list";
  const config = loadConfig();
  if (sub !== "list") {
    throw new Error(`Unknown blueprint command: ${sub}`);
  }
  const blueprints = await listBlueprints(config.paths.blueprints);
  for (const blueprint of blueprints) {
    console.log(
      `${blueprint.name}\t${blueprint.placements} blocks\t${blueprint.size.x}x${blueprint.size.y}x${blueprint.size.z}\t${blueprint.filePath}`,
    );
  }
}

async function commandCatalog(args: string[]): Promise<void> {
  const { ItemCatalog } = await import("./knowledge/ItemCatalog");
  const sub = args.shift() ?? "query";
  const config = loadConfig();
  const catalog = new ItemCatalog(config.paths.itemCatalog, config.minecraft.version);
  await catalog.load();
  if (sub === "query") {
    const query = args.join(" ").trim();
    console.log(JSON.stringify(catalog.query(query), null, 2));
    return;
  }
  if (sub === "upsert") {
    const name = args.shift();
    if (!name) {
      throw new Error("catalog upsert requires a name.");
    }
    const record = await catalog.upsert({ name, fields: parseKeyValuePairs(args) });
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  throw new Error(`Unknown catalog command: ${sub}`);
}

async function commandSkills(args: string[]): Promise<void> {
  const { SkillLibrary } = await import("./skills/SkillLibrary");
  const sub = args.shift() ?? "query";
  const config = loadConfig();
  const skills = new SkillLibrary(config.paths.skills);
  await skills.load();
  if (sub === "query") {
    console.log(JSON.stringify(skills.query(args.join(" ")), null, 2));
    return;
  }
  throw new Error(`Unknown skills command: ${sub}`);
}

async function commandTasks(args: string[]): Promise<void> {
  const { TaskStore } = await import("./tasks/TaskStore");
  const sub = args.shift() ?? "list";
  const config = loadConfig();
  const tasks = new TaskStore(config.paths.tasks);
  await tasks.load();
  if (sub === "list") {
    console.log(JSON.stringify(tasks.list(), null, 2));
    return;
  }
  if (sub === "add") {
    const intervalRaw = takeOption(args, "--interval");
    const runAt = takeOption(args, "--at");
    const prompt = takeOption(args, "--prompt") ?? args.join(" ").trim();
    const intervalSeconds = intervalRaw ? Number.parseInt(intervalRaw, 10) : undefined;
    const task = await tasks.add({
      prompt,
      intervalSeconds,
      runAt,
    });
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  if (sub === "remove") {
    const id = args[0];
    if (!id) {
      throw new Error("tasks remove requires an id.");
    }
    console.log(JSON.stringify({ removed: await tasks.remove(id) }, null, 2));
    return;
  }
  throw new Error(`Unknown tasks command: ${sub}`);
}

async function commandPing(): Promise<void> {
  const minecraftProtocolModule = (await import("minecraft-protocol")) as unknown as {
    ping?: unknown;
    default?: unknown;
  };
  const minecraftProtocol = (
    "ping" in minecraftProtocolModule
      ? minecraftProtocolModule
      : minecraftProtocolModule.default
  ) as {
    ping: (
      options: { host: string; port: number },
      callback: (error: Error | null, response?: unknown) => void,
    ) => void;
  };
  const config = loadConfig();
  const result = await new Promise<unknown>((resolve, reject) => {
    minecraftProtocol.ping(
      {
        host: config.minecraft.host,
        port: config.minecraft.port,
      },
      (error, response) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      },
    );
  });
  console.log(JSON.stringify(result, null, 2));
}

function printHelp(): void {
  console.log(`Usage:
  mc-agent start --task "Collect wood and build a shelter"
  mc-agent start --interactive
  mc-agent start --listen-chat --scheduler
  mc-agent blueprint list
  mc-agent catalog query oak
	  mc-agent catalog upsert oak_planks visual=tan structural=true
	  mc-agent skills query bridge
	  mc-agent tasks add --interval 3600 --prompt "Check the farm and repair anything broken"
	  mc-agent tasks list
	  mc-agent ping`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "start") {
    await commandStart(args);
    return;
  }
  if (command === "blueprint") {
    await commandBlueprint(args);
    return;
  }
  if (command === "catalog") {
    await commandCatalog(args);
    return;
  }
  if (command === "skills") {
    await commandSkills(args);
    return;
  }
  if (command === "tasks") {
    await commandTasks(args);
    return;
  }
  if (command === "ping") {
    await commandPing();
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
