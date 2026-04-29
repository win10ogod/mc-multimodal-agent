import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

export type AgentConfig = {
  projectRoot: string;
  strictVisual: boolean;
  minecraft: {
    host: string;
    port: number;
    username: string;
    auth: "offline" | "microsoft";
    version?: string;
    moddedTolerant: boolean;
    captureRecipes: boolean;
    skipRecipePackets: boolean;
    keepAliveTimeoutMs: number;
    pathfindTimeoutMs: number;
    placementTimeoutMs: number;
    placementRetries: number;
    autoReconnect: boolean;
    reconnectAttempts: number;
    reconnectDelayMs: number;
  };
  openai: {
    apiKey: string;
    baseURL?: string;
    apiMode: "responses" | "chat";
    model: string;
    requestTimeoutMs: number;
    maxRetries: number;
    retryInitialDelayMs: number;
    parallelToolCalls: boolean;
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    structuredOutputs: boolean;
    extraBody?: Record<string, unknown>;
    qwen: {
      enabled: boolean;
      thinkingMode: "default" | "thinking" | "instruct";
      preserveThinking: boolean;
      apiStyle: "chat_template_kwargs" | "dashscope";
      samplingProfile: "none" | "thinking" | "coding" | "instruct";
    };
  };
  chatGuidance: {
    enabled: boolean;
    trigger: string;
  };
  combat: {
    pveEnabled: boolean;
    allowPvp: boolean;
    autoDefense: boolean;
    scanRange: number;
    attackRange: number;
    lowHealth: number;
    criticalHealth: number;
  };
  observability: {
    announcePlansInChat: boolean;
    planChatMaxLines: number;
    logInternalFlow: boolean;
    logToolArgs: boolean;
    logToolResults: boolean;
  };
  imitation: {
    enabled: boolean;
    range: number;
    minMoveIntervalMs: number;
  };
  paths: {
    stateDir: string;
    itemCatalog: string;
    skills: string;
    memory: string;
    transcript: string;
    blueprints: string;
    soul: string;
    tasks: string;
    goals: string;
    imitation: string;
  };
  vision: {
    width: number;
    height: number;
    sampleWidth: number;
    sampleHeight: number;
    maxDistance: number;
    horizontalFovDeg: number;
    contextFrames: number;
    contextYawDeg: number;
    contextSweep: boolean;
  };
  loop: {
    maxToolCalls: number;
    maxToolCallsPerTurn: number;
    maxModelTurns: number;
    taskTimeoutMs: number;
    overallTaskTimeoutMs: number;
    maxSegments: number;
    checkpointEveryToolCalls: number;
    maxToolSequenceSteps: number;
    compactAfterMessages: number;
    autoObserveAfterActions: boolean;
  };
  skillLearning: {
    autoRecord: boolean;
    minToolCalls: number;
  };
  agentbeats: {
    modelEveryNSteps: number;
    defaultHoldSteps: number;
    maxHoldSteps: number;
  };
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw);
}

function envEnum<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim();
  return values.includes(raw as T) ? (raw as T) : fallback;
}

function envJsonObject(name: string): Record<string, unknown> | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function loadConfig(projectRoot = process.cwd()): AgentConfig {
  const root = path.resolve(projectRoot);
  const stateDir = path.resolve(root, process.env.AGENT_STATE_DIR ?? "state");
  const apiKey = process.env.OPENAI_API_KEY?.trim() || process.env.API_KEY?.trim() || "";
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.4";
  const qwenDetected = /\bqwen(?:\/|-|3\.6)/i.test(model);
  const segmentTimeoutMs = envInt("AGENT_TASK_TIMEOUT_MS", 600_000);
  const maxSegments = envInt("AGENT_MAX_TASK_SEGMENTS", 8);

  return {
    projectRoot: root,
    strictVisual: envBool("AGENT_STRICT_VISUAL", true),
    minecraft: {
      host: process.env.MC_HOST ?? "localhost",
      port: envInt("MC_PORT", 25565),
      username: process.env.MC_USERNAME ?? "OpenClawMC",
      auth: process.env.MC_AUTH === "microsoft" ? "microsoft" : "offline",
      version: process.env.MC_VERSION?.trim() || undefined,
      moddedTolerant: envBool("MC_MODDED_TOLERANT", false),
      captureRecipes: envBool("MC_CAPTURE_RECIPES", true),
      skipRecipePackets: envBool("MC_SKIP_RECIPE_PACKETS", envBool("MC_MODDED_TOLERANT", false)),
      keepAliveTimeoutMs: envInt("MC_KEEP_ALIVE_TIMEOUT_MS", 600_000),
      pathfindTimeoutMs: envInt("MC_PATHFIND_TIMEOUT_MS", 15_000),
      placementTimeoutMs: envInt("MC_PLACEMENT_TIMEOUT_MS", 15_000),
      placementRetries: envInt("MC_PLACEMENT_RETRIES", 2),
      autoReconnect: envBool("MC_AUTO_RECONNECT", true),
      reconnectAttempts: envInt("MC_RECONNECT_ATTEMPTS", 8),
      reconnectDelayMs: envInt("MC_RECONNECT_DELAY_MS", 5_000),
    },
    openai: {
      apiKey,
      baseURL:
        process.env.OPENAI_BASE_URL?.trim() ||
        process.env.OPENAI_API_BASE_URL?.trim() ||
        undefined,
      apiMode: process.env.OPENAI_API_MODE === "chat" ? "chat" : "responses",
      model,
      requestTimeoutMs: envInt("OPENAI_REQUEST_TIMEOUT_MS", 120_000),
      maxRetries: envInt("OPENAI_MAX_RETRIES", 5),
      retryInitialDelayMs: envInt("OPENAI_RETRY_INITIAL_DELAY_MS", 1_000),
      parallelToolCalls: envBool("OPENAI_PARALLEL_TOOL_CALLS", true),
      reasoningEffort:
        (process.env.OPENAI_REASONING_EFFORT?.trim() as AgentConfig["openai"]["reasoningEffort"]) ||
        "medium",
      structuredOutputs: envBool("OPENAI_STRUCTURED_OUTPUTS", true),
      extraBody: envJsonObject("OPENAI_EXTRA_BODY_JSON"),
      qwen: {
        enabled: envBool("OPENAI_QWEN_COMPAT", qwenDetected),
        thinkingMode: envEnum("OPENAI_QWEN_THINKING_MODE", ["default", "thinking", "instruct"] as const, "default"),
        preserveThinking: envBool("OPENAI_QWEN_PRESERVE_THINKING", false),
        apiStyle: envEnum(
          "OPENAI_QWEN_API_STYLE",
          ["chat_template_kwargs", "dashscope"] as const,
          "chat_template_kwargs",
        ),
        samplingProfile: envEnum(
          "OPENAI_QWEN_SAMPLING_PROFILE",
          ["none", "thinking", "coding", "instruct"] as const,
          "none",
        ),
      },
    },
    chatGuidance: {
      enabled: envBool("AGENT_CHAT_GUIDANCE", true),
      trigger: process.env.AGENT_CHAT_TRIGGER?.trim() || "!agent",
    },
    combat: {
      pveEnabled: envBool("COMBAT_PVE_ENABLED", true),
      allowPvp: envBool("COMBAT_ALLOW_PVP", false),
      autoDefense: envBool("COMBAT_AUTO_DEFENSE", false),
      scanRange: envFloat("COMBAT_SCAN_RANGE", 16),
      attackRange: envFloat("COMBAT_ATTACK_RANGE", 3.2),
      lowHealth: envFloat("COMBAT_LOW_HEALTH", 12),
      criticalHealth: envFloat("COMBAT_CRITICAL_HEALTH", 6),
    },
    observability: {
      announcePlansInChat: envBool("AGENT_ANNOUNCE_PLANS_IN_CHAT", true),
      planChatMaxLines: envInt("AGENT_PLAN_CHAT_MAX_LINES", 6),
      logInternalFlow: envBool("AGENT_LOG_INTERNAL_FLOW", true),
      logToolArgs: envBool("AGENT_LOG_TOOL_ARGS", true),
      logToolResults: envBool("AGENT_LOG_TOOL_RESULTS", true),
    },
    imitation: {
      enabled: envBool("IMITATION_ENABLED", true),
      range: envFloat("IMITATION_RANGE", 32),
      minMoveIntervalMs: envInt("IMITATION_MIN_MOVE_INTERVAL_MS", 1200),
    },
    paths: {
      stateDir,
      itemCatalog: path.resolve(root, "data/item-catalog.json"),
      skills: path.resolve(stateDir, "skills"),
      memory: path.resolve(stateDir, "memory"),
      transcript: path.resolve(stateDir, "transcripts/main.jsonl"),
      blueprints: path.resolve(root, "blueprints"),
      soul: path.resolve(root, process.env.AGENT_SOUL_FILE ?? "soul.md"),
      tasks: path.resolve(stateDir, "tasks.json"),
      goals: path.resolve(stateDir, "goals.json"),
      imitation: path.resolve(stateDir, "imitation.jsonl"),
    },
    vision: {
      width: envInt("VISION_WIDTH", 320),
      height: envInt("VISION_HEIGHT", 180),
      sampleWidth: envInt("VISION_SAMPLE_WIDTH", 96),
      sampleHeight: envInt("VISION_SAMPLE_HEIGHT", 54),
      maxDistance: envFloat("VISION_MAX_DISTANCE", 32),
      horizontalFovDeg: envFloat("VISION_HORIZONTAL_FOV_DEG", 90),
      contextFrames: envInt("VISION_CONTEXT_FRAMES", 3),
      contextYawDeg: envFloat("VISION_CONTEXT_YAW_DEG", 42),
      contextSweep: envBool("VISION_CONTEXT_SWEEP", true),
    },
    loop: {
      maxToolCalls: envInt("AGENT_MAX_TOOL_CALLS", 96),
      maxToolCallsPerTurn: envInt("AGENT_MAX_TOOL_CALLS_PER_TURN", 8),
      maxModelTurns: envInt("AGENT_MAX_MODEL_TURNS", 32),
      taskTimeoutMs: segmentTimeoutMs,
      overallTaskTimeoutMs: envInt("AGENT_OVERALL_TASK_TIMEOUT_MS", segmentTimeoutMs * maxSegments),
      maxSegments,
      checkpointEveryToolCalls: envInt("AGENT_CHECKPOINT_EVERY_TOOL_CALLS", 24),
      maxToolSequenceSteps: envInt("AGENT_MAX_TOOL_SEQUENCE_STEPS", 16),
      compactAfterMessages: envInt("AGENT_COMPACT_AFTER_MESSAGES", 120),
      autoObserveAfterActions: envBool("AGENT_AUTO_OBSERVE_AFTER_ACTIONS", true),
    },
    skillLearning: {
      autoRecord: envBool("AGENT_AUTO_RECORD_SKILLS", true),
      minToolCalls: envInt("AGENT_AUTO_SKILL_MIN_TOOL_CALLS", 2),
    },
    agentbeats: {
      modelEveryNSteps: envInt("AGENTBEATS_MODEL_EVERY_N_STEPS", 4),
      defaultHoldSteps: envInt("AGENTBEATS_DEFAULT_HOLD_STEPS", 3),
      maxHoldSteps: envInt("AGENTBEATS_MAX_HOLD_STEPS", 12),
    },
  };
}

export function assertRunnableConfig(config: AgentConfig): void {
  if (!config.openai.apiKey) {
    throw new Error("OPENAI_API_KEY or API_KEY is required. Copy .env.example to .env and set it.");
  }
}
