// Stub purple: hardcoded jump-place sequence.
//
// Goal: rule out everything except the actual macro action sequence.
// Skips planner / dispatcher / Placing / HotbarVerifier entirely. On every
// obs, returns the next compact MCU action from a fixed queue. Used to
// confirm "if MC receives equip → tilt → jump → wait → use, does a
// crafting_table block actually appear in the world?"
//
// Assumes the eval gives crafting_table on hotbar.2 (verified by prior
// runs' OCR). Run after green is already up on the docker network and
// the active task config is craft_furnace.
//
// Compact action encoding mirrors McuPolicy.toCompactMcuAgentActionPayload:
//   buttons = product over BUTTON_GROUPS of selected-index per group
//   camera  = cameraX * 11 + cameraY  (each axis: 11 bins, neutral=5,
//             ±10 deg max, 2 deg per bin)
//
// Group order (matches McuPolicy):
//   HOTBAR_GROUP (10)  forward/back (3)  left/right (3)  sprint/sneak (3)
//   use (2)  drop (2)  attack (2)  jump (2)  camera (2)

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.STUB_PORT || "9009", 10);

// Pre-computed compact action constants. See header comment for derivation.
//
// Camera convention: camera array in McuEnvAction is [delta_pitch, delta_yaw].
// cameraIndex = pitchBin * 11 + yawBin, where each bin is 2 deg with neutral at
// bin 5. So pitch=+10 (look down), yaw=0 → pitchBin=10, yawBin=5 → 10*11+5=115.
// Earlier this file shipped cameraIndex=65, which is pitchBin=5 yawBin=10 —
// that yaws RIGHT instead of pitching down (verified by user video).
const NOOP = { buttons: [0], camera: [60] };          // all none, camera neutral
const EQUIP_HOTBAR_2 = { buttons: [1728], camera: [60] }; // HOTBAR=hotbar.2
const TILT_DOWN_10 = { buttons: [1], camera: [115] }; // camera=[+10, 0] pitch-down
const JUMP = { buttons: [2], camera: [60] };          // jump=1
const USE = { buttons: [16], camera: [60] };          // use=1
// Sprint/sneak group: idx 2 = sneak. Encoded:
//   0,0,0,2,0,0,0,0,0 → 0,0,0,2,4,8,16,32,64
const SNEAK = { buttons: [64], camera: [60] };        // sneak=1
// Sprint/sneak idx 2 + use idx 1:
//   0,0,0,2,5,10,20,40,80
const SNEAK_USE = { buttons: [80], camera: [60] };    // sneak=1 + use=1

// Sequence mirrors the under-player Placing macro. Default emits use=1
// alone at the place tick. With STUB_SNEAK=1, the sequence inserts a
// sneak_engage tick (sneak=1 alone) before the place tick and emits
// sneak=1+use=1 compound at the place tick — same shape Placing.ts uses
// when the subgoal description matches /\bsneak\b/i.
const SNEAK_MODE = process.env.STUB_SNEAK === "1";
const PLACE_TICK = SNEAK_MODE ? SNEAK_USE : USE;
const SNEAK_PRIMING = SNEAK_MODE ? [SNEAK] : [];

const SEQUENCE = [
  ...Array(30).fill(NOOP),                                     // wait for /give
  EQUIP_HOTBAR_2,                                              // equip hotbar.2
  NOOP,                                                        // equip → aim_down transition
  TILT_DOWN_10, TILT_DOWN_10, TILT_DOWN_10,                    // aim ticks 1-3
  TILT_DOWN_10, TILT_DOWN_10, TILT_DOWN_10,                    // aim ticks 4-6
  TILT_DOWN_10, TILT_DOWN_10, TILT_DOWN_10,                    // aim ticks 7-9 (~90° down)
  NOOP,                                                        // settle
  JUMP,                                                        // jump (no use)
  NOOP, NOOP, NOOP, NOOP, NOOP,                                // midair ticks 1-5
  ...SNEAK_PRIMING,                                            // sneak_engage (only when SNEAK_MODE)
  PLACE_TICK,                                                  // place: use=1 or sneak+use
  ...Array(8).fill(NOOP),                                      // post-place settle
];

const queues = new Map(); // contextId -> array of remaining actions

function nextAction(contextId) {
  let q = queues.get(contextId);
  if (!q) {
    q = [...SEQUENCE];
    queues.set(contextId, q);
  }
  if (q.length === 0) return NOOP;
  return q.shift();
}

function jsonResponse(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function agentCard(baseUrl) {
  return {
    protocolVersion: "0.3.0",
    name: "stub-purple-jump-place",
    description: "Hardcoded jump-place sequence stub for macro isolation tests.",
    url: baseUrl,
    preferredTransport: "JSONRPC",
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{
      id: "mcu_low_level_control",
      name: "MCU Low-Level Control (stub)",
      description: "Returns hardcoded jump-place compact actions.",
      tags: ["test", "minecraft"],
      examples: ["place crafting_table"],
    }],
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function extractText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.map((p) => p?.text ?? p?.root?.text ?? "").filter(Boolean).join("\n").trim();
}

function handleMessageSend(request) {
  const message = request?.params?.message ?? {};
  const contextId = message.contextId || message.context_id || randomUUID().replace(/-/g, "");
  const inputText = extractText(message);
  let payload;
  try { payload = JSON.parse(inputText); } catch { payload = null; }

  let outputText;
  if (payload?.type === "init") {
    queues.delete(contextId); // fresh sequence per episode
    outputText = JSON.stringify({ type: "ack", success: true, message: "stub init ok" });
    console.log(`[stub-purple] init context=${contextId} task=${JSON.stringify(payload.text || "")}`);
  } else if (payload?.type === "obs") {
    const action = nextAction(contextId);
    const remaining = (queues.get(contextId) ?? []).length;
    outputText = JSON.stringify({ type: "action", action_type: "agent", buttons: action.buttons, camera: action.camera });
    console.log(`[stub-purple] step=${payload.step ?? "?"} → buttons=${action.buttons[0]} camera=${action.camera[0]} (remaining=${remaining})`);
  } else {
    outputText = JSON.stringify({ type: "ack", success: false, message: "unknown payload" });
  }

  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: {
      kind: "message",
      role: "agent",
      messageId: randomUUID().replace(/-/g, ""),
      contextId,
      taskId: message.taskId,
      parts: [{ kind: "text", text: outputText }],
    },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const baseUrl = `http://${req.headers.host || `localhost:${PORT}`}`;
    const url = new URL(req.url || "/", baseUrl);
    if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
      jsonResponse(res, 200, agentCard(baseUrl));
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      jsonResponse(res, 200, { ok: true });
      return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const body = await readJson(req);
    if (body?.method === "message/send") {
      jsonResponse(res, 200, handleMessageSend(body));
      return;
    }
    jsonResponse(res, 200, { jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: `Method not found: ${body?.method}` } });
  } catch (err) {
    console.error(`[stub-purple] error: ${err?.stack || err}`);
    jsonResponse(res, 500, { error: String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[stub-purple] listening on 0.0.0.0:${PORT} — sequence length=${SEQUENCE.length}`);
});
