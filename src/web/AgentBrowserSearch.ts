import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export type WebSearchEngine = "duckduckgo" | "bing";

export type WebSearchResult = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchResponse = {
  query: string;
  engine: WebSearchEngine;
  results: WebSearchResult[];
};

export type AgentBrowserSearchParams = {
  query: string;
  maxResults?: number;
  timeoutMs?: number;
  browserCommand?: string;
  engine?: WebSearchEngine;
  projectRoot?: string;
};

export type AgentBrowserRunOptions = {
  stdin: string;
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type AgentBrowserCommandResult = {
  stdout: string;
  stderr: string;
};

export type AgentBrowserRunner = (
  command: string,
  args: string[],
  options: AgentBrowserRunOptions,
) => Promise<AgentBrowserCommandResult>;

const RESULT_START = "AGENT_BROWSER_SEARCH_RESULTS_START";
const RESULT_END = "AGENT_BROWSER_SEARCH_RESULTS_END";

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function normalizeEngine(value: WebSearchEngine | undefined): WebSearchEngine {
  return value === "bing" ? "bing" : "duckduckgo";
}

function searchUrl(engine: WebSearchEngine, query: string): string {
  const encoded = new URLSearchParams({ q: query }).toString();
  if (engine === "bing") {
    return `https://www.bing.com/search?${encoded}`;
  }
  return `https://duckduckgo.com/html/?${encoded}`;
}

export function resolveAgentBrowserCommand(projectRoot = process.cwd(), configured?: string): string {
  if (configured?.trim()) {
    return configured.trim();
  }
  const envCommand = process.env.AGENT_BROWSER_COMMAND?.trim();
  if (envCommand) {
    return envCommand;
  }
  const localBin = path.resolve(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agent-browser.cmd" : "agent-browser",
  );
  if (existsSync(localBin)) {
    return localBin;
  }
  return process.platform === "win32" ? "agent-browser.cmd" : "agent-browser";
}

function extractionScript(limit: number): string {
  return `(() => {
    const limit = ${limit};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const decodeUrl = (href) => {
      try {
        const url = new URL(href, location.href);
        const uddg = url.searchParams.get("uddg");
        if (uddg) return decodeURIComponent(uddg);
        const bingTarget = url.searchParams.get("u");
        if (bingTarget) {
          const encoded = bingTarget.startsWith("a1") ? bingTarget.slice(2) : bingTarget;
          try {
            return atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
          } catch {
            return bingTarget;
          }
        }
        return url.href;
      } catch {
        return "";
      }
    };
    const blockedHosts = new Set([
      location.hostname,
      "duckduckgo.com",
      "www.duckduckgo.com",
      "bing.com",
      "www.bing.com",
    ]);
    const items = [];
    const seen = new Set();
    const push = (title, href, snippet) => {
      const url = decodeUrl(href);
      if (!url || seen.has(url)) return;
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) return;
        if (blockedHosts.has(parsed.hostname) && parsed.pathname === "/search") return;
      } catch {
        return;
      }
      const normalizedTitle = clean(title);
      if (!normalizedTitle || normalizedTitle.length < 2) return;
      seen.add(url);
      items.push({ title: normalizedTitle, url, snippet: clean(snippet).slice(0, 500) });
    };
    const resultRoots = [
      ...document.querySelectorAll(".result, .results_links, article, li.b_algo, [data-testid='result']")
    ];
    for (const root of resultRoots) {
      const anchor = root.querySelector("h2 a[href], .result__title a[href], a[data-testid='result-title-a'], a[href]");
      if (!anchor) continue;
      const rootText = clean(root.innerText || root.textContent || "");
      const title = clean(anchor.innerText || anchor.textContent || "");
      const snippet = rootText.replace(title, "").replace(clean(anchor.href), "");
      push(title, anchor.href, snippet);
      if (items.length >= limit) break;
    }
    if (items.length < limit) {
      for (const anchor of document.querySelectorAll("a[href]")) {
        const title = clean(anchor.innerText || anchor.textContent || "");
        const parentText = clean(anchor.closest("article, li, div")?.innerText || anchor.parentElement?.innerText || "");
        push(title, anchor.href, parentText.replace(title, ""));
        if (items.length >= limit) break;
      }
    }
    return "${RESULT_START}\\n" + JSON.stringify(items.slice(0, limit)) + "\\n${RESULT_END}";
  })()`;
}

function collectMarkedStringCandidates(value: unknown, candidates: string[]): void {
  if (typeof value === "string") {
    if (value.includes(RESULT_START) && value.includes(RESULT_END)) {
      candidates.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectMarkedStringCandidates(entry, candidates);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.result !== undefined) {
    collectMarkedStringCandidates(record.result, candidates);
  }
  for (const entry of Object.values(record)) {
    collectMarkedStringCandidates(entry, candidates);
  }
}

function parseMarkedJsonCandidate(candidate: string): unknown | undefined {
  const match = candidate.match(
    new RegExp(`${RESULT_START}\\s*([\\s\\S]*?)\\s*${RESULT_END}`),
  );
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return undefined;
  }
}

function parseMarkedJson(stdout: string): unknown {
  const candidates: string[] = [];
  for (const candidate of candidates) {
    const parsed = parseMarkedJsonCandidate(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    collectMarkedStringCandidates(parsed, candidates);
  } catch {
    candidates.push(stdout);
    candidates.push(stdout.replace(/\\n/g, "\n"));
  }

  for (const candidate of candidates) {
    const parsed = parseMarkedJsonCandidate(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  throw new Error("agent-browser search output did not include parseable marked JSON results.");
}

function normalizeResults(value: unknown, maxResults: number): WebSearchResult[] {
  if (!Array.isArray(value)) {
    throw new Error("agent-browser search output was not a result array.");
  }
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    .map((entry, index) => ({
      rank: index + 1,
      title: String(entry.title ?? "").trim(),
      url: String(entry.url ?? "").trim(),
      snippet: String(entry.snippet ?? "").replace(/\s+/g, " ").trim(),
    }))
    .filter((entry) => entry.title.length > 0 && /^https?:\/\//i.test(entry.url))
    .slice(0, maxResults);
}

export async function runAgentBrowserCommand(
  command: string,
  args: string[],
  options: AgentBrowserRunOptions,
): Promise<AgentBrowserCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`agent-browser timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `agent-browser CLI could not be started: ${error.message}. Install it with npm install agent-browser and run agent-browser install.`,
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `agent-browser exited with code ${code}. ${stderr.trim() || stdout.trim() || "Run agent-browser install to prepare Chrome."}`,
        ),
      );
    });
    child.stdin.end(options.stdin);
  });
}

export async function searchWithAgentBrowser(
  params: AgentBrowserSearchParams,
  runner: AgentBrowserRunner = runAgentBrowserCommand,
): Promise<WebSearchResponse> {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query must be a non-empty string.");
  }
  const maxResults = clampInteger(params.maxResults, 5, 1, 10);
  const timeoutMs = clampInteger(params.timeoutMs, 30_000, 1_000, 120_000);
  const engine = normalizeEngine(params.engine);
  const command = resolveAgentBrowserCommand(params.projectRoot, params.browserCommand);
  const commands = [
    ["open", searchUrl(engine, query)],
    ["wait", "--load", "domcontentloaded"],
    ["eval", extractionScript(maxResults)],
  ];
  const { stdout } = await runner(command, ["batch", "--bail", "--json"], {
    stdin: JSON.stringify(commands),
    timeoutMs,
    cwd: params.projectRoot,
    env: process.env,
  });
  return {
    query,
    engine,
    results: normalizeResults(parseMarkedJson(stdout), maxResults),
  };
}
