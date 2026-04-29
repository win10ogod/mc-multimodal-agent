export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Vec3Like = {
  x: number;
  y: number;
  z: number;
};

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; detail?: "low" | "high" | "auto" };

export type ToolResult = {
  ok: boolean;
  text: string;
  data?: JsonValue;
  content?: ToolContent[];
};

export type ToolSpec<TContext = unknown> = {
  name: string;
  description: string;
  parameters: JsonObject;
  execute: (args: JsonObject, context: TContext) => Promise<ToolResult>;
};

export type ToolCallRecord = {
  toolName: string;
  argsHash: string;
  callId?: string;
  resultHash?: string;
  timestamp: number;
};

export type SessionLoopState = {
  toolCallHistory: ToolCallRecord[];
};
