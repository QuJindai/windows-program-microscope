/* Shared, dependency-free MTP projections. Unknown observations stay null.
 * Perfetto JSON timestamps use microseconds:
 * https://perfetto.dev/docs/getting-started/other-formats
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TraceCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const REQUIRED = ['nodes', 'threads', 'events', 'values', 'edges', 'evidence', 'io'];
  const OPTIONAL = ['changes', 'counters', 'capabilities', 'resources', 'diagnostics'];
  const GRAPH_COLLECTIONS = ['nodes', 'events', 'values', 'io', 'resources'];
  const TRUTHS = new Set(['REAL', 'DERIVED', 'UNAVAILABLE', 'DEBUG_ONLY']);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const nonnegative = value => finite(value) && value >= 0;
  const validTime = value => nonnegative(value) && value <= Number.MAX_SAFE_INTEGER / 1000;
  const string = value => typeof value === 'string' && value.trim().length > 0;
  const identifier = value => string(value) || (Number.isSafeInteger(value) && value >= 0);
  const rows = (trace, key) => Array.isArray(trace?.[key]) ? trace[key].filter(object) : [];
  const knownDuration = item => nonnegative(item.duration_ms) && item.duration_observed !== false;
  const eventEnd = item => item.start_ms + (knownDuration(item) ? item.duration_ms : 0);

  function validateTrace(trace) {
    const errors = [];
    if (!object(trace)) return ['trace must be an object'];
    // JSON parsers can accept overflow such as 1e400. Check nested details too.
    const pending = [[trace, 'trace']], seen = new WeakSet();
    while (pending.length) {
      const [value, location] = pending.pop();
      if (typeof value === 'number' && !Number.isFinite(value)) errors.push(`${location} must be finite`);
      if (value && typeof value === 'object') {
        if (seen.has(value)) continue;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) pending.push([child, `${location}.${key}`]);
      }
    }
    if (trace.schema_version !== '0.1') errors.push('schema_version must be 0.1');
    const run = object(trace.run) ? trace.run : {};
    if (!object(trace.run)) errors.push('run must be an object');
    for (const key of ['id', 'name']) if (!string(run[key])) errors.push(`run.${key} must be a nonempty string`);
    if (!['running', 'completed', 'failed', 'cancelled'].includes(run.status)) errors.push('run.status is invalid');
    if (!['observe', 'deep_trace', 'time_travel'].includes(run.capture_mode)) errors.push('run.capture_mode is invalid');
    if (!validTime(run.duration_ms)) errors.push('run.duration_ms must be finite, nonnegative and safely convertible to microseconds');
    for (const key of ['target', 'summary']) if (!object(run[key])) errors.push(`run.${key} must be an object`);
    if (run.target?.pid != null && (!Number.isSafeInteger(run.target.pid) || run.target.pid < 0)) errors.push('run.target.pid must be a nonnegative integer');
    for (const key of [...REQUIRED, ...OPTIONAL]) {
      if ((REQUIRED.includes(key) || key in trace) && !Array.isArray(trace[key])) errors.push(`${key} must be an array`);
      if (Array.isArray(trace[key])) trace[key].forEach((row, i) => {
        if (!object(row)) errors.push(`${key}[${i}] must be an object`);
      });
    }
    if (Array.isArray(trace.events) && trace.events.length > 100000) errors.push('events exceeds 100000 event limit');
    const ids = new Map(), allGraphIds = new Set();
    for (const key of [...GRAPH_COLLECTIONS, 'threads', 'edges', 'evidence', 'counters', 'capabilities']) {
      const collectionIds = new Set(); ids.set(key, collectionIds);
      for (const [index, row] of rows(trace, key).entries()) {
        const validId = key === 'threads' ? identifier(row.id) : string(row.id);
        if (!validId) { errors.push(`${key}[${index}].id is invalid`); continue; }
        const id = String(row.id);
        if (collectionIds.has(id)) errors.push(`duplicate ${key} id: ${id}`);
        collectionIds.add(id);
        if (GRAPH_COLLECTIONS.includes(key)) {
          if (allGraphIds.has(id)) errors.push(`duplicate graph id: ${id}`);
          allGraphIds.add(id);
        }
      }
    }
    function textFields(row, fields, location) {
      for (const key of fields) if (!string(row[key])) errors.push(`${location}.${key} must be a nonempty string`);
    }
    function timestamp(value, location, required = true) {
      if (value == null && !required) return;
      if (!validTime(value)) errors.push(`${location} must be finite, nonnegative and safely convertible to microseconds`);
    }
    function references(row, location) {
      const targets = {node: 'nodes', event: 'events', resource: 'resources', thread: 'threads', edge: 'edges', evidence: 'evidence', io: 'io', value: 'values'};
      for (const [prefix, collection] of Object.entries(targets)) {
        const validId = collection === 'threads' ? identifier : string;
        const field = `${prefix}_id`, plural = `${prefix}_ids`;
        if (row[field] != null && (!validId(row[field]) || !ids.get(collection).has(String(row[field])))) errors.push(`${location} references unknown ${field}: ${row[field]}`);
        if (plural in row) {
          if (!Array.isArray(row[plural])) errors.push(`${location}.${plural} must be an array`);
          else for (const id of row[plural]) {
            if (!validId(id) || !ids.get(collection).has(String(id))) errors.push(`${location} references unknown ${prefix}: ${id}`);
          }
        }
      }
    }
    let previousStart = -Infinity;
    for (const event of rows(trace, 'events')) {
      const location = `event ${event.id}`;
      textFields(event, ['kind', 'label', 'status'], location);
      timestamp(event.start_ms, `${location}.start_ms`);
      timestamp(event.duration_ms, `${location}.duration_ms`, false);
      if (nonnegative(event.start_ms) && event.start_ms < previousStart) errors.push(`events are not ordered at ${event.id}`);
      if (nonnegative(event.start_ms)) previousStart = event.start_ms;
      if ('details' in event && !object(event.details)) errors.push(`${location}.details must be an object`);
      if ('duration_observed' in event && typeof event.duration_observed !== 'boolean') errors.push(`${location}.duration_observed must be boolean`);
    }
    for (const node of rows(trace, 'nodes')) textFields(node, ['kind', 'label'], `node ${node.id}`);
    for (const io of rows(trace, 'io')) {
      textFields(io, ['operation'], `io ${io.id}`);
      if (!string(io.type) && !string(io.kind)) errors.push(`io ${io.id} requires type or kind`);
      timestamp(io.start_ms, `io ${io.id}.start_ms`);
      timestamp(io.duration_ms, `io ${io.id}.duration_ms`, false);
      for (const key of ['bytes', 'bytes_received', 'bytes_sent']) if (key in io && io[key] != null && !nonnegative(io[key])) errors.push(`io ${io.id}.${key} must be finite and nonnegative`);
    }
    for (const value of rows(trace, 'values')) textFields(value, ['name'], `value ${value.id}`);
    for (const thread of rows(trace, 'threads')) {
      if ('cpu_ms' in thread) timestamp(thread.cpu_ms, `thread ${thread.id}.cpu_ms`, false);
    }
    for (const evidence of rows(trace, 'evidence')) {
      textFields(evidence, ['source', 'detail'], `evidence ${evidence.id}`);
      if (!TRUTHS.has(evidence.truth)) errors.push(`evidence ${evidence.id} has invalid truth`);
    }
    for (const edge of rows(trace, 'edges')) {
      textFields(edge, ['from', 'to', 'type'], `edge ${edge.id}`);
      for (const key of ['from', 'to']) if (!allGraphIds.has(edge[key])) errors.push(`edge ${edge.id} references unknown ${key}: ${edge[key]}`);
    }
    for (const counter of rows(trace, 'counters')) {
      textFields(counter, ['name', 'unit'], `counter ${counter.id}`);
      if (!Array.isArray(counter.samples)) errors.push(`counter ${counter.id}.samples must be an array`);
      else {
        let last = -Infinity;
        for (const sample of counter.samples) {
          if (!object(sample)) { errors.push(`counter ${counter.id} sample must be an object`); continue; }
          timestamp(sample.timestamp_ms, `counter ${counter.id} sample.timestamp_ms`);
          if (!finite(sample.value)) errors.push(`counter ${counter.id} sample.value must be finite`);
          if (nonnegative(sample.timestamp_ms) && sample.timestamp_ms < last) errors.push(`counter ${counter.id} samples must be ordered`);
          if (nonnegative(sample.timestamp_ms)) last = sample.timestamp_ms;
        }
      }
    }
    for (const capability of rows(trace, 'capabilities')) {
      if (typeof capability.available !== 'boolean') errors.push(`capability ${capability.id}.available must be boolean`);
    }
    for (const change of rows(trace, 'changes')) if ('at_ms' in change) timestamp(change.at_ms, 'change.at_ms');
    for (const key of [...REQUIRED, ...OPTIONAL]) for (const row of rows(trace, key)) {
      references(row, `${key} ${row.id}`);
      for (const field of ['start_ms', 'timestamp_ms', 'at_ms', 'end_ms', 'duration_ms', 'cpu_ms']) if (field in row) {
        const nullable = field === 'duration_ms' && ['events', 'io'].includes(key) || field === 'cpu_ms' && key === 'threads';
        timestamp(row[field], `${key} ${row.id}.${field}`, !nullable);
      }
      if ('duration_observed' in row && typeof row.duration_observed !== 'boolean') errors.push(`${key} ${row.id}.duration_observed must be boolean`);
    }
    return errors;
  }

  function unionDuration(intervals) {
    if (!intervals.length) return null;
    intervals.sort((a, b) => a[0] - b[0]);
    let [start, end] = intervals[0], total = 0;
    for (const [nextStart, nextEnd] of intervals.slice(1)) {
      if (nextStart > end) { total += end - start; start = nextStart; end = nextEnd; }
      else end = Math.max(end, nextEnd);
    }
    return total + end - start;
  }

  function summarize(trace) {
    const events = rows(trace, 'events'), run = trace.run || {};
    const duration = nonnegative(run.duration_ms) ? run.duration_ms : null;
    const network = rows(trace, 'io').filter(item => (item.type || item.kind) === 'network');
    const intervals = [], unknown = network.filter(item => !knownDuration(item) || !nonnegative(item.start_ms));
    for (const item of network) if (duration !== null && knownDuration(item) && nonnegative(item.start_ms)) {
      const start = Math.max(0, Math.min(item.start_ms, duration ?? Infinity));
      const end = Math.max(start, Math.min(eventEnd(item), duration ?? Infinity));
      intervals.push([start, end]);
    }
    const observed = unionDuration(intervals);
    const wait = network.length && !unknown.length ? observed : null;
    let longest = null;
    for (const item of events) if (knownDuration(item) && (!longest || item.duration_ms > longest.duration_ms)) longest = item;
    return {
      headline: run.summary?.headline || (run.status === 'completed' ? 'Completed successfully' : 'Run needs attention'),
      duration_ms: duration, event_count: events.length,
      fault_count: events.filter(item => ['fault', 'error'].includes(item.status)).length,
      longest_wait: longest, network_wait_ms: wait,
      network_wait_percent: wait !== null && duration > 0 ? Math.round(wait / duration * 1000) / 10 : null,
      network_wait_truth: wait === null ? 'UNAVAILABLE' : 'DERIVED',
      observed_network_duration_ms: observed, unknown_network_duration_count: unknown.length,
      thread_count: rows(trace, 'threads').length, node_count: rows(trace, 'nodes').length,
      evidence_count: rows(trace, 'evidence').length, counters: rows(trace, 'counters'),
    };
  }

  function threadLanes(trace, sharedNames) {
    const threadNames = new Map(rows(trace, 'threads').map(thread => [String(thread.id), thread.name]));
    const lanes = new Map();
    rows(trace, 'events').forEach((event, index) => {
      const name = threadNames.get(String(event.thread_id));
      const key = sharedNames.has(name) ? `name:${name}` : event.thread_id == null ? '@unassigned' : `id:${event.thread_id}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push({event, index});
    });
    return lanes;
  }

  function firstDivergence(normal, failed) {
    const nameCounts = trace => {
      const counts = new Map();
      for (const thread of rows(trace, 'threads')) if (string(thread.name)) counts.set(thread.name, (counts.get(thread.name) || 0) + 1);
      return counts;
    };
    const leftNames = nameCounts(normal), rightNames = nameCounts(failed);
    const sharedNames = new Set([...leftNames.keys()].filter(name => leftNames.get(name) === 1 && rightNames.get(name) === 1));
    const left = threadLanes(normal, sharedNames), right = threadLanes(failed, sharedNames);
    const comparableLanes = [...left.keys()].filter(key => right.has(key)).length;
    const coverage = {comparable_lanes: comparableLanes, ignored_normal_lanes: left.size - comparableLanes, ignored_failed_lanes: right.size - comparableLanes};
    const resourceFields = ['file_path', 'path', 'registry_key', 'value_name', 'endpoint', 'target', 'source_address', 'source_port', 'destination_address', 'destination_port', 'protocol'];
    const signature = event => {
      const key = [event.phase || event.label, event.kind];
      // ETW phases such as "read" are generic. Preserve observed resource
      // identity, while excluding run-local node IDs, PIDs and clock values.
      if (['file', 'network', 'registry'].includes(event.kind)) key.push(event.label,
        resourceFields.map(field => event[field] ?? event.details?.[field] ?? null));
      return JSON.stringify(key);
    };
    const candidates = [];
    function difference(a, b, samePhase) {
      const first = a?.event, second = b?.event;
      const starts = [first, second].filter(Boolean).map(event => event.start_ms);
      const at = samePhase ? Math.max(eventEnd(first), eventEnd(second)) : Math.min(...starts);
      let reason = 'the execution route changed';
      if (!first || !second) reason = first ? 'an event is missing from the compared thread' : 'an event was added to the compared thread';
      else if (samePhase && first.outcome !== second.outcome) reason = `${first.phase || first.label} outcome changed from ${first.outcome ?? 'unknown'} to ${second.outcome ?? 'unknown'}`;
      else if (samePhase && first.status !== second.status) reason = `status changed from ${first.status} to ${second.status}`;
      return {index: Math.min(a?.index ?? Infinity, b?.index ?? Infinity), normal_index: a?.index ?? null, failed_index: b?.index ?? null,
        at_ms: at, normal: first || null, failed: second || null, reason, alignment: 'thread-semantic', kind: 'divergence', ...coverage};
    }
    const normalEvents = rows(normal, 'events'), failedEvents = rows(failed, 'events');
    if (!normalEvents.length && !failedEvents.length) return null;
    if (!normalEvents.length || !failedEvents.length) return difference(
      normalEvents.length ? {event: normalEvents[0], index: 0} : null,
      failedEvents.length ? {event: failedEvents[0], index: 0} : null, false);
    if (!comparableLanes) return {
      ...difference({event: normalEvents[0], index: 0}, {event: failedEvents[0], index: 0}, false),
      kind: 'incomparable', alignment: 'unavailable', reason: 'runs have no comparable thread lanes',
    };
    // A thread present in only one trace cannot be mapped to an execution lane
    // in the other. No cross-thread causal ordering is inferred.
    for (const [lane, a] of left) {
      const b = right.get(lane);
      if (!b) continue;
      for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const first = a[index], second = b[index];
        if (!first || !second) { candidates.push(difference(first, second, false)); break; }
        if (signature(first.event) !== signature(second.event)) {
          if (b[index + 1] && signature(first.event) === signature(b[index + 1].event)) candidates.push(difference(null, second, false));
          else if (a[index + 1] && signature(a[index + 1].event) === signature(second.event)) candidates.push(difference(first, null, false));
          else candidates.push(difference(first, second, false));
          break;
        }
        if (first.event.outcome !== second.event.outcome || first.event.status !== second.event.status) { candidates.push(difference(first, second, true)); break; }
      }
    }
    candidates.sort((a, b) => a.at_ms - b.at_ms || (a.normal_index ?? Infinity) - (b.normal_index ?? Infinity) || (a.failed_index ?? Infinity) - (b.failed_index ?? Infinity));
    if (candidates.length) return candidates[0];
    return coverage.ignored_normal_lanes || coverage.ignored_failed_lanes ? {
      kind: 'partial', normal: null, failed: null, at_ms: null, index: null, normal_index: null, failed_index: null,
      alignment: 'thread-semantic', reason: 'no divergence in comparable threads; some thread lanes could not be matched', ...coverage,
    } : null;
  }

  function itemLabel(item) {
    if ('name' in item && 'value' in item) return `${item.name} = ${typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}`;
    if ('operation' in item) return `${item.operation} ${item.endpoint || item.path || item.target || ''}`.trim();
    return String(item.label || item.name || item.path || item.id);
  }
  function buildGraph(trace) {
    const nodes = [];
    for (const collection of GRAPH_COLLECTIONS) for (const item of rows(trace, collection)) {
      nodes.push({id: String(item.id), kind: collection === 'io' ? 'io' : collection === 'values' ? 'value' : item.kind || collection.replace(/s$/, ''), label: itemLabel(item), item});
    }
    const valid = new Set(nodes.map(node => node.id));
    return {nodes, edges: rows(trace, 'edges').filter(edge => valid.has(String(edge.from)) && valid.has(String(edge.to)))};
  }
  function adjacency(graph, direction = 'forward') {
    const adjacent = new Map(graph.nodes.map(node => [String(node.id), []]));
    for (const edge of graph.edges) {
      const from = String(edge.from), to = String(edge.to);
      if (!adjacent.has(from) || !adjacent.has(to)) continue;
      if (direction !== 'backward') adjacent.get(from).push({id: to, edge});
      if (direction !== 'forward') adjacent.get(to).push({id: from, edge});
    }
    return adjacent;
  }
  function reachable(graph, id, direction = 'forward') {
    if (!['forward', 'backward', 'both'].includes(direction)) throw new Error('direction must be forward, backward or both');
    const adjacent = adjacency(graph, direction), origin = String(id);
    if (!adjacent.has(origin)) return {nodes: [], edges: []};
    const visited = new Set([origin]), queue = [origin], edgeIds = new Set();
    for (let index = 0; index < queue.length; index++) for (const next of adjacent.get(queue[index])) {
      edgeIds.add(next.edge.id);
      if (!visited.has(next.id)) { visited.add(next.id); queue.push(next.id); }
    }
    return {nodes: graph.nodes.filter(node => visited.has(String(node.id))), edges: graph.edges.filter(edge => edgeIds.has(edge.id))};
  }
  function shortestPath(graph, from, to) {
    const adjacent = adjacency(graph), start = String(from), finish = String(to);
    if (!adjacent.has(start) || !adjacent.has(finish)) return {nodes: [], edges: []};
    const previous = new Map([[start, null]]), queue = [start];
    for (let index = 0; index < queue.length && !previous.has(finish); index++) for (const next of adjacent.get(queue[index])) {
      if (!previous.has(next.id)) { previous.set(next.id, {id: queue[index], edge: next.edge}); queue.push(next.id); }
    }
    if (!previous.has(finish)) return {nodes: [], edges: []};
    const byId = new Map(graph.nodes.map(node => [String(node.id), node])), nodes = [], edges = [];
    let current = finish;
    while (current !== null) {
      nodes.push(byId.get(current));
      const entry = previous.get(current);
      if (entry) edges.push(entry.edge);
      current = entry ? entry.id : null;
    }
    return {nodes: nodes.reverse(), edges: edges.reverse()};
  }
  function provenance(trace, id, limit = 1000) {
    const graph = buildGraph(trace), byId = new Map(graph.nodes.map(node => [node.id, node]));
    const causal = {...graph, edges: graph.edges.filter(edge => edge.type === 'CAUSES')};
    const adjacent = adjacency(causal, 'backward'), origin = String(id), result = [];
    if (!byId.has(origin) || limit <= 0) return result;
    const visited = new Set([origin]), queue = [{id: origin, depth: 0, parent_id: null, via_edge_id: null}];
    for (let index = 0; index < queue.length && result.length < limit; index++) {
      const step = queue[index];
      result.push({...byId.get(step.id), ...step});
      for (const next of adjacent.get(step.id)) if (!visited.has(next.id)) {
        visited.add(next.id);
        queue.push({id: next.id, depth: step.depth + 1, parent_id: step.id, via_edge_id: next.edge.id});
      }
    }
    const included = new Set(result.map(step => step.id)), outgoing = adjacency(causal);
    for (const step of result) {
      const links = step.id === origin ? [] : outgoing.get(step.id).filter(link => included.has(link.id));
      step.parent_ids = [...new Set(links.map(link => link.id))];
      step.via_edge_ids = links.map(link => link.edge.id);
    }
    return result;
  }

  function toPerfetto(trace) {
    const errors = validateTrace(trace);
    if (errors.length) throw new Error(`Invalid MTP trace: ${errors.join('; ')}`);
    const run = trace.run, pid = run.target.pid ?? 0, output = [];
    const threadIds = new Map(), occupied = new Set([0]);
    const nativeId = id => (typeof id === 'number' || /^\d+$/.test(String(id))) && Number.isSafeInteger(Number(id)) && Number(id) >= 0;
    const identifiers = [...rows(trace, 'threads').map(thread => thread.id), ...rows(trace, 'events').map(event => event.thread_id), ...rows(trace, 'counters').map(counter => counter.thread_id)].filter(id => id != null);
    for (const id of identifiers) if (nativeId(id)) { threadIds.set(String(id), Number(id)); occupied.add(Number(id)); }
    let nextId = 1;
    for (const id of identifiers) if (!threadIds.has(String(id))) {
      while (occupied.has(nextId)) nextId++;
      threadIds.set(String(id), nextId); occupied.add(nextId++);
    }
    const tid = id => id == null ? 0 : threadIds.get(String(id)) ?? 0;
    output.push({name: 'process_name', ph: 'M', pid, tid: 0, args: {name: run.target.name || run.name}});
    for (const thread of rows(trace, 'threads')) output.push({name: 'thread_name', ph: 'M', pid, tid: tid(thread.id), args: {name: thread.name || String(thread.id)}});
    for (const event of rows(trace, 'events')) {
      const observed = knownDuration(event);
      const row = {name: event.label, cat: `microscope.${event.kind}`, ph: observed ? 'X' : 'i', ts: event.start_ms * 1000,
        pid, tid: tid(event.thread_id), args: {mtp_id: event.id, phase: event.phase ?? null, outcome: event.outcome ?? null,
          status: event.status, evidence_ids: event.evidence_ids || [], duration_observed: observed, details: event.details || {}}};
      if (observed) row.dur = event.duration_ms * 1000; else row.s = 't';
      output.push(row);
    }
    for (const counter of rows(trace, 'counters')) for (const sample of counter.samples) {
      output.push({name: counter.name, cat: 'microscope.counter', ph: 'C', ts: sample.timestamp_ms * 1000, pid, tid: tid(counter.thread_id), id: counter.id, args: {value: sample.value}});
    }
    const summary = summarize(trace);
    if (summary.network_wait_ms !== null) output.push({name: 'network_wait_ms', cat: 'microscope.derived', ph: 'C', ts: run.duration_ms * 1000,
      pid, tid: 0, args: {value: summary.network_wait_ms}});
    const events = new Map(rows(trace, 'events').map(event => [event.id, event])), exportDiagnostics = [];
    for (const edge of rows(trace, 'edges')) {
      if (edge.type !== 'CAUSES') continue;
      const source = events.get(edge.from), target = events.get(edge.to);
      if (!source || !target) continue;
      if (!knownDuration(source) || eventEnd(source) > target.start_ms) {
        exportDiagnostics.push({code: 'FLOW_NOT_PROJECTED', edge_id: edge.id, reason: !knownDuration(source) ? 'source duration unobserved' : 'source end follows target start'});
        continue;
      }
      const common = {name: edge.label || edge.type, cat: 'microscope.flow', pid, id: edge.id, args: {from: edge.from, to: edge.to, evidence_ids: edge.evidence_ids || []}};
      output.push({...common, ph: 's', ts: eventEnd(source) * 1000, tid: tid(source.thread_id)});
      output.push({...common, ph: 'f', ts: target.start_ms * 1000, tid: tid(target.thread_id), bp: 'e'});
    }
    return {traceEvents: output, displayTimeUnit: 'ms', metadata: {
      mtp_schema_version: trace.schema_version, mtp_run_id: run.id, mtp_started_at: run.started_at ?? null,
      timestamp_unit: 'us', mtp_edges: rows(trace, 'edges'), mtp_evidence: rows(trace, 'evidence'),
      mtp_counters: rows(trace, 'counters'), mtp_capabilities: rows(trace, 'capabilities'),
      mtp_resources: rows(trace, 'resources'), mtp_diagnostics: rows(trace, 'diagnostics'),
      mtp_export_diagnostics: exportDiagnostics,
      mtp_derived_counters: summary.network_wait_ms === null ? [] : [{id: 'network_wait_ms', name: 'network_wait_ms', unit: 'ms', truth: 'DERIVED',
        evidence_ids: [...new Set(rows(trace, 'io').filter(item => (item.type || item.kind) === 'network').flatMap(item => item.evidence_ids || []))]}],
    }};
  }

  return {validateTrace, summarize, firstDivergence, provenance, buildGraph, reachable, shortestPath, toPerfetto};
});
