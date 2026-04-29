import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { AgentConfig } from "../config";
import { McuVisualPolicy } from "./McuPolicy";

export type AgentBeatsServerOptions = {
  host: string;
  port: number;
  cardUrl?: string;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type A2AMessage = {
  kind: "message";
  role: "agent" | "user";
  messageId: string;
  contextId?: string;
  taskId?: string;
  parts: Array<{ kind: "text"; text: string }>;
};

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function textResponse(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
    },
  };
}

async function readJson(req: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTextPart(part: unknown): string | undefined {
  if (!isRecord(part)) {
    return undefined;
  }
  const root = isRecord(part.root) ? part.root : part;
  return firstString(root.text, part.text);
}

function extractA2AText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.map(extractTextPart).filter((text): text is string => Boolean(text)).join("\n").trim();
}

function createAgentMessage(text: string, contextId: string, taskId?: string): A2AMessage {
  return {
    kind: "message",
    role: "agent",
    messageId: randomUUID().replace(/-/g, ""),
    contextId,
    taskId,
    parts: [
      {
        kind: "text",
        text,
      },
    ],
  };
}

function createAgentCard(cardUrl: string): Record<string, unknown> {
  return {
    protocolVersion: "0.3.0",
    name: "mc-multimodal-agent",
    description: "Minecraft AgentBeats purple agent adapter backed by a multimodal OpenAI-compatible policy.",
    url: cardUrl,
    preferredTransport: "JSONRPC",
    version: "0.1.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "mcu_low_level_control",
        name: "MCU Low-Level Control",
        description: "Receives MCU init/obs JSON messages and returns Minecraft environment action JSON.",
        tags: ["minecraft", "agentbeats", "mcu", "vision"],
        examples: ["craft a furnace from cobblestone", "collect wood", "build a small shelter"],
      },
    ],
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function requestBaseUrl(req: IncomingMessage, fallbackHost: string, fallbackPort: number, explicitCardUrl?: string): string {
  if (explicitCardUrl) {
    return explicitCardUrl.replace(/\/$/, "");
  }
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const hostHeader = firstHeaderValue(req.headers.host);
  const host = forwardedHost || hostHeader || `${fallbackHost}:${fallbackPort}`;
  const proto = forwardedProto || "http";
  return `${proto}://${host}`.replace(/\/$/, "");
}

async function handleMessageSend(
  request: JsonRpcRequest,
  policy: McuVisualPolicy,
): Promise<Record<string, unknown>> {
  if (!isRecord(request.params) || !isRecord(request.params.message)) {
    return rpcError(request.id, -32602, "Invalid message/send params.");
  }
  const message = request.params.message;
  const contextId = firstString(message.contextId, message.context_id) ?? randomUUID().replace(/-/g, "");
  const taskId = firstString(message.taskId, message.task_id);
  const inputText = extractA2AText(message);
  const outputText = await policy.handleText(inputText, contextId);
  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: createAgentMessage(outputText, contextId, taskId),
  };
}

async function handleRpc(request: JsonRpcRequest, policy: McuVisualPolicy): Promise<Record<string, unknown>> {
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return rpcError(request.id, -32600, "Invalid JSON-RPC request.");
  }
  if (request.method === "message/send") {
    return handleMessageSend(request, policy);
  }
  if (request.method === "agent/getAuthenticatedExtendedCard") {
    return rpcError(request.id, -32004, "Authenticated extended card is not configured.");
  }
  return rpcError(request.id, -32601, `Method not found: ${request.method}`);
}

async function handleRpcStream(request: JsonRpcRequest, res: ServerResponse, policy: McuVisualPolicy): Promise<void> {
  if (request.jsonrpc !== "2.0" || request.method !== "message/stream") {
    jsonResponse(res, 400, rpcError(request.id, -32600, "Invalid streaming JSON-RPC request."));
    return;
  }
  const response = await handleMessageSend({ ...request, method: "message/send" }, policy);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(response)}\n\n`);
  res.end();
}

export async function startAgentBeatsServer(
  config: AgentConfig,
  options: AgentBeatsServerOptions,
): Promise<http.Server> {
  const policy = new McuVisualPolicy(config);
  const explicitCardUrl = options.cardUrl?.trim() || undefined;

  const server = http.createServer(async (req, res) => {
    try {
      const baseUrl = requestBaseUrl(req, options.host, options.port, explicitCardUrl);
      const url = new URL(req.url ?? "/", baseUrl);
      if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
        jsonResponse(res, 200, createAgentCard(baseUrl));
        return;
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        jsonResponse(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST") {
        textResponse(res, 404, "Not found.");
        return;
      }
      const body = await readJson(req);
      if (Array.isArray(body) || !isRecord(body)) {
        jsonResponse(res, 400, rpcError(null, -32600, "Batch or non-object JSON-RPC requests are not supported."));
        return;
      }
      const request = body as JsonRpcRequest;
      if (request.method === "message/stream") {
        await handleRpcStream(request, res, policy);
        return;
      }
      jsonResponse(res, 200, await handleRpc(request, policy));
    } catch (error) {
      jsonResponse(res, 500, rpcError(null, -32603, error instanceof Error ? error.message : String(error)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });

  const address = server.address() as AddressInfo;
  console.log(`[agentbeats] A2A purple agent listening on http://${address.address}:${address.port}`);
  console.log(
    `[agentbeats] Agent card: ${(explicitCardUrl ?? `http://${options.host}:${options.port}`).replace(
      /\/$/,
      "",
    )}/.well-known/agent-card.json`,
  );
  if (!config.openai.apiKey) {
    console.warn("[agentbeats] OPENAI_API_KEY/API_KEY is not set; using heuristic fallback actions only.");
  }
  return server;
}
