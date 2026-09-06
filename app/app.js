/* Program Microscope v0.1 — dependency-free GUI prototype. */

const state = {
  lens: "overview",
  trace: null,
  normal: null,
  failure: null,
  selectedEventId: "f6",
  ioTab: "network",
  captureMode: "deep_trace",
  selectedTarget: "MyApp.exe",
  query: ""
};

const truthClass = { REAL: "real", DERIVED: "derived", UNAVAILABLE: "unavailable", DEBUG_ONLY: "debug" };

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtTime(ms) { return `${(Number(ms || 0) / 1000).toFixed(3)} s`; }
function fmtDuration(ms) {
  const value = Number(ms || 0);
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}
function pct(value) { return `${Number(value || 0).toFixed(Number(value || 0) % 1 ? 1 : 0)}%`; }
function byId(items) { return Object.fromEntries((items || []).map(item => [String(item.id), item])); }
function currentEvent() { return (state.trace?.events || []).find(item => item.id === state.selectedEventId) || state.trace?.events?.[0] || null; }
function eventStatusClass(event) {
  if (!event) return "";
  if (["fault", "error"].includes(event.status)) return "fault";
  if (["network", "file", "registry", "process"].includes(event.kind)) return "io";
  if (event.kind === "user_action") return "action";
  return "";
}
function truthBadge(truth) {
  const value = truth || "UNAVAILABLE";
  return `<span class="badge ${truthClass[value] || "unavailable"}">${escapeHtml(value)}</span>`;
}
function runSelector() {
  const id = state.trace?.run?.id || "failure";
  return `<select id="run-select" class="select-control" aria-label="Selected run">
    <option value="failure" ${id === "failure" ? "selected" : ""}>Run B · Failed</option>
    <option value="normal" ${id === "normal" ? "selected" : ""}>Run A · Normal</option>
  </select>`;
}
function viewHeader(title, subtitle, actions = "") {
  return `<div class="view-header"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><div class="view-actions">${actions}</div></div>`;
}
function card(title, body, extraClass = "") {
  return `<section class="card ${extraClass}"><div class="card-title"><span>${title}</span></div><div class="card-body">${body}</div></section>`;
}
function selectedTruth(event) {
  const evidence = byId(state.trace?.evidence || []);
  const first = (event?.evidence_ids || []).map(id => evidence[id]).find(Boolean);
  return first?.truth || "REAL";
}

function fallbackTrace(id) {
  const failure = id !== "normal";
  const prefix = failure ? "f" : "n";
  const events = failure ? [
    ["1", "user_action", "Startup", 0, 17, "Click Open", "ok", "open_requested"],
    ["2", "function", "Load config", 17, 400, "Load config", "ok", "config_loaded"],
    ["3", "network", "Connect device", 417, 1676, "Connect device", "ok", "connected"],
    ["4", "network", "Read device", 2093, 6003, "Read device", "ok", "4096_bytes"],
    ["5", "function", "Parse response", 8096, 152, "Parse response", "ok", "19_records"],
    ["6", "function", "CheckCRC", 8248, 120, "CheckCRC", "fault", "crc_mismatch"],
    ["7", "network", "Retry #1", 8368, 163, "Retry #1", "fault", "no_response"],
    ["8", "network", "Retry #2", 8531, 1211, "Retry #2", "fault", "no_response"],
    ["9", "network", "Retry #3", 9742, 1264, "Retry #3", "fault", "no_response"],
    ["10", "exception", "Timeout", 11006, 2204, "Timeout", "fault", "WSAETIMEDOUT"]
  ] : [
    ["1", "user_action", "Startup", 0, 18, "Click Open", "ok", "open_requested"],
    ["2", "function", "Load config", 18, 403, "Load config", "ok", "config_loaded"],
    ["3", "network", "Connect device", 421, 1694, "Connect device", "ok", "connected"],
    ["4", "network", "Read device", 2115, 5987, "Read device", "ok", "4096_bytes"],
    ["5", "function", "Parse response", 8102, 152, "Parse response", "ok", "19_records"],
    ["6", "function", "CheckCRC", 8254, 114, "CheckCRC", "ok", "crc_ok"],
    ["7", "function", "Process data", 8368, 144, "Process data", "ok", "state_updated"],
    ["8", "phase", "Complete", 8512, 900, "Complete", "ok", "success"]
  ];
  return {
    schema_version: "0.1",
    run: { id, name: failure ? "Run B · Failed" : "Run A · Normal", status: failure ? "failed" : "completed", duration_ms: failure ? 13210 : 9412, capture_mode: failure ? "deep_trace" : "observe", target: { name: "MyApp.exe", pid: 8420, path: "C:\\Apps\\MyApp\\MyApp.exe", arch: "x64", os: "Windows 11" }, summary: { headline: failure ? "Timed out after CRC mismatch" : "Completed successfully", now: failure ? "Waiting for a device response" : "Updating the document", cpu_percent: failure ? 14 : 18, memory_mb: failure ? 682 : 604, threads: failure ? 18 : 14, modules: 37, network_connections: failure ? 3 : 1, exceptions: failure ? 1 : 0, wait_percent: failure ? 63 : 0 } },
    nodes: [], threads: [{ id: 1, name: "Main", state: failure ? "Waiting" : "Running", cpu_ms: 312 }, { id: 14, name: "Worker", state: "Waiting", cpu_ms: 412 }],
    events: events.map(item => ({ id: prefix + item[0], kind: item[1], phase: item[2], start_ms: item[3], duration_ms: item[4], thread_id: item[1] === "user_action" ? 1 : 14, node_id: item[2].toLowerCase().replaceAll(" ", "_"), label: item[5], status: item[6], outcome: item[7], details: {}, evidence_ids: ["ev_process"] })),
    values: failure ? [{ id: "v_actual_crc", name: "actualCrc", type: "uint16_t", value: "0x9C4D", event_id: "f6" }, { id: "v_result", name: "result", type: "bool", value: "false", event_id: "f6" }] : [{ id: "v_result", name: "result", type: "bool", value: "true", event_id: "n7" }],
    edges: failure ? [{ id: "e1", from: "v_actual_crc", to: "v_result", type: "CAUSES", label: "CRC mismatch" }] : [],
    evidence: [{ id: "ev_process", truth: failure ? "DEBUG_ONLY" : "REAL", source: "ETW process/thread provider", detail: "fixture fallback" }],
    io: failure ? [{ id: "io1", type: "network", operation: "tcp_read", endpoint: "10.42.17.8:5023", start_ms: 8368, duration_ms: 6003, status: "timeout", bytes_received: 0, thread_id: 14, caller: "DeviceClient::Read" }] : [{ id: "io1", type: "network", operation: "tcp_read", endpoint: "10.42.17.8:5023", start_ms: 2115, duration_ms: 5987, status: "ok", bytes_received: 4096, thread_id: 14, caller: "DeviceClient::Read" }],
    changes: failure ? [{ scope: "FILES", action: "created", path: "cache\\data.bin", at_ms: 8361, detail: "4096 bytes" }, { scope: "NETWORK", action: "attempted", path: "10.42.17.8:5023", at_ms: 8372, detail: "TIMEOUT" }] : []
  };
}

async function fetchTrace(id) {
  try {
    const response = await fetch(`/api/trace/${id}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    return fallbackTrace(id);
  }
}

async function loadRun(id) {
  state.trace = id === "normal" ? (state.normal || await fetchTrace("normal")) : (state.failure || await fetchTrace("failure"));
  if (id === "normal") state.normal = state.trace; else state.failure = state.trace;
  if (state.trace.run.id === "failure" && !state.selectedEventId.startsWith("f")) state.selectedEventId = "f6";
  if (state.trace.run.id === "normal" && !state.selectedEventId.startsWith("n")) state.selectedEventId = "n6";
  render();
}

function syncTopbar() {
  const run = state.trace?.run;
  const target = document.querySelector("#target-name");
  const status = document.querySelector("#run-status");
  const dot = document.querySelector(".target-dot");
  if (target) target.textContent = run?.target?.name || "MyApp.exe";
  if (status) status.textContent = run?.status === "failed" ? "Failed" : "Completed";
  if (dot) dot.style.background = run?.status === "failed" ? "var(--red)" : "var(--green)";
}

function selectEvent(id) {
  if (!id) return;
  state.selectedEventId = id;
  render();
}

function explainEvent(event) {
  if (!event) return "Select an event to see a plain-language explanation and the evidence behind it.";
  const details = event.details || {};
  if (event.status === "fault" || event.status === "error") {
    if (event.outcome === "crc_mismatch") return "The response arrived, but its checksum did not match the expected value. The program entered the retry path.";
    if (event.outcome === "WSAETIMEDOUT") return "The program is waiting for a device response. The socket did not receive data before the timeout.";
    return `This step reported ${event.outcome || "a fault"}; inspect the evidence before changing code.`;
  }
  if (event.kind === "network" && event.outcome === "4096_bytes") return `The program received ${details.bytes_received || 4096} bytes from the device and passed them to the parser.`;
  if (event.kind === "user_action") return "This is the human action that started the observed route through the program.";
  return `${event.label} completed with outcome ${event.outcome || "ok"}.`;
}

function renderOverview() {
  const run = state.trace.run;
  const summary = run.summary || {};
  const events = state.trace.events || [];
  const important = events.filter(event => event.status !== "ok" || event.kind === "user_action" || Number(event.duration_ms) > 1000).slice(-6);
  const waitPercent = summary.wait_percent ?? 0;
  return `${viewHeader("Program overview", `${run.target.name} · ${run.status === "failed" ? "failed run" : "normal run"}`, runSelector())}
    <div class="grid grid-overview">
      ${card(`<span>What is happening now?</span><small>${fmtTime(run.duration_ms)} elapsed</small>`, `<div class="status-headline"><div><h2>${escapeHtml(summary.now || summary.headline)}</h2><p>${escapeHtml(explainEvent(currentEvent()))}</p></div><div class="status-icon">${run.status === "failed" ? "!" : "✓"}</div></div><div class="metric-row"><div class="metric"><strong>${summary.cpu_percent || 0}%</strong><span>CPU · <i class="ok">live</i></span></div><div class="metric"><strong>${summary.memory_mb || 0} MB</strong><span>Memory · <i class="up">${run.status === "failed" ? "↑ 42 MB" : "stable"}</i></span></div><div class="metric"><strong>${summary.threads || 0}</strong><span>Threads</span></div><div class="metric"><strong>${summary.network_connections || 0}</strong><span>Network</span></div></div>`, "status-card")}
      ${card("Worth checking", `<div class="recommendations"><div class="recommendation"><span class="rec-mark">⚠</span><div><b>${waitPercent ? `Network wait is ${waitPercent}% of this run` : "No long wait detected"}</b><p>${waitPercent ? "Open Timeline or I/O to see the exact endpoint and caller." : "The run spent its time in expected processing steps."}</p></div></div><div class="recommendation"><span class="rec-mark">${summary.exceptions ? "⚠" : "✓"}</span><div><b>${summary.exceptions || 0} exception${summary.exceptions === 1 ? "" : "s"} observed</b><p>${summary.exceptions ? "Select the red event to inspect the first fault." : "No exception evidence was recorded."}</p></div></div><div class="recommendation"><span class="rec-mark">⌁</span><div><b>${state.trace.evidence.length} evidence records attached</b><p>Numbers are labelled REAL, DERIVED or UNAVAILABLE before they are shown.</p></div></div></div>`)}
    </div>
    <div class="grid grid-two" style="margin-top:14px">
      ${card("Recent important events", `<div class="event-list">${important.map(eventRow).join("") || `<div class="empty">No important events in this run.</div>`}</div>`)}
      ${card("Run facts", `<dl class="kv"><dt>Capture mode</dt><dd>${escapeHtml(run.capture_mode)}</dd><dt>Target</dt><dd>${escapeHtml(run.target.path)}</dd><dt>Duration</dt><dd>${fmtDuration(run.duration_ms)}</dd><dt>Modules</dt><dd>${summary.modules || 0} ${truthBadge("REAL")}</dd><dt>Registry</dt><dd>${truthBadge("UNAVAILABLE")} not enabled</dd></dl><div class="explain"><strong>Human view</strong><br>${escapeHtml(run.status === "failed" ? "The run diverged at CheckCRC and then spent most of its remaining time retrying a device read." : "The run followed the expected route and reached Complete.")}</div>`)}
    </div>`;
}

function eventRow(event) {
  const selected = event.id === state.selectedEventId ? "selected" : "";
  return `<div class="event-row ${selected}" data-event="${escapeHtml(event.id)}"><span class="event-time">${fmtTime(event.start_ms)}</span><span class="event-kind ${eventStatusClass(event)}"></span><span class="event-label">${escapeHtml(event.label)}</span><span class="event-detail">${escapeHtml(event.outcome || event.status)}</span></div>`;
}

function renderTimelineChart(events, maxMs, compact = false) {
  const lanes = ["Process", "Thread 1", "Thread 14", "Network I/O", "File I/O", "Exceptions"];
  const laneFor = event => event.kind === "exception" ? "Exceptions" : event.kind === "network" ? "Network I/O" : event.thread_id === 1 ? "Thread 1" : event.thread_id === 14 ? "Thread 14" : "Process";
  const safeMax = Math.max(1, Number(maxMs || 1));
  const ruler = compact ? "" : `<div class="time-ruler"><span></span>${Array.from({ length: 8 }, (_, i) => `<span>${((safeMax / 1000) * i / 7).toFixed(1)}s</span>`).join("")}</div>`;
  const rows = lanes.map(lane => {
    const bars = events.filter(event => laneFor(event) === lane).map(event => {
      const left = Math.max(0, Number(event.start_ms || 0) / safeMax * 100);
      const width = Math.max(0.8, Number(event.duration_ms || 1) / safeMax * 100);
      const cls = `${eventStatusClass(event)} ${event.id === state.selectedEventId ? "selected" : ""}`;
      return `<div class="${compact ? "mini-bar" : "event-bar"} ${cls}" style="left:${left}%;width:${width}%" data-event="${escapeHtml(event.id)}" title="${escapeHtml(event.label)} · ${fmtDuration(event.duration_ms)}">${compact ? "" : escapeHtml(event.label)}</div>`;
    }).join("");
    return compact ? `<div class="mini-lane"><span class="mini-label">${lane}</span><div class="mini-track">${bars}</div></div>` : `<div class="lane"><span class="lane-label">${lane}</span><div class="lane-track">${bars}</div></div>`;
  }).join("");
  const playEvent = currentEvent();
  const playhead = playEvent ? `<div class="${compact ? "mini-playhead" : "playhead"}" style="left:${Math.min(100, Number(playEvent.start_ms || 0) / safeMax * 100)}%" ${compact ? "" : `data-label="${fmtTime(playEvent.start_ms)}"`}></div>` : "";
  return `${ruler}<div class="${compact ? "mini-chart" : "timeline-chart"}">${rows}${playhead}</div>`;
}

function renderTimeline() {
  const run = state.trace.run;
  const events = state.trace.events || [];
  const query = state.query.trim().toLowerCase();
  const visible = query ? events.filter(event => JSON.stringify(event).toLowerCase().includes(query)) : events;
  return `${viewHeader("Execution timeline", "Every event is aligned to one program clock; select a bar to inspect it.", `${runSelector()}<input id="timeline-filter" class="filter-input" placeholder="Filter events…" value="${escapeHtml(state.query)}">`)}
    <div class="card timeline-view"><div class="card-body"><div class="timeline-toolbar"><span class="badge real">${events.length} events</span><span class="badge derived">${state.trace.evidence.length} evidence records</span><span class="muted">Click a lane or event; the inspector follows.</span></div>${renderTimelineChart(visible, run.duration_ms)}<div style="margin-top:14px;max-height:200px;overflow:auto"><table class="event-table"><thead><tr><th>Time</th><th>Event</th><th>Thread</th><th>Duration</th><th>Outcome</th></tr></thead><tbody>${visible.map(event => `<tr class="${event.id === state.selectedEventId ? "selected" : ""}" data-event="${escapeHtml(event.id)}"><td class="number">${fmtTime(event.start_ms)}</td><td>${escapeHtml(event.label)}</td><td>${escapeHtml(event.thread_id || "—")}</td><td class="number">${fmtDuration(event.duration_ms)}</td><td>${event.status === "fault" ? `<span class="io-status-timeout">${escapeHtml(event.outcome)}</span>` : escapeHtml(event.outcome || event.status)}</td></tr>`).join("")}</tbody></table></div></div></div>`;
}

function renderFlow() {
  const events = state.trace.events || [];
  const normalPath = events.slice(0, Math.min(6, events.length));
  const tail = events.slice(6);
  const node = event => `<div class="flow-node ${event.status === "fault" ? "fault" : ""} ${event.id === state.selectedEventId ? "selected" : ""}" data-event="${escapeHtml(event.id)}"><b>${escapeHtml(event.label)}</b><small>${fmtTime(event.start_ms)} · ${fmtDuration(event.duration_ms)}</small></div>`;
  const arrows = list => list.map((event, index) => `${node(event)}${index < list.length - 1 ? `<span class="flow-arrow">→</span>` : ""}`).join("");
  return `${viewHeader("Execution flow", "The route the program actually took after the human action.", runSelector())}
    <div class="grid grid-two"><section class="card"><div class="card-title"><span>Observed route</span><small>${events.length} invocations</small></div><div class="card-body flow-canvas"><div class="flow-path">${arrows(normalPath)}</div>${tail.length ? `<div class="flow-branch"><div class="flow-branch-label">Failure branch · executed after the first divergence</div><div class="flow-path">${arrows(tail)}</div></div>` : ""}<div class="flow-branch"><div class="flow-branch-label">Unexecuted in this run</div><div class="flow-path"><div class="flow-node skipped"><b>Process data</b><small>skipped</small></div><span class="flow-arrow">→</span><div class="flow-node skipped"><b>Complete</b><small>skipped</small></div></div></div></div></section>${renderInspector()}</div>`;
}

function renderInspector() {
  const event = currentEvent();
  const evidence = byId(state.trace.evidence || []);
  const evidenceRows = (event?.evidence_ids || []).map(id => evidence[id]).filter(Boolean).map(item => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line-soft)"><span>${escapeHtml(item.source)}</span>${truthBadge(item.truth)}</div>`).join("");
  return `<section class="card inspector"><div class="card-title"><span>Selected event</span><small>${event ? fmtTime(event.start_ms) : "—"}</small></div><div class="card-body">${event ? `<h3>${escapeHtml(event.label)}</h3><p>${escapeHtml(explainEvent(event))}</p><dl class="kv"><dt>Status</dt><dd>${event.status === "fault" ? `<span class="io-status-timeout">${escapeHtml(event.status)}</span>` : escapeHtml(event.status)}</dd><dt>Thread</dt><dd>${escapeHtml(event.thread_id || "—")}</dd><dt>Duration</dt><dd>${fmtDuration(event.duration_ms)}</dd><dt>Outcome</dt><dd>${escapeHtml(event.outcome || "—")}</dd></dl><div class="inspector-actions"><button class="button-secondary" data-action="state">Open state</button><button class="button-secondary" data-action="origin">Trace value origin</button></div><div style="margin-top:15px"><div class="muted" style="margin-bottom:6px">Evidence</div>${evidenceRows || `<span class="muted">No evidence attached</span>`}</div>` : `<div class="empty">Select an event.</div>`}</div></section>`;
}

function renderState() {
  const event = currentEvent();
  const values = (state.trace.values || []).filter(value => value.event_id === event?.id || value.name === "result");
  const failure = state.trace.run.status === "failed";
  const originValue = values.find(value => value.id === "v_result") || values[0];
  const stack = [event?.label || "—", "readDevice()", "onMessage()", "main()"];
  const locals = failure ? [["expectedCrc", "0x3F2A", "uint16_t"], ["actualCrc", "0x9C4D", "uint16_t"], ["retryCount", "2", "int"], ["result", "false", "bool"], ["responseSize", "49,152", "size_t"]] : [["expectedCrc", "0x3F2A", "uint16_t"], ["actualCrc", "0x3F2A", "uint16_t"], ["retryCount", "0", "int"], ["result", "true", "bool"]];
  const chain = originValue ? provenanceChain(originValue.id) : [];
  return `${viewHeader(`State at ${fmtTime(event?.start_ms || 0)}`, `${event?.thread_id ? `Thread ${event.thread_id}` : "Selected thread"}  ›  ${event?.label || "No event"}`, `${runSelector()}<span class="muted">Event ${(state.trace.events || []).findIndex(item => item.id === event?.id) + 1} of ${(state.trace.events || []).length}</span>`)}
    <div class="state-grid"><section class="card"><div class="card-title"><span>Thread</span></div><div class="card-body"><dl class="kv"><dt>Thread ID</dt><dd>${escapeHtml(event?.thread_id || "—")}</dd><dt>Status</dt><dd>${failure ? "Waiting" : "Running"}</dd><dt>Current function</dt><dd>${escapeHtml(event?.label || "—")}()</dd><dt>Total CPU time</dt><dd>412 ms ${truthBadge("REAL")}</dd><dt>Priority</dt><dd>Normal</dd></dl></div></section><section class="card"><div class="card-title"><span>Local variables</span><small>${truthBadge(failure ? "DEBUG_ONLY" : "REAL")}</small></div><div class="card-body" style="padding:0"><table class="locals"><thead><tr><th>Name</th><th>Value</th><th>Type</th></tr></thead><tbody>${locals.map(row => `<tr class="${row[0] === "result" ? "selected" : ""}"><td>${row[0]}</td><td>${row[1]}</td><td class="muted">${row[2]}</td></tr>`).join("")}</tbody></table></div></section><section class="card inspector"><div class="card-title"><span>Call stack</span><small>Thread ${escapeHtml(event?.thread_id || "—")}</small></div><div class="card-body" style="padding:0">${stack.map((item, index) => `<div class="stack-item ${index === 0 ? "selected" : ""}"><b>#${index} ${escapeHtml(item)}</b><small>MyApp.exe · ${index === 0 ? "state.cpp:278" : `frame:${index}`}</small></div>`).join("")}</div></section></div>
    <div class="state-bottom"><section class="card"><div class="card-title"><span>Memory around response.json</span><small>48 KB · ${truthBadge(failure ? "DEBUG_ONLY" : "REAL")}</small></div><div class="card-body"><div class="memory">0x0000006F3A1F2D10  7B 22 73 74 61 74 75 73 22 3A 22 4F 4B 22 7D  {"status":"OK"}\n0x0000006F3A1F2D20  22 64 61 74 61 22 3A 7B 22 69 64 22 3A 31 32 34  {"data":{"id":124\n… (48 KB total)</div></div></section><section class="card"><div class="card-title"><span>Value origin</span><small>${originValue ? escapeHtml(originValue.name + " = " + originValue.value) : "No selected value"}</small></div><div class="card-body"><div class="provenance">${chain.length ? chain.map(item => `<div class="origin-item"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(item.kind === "io" ? `${item.item.operation} · ${item.item.endpoint || item.item.path || ""}` : item.item.source || item.item.label || "observed value")}</span></div>`).join("") : `<div class="empty">No provenance edge is available for this value.</div>`}</div><div class="inspector-actions"><button class="button-secondary" data-action="origin">Trace backward</button><button class="button-secondary" data-lens="compare">Compare normal run</button></div></div></section></div>`;
}

function provenanceChain(targetId) {
  const items = byId([...(state.trace.values || []), ...(state.trace.events || []), ...(state.trace.io || [])]);
  const chain = [];
  const visited = new Set();
  let current = targetId;
  while (current && !visited.has(current) && chain.length < 8) {
    visited.add(current);
    if (items[current]) {
      const item = items[current];
      chain.push({ id: current, item, kind: item.name ? "value" : item.operation ? "io" : "event", label: item.name ? `${item.name} = ${item.value}` : item.operation ? `${item.operation} ${item.endpoint || item.path || ""}` : item.label });
    }
    const edge = (state.trace.edges || []).find(candidate => candidate.type === "CAUSES" && String(candidate.to) === String(current));
    current = edge?.from;
  }
  return chain;
}

function renderIO() {
  const tabs = ["files", "registry", "network", "processes", "dlls", "handles"];
  const selectedTab = state.ioTab;
  const items = (state.trace.io || []).filter(item => selectedTab === "network" ? item.type === "network" : selectedTab === "files" ? item.type === "file" : false);
  const changes = state.trace.changes || [];
  const grouped = Object.groupBy ? Object.groupBy(changes, item => item.scope) : changes.reduce((acc, item) => ((acc[item.scope] ||= []).push(item), acc), {});
  return `${viewHeader(`Windows I/O at ${fmtTime(currentEvent()?.start_ms || 0)}`, `System interactions performed by ${state.trace.run.target.name}`, `${runSelector()}<input id="io-filter" class="filter-input" placeholder="Filter I/O events…">`)}
    <div class="io-tabs">${tabs.map(tab => `<button class="io-tab ${tab === selectedTab ? "active" : ""}" data-io-tab="${tab}">${tab[0].toUpperCase() + tab.slice(1)}${tab === "network" ? " (12)" : ""}</button>`).join("")}</div>
    <div class="io-layout"><section class="card"><div class="card-title"><span>${selectedTab[0].toUpperCase() + selectedTab.slice(1)} events</span><small>${items.length} captured</small></div><div class="card-body" style="padding:0"><table class="event-table"><thead><tr><th>#</th><th>Time</th><th>Operation</th><th>Details</th><th>Duration</th><th>Status</th><th>Caller</th></tr></thead><tbody>${items.length ? items.map((item, index) => `<tr class="${item.id === "io10" ? "selected" : ""}" data-event="${escapeHtml(item.id)}"><td>${index + 1}</td><td class="number">${fmtTime(item.start_ms)}</td><td>${escapeHtml(item.operation)}</td><td>${escapeHtml(item.endpoint || item.path || "—")}</td><td class="number">${fmtDuration(item.duration_ms)}</td><td class="${item.status === "timeout" ? "io-status-timeout" : "io-status-ok"}">${escapeHtml(item.status)}</td><td>${escapeHtml(item.caller || "—")}</td></tr>`).join("") : `<tr><td colspan="7" class="empty">This provider is unavailable in the current capture mode.</td></tr>`}</tbody></table></div></section><aside class="card"><div class="card-title"><span>Changes observed</span><small>since start</small></div><div class="card-body">${Object.entries(grouped).map(([scope, list]) => `<div class="change-group"><h4>${escapeHtml(scope)} (${list.length})</h4>${list.map(item => `<div class="change ${item.action === "modified" ? "modified" : ""}"><span class="change-mark">${item.action === "modified" ? "✎" : "+"}</span><span class="change-path">${escapeHtml(item.path)}</span><span class="change-detail">${fmtTime(item.at_ms)}<br>${escapeHtml(item.detail)}</span></div>`).join("")}</div>`).join("") || `<div class="empty">No system changes were captured.</div>`}</div></aside></div>
    <div class="grid grid-two" style="margin-top:14px"><section class="card warning-card"><div class="card-title"><span>Capability boundary</span><small>${truthBadge("UNAVAILABLE")}</small></div><div class="card-body">Registry and handle details were not enabled for this session. Start a Deep Trace capture if you need them; the absence is recorded rather than shown as zero.</div></section>${renderInspector()}</div>`;
}

function firstDivergence(normal, failed) {
  const left = normal?.events || [];
  const right = failed?.events || [];
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = left[i], b = right[i];
    if ([a.phase || a.label, a.outcome, a.status].join("|") !== [b.phase || b.label, b.outcome, b.status].join("|")) return { index: i, at_ms: a.phase === b.phase ? Math.max(Number(a.start_ms) + Number(a.duration_ms), Number(b.start_ms) + Number(b.duration_ms)) : Math.min(a.start_ms, b.start_ms), normal: a, failed: b, reason: `${a.phase || a.label} changed from ${a.outcome || a.status} to ${b.outcome || b.status}` };
  }
  return left.length === right.length ? null : { index: length, at_ms: (left[length] || right[length])?.start_ms || 0, normal: left[length], failed: right[length], reason: "one run continued after the other ended" };
}

function renderCompare() {
  const normal = state.normal || fallbackTrace("normal");
  const failed = state.failure || state.trace || fallbackTrace("failure");
  const divergence = firstDivergence(normal, failed);
  const leftRows = normal.events || [], rightRows = failed.events || [];
  const row = (event, index, side) => `<div class="compare-row ${divergence && index === divergence.index ? "divergence" : ""} ${event?.status === "fault" ? "fault" : ""}" data-event="${escapeHtml(event?.id || "")}"><span class="idx">${index + 1}</span><span class="phase">${escapeHtml(event?.phase || event?.label || "—")}<br><small class="muted">${escapeHtml(event?.outcome || event?.status || "—")}</small></span><span class="when">${event ? fmtTime(event.start_ms) : "—"}</span></div>`;
  const evidence = divergence ? [`Input data differs`, `CRC calculation mismatch`, `Retry attempts`, `Device timeout`] : ["No divergence found", "Runs have the same event outcomes"];
  return `${viewHeader("Compare runs", "Side-by-side execution of the same program to find where behavior diverges.", `<select id="compare-normal" class="select-control"><option>Run A · Normal</option></select><select id="compare-failed" class="select-control"><option>Run B · Failed</option></select>`)}
    ${divergence ? `<div class="compare-banner"><span class="alert">!</span><div><b>First divergence at ${fmtTime(divergence.at_ms)} · ${escapeHtml(divergence.normal.phase || divergence.normal.label)} → ${escapeHtml(divergence.failed.phase || divergence.failed.label)}</b><span>Runs are identical up to this point. ${escapeHtml(divergence.reason)}.</span></div></div>` : ""}
    <div class="compare-layout"><section class="card"><div class="run-columns"><div class="run-column"><div class="run-head"><strong><span class="normal">●</span> Run A · Normal</strong><span class="run-total">${fmtDuration(normal.run.duration_ms)}</span></div>${leftRows.map((event, index) => row(event, index, "normal")).join("")}</div><div class="run-column"><div class="run-head"><strong><span class="failed">●</span> Run B · Failed</strong><span class="run-total">${fmtDuration(failed.run.duration_ms)}</span></div>${rightRows.map((event, index) => row(event, index, "failed")).join("")}</div></div></section><aside class="card"><div class="card-title"><span>Why different?</span><small>evidence chain</small></div><div class="card-body"><h3>${divergence ? "The device data read was different between runs." : "No behavior difference is currently known."}</h3><p class="muted">${divergence ? "The failed run entered a retry path after CheckCRC." : "Capture another run to compare it here."}</p><ol class="compare-evidence">${evidence.map((item, index) => `<li><span class="evidence-index">${index + 1}</span><div><b>${item}</b><span>${divergence ? ["ReadDevice returned bytes with differing content.", "Expected 0x3F2A, got 0x9C4D.", "The failed run retried the read three times.", "No valid response arrived before WSAETIMEDOUT."][index] : "No additional evidence."}</span></div></li>`).join("")}</ol><div class="inspector-actions"><button class="button-primary" data-action="divergence">Open divergence</button><button class="button-secondary" data-action="origin">Trace value origin</button><button class="button-secondary" data-lens="timeline">Jump to timeline</button></div></div></aside></div><section class="card compare-timeline"><div class="card-title"><span>Execution timeline (aligned)</span><small>${divergence ? `marker at ${fmtTime(divergence.at_ms)}` : "aligned"}</small></div><div class="card-body">${renderDualTimeline(normal, failed, divergence)}</div></section>`;
}

function renderDualTimeline(normal, failed, divergence) {
  const max = Math.max(normal.run.duration_ms, failed.run.duration_ms);
  const track = (trace, failedTrack) => `<div class="dual-track"><span class="dual-label">${failedTrack ? "● Run B · Failed" : "● Run A · Normal"}</span><div class="dual-lane">${trace.events.map(event => `<span class="phase-segment ${failedTrack ? "failed" : ""}" style="left:${event.start_ms / max * 100}%;width:${Math.max(.5, event.duration_ms / max * 100)}%" title="${escapeHtml(event.label)}"></span>`).join("")}${divergence ? `<span class="dual-divergence" style="left:${divergence.at_ms / max * 100}%"></span>` : ""}</div></div>`;
  return `${track(normal, false)}${track(failed, true)}<div class="muted" style="margin:8px 0 0 108px;font-size:11px">0 s　　　　　　　　　　　　　　　　　　　　　　　　${fmtDuration(max)}</div>`;
}

function renderCapture() {
  const modes = [{ id: "observe", title: "Observe", subtitle: "Low overhead event tracing using Windows ETW.", tags: ["Process, thread, file, network and window events", "Good for long-running sessions"], badge: "RECOMMENDED" }, { id: "deep_trace", title: "Deep Trace", subtitle: "Higher overhead tracing with detailed instrumentation.", tags: ["Function calls and call stacks", "Selected parameter and return values"], badge: "" }, { id: "time_travel", title: "Time Travel", subtitle: "Full instruction-level recording with reverse execution.", tags: ["Record and replay execution", "Largest data size, highest overhead"], badge: "" }];
  const targetRows = [{ name: "MyApp.exe", pid: 8420, path: "C:\\Apps\\MyApp\\MyApp.exe", selected: true }, { name: "helper.exe", pid: 12480, path: "C:\\Apps\\Helper\\helper.exe", selected: false }, { name: "Launch executable…", pid: "", path: "Browse for an executable to launch and trace", selected: false }];
  const captures = [["Process and thread events", "REAL", "From ETW"], ["File system activity", "REAL", "From ETW"], ["Network activity", "REAL", "From ETW"], ["Function calls", "REAL", "Instrumented tracing"], ["Call stacks", "REAL", "Captured at call time"], ["CPU usage (per thread)", "DERIVED", "From event aggregation"], ["Registry activity", "UNAVAILABLE", "Not enabled in this mode"], ["Instruction trace", "UNAVAILABLE", "Requires Time Travel mode"]];
  return `${viewHeader("Start a microscope session", "Select a target process and capture mode before you change the machine.", `<button class="button-secondary" data-action="refresh">↻ Refresh</button>`)}<div class="capture-layout"><div><section class="card"><div class="card-body"><div class="step-title"><span class="step-num">1</span>Select target</div>${targetRows.map(row => `<div class="process-row ${row.selected ? "selected" : ""}"><span class="radio ${row.selected ? "selected" : ""}"></span><b>${escapeHtml(row.name)}</b><span>${escapeHtml(row.pid)}</span><small>${escapeHtml(row.path)}</small></div>`).join("")}</div></section><section class="card" style="margin-top:14px"><div class="card-body"><div class="step-title"><span class="step-num">2</span>Select capture mode</div><div class="mode-list">${modes.map(mode => `<div class="mode-card ${state.captureMode === mode.id ? "selected" : ""}" data-mode="${mode.id}"><div class="mode-card-head"><span class="radio ${state.captureMode === mode.id ? "selected" : ""}"></span><h3>${mode.title}</h3>${mode.badge ? `<span class="badge real" style="margin-left:auto">${mode.badge}</span>` : ""}</div><p>${mode.subtitle}</p><ul>${mode.tags.map(item => `<li>${item}</li>`).join("")}</ul></div>`).join("")}</div></div></section><section class="card" style="margin-top:14px"><div class="card-body"><div class="step-title" style="margin:0"><span class="step-num">3</span>Advanced options <span class="muted" style="margin-left:auto">⌄ Show options</span></div></div></section></div><div><section class="card"><div class="card-title"><span>What will be captured</span><small>MTP v0.1</small></div><div class="card-body capture-checklist">${captures.map(row => `<div class="cap-row"><span>${row[0]}</span>${truthBadge(row[1])}<span class="cap-source">${row[2]}</span></div>`).join("")}<div class="overhead"><div class="meter-line"><span>CPU overhead</span><span class="meter"><i class="on"></i><i class="on"></i><i></i><i></i></span><b>Moderate</b></div><div class="meter-line"><span>Memory</span><span class="meter"><i class="on"></i><i class="on"></i><i></i><i></i></span><b>200–500 MB</b></div><div class="meter-line"><span>Disk / hour</span><span class="meter"><i class="on"></i><i class="on"></i><i></i><i></i></span><b>0.5–2 GB</b></div></div></div></section><div class="admin-warning"><span style="font-size:20px">⚠</span><div><strong>Administrator rights recommended</strong>Some providers and other processes require elevation. Missing access is recorded as unavailable.</div></div><div class="capture-actions"><button class="button-secondary" data-action="cancel">Cancel</button><button class="button-primary" data-action="start-capture">▶ Start capture</button></div></div></div>`;
}

function render() {
  if (!state.trace) return;
  const view = document.querySelector("#view");
  const lens = state.lens;
  view.innerHTML = lens === "overview" ? renderOverview() : lens === "timeline" ? renderTimeline() : lens === "flow" ? renderFlow() : lens === "state" ? renderState() : lens === "io" ? renderIO() : lens === "compare" ? renderCompare() : renderCapture();
  renderFooter();
  document.querySelectorAll(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.lens === lens));
  syncTopbar();
  bindViewEvents();
}

function renderFooter() {
  const footer = document.querySelector("#timeline-footer");
  const run = state.trace.run;
  footer.innerHTML = `<div class="timeline-footer-head"><strong>Execution timeline</strong><span>${fmtTime(currentEvent()?.start_ms || 0)} selected · ${fmtDuration(run.duration_ms)} total</span></div>${renderTimelineChart(state.trace.events || [], run.duration_ms, true)}<div class="legend" style="margin:7px 0 0 94px"><span>running</span><span class="network">I/O</span><span class="fault">fault</span><span class="action">user action</span></div>`;
  footer.querySelectorAll("[data-event]").forEach(item => item.addEventListener("click", () => selectEvent(item.dataset.event)));
}

function bindViewEvents() {
  document.querySelectorAll("[data-event]").forEach(item => item.addEventListener("click", event => { event.stopPropagation(); selectEvent(item.dataset.event); }));
  const select = document.querySelector("#run-select");
  if (select) select.addEventListener("change", event => loadRun(event.target.value));
  const filter = document.querySelector("#timeline-filter");
  if (filter) filter.addEventListener("input", event => { state.query = event.target.value; render(); const input = document.querySelector("#timeline-filter"); input?.focus(); input?.setSelectionRange(state.query.length, state.query.length); });
  document.querySelectorAll("[data-lens]").forEach(item => item.addEventListener("click", () => { state.lens = item.dataset.lens; render(); }));
  document.querySelectorAll("[data-io-tab]").forEach(item => item.addEventListener("click", () => { state.ioTab = item.dataset.ioTab; render(); }));
  document.querySelectorAll("[data-mode]").forEach(item => item.addEventListener("click", () => { state.captureMode = item.dataset.mode; render(); }));
  document.querySelectorAll("[data-action]").forEach(item => item.addEventListener("click", () => handleAction(item.dataset.action)));
}

function handleAction(action) {
  if (action === "state") state.lens = "state";
  else if (action === "origin") state.lens = "state";
  else if (action === "divergence") { state.lens = "compare"; state.selectedEventId = "f6"; }
  else if (action === "start-capture") { toast("Capture started in demo mode. The Windows collector writes the same MTP contract."); state.lens = "timeline"; }
  else if (action === "cancel") { state.lens = "overview"; }
  else if (action === "refresh") { toast("Target list refreshed. Administrator access is still required for all providers."); }
  render();
}

function toast(message) {
  const element = document.querySelector("#toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.classList.remove("show"), 3200);
}

function bindGlobal() {
  document.querySelectorAll("#lens-nav .nav-item, .sidebar > [data-lens]").forEach(item => item.addEventListener("click", () => { state.lens = item.dataset.lens; render(); }));
  document.querySelector("#new-session")?.addEventListener("click", () => { state.lens = "capture"; render(); });
  document.querySelector("#global-search")?.addEventListener("input", event => { state.query = event.target.value; state.lens = "timeline"; render(); const input = document.querySelector("#global-search"); input?.focus(); input?.setSelectionRange(state.query.length, state.query.length); });
}

(async function boot() {
  bindGlobal();
  state.failure = await fetchTrace("failure");
  state.normal = await fetchTrace("normal");
  state.trace = state.failure;
  render();
})();
