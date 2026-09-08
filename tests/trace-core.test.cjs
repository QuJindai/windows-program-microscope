const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modulePath = path.join(__dirname, '../app/trace-core.js');
let core;
try { core = require(modulePath); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const normal = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../trace/sample-normal.json'), 'utf8'));
const failed = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../trace/sample-failure.json'), 'utf8'));
const minimal = () => ({schema_version:'0.1',run:{id:'test',name:'Test',status:'completed',duration_ms:100,target:{pid:42,name:'probe.exe'},capture_mode:'observe',summary:{}},nodes:[],threads:[],events:[],values:[],edges:[],evidence:[],io:[]});
const event = (id,start,duration,extra={}) => ({id,kind:'phase',phase:id,label:id,start_ms:start,duration_ms:duration,status:'ok',...extra});

test('browser and CommonJS expose the same analysis API', () => {
  assert.ok(core, 'the shared analysis module must exist');
  const context = {};
  vm.runInNewContext(fs.readFileSync(modulePath,'utf8'), context);
  assert.equal(typeof context.TraceCore.validateTrace,'function');
  assert.deepEqual([...Object.keys(context.TraceCore)].sort(),Object.keys(core).sort());
});

test('legacy fixtures remain valid and preserve CRC divergence at completion', () => {
  assert.deepEqual(core.validateTrace(normal()),[]);
  assert.deepEqual(core.validateTrace(failed()),[]);
  const diff = core.firstDivergence(normal(),failed());
  assert.equal(diff.normal.phase,'CheckCRC');
  assert.equal(diff.at_ms,8368);
});

test('malformed collections, invalid numbers, duplicate and dangling references are rejected', () => {
  for (const input of [null,[],42,'x']) assert.ok(core.validateTrace(input).length);
  for (const mutate of [
    t => { t.events={}; }, t => { t.events=[null]; },
    t => { t.run.duration_ms=NaN; }, t => { t.run.duration_ms=true; },
    t => { t.events[0].start_ms=-1; }, t => { t.events[0].duration_ms=Infinity; },
    t => { t.events[0].duration_ms='1'; }, t => { t.events[0].start_ms=true; },
    t => { t.events[0].details={bytes:Infinity}; },
    t => { t.events.push({...t.events[0]}); },
    t => { t.evidence.push({...t.evidence[0]}); },
    t => { t.events[0].node_id='missing'; },
    t => { t.events[0].thread_id='missing'; },
    t => { t.events[0].evidence_ids=['missing']; },
    t => { t.events[0].evidence_ids='ev_user'; },
    t => { t.values[0].event_id='missing'; },
    t => { t.events[0].edge_ids=['missing']; },
    t => { t.events[0].value_id='missing'; },
    t => { t.io[0].event_id=5; },
    t => { t.edges[0].from='missing'; },
    t => { t.io[0].resource_id='missing'; },
    t => { t.counters=[{id:'cpu',name:'CPU',unit:'%',samples:[{timestamp_ms:0,value:'bad'}]}]; },
    t => { t.capabilities={}; },
    t => { t.evidence[0].event_id='missing'; },
    t => { t.resources=[{id:'r',start_ms:-1}]; },
    t => { t.io[0].duration_observed='unknown'; },
    t => { t.events[t.events.length-1].start_ms=1e308; },
  ]) { const trace=normal(); mutate(trace); assert.ok(core.validateTrace(trace).length,mutate.toString()); }
});

test('unknown duration and measured counters validate without fabricated telemetry', () => {
  const trace=minimal();
  trace.events=[event('open',3,null)];
  trace.io=[{id:'io',event_id:'open',kind:'file',operation:'open',start_ms:3,duration_ms:null}];
  trace.counters=[{id:'memory',name:'Working set',unit:'bytes',samples:[{timestamp_ms:1,value:1024},{timestamp_ms:2,value:2048}]}];
  assert.deepEqual(core.validateTrace(trace),[]);
  const summary=core.summarize(trace);
  assert.equal(summary.network_wait_ms,null);
  assert.equal(summary.network_wait_percent,null);
  assert.equal(summary.longest_wait,null);
  assert.equal(summary.counters[0].samples[1].value,2048);
});

test('network occupied time merges overlapping intervals and reports partial observation', () => {
  const trace=minimal();
  trace.io=[{id:'a',type:'network',operation:'read',start_ms:10,duration_ms:50},
    {id:'b',type:'network',operation:'read',start_ms:30,duration_ms:50},
    {id:'c',kind:'network',operation:'read',start_ms:90,duration_ms:30}];
  assert.equal(core.summarize(trace).network_wait_ms,80);
  assert.equal(core.summarize(trace).network_wait_percent,80);
  trace.io.push({id:'d',type:'network',operation:'send',start_ms:50,duration_ms:null});
  const summary=core.summarize(trace);
  assert.equal(summary.network_wait_ms,null);
  assert.equal(summary.observed_network_duration_ms,80);
  assert.equal(summary.unknown_network_duration_count,1);
  assert.equal(summary.network_wait_truth,'UNAVAILABLE');
  trace.run.duration_ms=null;
  assert.equal(core.summarize(trace).observed_network_duration_ms,null);
});

test('comparison ignores concurrent lane scheduling and unrelated thread insertions', () => {
  const a=normal(),b=normal();
  b.threads.push({id:99,name:'Background telemetry'});
  b.events.splice(2,0,event('noise',19,1,{thread_id:99}));
  const partial=core.firstDivergence(a,b);
  assert.equal(partial.kind,'partial');
  assert.equal(partial.normal,null);
  assert.equal(partial.ignored_failed_lanes,1);
  assert.equal(partial.comparable_lanes,3);
  b.events.find(e=>e.phase==='CheckCRC').outcome='bad';
  assert.equal(core.firstDivergence(a,b).normal.phase,'CheckCRC');
  const c=minimal(),d=minimal();
  c.threads=[{id:1,name:'Main'},{id:2,name:'Worker'}];
  d.threads=[{id:91,name:'Main'},{id:92,name:'Worker'}];
  c.events=[event('a',1,1,{thread_id:1}),event('b',2,1,{thread_id:2}),event('c',3,1,{thread_id:1})];
  d.events=[event('b',1,1,{thread_id:92}),event('a',2,1,{thread_id:91}),event('c',3,1,{thread_id:91})];
  assert.equal(core.firstDivergence(c,d),null);
  d.events.push(event('extra',5,1,{thread_id:91}));
  assert.equal(core.firstDivergence(c,d).failed.id,'extra');
});

test('comparison distinguishes an empty capture and reports incomparable thread lanes honestly', () => {
  const a=minimal(),b=minimal();
  assert.equal(core.firstDivergence(a,b),null);
  b.threads=[{id:1,name:'First'}];b.events=[event('x',1,1,{thread_id:1})];
  assert.equal(core.firstDivergence(a,b).failed.id,'x');
  a.threads=[{id:2,name:'Second'}];a.events=[event('x',2,1,{thread_id:2})];
  const result=core.firstDivergence(a,b);
  assert.equal(result.kind,'incomparable');
  assert.equal(result.alignment,'unavailable');
});

test('comparison detects changed I/O resources despite generic phases and ignores run-local identity', () => {
  const a=minimal(),b=minimal();
  a.events=[event('a',1,null,{kind:'file',phase:'read',label:'File read',node_id:'node_a',details:{file_path:'C:\\config-a.ini',pid:10,timestamp_qpc:123}})];
  b.events=[event('b',1,null,{kind:'file',phase:'read',label:'File read',node_id:'node_b',details:{file_path:'C:\\config-b.ini',pid:20,timestamp_qpc:456}})];
  assert.equal(core.firstDivergence(a,b).kind,'divergence');
  b.events[0].details.file_path='C:\\config-a.ini';
  assert.equal(core.firstDivergence(a,b),null);
  delete a.events[0].phase;delete b.events[0].phase;
  assert.equal(core.firstDivergence(a,b),null);
});

test('provenance retains every causal branch and ignores sequence edges and cycles', () => {
  const trace=minimal();
  trace.events=['a','b','c','d','noise'].map((id,i)=>event(id,i,0));
  trace.edges=[{id:'ac',from:'a',to:'c',type:'CAUSES'}, {id:'bc',from:'b',to:'c',type:'CAUSES'},
    {id:'cd',from:'c',to:'d',type:'CAUSES'}, {id:'dc',from:'d',to:'c',type:'CAUSES'},
    {id:'nd',from:'noise',to:'d',type:'SEQUENCE'}];
  const provenance=core.provenance(trace,'d');
  assert.deepEqual(provenance.map(p=>p.id),['d','c','a','b']);
  assert.equal(provenance.find(p=>p.id==='b').parent_id,'c');
  assert.equal(provenance.find(p=>p.id==='b').via_edge_id,'bc');
});

test('provenance keeps both paths through a shared ancestor and renders recorded values', () => {
  const trace=minimal();
  trace.events=['a','b','c','d'].map((id,i)=>event(id,i,0));
  trace.edges=[{id:'ab',from:'a',to:'b',type:'CAUSES'},{id:'ac',from:'a',to:'c',type:'CAUSES'},
    {id:'bd',from:'b',to:'d',type:'CAUSES'},{id:'cd',from:'c',to:'d',type:'CAUSES'}];
  const chain=core.provenance(trace,'d');
  assert.deepEqual(chain.find(row=>row.id==='a').parent_ids,['b','c']);
  assert.deepEqual(chain.find(row=>row.id==='a').via_edge_ids,['ab','ac']);
  trace.values=[{id:'v',name:'result',value:{ok:false}}];
  assert.equal(core.buildGraph(trace).nodes.find(row=>row.id==='v').label,'result = {"ok":false}');
});

test('graph reachability and shortest path use actual edges, including cycles and isolated nodes', () => {
  const trace=minimal();
  trace.events=['a','b','c','d','isolated'].map((id,i)=>event(id,i,0));
  trace.edges=[{id:'ab',from:'a',to:'b',type:'SEQUENCE'}, {id:'bc',from:'b',to:'c',type:'CAUSES'},
    {id:'ac',from:'a',to:'c',type:'CAUSES'}, {id:'cd',from:'c',to:'d',type:'CAUSES'},
    {id:'da',from:'d',to:'a',type:'SEQUENCE'}];
  const graph=core.buildGraph(trace);
  assert.equal(graph.edges.length,5);
  assert.equal(graph.nodes.length,5);
  assert.deepEqual(core.shortestPath(graph,'a','d').nodes.map(n=>n.id),['a','c','d']);
  assert.deepEqual(core.shortestPath(graph,'a','isolated'),{nodes:[],edges:[]});
  assert.deepEqual(core.reachable(graph,'isolated').nodes.map(n=>n.id),['isolated']);
  assert.equal(core.reachable(graph,'d','backward').nodes.length,4);
  const empty=minimal();empty.events=[event('x',0,1),event('y',1,1)];
  assert.deepEqual(core.buildGraph(empty).edges,[]);
});

test('Perfetto emits microsecond timestamps, real metadata, measured counters and explicit forward causal flows', () => {
  const trace=minimal(); trace.run.started_at='2026-09-08T00:00:00Z';
  trace.threads=[{id:'worker',name:'Worker'}];
  trace.events=[event('a',1.5,2,{thread_id:'worker'}),event('point',4,null,{thread_id:'worker'}),event('b',5,1,{thread_id:'worker'})];
  trace.edges=[{id:'causal',from:'a',to:'b',type:'CAUSES'}, {id:'ordered',from:'point',to:'b',type:'SEQUENCE'}, {id:'backwards',from:'b',to:'a',type:'CAUSES'}];
  trace.counters=[{id:'cpu',name:'CPU',unit:'%',samples:[{timestamp_ms:7,value:12.5}]}];
  const exported=core.toPerfetto(trace),rows=exported.traceEvents;
  assert.equal(rows.find(e=>e.ph==='X'&&e.args.mtp_id==='a').ts,1500);
  assert.equal(rows.find(e=>e.ph==='X'&&e.args.mtp_id==='a').dur,2000);
  assert.equal(rows.find(e=>e.ph==='i').args.duration_observed,false);
  assert.deepEqual(rows.filter(e=>e.ph==='s'||e.ph==='f').map(e=>e.ts),[3500,5000]);
  assert.equal(rows.find(e=>e.ph==='C').ts,7000);
  assert.deepEqual(rows.find(e=>e.ph==='C').args,{value:12.5});
  assert.ok(rows.some(e=>e.name==='process_name'&&e.ph==='M'));
  assert.ok(rows.some(e=>e.name==='thread_name'&&e.args.name==='Worker'));
  assert.equal(exported.metadata.mtp_started_at,'2026-09-08T00:00:00Z');
  assert.equal(exported.metadata.mtp_edges.length,3);
  assert.equal(exported.metadata.timestamp_unit,'us');
  assert.ok(rows.filter(e=>e.ph!=='M').every(e=>Number.isInteger(e.tid)));
  assert.equal(core.toPerfetto(minimal()).traceEvents.filter(e=>e.ph==='C').length,0);
});

test('counter tracks retain a recorded thread and cannot introduce dangling references', () => {
  const trace=minimal(); trace.threads=[{id:'counter-worker',name:'Sampler'}];
  trace.counters=[{id:'cpu',name:'CPU',unit:'%',thread_id:'counter-worker',samples:[{timestamp_ms:7,value:0}]}];
  const rows=core.toPerfetto(trace).traceEvents;
  const thread=rows.find(row=>row.ph==='M'&&row.name==='thread_name');
  assert.equal(rows.find(row=>row.ph==='C').tid,thread.tid);
  assert.notEqual(thread.tid,0);
  trace.counters[0].thread_id='missing';
  assert.ok(core.validateTrace(trace).length);
});
