/**
 * Debug dashboard generator.
 *
 * Reads events.jsonl + image artifacts from the eval debug dir and
 * produces a single self-contained HTML page that lets you walk
 * through the eval frame-by-frame, comparing the actual rendered
 * frame to the agent's CONTEXT at that timestamp:
 *   - what slotMemory said (Known slot contents)
 *   - what cursorItemSignature said (Cursor: ...)
 *   - what action was emitted (move, verify_slots, place, ...)
 *   - what the click verifier reported (OK / MISMATCH / DRIFTED)
 *
 * Use:
 *   node local_tests/debug_dashboard.mjs <debugDir>
 *   ⇒ writes <debugDir>/dashboard.html
 *
 * Then open <debugDir>/dashboard.html in a browser.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const debugDir = process.argv[2] ?? "C:\\Users\\eddie\\AppData\\Local\\Temp\\mcu-eval\\debug";
if (!fs.existsSync(debugDir)) { console.error(`debugDir not found: ${debugDir}`); process.exit(1); }

const events = fs.readFileSync(path.join(debugDir, "events.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e);

// Build a chronological list of "rows" — one per significant event,
// each pointing at the relevant image (if any) and capturing the
// context the agent saw at that step.
const rows = [];
for (const e of events) {
  const t = e.ts ?? null;
  const seq = e.seq ?? "";
  switch (e.type) {
    case "probe_input":
    case "fastui_action_call":
    case "fastui_planner_call":
    case "slot_ocr":
    case "verify":
    case "pre_check_move":
    case "planner_assistant":
    case "planner_dispatch":
    case "placing_call":
    case "placing_response":
    case "mining_call":
    case "mining_response":
    case "combat_call":
    case "combat_response":
    case "world_explore_call":
    case "world_explore_response":
    case "hotbar_ocr":
    case "hotbar_verifier_step": {
      rows.push({ t, seq, type: e.type, data: e.data ?? {}, imageFile: e.imageFile });
      break;
    }
    default: rows.push({ t, seq, type: e.type, data: e.data ?? {}, imageFile: e.imageFile });
  }
}
// PRESERVE FILE ORDER — every recorder (DebugRecorder, SlotOcr, HotbarOcr,
// WorldBlockOpener) appends to events.jsonl atomically as the event fires,
// so the line order in the file IS the causal order. Sorting by timestamp
// is unreliable (ms-resolution clashes, batched writes can land out of
// order); sorting by seq is even worse because each module uses its own
// seq range (recorder=1+, SlotOcr=200001+, HotbarOcr=210001+, WorldBlockOpener=220001+),
// dumping OCR events at the end of a seq sort. File order has no such issues.

// Map each row to its likely associated image: probe → 0000N_probe_input.png,
// action → fastui_action_NNNNN_input.png, ocr → 200NNN_slot_ocr.png, etc.
function findImage(row) {
  // imageFile is now set by DebugRecorder for ALL event types that
  // pass an image (probe_input, fastui_action_call, fastui_planner_call,
  // slot_ocr). Filenames use the global event seq so listing the dir
  // sorts chronologically.
  if (row.imageFile) return row.imageFile;
  if (row.type === "verify") return null;
  return null;
}

// Concise summary per row type — the diagnostic content.
function summarize(row) {
  const d = row.data ?? {};
  switch (row.type) {
    case "probe_input": {
      const known = (d.knownSlots ?? []).map((s) => `${s.index}(${s.name ?? "?"})=${s.item}`).join(", ") || "(none)";
      return {
        title: `[probe iter=${d.iteration}] probe_input — VLM call`,
        body: [
          `task: ${d.taskText ?? ""}`,
          `cursorHolding: ${d.cursorHolding ?? ""}`,
          `Known: ${known}`,
          d.recipeHint ? `recipe: ${(d.recipeHint || "").slice(0, 200)}` : "",
        ].filter(Boolean),
      };
    }
    case "fastui_planner_call": {
      const inp = d.input ?? {};
      const known = (inp.known_slots ?? []).map((s) => `${s.index}(${s.name ?? "?"})=${s.item}`).join(", ") || "(none)";
      const checklist = (d.output?.checklist ?? []).map((c) => `${c.done ? "✓" : "·"}${c.id}`).join(" ");
      return {
        title: `[planner #${d.seq} ${inp.trigger}]`,
        body: [
          `Known: ${known}`,
          `cursor: ${inp.cursor_holding ?? "(empty)"}`,
          `recipe: ${inp.recipe?.target ?? "?"} (${(inp.recipe?.ingredients ?? []).map((it) => `${it.count}x${it.name}`).join("+")})`,
          `→ all_done=${d.output?.all_done} next_idx=${d.output?.next_idx} checklist=[${checklist}]`,
          `recent_history: ${(inp.recent_history ?? []).slice(0, 3).join(" | ")}`,
        ],
      };
    }
    case "fastui_action_call": {
      const o = d.output ?? {};
      const subtask = d.subtask ?? {};
      return {
        title: `[action #${d.seq}] subtask=${subtask.kind} ${subtask.item ?? subtask.expectedItem ?? subtask.condition ?? (subtask.items?.join(",") ?? "")}`,
        body: [
          `EMIT: ${JSON.stringify(o)}`,
        ],
      };
    }
    case "slot_ocr": {
      return {
        title: `[ocr] slot ${d.slotName ?? d.slotIndex ?? ""} @ (${d.slotPos?.x},${d.slotPos?.y})`,
        body: [
          `parsed: ${JSON.stringify(d.parsed ?? {})}`,
          `raw: ${(d.raw ?? "").slice(0, 80)}`,
        ],
      };
    }
    case "verify": {
      // The verify event payload is {type, step, data:{slotName,
      // slotIndex, intent, outcome, slotChanges, cursorChange, retries,
      // cursor}}. The summarizer's `d` is the outer e.data — drill in.
      const v = d.data ?? d;
      const ok = v.outcome === "confirmed" || v.outcome === "drifted";
      const slotChangesStr = Array.isArray(v.slotChanges)
        ? v.slotChanges.map(([i, ch]) => `${i}:${ch}`).join(", ") || "(none)"
        : "(unknown)";
      return {
        title: `[verify] slot ${v.slotName ?? v.slotIndex ?? ""} ${v.intent ?? ""} → ${v.outcome ?? "(unknown)"} ${ok ? "OK" : ""}`,
        body: [
          `slot changes: ${slotChangesStr}`,
          `cursor change: ${v.cursorChange ?? "(unknown)"}`,
          `cursor: (${v.cursor?.x},${v.cursor?.y})`,
          `retries: ${v.retries ?? 0}`,
        ],
      };
    }
    case "pre_check_move": {
      return {
        title: `[pre_check_move] ${d.from?.name ?? d.from?.index} → ${d.to?.name ?? d.to?.index} (count=${d.count}) decision=${d.decision}`,
        body: [
          `destPatch: mean=(${d.destPatch?.meanR?.toFixed(0)},${d.destPatch?.meanG?.toFixed(0)},${d.destPatch?.meanB?.toFixed(0)}) stddev=${d.destPatch?.stddev?.toFixed(1)}`,
        ],
      };
    }
    case "planner_assistant": {
      return {
        title: `[planner-llm hop=${d.hop}]`,
        body: [
          d.tool_calls?.length ? `tools: ${d.tool_calls.map((tc) => `${tc.function?.name}(${tc.function?.arguments?.slice(0, 80)})`).join(" | ")}` : `content: ${(d.content || "").slice(0, 200)}`,
        ],
      };
    }
    case "placing_call":
    case "mining_call":
    case "combat_call":
    case "world_explore_call": {
      const sg = d.subgoal ?? {};
      return {
        title: `[${row.type.replace("_call", "")} iter=${d.iteration}] subgoal: ${sg.description ?? "?"}`,
        body: [
          `success: ${sg.success_criteria ?? "?"}`,
          `recent_history: ${(d.history ?? []).slice(-3).join(" | ")}`,
        ],
      };
    }
    case "placing_response":
    case "mining_response":
    case "combat_response":
    case "world_explore_response": {
      const p = d.parsed ?? {};
      const a = p.action ?? {};
      const buttons = ["attack","use","forward","back","left","right","jump","sneak","sprint","drop","inventory"]
        .filter((k) => a[k] === 1);
      const hotbar = Object.keys(a).filter((k) => k.startsWith("hotbar.") && a[k] === 1);
      return {
        title: `[${row.type.replace("_response", "")}] iter=${d.iteration} ${p.task_done ? "task_done=TRUE" : ""}`,
        body: [
          `pressed: ${[...buttons, ...hotbar].join(", ") || "(none)"}`,
          `camera: ${JSON.stringify(a.camera ?? [0, 0])}`,
          d.rawText ? `rawText: ${(d.rawText || "").slice(0, 120)}` : "",
        ].filter(Boolean),
      };
    }
    case "hotbar_ocr": {
      const parsed = d.parsed ?? {};
      const observedTxt = parsed.observed === "" ? "(no banner)" : parsed.observed;
      return {
        title: `[hotbar_ocr] target=${d.target ?? "?"} candidate=${d.candidateLabel ?? "?"} match=${parsed.match ? "TRUE" : "false"}`,
        body: [
          `observed: ${observedTxt}`,
          `raw: ${(d.raw ?? "").slice(0, 80)}`,
        ],
      };
    }
    case "hotbar_verifier_step": {
      return {
        title: `[verifier] phase=${d.innerPhase ?? "?"} cursor=${d.cursor ?? "?"} candidate=hotbar.${d.candidateSlot ?? "?"} target=${d.target ?? "?"}`,
        body: [
          `action: ${d.action ?? ""}`,
          d.observed !== undefined ? `observed: ${d.observed} match: ${d.match}` : "",
          `activeSlot: ${d.activeSlot ?? "(unknown)"}`,
        ].filter(Boolean),
      };
    }
    default:
      return { title: `[${row.type}]`, body: [JSON.stringify(row.data ?? {}).slice(0, 200)] };
  }
}

const dashboardRows = rows.map((r) => {
  const summary = summarize(r);
  const img = findImage(r);
  const imgPath = img && fs.existsSync(path.join(debugDir, img)) ? img : null;
  return { seq: r.seq, t: r.t, type: r.type, summary, imgPath };
});

// Pull the prompt text for action/planner calls — that's what the
// LLM actually saw, vs what context implied.
for (const r of dashboardRows) {
  if (r.type === "fastui_action_call") {
    const seq = String(r.summary.title.match(/#(\d+)/)?.[1] ?? "00000").padStart(5, "0");
    const promptPath = path.join(debugDir, `fastui_action_${seq}_prompt.txt`);
    if (fs.existsSync(promptPath)) r.promptText = fs.readFileSync(promptPath, "utf8");
  } else if (r.type === "fastui_planner_call") {
    const seq = String(r.summary.title.match(/#(\d+)/)?.[1] ?? "00000").padStart(5, "0");
    const promptPath = path.join(debugDir, `fastui_planner_${seq}_prompt.txt`);
    if (fs.existsSync(promptPath)) r.promptText = fs.readFileSync(promptPath, "utf8");
  }
}

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>MCU Eval Debug Dashboard</title>
<style>
  body { font-family: 'Cascadia Code', 'Consolas', monospace; margin: 0; background: #1e1e1e; color: #ddd; }
  .row { display: grid; grid-template-columns: 360px 1fr; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #333; align-items: start; }
  .row:hover { background: #262626; }
  .row.action_call { background: #1f2a1f; }
  .row.planner_call { background: #1f1f2a; }
  .row.verify_match { background: #1a2a1a; }
  .row.verify_mismatch { background: #2a1a1a; }
  .row.ocr { background: #1f2a2a; }
  img { max-width: 360px; height: auto; border: 1px solid #444; }
  .summary .title { font-weight: bold; margin-bottom: 4px; }
  .summary .body { white-space: pre-wrap; font-size: 11px; line-height: 1.4; color: #aaa; }
  .summary .body .key { color: #ff7; }
  details { margin-top: 6px; }
  summary { cursor: pointer; color: #79c; font-size: 11px; }
  pre { font-size: 10px; color: #888; max-height: 400px; overflow: auto; background: #111; padding: 6px; }
  .seq { color: #666; font-size: 10px; }
  .filter { padding: 8px; background: #2a2a2a; border-bottom: 2px solid #555; position: sticky; top: 0; }
  .filter button { margin-right: 8px; padding: 4px 10px; background: #444; color: #ddd; border: none; cursor: pointer; }
  .filter button.active { background: #79c; color: #000; }
</style></head><body>
<div class="filter">
  <strong>Filter:</strong>
  <button class="active" data-filter="all">All</button>
  <button data-filter="action_call">Actions</button>
  <button data-filter="planner_call">Planners</button>
  <button data-filter="ocr">OCR</button>
  <button data-filter="verify">Verifies</button>
  <button data-filter="verify_mismatch">Mismatches</button>
  <button data-filter="pre_check_move">Pre-checks</button>
  <span style="margin-left: 20px; color: #888;">${dashboardRows.length} rows</span>
</div>
${dashboardRows.map((r) => {
  const cls = r.type === "fastui_action_call" ? "action_call"
    : r.type === "fastui_planner_call" ? "planner_call"
    : r.type === "verify" ? (/→ (confirmed|drifted)/.test(r.summary.title) ? "verify_match" : "verify_mismatch")
    : r.type === "slot_ocr" ? "ocr"
    : r.type;
  const verifyClass = r.type === "verify" ? (/→ (confirmed|drifted)/.test(r.summary.title) ? "verify" : "verify verify_mismatch") : "";
  const dataAttrs = `data-cls="${cls}" data-vmm="${verifyClass.includes("mismatch") ? "1" : "0"}"`;
  return `<div class="row ${cls}" ${dataAttrs}>
    <div>
      ${r.imgPath ? `<img src="${r.imgPath}" alt="${r.imgPath}" loading="lazy" />` : '<span style="color:#444">(no image)</span>'}
      <div class="seq">seq=${r.seq} type=${r.type}</div>
    </div>
    <div class="summary">
      <div class="title">${escapeHtml(r.summary.title)}</div>
      <div class="body">${r.summary.body.map((b) => escapeHtml(b)).join("\n")}</div>
      ${r.promptText ? `<details><summary>show prompt to LLM</summary><pre>${escapeHtml(r.promptText)}</pre></details>` : ""}
    </div>
  </div>`;
}).join("\n")}
<script>
  document.querySelectorAll('.filter button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const f = btn.dataset.filter;
      document.querySelectorAll('.row').forEach(row => {
        if (f === 'all') row.style.display = '';
        else if (f === 'verify_mismatch') row.style.display = row.dataset.vmm === '1' ? '' : 'none';
        else if (f === 'verify') row.style.display = row.dataset.cls.startsWith('verify') ? '' : 'none';
        else row.style.display = row.dataset.cls === f ? '' : 'none';
      });
    });
  });
</script>
</body></html>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

const outPath = path.join(debugDir, "dashboard.html");
fs.writeFileSync(outPath, html);
console.log(`Dashboard written: ${outPath}`);
console.log(`Open in browser: file:///${outPath.replace(/\\/g, "/")}`);
console.log(`Rows: ${dashboardRows.length} (${dashboardRows.filter((r) => r.imgPath).length} with images)`);
