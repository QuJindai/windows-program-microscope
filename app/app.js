/* Windows 程序显微镜 V0.2 — all lenses project the same validated MTP evidence. */
'use strict';
const state = {
  lens: 'capture', trace: null, example: false, selectedId: null, query: '',
  ioTab: 'network', captureMode: 'observe', runtime: null, processes: [], pid: null,
  durationSeconds: 30, capture: null, captureStarted: null, captureEpoch: 0, runs: [], traces: new Map(),
  examples: new Set(), compareA: null, compareB: null, graphMode: 'all', graphTo: '',
  error: '', busy: false, zoom: 1, pePath: '', pe: null, rowLimit: 250
};
const zh = {
  'Click Open':'点击打开','Load config':'加载配置','Connect device':'连接设备','Read device':'读取设备',
  'Parse response':'解析响应','CheckCRC':'校验 CRC','Retry #1':'重试 #1','Retry #2':'重试 #2',
  'Retry #3':'重试 #3','Retry ×3':'重试 ×3','Timeout':'超时','Process data':'处理数据','Complete':'完成',
  'Startup':'启动','Main':'主线程','Worker':'工作线程','Device I/O':'设备 I/O','Waiting':'等待中',
  'Running':'运行中','completed':'已完成','failed':'失败','running':'采集中','cancelled':'已取消',
  'ok':'正常','error':'错误','fault':'异常','timeout':'超时','observed':'已观察','unknown':'未知',
  'read':'读取','write':'写入','open':'打开','create':'创建','close':'关闭','tcp_read':'TCP 读取',
  'tcp_write':'TCP 写入','tcp_connect':'TCP 连接','file':'文件','network':'网络','registry':'注册表',
  'function':'函数','user_action':'用户操作','exception':'异常','phase':'阶段','thread':'线程',
  'module':'模块','process':'进程','handle':'句柄','observe':'观察','deep_trace':'深度追踪',
  'time_travel':'时间旅行','created':'已创建','modified':'已修改','started':'已启动','attempted':'尝试',
  'success':'成功','crc_ok':'CRC 一致','crc_mismatch':'CRC 不匹配','no_response':'无响应',
  'open_requested':'请求打开','config_loaded':'配置已加载','connected':'已连接','state_updated':'状态已更新',
  'CAUSES':'因果证据','CALLS':'调用','SEQUENCE':'时间顺序','NEXT':'时间顺序','CONTAINS':'包含',
  'Run B · Failed':'运行 B · 失败','Run A · Normal':'运行 A · 正常',
  'FILES':'文件','REGISTRY':'注册表','NETWORK':'网络','PROCESSES':'进程',
  'linux':'Linux（当前环境）','windows':'Windows','darwin':'macOS','value':'值','resource':'资源','node':'节点','event':'事件','4096_bytes':'4,096 字节','19_records':'19 条记录'
};
const label = value => zh[value] || String(value ?? '未采集');
const isExample = trace => trace?.run?.data_origin==='example' || trace?.run?.source==='example';
const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const observedDuration = item => item?.duration_observed===false ? null : item?.duration_ms;
const runtimeReason = () => state.runtime?.platform==='linux' || state.runtime?.platform==='darwin' ? '当前环境不支持 Windows 实时采集。请在 Windows 桌面客户端采集；这里可以打开和分析 MTP 记录。' : state.runtime?.collector_available ? '采集器已就绪。选择目标进程后即可开始。' : state.runtime?.reason || '正在检查本机采集能力…';
const fmtTime = ms => Number.isFinite(Number(ms)) && ms != null ? `${(Number(ms)/1000).toFixed(3)} s` : '未采集';
const fmtDuration = ms => ms == null ? '未采集' : Number(ms)>=1000 ? `${(Number(ms)/1000).toFixed(2)} s` : `${Number(ms).toFixed(Number.isInteger(Number(ms))?0:2)} ms`;
const arr = key => state.trace?.[key] || [];
const allItems = () => [...arr('events'),...arr('io'),...arr('values'),...arr('nodes'),...arr('resources')];
const byId = id => allItems().find(item => String(item.id)===String(id));
const selected = () => byId(state.selectedId) || null;
const selectedEvent = () => {
  const item=selected();
  return arr('events').find(e=>String(e.id)===String(item?.event_id)) || (arr('events').includes(item) ? item : arr('events').find(e=>String(e.node_id)===String(item?.id))) || (item?.start_ms != null ? item : null);
};
const fault = item => ['fault','error','failed','timeout'].includes(item?.status);
const itemClass = item => fault(item) ? 'fault' : String(item?.kind || item?.type || '').replace(/[^a-z_]/g,'');
const itemLabel = item => label(item?.label || item?.name || item?.operation || item?.id || '未选择事件');
const statusLabel = item => label(item?.status || 'unknown');
const badge = truth => `<span class="badge ${{REAL:'real',DERIVED:'derived',DEBUG_ONLY:'debug',UNAVAILABLE:'unavailable'}[truth] || 'unavailable'}">${{REAL:'真实',DERIVED:'派生',DEBUG_ONLY:'仅调试',UNAVAILABLE:'不可用'}[truth] || '未采集'}</span>`;
const evidenceFor = item => arr('evidence').filter(e => (item?.evidence_ids || []).includes(e.id));
const itemTruth = item => item?.truth || evidenceFor(item)[0]?.truth || 'UNAVAILABLE';
const detailText = item => item?.outcome ? label(item.outcome) : item?.endpoint || item?.path || item?.detail || Object.entries(item?.details||{}).slice(0,2).map(([k,v])=>`${k}: ${typeof v==='object'?JSON.stringify(v):v}`).join(' · ') || '无附加详情';
const kv = pairs => `<dl class="kv">${pairs.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v ?? '未采集')}</dd>`).join('')}</dl>`;
const card = (title,body,cls='',small='') => `<section class="card ${cls}"><div class="card-title"><span>${title}</span>${small?`<small>${small}</small>`:''}</div><div class="card-body">${body}</div></section>`;
const header = (title,subtitle,actions='') => `<div class="view-header"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="view-actions">${actions}</div></div>`;
const noData = (title='尚未打开运行记录',detail='选择正在运行的 Windows 进程开始采集，或打开已有的 MTP 记录。') => `<div class="empty-page"><div class="empty"><span class="empty-icon">◎</span><strong>${esc(title)}</strong><p>${esc(detail)}</p><div class="empty-actions"><button class="button-primary" data-lens="capture">开始采集</button><button class="button-secondary" data-action="import">打开记录</button><button class="button-secondary" data-action="example">打开示例</button></div></div></div>`;
const invoke = (command,args={}) => {
  const native = window.__TAURI__?.core?.invoke;
  if (!native) return Promise.reject(new Error('当前为浏览器预览。请在 Windows 桌面客户端中使用本地采集。'));
  return native(command,args);
};
function notify(message,error=false) {
  const toast=document.querySelector('#toast'); toast.textContent=message; toast.classList.add('show');
  toast.style.borderColor=error?'#ad5c69':'';clearTimeout(notify.timer);notify.timer=setTimeout(()=>toast.classList.remove('show'),5500);
}
function errorMessage(error) { return typeof error==='string'?error:error?.message || JSON.stringify(error); }
function reportError(error) { state.error=errorMessage(error);notify(state.error,true);render(); }
function validate(trace) {
  if (!window.TraceCore) throw new Error('分析模块未加载，请重新打开程序。');
  const errors=TraceCore.validateTrace(trace);
  if (errors.length) throw new Error(`记录校验失败：${errors.slice(0,4).join('；')}${errors.length>4?`（共 ${errors.length} 项）`:''}`);
}
function installTrace(trace,{example=false,lens=state.lens}={}) {
  validate(trace);
  example=example||isExample(trace);
  const oldId=state.trace?.run?.id;
  state.trace=trace;state.example=example;state.error='';state.traces.set(String(trace.run.id),trace);
  if (example) state.examples.add(String(trace.run.id));
  else state.examples.delete(String(trace.run.id));
  state.selectedId=oldId===trace.run.id && byId(state.selectedId) ? state.selectedId : trace.events?.find(fault)?.id || trace.events?.[0]?.id || trace.io?.[0]?.id || null;
  if (!state.compareA) state.compareA=String(trace.run.id);
  if (!state.compareB || state.compareB===state.compareA) state.compareB=String(trace.run.id);
  state.lens=lens;state.graphMode='all';state.graphTo='';state.rowLimit=250;
  render();
}
async function importTrace(input,{compare=false}={}) {
  try {
    const trace=typeof input==='string'?JSON.parse(input):input;
    validate(trace);
    if (compare) {
      state.traces.set(String(trace.run.id),trace);if(isExample(trace))state.examples.add(String(trace.run.id));state.compareB=String(trace.run.id);state.lens='compare';state.error='';render();
      notify('已载入运行 B，可以与当前记录对比。');
    } else { installTrace(trace,{lens:'overview'});notify('记录已校验并打开。'); }
    return true;
  } catch(error) { reportError(error instanceof SyntaxError?new Error('文件不是有效 JSON。当前运行记录已保留。'):error);return false; }
}
async function openExample(id) {
  document.querySelector('#example-dialog').close();state.busy=true;render();
  try {
    const result=await fetch(`examples/${id}.json`);
    if (!result.ok) throw new Error('无法打开示例文件。');
    const trace=await result.json();trace.run.data_origin='example';installTrace(trace,{example:true,lens:'overview'});
    if (id==='normal') state.compareA=String(trace.run.id);else state.compareB=String(trace.run.id);
    notify('已打开示例数据；这些数据不代表本机采集结果。');
  } catch(error) { reportError(error); } finally {state.busy=false;render();}
}
async function loadStoredTrace(id,{compareSide=null}={}) {
  if (!id) return;
  try {
    const trace=state.traces.get(String(id)) || await invoke('load_trace',{id});validate(trace);
    state.traces.set(String(trace.run.id),trace);
    if(isExample(trace))state.examples.add(String(trace.run.id));
    if (compareSide) {state[compareSide]=String(trace.run.id);render();}
    else installTrace(trace,{example:state.examples.has(String(id)),lens:state.lens==='capture'?'overview':state.lens});
  } catch(error){reportError(error);}
}
async function refreshRuns() {
  if (!window.__TAURI__?.core?.invoke) return;
  try { const runs=await invoke('list_traces');if(!Array.isArray(runs))throw new Error('记录列表格式不正确。');state.runs=runs;render();}
  catch(error){reportError(error);}
}
async function refreshProcesses() {
  state.busy=true;state.error='';render();
  try {
    const processes=await invoke('list_processes');
    if(!Array.isArray(processes))throw new Error('进程列表格式不正确。');
    state.processes=processes;
    if(!processes.some(p=>Number(p.pid)===Number(state.pid)))state.pid=processes[0]?.pid || null;
    notify(`已发现 ${processes.length} 个进程。`);
  } catch(error){state.processes=[];state.pid=null;reportError(error);}
  finally{state.busy=false;render();}
}
let capturePoll=null;
async function finishCapture(result,{epoch=state.captureEpoch,id=state.capture?.id}={}) {
  if(epoch!==state.captureEpoch || !result || result.id!==id || state.capture?.id!==id)return;
  if(['completed','failed','cancelled'].includes(state.capture?.status))return;
  state.capture=result;
  if(result.status==='running'){render();return;}
  clearTimeout(capturePoll);capturePoll=null;state.busy=false;
  if(!['completed','failed','cancelled'].includes(result.status)){reportError(new Error(`无法识别的采集状态：${result.status}`));return;}
  try {
    const trace=result.trace || (result.status==='completed'?await invoke('load_trace',{id:result.id}):null);
    if(epoch!==state.captureEpoch || state.capture?.id!==id)return;
    if(trace){
      installTrace(trace,{lens:'overview'});
      if(result.status==='failed'){state.error=`采集失败，已保留部分记录：${result.error||'请查看采集诊断'}`;notify(state.error,true);render();}
      else notify(result.status==='cancelled'?'已停止，已保留采集结果。':'采集完成，运行记录已保存。');
      await refreshRuns();
    } else if(result.status==='failed')reportError(new Error(`采集失败：${result.error||'采集器未返回错误详情'}`));
    else{render();notify('会话已取消，未产生可保存的记录。');}
  }catch(error){if(epoch===state.captureEpoch)reportError(error);}
}
async function pollCapture() {
  const id=state.capture?.id,epoch=state.captureEpoch;
  if(!id||state.capture?.status!=='running')return;
  try {const result=await invoke('capture_status',{id});await finishCapture(result,{epoch,id});}
  catch(error){if(epoch===state.captureEpoch&&state.capture?.id===id&&state.capture?.status==='running'){state.error=`读取采集状态失败：${errorMessage(error)}`;render();}}
  if(epoch===state.captureEpoch&&state.capture?.id===id&&state.capture?.status==='running')capturePoll=setTimeout(pollCapture,700);
}
async function startCapture() {
  if(state.busy || state.capture?.status==='running')return;
  const duration=Number(state.durationSeconds);
  if(!Number.isInteger(duration)||duration<1||duration>3600){reportError(new Error('采集时长必须为 1～3600 秒的整数。'));return;}
  if(!state.pid || !state.runtime?.collector_available){reportError(new Error('请选择可访问的目标进程，并确保 Windows 采集器可用。'));return;}
  const epoch=++state.captureEpoch;clearTimeout(capturePoll);capturePoll=null;
  state.busy=true;state.error='';render();
  try {
    const result=await invoke('start_capture',{pid:Number(state.pid),durationSeconds:duration});
    if(epoch!==state.captureEpoch)return;
    if(!result?.id)throw new Error('采集器未返回会话标识。');
    state.capture={...result,status:'running'};state.captureStarted=Date.now();state.busy=false;render();
    if(result.status==='running')capturePoll=setTimeout(pollCapture,100);else await finishCapture(result,{epoch,id:result.id});
  }catch(error){if(epoch===state.captureEpoch){state.busy=false;reportError(error);}}
}
async function stopCapture() {
  if(state.capture?.status!=='running'||state.busy)return;
  const id=state.capture.id,epoch=state.captureEpoch;state.busy=true;render();
  try {const result=await invoke('stop_capture',{id});await finishCapture(result,{epoch,id});}
  catch(error){if(epoch===state.captureEpoch)reportError(error);}
  finally{if(epoch===state.captureEpoch){state.busy=false;render();}}
}

async function saveTrace() {
  if(!state.trace)return;
  try { const run=await invoke('save_trace',{trace:state.trace});state.runs=state.runs.filter(r=>r.id!==run.id).concat(run);notify('运行记录已保存，可在记录列表中重新打开。');render();}
  catch(error){reportError(error);}
}
function downloadTrace(format) {
  if(!state.trace)return;
  try {
    const value=format==='perfetto'?TraceCore.toPerfetto(state.trace):state.trace;
    const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;
    a.download=`${String(state.trace.run.id).replace(/[^a-zA-Z0-9_-]/g,'_')}${state.example?'-example':''}.${format==='perfetto'?'perfetto':'mtp'}.json`;
    a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);notify(`已导出 ${format==='perfetto'?'Perfetto':'MTP'} 记录。`);
  } catch(error){reportError(error);}
}
function selectItem(id) {
  if(!byId(id))return;
  state.selectedId=id;render();
}
function getRuns() {
  const map=new Map(state.runs.map(run=>[String(run.id),run]));
  for(const [id,trace] of state.traces)map.set(id,trace.run);
  return [...map.values()];
}
function runOptions(value,placeholder='选择运行记录') {
  return `<option value="">${placeholder}</option>${getRuns().map(r=>`<option value="${esc(r.id)}" ${String(r.id)===String(value)?'selected':''}>${state.examples.has(String(r.id))?'示例 · ':''}${esc(label(r.name||r.id))}</option>`).join('')}`;
}
function runControls() {
  return `<div class="run-controls"><select id="run-select" class="select-control" aria-label="选择运行记录">${runOptions(state.trace?.run?.id)}</select><div class="run-buttons"><button class="button-secondary compact" data-action="import">导入记录</button><button class="button-secondary compact" data-action="save" ${!window.__TAURI__?.core?.invoke?'disabled title="在桌面客户端中保存"':''}>保存</button><button class="button-secondary compact" data-action="export-mtp">导出 MTP</button><button class="button-secondary compact" data-action="export-perfetto">导出 Perfetto</button><button class="button-secondary compact" data-action="diagnostics">采集诊断 (${arr('diagnostics').length})</button></div></div>`;
}
function eventRows(events,{io=false}={}) {
  const rows=events.slice(0,state.rowLimit);
  return `<table class="event-table ${io?'io-table':''}"><thead><tr><th>时间</th><th>${io?'操作':'事件'}</th><th>${io?'路径或端点':'类型 / 证据'}</th><th>${io?'耗时':'详情'}</th>${io?'<th>状态</th>':''}</tr></thead><tbody>${rows.length?rows.map(item=>`<tr tabindex="0" data-select="${esc(item.id)}" class="${String(state.selectedId)===String(item.id)?'selected':''}"><td class="number">${fmtTime(item.start_ms)}</td><td title="${esc(itemLabel(item))}"><span class="status-dot ${itemClass(item)}"></span>${esc(itemLabel(item))}</td><td title="${esc(io?(item.endpoint||item.path||'未采集'):label(item.kind))}">${io?esc(item.endpoint||item.path||'未采集'):badge(itemTruth(item))}</td><td class="detail-cell" title="${esc(detailText(item))}">${io?fmtDuration(observedDuration(item)):esc(detailText(item))}</td>${io?`<td class="${fault(item)?'red':''}">${esc(statusLabel(item))}</td>`:''}</tr>`).join(''):'<tr><td colspan="5" class="muted">当前筛选范围没有已记录事件。</td></tr>'}</tbody></table>${events.length>rows.length?`<div class="card-body"><button class="button-secondary compact" data-action="more-rows">继续显示（已显示 ${rows.length} / ${events.length}）</button></div>`:''}`;
}
function renderInspector() {
  const item=selected(),event=selectedEvent(),evidence=evidenceFor(item);
  if(!item)return card('选中事件','<div class="empty"><span class="empty-icon">⌖</span><p>点击事件、图节点或时间线标记，查看同一条记录的证据。</p></div>','inspector');
  const details=Object.entries(item.details||{});
  const source=evidence.map(e=>e.source).filter(Boolean).join('；') || item.source || '未记录';
  return `<aside class="card inspector"><div class="card-title"><span>选中事件</span><small>${esc(item.id)}</small></div><div class="card-body"><div class="selected-heading"><span class="event-glyph ${itemClass(item)}">${fault(item)?'!':'◎'}</span><div><h2 class="${fault(item)?'red':'amber'}">${esc(itemLabel(item))}</h2><p class="muted number">${fmtTime(event?.start_ms)}${event?` · ${fmtDuration(observedDuration(event))}`:''}</p></div></div>${kv([['线程',event?.thread_id!=null?`线程 ${event.thread_id}`:null],['进程',state.trace?.run?.target?.name],['类别',label(item.kind||item.type)],['结果',label(item.outcome||item.status||'unknown')],['来源',source],['记录 ID',item.id]])}<h3>事件说明</h3><p class="explain">${esc(detailText(item))}。${fault(item)?'该记录标记了异常结果；具体原因请核对附带证据。':'此处仅展示记录中可验证的信息。'}</p>${details.length?`<h3>记录字段</h3>${kv(details.map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):v]))}`:''}<h3>相关证据（${evidence.length}）</h3>${evidence.length?evidence.map(e=>`<div class="evidence-item"><div><strong class="cyan">${esc(e.source)}</strong>${badge(e.truth)}</div><p>${esc(e.detail||e.description||'来源未附加说明')}</p></div>`).join(''):`<div class="evidence-item"><div><span>未附加来源证据</span>${badge('UNAVAILABLE')}</div><p>没有证据时，不将事件升级为真实或因果结论。</p></div>`}<div class="inspector-actions"><button class="button-secondary compact" data-lens="state">追溯值来源</button><button class="button-secondary compact" data-lens="timeline">转到时间线</button></div></div></aside>`;
}
function observedCounter(name) {
  const list=arr('counters').filter(c=>[c.id,c.name,c.kind,c.metric].some(n=>String(n||'').toLowerCase().includes(name)));
  const c=list.at(-1);if(!c)return null;
  const v=c.value ?? c.samples?.at(-1)?.value;return v==null?null:{value:v,unit:c.unit||'',item:c};
}
function renderOverview() {
  if(!state.trace)return header('程序总览','从真实运行记录中观察行为与证据。')+noData();
  const summary=TraceCore.summarize(state.trace),run=state.trace.run;
  const cpu=observedCounter('cpu'),mem=observedCounter('memory')||observedCounter('working_set');
  const metrics=[['▧','CPU',cpu?`${Number(cpu.value).toFixed(1)}${cpu.unit||'%'}`:null],['▤','内存',mem?mem.unit==='bytes'?`${(Number(mem.value)/1048576).toFixed(1)} MB`:`${Number(mem.value).toLocaleString()} ${mem.unit}`:null],['⚙','线程记录',arr('threads').length?String(arr('threads').length):null],['◎','网络事件',arr('io').filter(i=>i.type==='network').length?String(arr('io').filter(i=>i.type==='network').length):null]];
  return `<div class="overview-header"><div class="overview-heading"><h1>程序总览</h1><p>${esc(run.target?.name)} · ${esc(statusLabel(run))}</p></div>${metrics.map(([icon,title,value])=>`<div class="metric-tile"><span class="metric-icon">${icon}</span><div><small>${title}</small><strong class="${value==null?'missing':''}">${esc(value??'未采集')}</strong></div></div>`).join('')}</div><div class="summary-strip"><div class="summary-box ${summary.fault_count?'failure':''}"><span class="summary-icon">${summary.fault_count?'!':'✓'}</span><div><strong>${summary.fault_count?'记录包含异常':'运行记录已载入'}</strong><p>${summary.event_count} 个事件 · 持续 ${fmtDuration(run.duration_ms)}</p></div></div><div class="summary-box warning"><span class="summary-icon">△</span><div><strong>${summary.fault_count?'值得检查':'运行事实'}</strong><p>${summary.fault_count?`观察到 ${summary.fault_count} 个异常结果`:'尚未观察到标记为异常的事件'}</p></div></div><div class="summary-box"><span class="summary-icon">▤</span><div><strong>已附加 ${summary.evidence_count} 条证据</strong><p>选择事件，核对来源与能力边界</p></div></div></div><div class="overview-content"><div class="overview-left"><section class="card overview-events"><div class="card-title"><span>最近的重要事件</span><small>${arr('events').length} 条已记录</small></div><div class="table-wrap grow">${eventRows(arr('events'))}</div></section><div class="facts-grid">${card('运行事实',kv([['采集模式',label(run.capture_mode)],['目标程序',run.target?.name],['持续时间',fmtDuration(run.duration_ms)],['网络等待',summary.network_wait_ms==null?'未采集':`${fmtDuration(summary.network_wait_ms)}（区间并集）`],['数据来源',state.example?'示例数据':label(run.source||run.capture_mode||'导入记录')]]))}${card('选择运行记录',runControls())}</div></div>${renderInspector()}</div>`;
}
function counterLane(name,title,color) {
  const c=observedCounter(name)||(name==='memory'?observedCounter('working_set'):null);if(!c)return lane(title,[],null,'未采集');
  let samples=Array.isArray(c.item.samples)?c.item.samples:arr('counters').filter(x=>x.name===c.item.name && x.start_ms!=null).map(x=>({at_ms:x.start_ms,value:x.value}));
  if(samples.length<2)return lane(title,[],null,`已记录 ${c.value} ${c.unit}；没有连续采样`);
  const max=Math.max(...samples.map(s=>Number(s.value)),1),duration=Math.max(state.trace.run.duration_ms,1);
  const points=samples.map(s=>`${Math.max(0,Math.min(1000,Number(s.at_ms??s.start_ms??s.timestamp_ms??0)/duration*1000))},${40-Number(s.value)/max*32}`).join(' ');
  return `<div class="lane"><div class="lane-label">${esc(title)}</div><div class="lane-track"><svg class="counter-chart" viewBox="0 0 1000 46" preserveAspectRatio="none" aria-label="${esc(title)}已记录计数器"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/></svg></div></div>`;
}
function lane(title,events,duration=null,missing='') {
  const max=Math.max(duration??state.trace?.run.duration_ms??1,1),position=selectedEvent()?.start_ms;
  return `<div class="lane"><div class="lane-label">${esc(title)}</div><div class="lane-track">${events.slice(0,700).map(e=>{const left=Math.min(99.6,Math.max(0,e.start_ms/max*100));const width=Math.min(100-left,Math.max(.4,(observedDuration(e)||0)/max*100));return `<button class="event-bar ${itemClass(e)} ${String(state.selectedId)===String(e.id)?'selected':''}" style="left:${left}%;width:${width}%" data-select="${esc(e.id)}" title="${esc(itemLabel(e))} · ${fmtTime(e.start_ms)}">${esc(itemLabel(e))}</button>`;}).join('')}${!events.length && missing?`<span class="missing-data">${esc(missing)}</span>`:''}${position!=null?`<span class="chart-playhead" style="left:${Math.min(100,position/max*100)}%"></span>`:''}</div></div>`;
}
function filteredEvents() { const q=state.query.toLocaleLowerCase();return arr('events').filter(e=>!q||`${itemLabel(e)} ${e.label} ${e.thread_id} ${e.id} ${JSON.stringify(e.details||{})}`.toLocaleLowerCase().includes(q)); }
function renderTimeline() {
  if(!state.trace)return header('执行时间线','点击轨道或事件，右侧检查器会同步更新。')+noData();
  const events=filteredEvents(),eventIds=new Set(events.map(e=>String(e.id))),duration=state.trace.run.duration_ms,threadIds=[...new Set(events.map(e=>e.thread_id).filter(v=>v!=null))];
  return header('执行时间线','点击轨道或事件，所有镜片共享当前选择。',`<span class="muted">${events.length} / ${arr('events').length} 个事件</span><input id="timeline-filter" class="filter-input" type="search" placeholder="筛选事件…" value="${esc(state.query)}" aria-label="筛选事件">`)+`<div class="split"><div class="stack"><section class="card timeline-chart grow"><div class="ruler-row"><div class="ruler-label">时间 (s) / 线程</div><div class="ruler-track">${Array.from({length:11},(_,i)=>`<span style="left:${i*10}%">${(duration/1000*i/10).toFixed(1)}</span>`).join('')}</div></div><div class="lane group-lane"><div class="lane-label">⌄　目标进程</div><div class="lane-label">${esc(state.trace.run.target?.name)}</div></div>${threadIds.map(id=>lane(`›　线程 ${id}`,events.filter(e=>e.thread_id===id))).join('')}${events.some(e=>e.thread_id==null)?lane('›　未指定线程',events.filter(e=>e.thread_id==null)):''}<div class="lane group-lane"><div class="lane-label">⌄　系统事件 / 计数器</div><div></div></div>${counterLane('cpu','CPU', '#47cd87')}${counterLane('memory','内存','#9e83e5')}${[['file','文件 I/O'],['registry','注册表'],['network','网络'],['thread','线程生命周期'],['exception','异常'],['module','DLL 加载'],['user_action','用户操作']].map(([kind,title])=>lane(title,[...events.filter(e=>e.kind===kind),...arr('io').filter(e=>!eventIds.has(String(e.event_id)) && e.type===kind && (!state.query || `${e.path} ${e.operation} ${e.endpoint}`.toLowerCase().includes(state.query.toLowerCase())))],duration,'当前记录未包含此类事件')).join('')}</section><div class="legend"><span>已记录事件</span><span class="fault">异常结果</span><span class="derived">连续曲线仅来自已记录计数器</span></div></div>${renderInspector()}</div>`;
}
function graphProjection() {
  const graph=TraceCore.buildGraph(state.trace);
  const connected=new Set(graph.edges.flatMap(e=>[String(e.from),String(e.to)]));
  const eventIds=new Set(arr('events').map(e=>String(e.id)));
  let nodes=graph.nodes.filter(n=>connected.has(String(n.id)) || eventIds.has(String(n.id)));
  if(!nodes.length)nodes=graph.nodes;
  const chosen=state.selectedId;
  let highlight=null;
  if(state.graphMode==='forward'||state.graphMode==='backward')highlight=TraceCore.reachable(graph,chosen,state.graphMode);
  else if(state.graphMode==='path'&&state.graphTo)highlight=TraceCore.shortestPath(graph,chosen,state.graphTo);
  if(highlight?.nodes?.length) {
    const active=new Set(highlight.nodes.map(n=>String(n.id)));
    nodes.sort((a,b)=>Number(active.has(String(b.id)))-Number(active.has(String(a.id))));
  }
  return {graph,nodes:nodes.slice(0,100),highlight,total:nodes.length};
}
function renderGraph() {
  const {graph,nodes,highlight,total}=graphProjection();
  if(!nodes.length)return '<div class="empty graph-empty"><strong>没有图节点</strong><p>当前记录没有可供连线的事件或证据。</p></div>';
  const ids=new Set(nodes.map(n=>String(n.id))),edges=graph.edges.filter(e=>ids.has(String(e.from))&&ids.has(String(e.to)));
  const highlighted=highlight?new Set(highlight.nodes.map(n=>String(n.id))):null;
  const highlightedEdges=highlight?new Set(highlight.edges.map(e=>String(e.id))):null;
  const fullSequence=arr('events').slice().sort((a,b)=>a.start_ms-b.start_ms);
  const selectedIndex=fullSequence.findIndex(e=>String(e.id)===String(state.selectedId));
  const firstIndex=Math.max(0,selectedIndex>24?selectedIndex-12:0);
  const sequence=fullSequence.slice(firstIndex,firstIndex+30);
  const seqPositions=new Map(sequence.map((e,i)=>{const row=Math.floor(i/5),col=row%2?4-i%5:i%5;return [String(e.id),{x:24+col*158,y:42+row*86}];}));
  const drawNode=(id,item,pos,meta)=>`<g class="graph-node ${String(state.selectedId)===String(id)?'selected':''} ${fault(item)?'fault':''} ${highlighted&&!highlighted.has(String(id))?'dim-node':''}" transform="translate(${pos.x},${pos.y})" data-select="${esc(id)}" tabindex="0" role="button" aria-label="${esc(itemLabel(item))}"><rect width="145" height="54"/><text x="12" y="23">${esc(itemLabel(item).slice(0,15))}</text><text class="node-meta" x="12" y="41">${esc(meta)}</text><title>${esc(itemLabel(item))} · ${esc(id)}</title></g>`;
  const route=(a,b)=>{
    if(Math.abs(a.y-b.y)<1)return `M${a.x+(a.x<b.x?145:0)},${a.y+27} L${b.x+(a.x<b.x?0:145)},${b.y+27}`;
    if(Math.abs(a.x-b.x)<1)return `M${a.x+73},${a.y+54} L${b.x+73},${b.y}`;
    return `M${a.x+73},${a.y+54} C${a.x+73},${a.y+76} ${b.x+73},${b.y-20} ${b.x+73},${b.y}`;
  };
  const sequenceLines=sequence.slice(1).map((e,i)=>`<path class="graph-edge sequence" d="${route(seqPositions.get(String(sequence[i].id)),seqPositions.get(String(e.id)))}" marker-end="url(#arrow-sequence)"><title>时间顺序：${esc(itemLabel(sequence[i]))} → ${esc(itemLabel(e))}；不表示调用或因果</title></path>`).join('');
  const connectedIds=new Set(edges.flatMap(e=>[String(e.from),String(e.to)]));
  const connected=nodes.filter(n=>connectedIds.has(String(n.id)));
  const rank=new Map(),incoming=new Map(connected.map(n=>[String(n.id),0]));
  for(const e of edges)incoming.set(String(e.to),incoming.get(String(e.to))+1);
  const queue=connected.filter(n=>incoming.get(String(n.id))===0).map(n=>String(n.id));queue.forEach(id=>rank.set(id,0));
  for(let i=0;i<queue.length;i++)for(const e of edges.filter(e=>String(e.from)===queue[i])) {
    const target=String(e.to);rank.set(target,Math.max(rank.get(target)||0,(rank.get(queue[i])||0)+1));incoming.set(target,incoming.get(target)-1);if(incoming.get(target)===0)queue.push(target);
  }
  const baseY=sequence.length?Math.ceil(sequence.length/5)*86+83:48;
  const groups=new Map();for(const n of connected){const r=rank.get(String(n.id))||0;if(!groups.has(r))groups.set(r,[]);groups.get(r).push(n);}
  const groupHeight=Math.max(1,...[...groups.values()].map(g=>g.length))*87;
  const positions=new Map();let lastY=baseY;
  for(const [r,group]of groups)group.forEach((n,i)=>{const row=Math.floor(r/4),col=row%2?3-r%4:r%4;const pos={x:34+col*190,y:baseY+row*groupHeight+i*87};positions.set(String(n.id),pos);lastY=Math.max(lastY,pos.y);});
  const height=Math.max(430,lastY+(connected.length?95:30));
  return `<svg viewBox="0 0 825 ${height}" width="825" height="${height}" role="img" aria-label="事件时间顺序与显式证据关系图"><defs><marker id="arrow-evidence" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="#ffb52d"/></marker><marker id="arrow-sequence" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="#708896"/></marker></defs>${sequence.length?`<text x="24" y="24" class="graph-label">时间顺序 · ${firstIndex+1}–${firstIndex+sequence.length} / ${fullSequence.length} 个事件 · 灰色连线仅表示时间顺序，不表示调用或因果</text>${sequenceLines}${sequence.map(e=>drawNode(e.id,e,seqPositions.get(String(e.id)),`${fmtTime(e.start_ms)} · 线程 ${e.thread_id??'未记录'}`)).join('')}`:''}${connected.length?`<text x="34" y="${baseY-19}" class="graph-label">显式证据关系 · ${edges.length} 条边</text>`:`<text x="24" y="${baseY}" class="graph-label">当前记录未提供显式证据关系，可在时间线上检查原始事件。</text>`}${edges.map(e=>{
    const a=positions.get(String(e.from)),b=positions.get(String(e.to));const active=!highlightedEdges||highlightedEdges.has(String(e.id));
    return `<path class="graph-edge ${e.type==='CAUSES'?'causes':'sequence'} ${!active?'dim-edge':highlighted?'path-edge':''}" d="${route(a,b)}" marker-end="url(#arrow-${e.type==='CAUSES'?'evidence':'sequence'})"><title>${esc(label(e.type))}: ${esc(e.label||'')}</title></path>`;
  }).join('')}${connected.map(n=>drawNode(n.id,n.item,positions.get(String(n.id)),n.item.start_ms!=null?fmtTime(n.item.start_ms):label(n.kind))).join('')}</svg>${total>100?`<div class="flow-note">关系图显示 ${nodes.length} / ${total} 个节点；选择可达范围将优先显示相关节点。</div>`:''}`;
}

function renderFlow() {
  if(!state.trace)return header('执行流程','从已记录事件和显式关系中检查运行路径。')+noData();
  const graph=TraceCore.buildGraph(state.trace),path=state.graphMode==='path'&&state.graphTo?TraceCore.shortestPath(graph,state.selectedId,state.graphTo):null;
  return header('执行流程','只对记录中明确提供的关系进行可达与路径分析。',`<span class="muted">${graph.nodes.length} 个节点 · ${graph.edges.length} 条显式关系</span>`)+`<div class="split"><section class="card stack" style="gap:0"><div class="flow-toolbar"><label for="graph-mode" class="muted">关系范围</label><select id="graph-mode" class="select-control"><option value="all" ${state.graphMode==='all'?'selected':''}>全部关系</option><option value="backward" ${state.graphMode==='backward'?'selected':''}>反向可达（来源）</option><option value="forward" ${state.graphMode==='forward'?'selected':''}>正向可达（影响）</option><option value="path" ${state.graphMode==='path'?'selected':''}>最短有向路径</option></select><select id="graph-target" class="select-control" aria-label="路径终点"><option value="">选择路径终点…</option>${graph.nodes.slice(0,2000).map(n=>`<option value="${esc(n.id)}" ${String(n.id)===state.graphTo?'selected':''}>${esc(itemLabel(n.item))} · ${esc(n.id)}</option>`).join('')}</select><button class="button-secondary compact" data-action="graph-reset">重置</button></div><div class="flow-note"><div class="legend"><span class="causes">显式因果证据</span><span class="sequence">顺序或其他关系</span></div>${path&&!path.nodes.length?'<p class="amber">当前选择到终点没有已记录的有向路径。</p>':'<p>时间邻近不等于因果；没有关系边的事件独立显示。</p>'}</div><div class="flow-canvas">${renderGraph()}</div></section>${renderInspector()}</div>`;
}
function renderState() {
  if(!state.trace)return header('程序状态','检查当前事件、已捕获字段与值来源。')+noData();
  const event=selectedEvent(),item=selected();
  const thread=arr('threads').find(t=>String(t.id)===String(event?.thread_id));
  const values=arr('values').filter(v=>String(v.event_id)===String(event?.id)||String(v.id)===String(state.selectedId));
  const chain=state.selectedId?TraceCore.provenance(state.trace,state.selectedId):[];
  return header(`状态 · ${fmtTime(event?.start_ms)}`,'当前选择在所有分析镜片中保持一致。',`<span class="badge ${state.example?'example':'derived'}">${state.example?'示例数据':'运行证据'}</span><button class="button-secondary" disabled title="ETW 不记录完整指令执行，无法逆向执行或恢复任意时刻的局部变量。">Ⅱ 时间旅行不可用</button>`)+`<div class="view-body stack"><div class="state-grid">${card('选中线程',kv([['线程',event?.thread_id!=null?`线程 ${event.thread_id}`:null],['线程名称',thread?label(thread.name):null],['记录状态',thread?.state?label(thread.state):null],['当前事件',item?itemLabel(item):null],['CPU 总时间',thread?.cpu_ms!=null?fmtDuration(thread.cpu_ms):null],['事件时间',fmtTime(event?.start_ms)]]))}<section class="card"><div class="card-title"><span>已捕获的值 / 字段</span><small>${values.length} 个显式值</small></div>${values.length?`<div class="table-wrap"><table class="event-table state-values"><thead><tr><th>名称</th><th>值</th><th>类型</th></tr></thead><tbody>${values.map(v=>`<tr data-select="${esc(v.id)}" tabindex="0" class="${String(v.id)===String(state.selectedId)?'selected':''}"><td>${esc(v.name)}</td><td class="cyan mono">${esc(typeof v.value==='object'?JSON.stringify(v.value):v.value)}</td><td>${esc(v.type)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="unsupported"><span class="lock">⊘</span><div><strong>没有记录局部变量</strong>ETW 事件不会自动包含任意原生局部变量。仅在记录明确携带值时显示。</div></div>`}</section>${card('调用栈',`<div class="unsupported"><span class="lock">⊘</span><div><strong>当前记录未提供调用栈</strong>事件先后顺序不能替代调用栈。需要额外的栈采样或调试记录。</div></div>`)}</div>${card('内存内容',`<div class="memory-empty"><span class="empty-icon">▤</span><div><strong>未采集内存快照</strong><p>当前采集模式不读取进程内存。字段值与完整内存内容分别标注，不补造地址、十六进制数据或内存用量。</p></div></div>`)}<div class="state-bottom grow"><section class="card stack" style="gap:0"><div class="card-title"><span>值来源 / 证据分支</span><small>${chain.length} 个来源节点</small></div><div class="scroll-panel grow"><div class="provenance-list">${chain.length?chain.map(p=>`<div class="origin-item ${String(p.id)===String(state.selectedId)?'selected':''}" style="margin-left:${Math.min(p.depth||0,5)*17}px" data-select="${esc(p.id)}" tabindex="0"><strong>${esc(itemLabel(p.item))}</strong><p>${p.parent_id?`通过 ${esc(p.via_edge_id||'显式边')} → ${esc(p.parent_id)}`:'当前追溯目标'} · ${esc(label(p.kind))}</p></div>`).join(''):'<div class="empty"><p>选中对象没有显式来源关系。不能依据时间先后推断值来源。</p></div>'}</div></div></section>${card('证据边界',`<div class="truth-list"><div class="truth-item"><span>事件与附带字段</span>${badge(itemTruth(item))}</div><div class="truth-item"><span>显式关系追溯</span>${badge(chain.length>1?'DERIVED':'UNAVAILABLE')}</div><div class="truth-item"><span>任意局部变量</span>${badge('DEBUG_ONLY')}</div><div class="truth-item"><span>指令级逆向执行</span>${badge('UNAVAILABLE')}</div></div><div class="inspector-actions"><button class="button-primary compact" data-lens="flow">在流程中查看</button><button class="button-secondary compact" data-lens="timeline">转到时间线</button></div>`)}</div></div>`;
}
function hasCapability(kind) {
  const caps=state.trace?.capabilities || state.runtime?.capabilities || [];
  return caps.some(c=>typeof c==='string'?c.toLowerCase().includes(kind):String(c.id||c.name||c.kind||'').toLowerCase().includes(kind)&&c.available!==false&&c.status!=='unavailable'&&c.truth!=='UNAVAILABLE');
}
function renderIO() {
  if(!state.trace)return header('Windows 输入/输出','程序对 Windows 世界做了什么？')+noData();
  const tabNames={file:'文件',registry:'注册表',network:'网络',module:'模块',process:'子进程',handle:'句柄'};
  const items=arr('io').filter(i=>i.type===state.ioTab),changes=arr('changes');
  const resourceItems=arr('resources').filter(r=>r.kind===state.ioTab||r.type===state.ioTab);
  const ioRows=items.length?items:resourceItems;
  return header('Windows 输入/输出','查看文件、注册表、网络与其他系统交互的实际记录。',`<button class="button-secondary" data-action="export-mtp">导出记录</button>`)+`<div class="split"><div class="stack"><div class="tabs">${Object.entries(tabNames).map(([id,title])=>{const count=arr('io').filter(i=>i.type===id).length;return `<button class="tab ${id===state.ioTab?'active':''}" data-io-tab="${id}">${title}<span class="count">${count?`(${count})`:''}</span></button>`;}).join('')}</div><div class="io-summary">${ioRows.length} 条${tabNames[state.ioTab]}记录 · ${arr('io').length} 条 I/O 记录 · ${changes.length} 条已记录变化</div><section class="card grow stack" style="gap:0"><div class="table-wrap grow">${ioRows.length?eventRows(ioRows,{io:true}):`<div class="empty"><span class="empty-icon">⊘</span><strong>没有${tabNames[state.ioTab]}记录</strong><p>${hasCapability(state.ioTab)?'本次采集未返回此类事件。':'当前记录未声明此项能力，不能据此认定没有发生操作。'}</p></div>`}</div></section><div class="grid two"><section class="card"><div class="card-title"><span>观察到的变化</span><small>仅列出记录中的 changes</small></div><div class="changes-list scroll-panel" style="max-height:175px">${changes.length?changes.map(c=>`<div class="change-row"><span class="cyan">${esc(label(c.scope))}</span><span class="path">${esc(c.path)}<br><span class="muted">${esc(c.detail||'')}</span></span><span class="muted">${esc(label(c.action))}</span></div>`).join(''):'<div class="unsupported">没有独立的变化记录；I/O 调用本身不等于持久状态已改变。</div>'}</div></section>${card('能力边界',Object.entries(tabNames).map(([id,title])=>`<div class="capability-row"><span>${title}</span>${badge(arr('io').some(i=>i.type===id)?'REAL':hasCapability(id)?'DERIVED':'UNAVAILABLE')}</div>`).join(''))}</div></div>${renderInspector()}</div>`;
}
function compareRow(event,divergence,side,index,trace) {
  const isDiv=divergence&&(side==='A'?divergence.normal_index===index:divergence.failed_index===index);
  return `<div class="compare-row ${isDiv?'divergence':''}" data-compare-event="${esc(event.id)}" data-run-id="${esc(trace.run.id)}" tabindex="0"><span class="when number">${fmtTime(event.start_ms)}</span><span class="route-dot"></span><span class="route-label">${esc(itemLabel(event))}<small>${esc(label(event.outcome||event.status))}</small></span></div>`;
}
function renderCompare() {
  if(!state.trace)return header('运行对比','对齐同一程序的运行记录，找出最早的行为分歧。')+noData();
  const a=state.traces.get(state.compareA),b=state.traces.get(state.compareB),ready=a&&b&&state.compareA!==state.compareB;
  const comparison=ready?TraceCore.firstDivergence(a,b):null;
  const coverage=comparison&&['partial','incomparable'].includes(comparison.kind)?comparison:null;
  const divergence=coverage?null:comparison;
  const col=(trace,side)=>`<section class="card compare-column ${side==='B'?'right':''}"><div class="compare-head ${side==='B'?'failed':''}"><span>${side==='A'?'✓':'◉'}</span><span>运行 ${side}</span><select id="compare-${side.toLowerCase()}" class="select-control" aria-label="选择运行 ${side}">${runOptions(side==='A'?state.compareA:state.compareB)}</select></div><div class="compare-route">${trace?.events?.slice(0,500).map((e,i)=>compareRow(e,divergence,side,i,trace)).join('')||'<div class="empty"><p>选择已有记录或导入另一次运行。</p></div>'}</div><div class="compare-status">${trace?esc(statusLabel(trace.run)):'未选择'}</div></section>`;
  const value=(event)=>event?label(event.outcome||event.status||event.label):'没有对应事件';
  return header('运行对比','按线程内行为顺序对齐；忽略其他线程插入的无关事件。',`<button class="button-secondary" data-action="compare-import">导入运行 B</button><button class="button-secondary" data-action="example">打开示例</button>`)+`<div class="compare-grid">${col(a,'A')}${col(b,'B')}<aside class="card compare-inspector"><div class="card-title"><span>首次分歧</span><small>${ready&&divergence?fmtTime(divergence.at_ms):''}</small></div><div class="card-body">${!ready?`<h3>请选择两条不同的运行记录</h3><p class="muted">当前记录可作为运行 A。导入另一条记录，或从已打开的记录中选择运行 B。</p>`:divergence?`<h3 class="amber">${esc(itemLabel(divergence.normal||divergence.failed))}</h3><p class="muted">可比较的线程行为在此出现差异。</p><div class="difference-values"><div><small>运行 A</small><strong>${esc(value(divergence.normal))}</strong></div><div><small>运行 B</small><strong>${esc(value(divergence.failed))}</strong></div></div><h3>为什么不同？</h3><p class="explain">${esc(itemLabel(divergence.normal||divergence.failed))}的结果从“${esc(value(divergence.normal))}”变为“${esc(value(divergence.failed))}”。这是记录间的行为差异，不自动证明根因。</p><h3>对应证据</h3>${[divergence.normal,divergence.failed].map((event,i)=>`<div class="evidence-item"><div><strong>运行 ${i?'B':'A'} · ${esc(event?.id||'缺失')}</strong><span class="muted">${fmtTime(event?.start_ms)}</span></div><p>${esc(event?detailText(event):'此运行没有对应事件')}</p><p>${event?.evidence_ids?.length?`关联证据：${esc(event.evidence_ids.join('、'))}`:'没有附加证据标识'}</p></div>`).join('')}<div class="inspector-actions"><button class="button-primary compact" data-action="divergence">打开分歧点</button><button class="button-secondary compact" data-action="divergence-state">追溯值来源</button></div>`:`<h3 class="${coverage?'amber':'green'}">${coverage?.kind==='incomparable'?'无可比较线程，无法判定分歧':coverage?'可比线程内未发现分歧':'未发现可比较行为的差异'}</h3><p class="muted">${coverage?`运行 A 有 ${coverage.ignored_normal_lanes||0} 条、运行 B 有 ${coverage.ignored_failed_lanes||0} 条线程无法匹配。`:'已对齐事件的结果一致。'}此结论不代表未记录的状态、全部线程或程序内部实现完全相同。</p>`}<h3>对比范围</h3>${kv([['程序 A',a?.run?.target?.name],['程序 B',b?.run?.target?.name],['对齐方式','线程内语义顺序'],['未匹配线程',comparison?`A: ${comparison.ignored_normal_lanes||0} · B: ${comparison.ignored_failed_lanes||0}`:'无'],['A 的来源',a?state.examples.has(String(a.run.id))?'示例数据':'运行记录':null],['B 的来源',b?state.examples.has(String(b.run.id))?'示例数据':'运行记录':null]])}</div></aside></div>${a&&b?`<section class="card"><div class="card-title"><span>执行时间线（同起点）</span><small>标记位置使用各自记录的时间戳</small></div><div class="dual-chart">${[a,b].map((trace,i)=>{const max=Math.max(a.run.duration_ms,b.run.duration_ms,1);return `<div class="dual-row"><span>运行 ${i?'B':'A'}</span><div class="dual-track">${trace.events.slice(0,1000).map(e=>`<button style="left:${Math.min(99.7,e.start_ms/max*100)}%" data-compare-event="${esc(e.id)}" data-run-id="${esc(trace.run.id)}" title="${esc(itemLabel(e))} · ${fmtTime(e.start_ms)}"></button>`).join('')}${divergence?`<span class="chart-playhead" style="left:${Math.min(100,divergence.at_ms/max*100)}%"></span>`:''}</div></div>`;}).join('')}</div></section>`:''}`;
}
function capabilityStatus(id,unsupported=false) {
  if(unsupported)return badge('UNAVAILABLE');
  const caps=state.runtime?.capabilities||[];
  const match=caps.find(c=>typeof c==='string'?c.toLowerCase().includes(id):String(c.id||c.name||c.kind||'').toLowerCase().includes(id));
  if(!state.runtime?.collector_available)return badge('UNAVAILABLE');
  if(!match)return badge('UNAVAILABLE');
  if(typeof match==='object'&&(match.available===false||match.truth==='UNAVAILABLE'||match.status==='unavailable'))return badge('UNAVAILABLE');
  return `<span class="badge real">可采集</span>`;
}
function renderCapture() {
  const process=state.processes.find(p=>Number(p.pid)===Number(state.pid));
  const running=state.capture?.status==='running';
  const percent=running?Math.min(98,(Date.now()-state.captureStarted)/(state.durationSeconds*1000)*100):0;
  const groups=[['CPU 与线程',[['thread','线程创建 / 结束'],['cpu','CPU 采样'],['stack','调用栈',true],['function','任意函数调用',true]]],['内存',[['memory','进程内存计数器'],['snapshot','内存快照',true],['locals','局部变量',true]]],['文件与 I/O',[['file','文件操作'],['network','网络 I/O'],['registry','注册表操作']]],['进程与模块',[['process','进程生命周期'],['module','DLL 模块加载'],['ui','窗口与界面事件',true]]]];
  return header('开始程序显微镜会话','选择目标进程并配置采集选项，从多个维度观察程序的运行行为。')+`${state.error?`<div class="error-banner" role="alert">${esc(state.error)}</div>`:''}<div class="capture-layout"><section class="card capture-main">${state.runs.length?`<div class="capture-section"><h2 class="section-heading" style="font-size:16px">已有运行记录</h2><select id="run-select" class="select-control" style="width:100%" aria-label="选择已保存记录">${runOptions(null,'打开已保存的运行记录…')}</select></div>`:''}<div class="capture-section"><h2 class="section-heading"><span class="target-icon">◎</span>选择目标进程</h2><div class="process-picker"><select id="process-select" class="select-control" aria-label="目标进程" ${running?'disabled':''}><option value="">${state.processes.length?'请选择目标进程':'刷新以获取 Windows 进程列表'}</option>${state.processes.map(p=>`<option value="${p.pid}" ${Number(p.pid)===Number(state.pid)?'selected':''}>${esc(p.name)}　·　PID ${p.pid}</option>`).join('')}</select><button class="button-secondary" data-action="refresh-processes" ${state.busy||running?'disabled':''}>↻ 刷新</button></div><div class="process-facts">${kv([['进程名称',process?.name],['PID',process?.pid],['进程路径',process?.path]])}${kv([['架构',process?.arch],['平台',state.runtime?.platform?label(state.runtime.platform):null],['采集会话',running?state.capture.id:'未开始']])}</div></div><div class="capture-section"><h2 class="section-heading"><span>⚙</span>选择采集模式</h2><div class="mode-grid"><button class="mode-card selected" data-mode="observe"><strong><span class="radio"></span>观察（推荐）</strong><p>通过 Windows ETW 采集已支持的系统事件，保留时间戳、来源与能力诊断。</p></button><button class="mode-card" data-mode="deep_trace" disabled title="尚未实现函数插桩与任意参数采集。"><strong><span class="radio"></span>深度追踪</strong><p>函数参数、任意局部变量与完整调用栈需要额外插桩。当前不可用。</p></button><button class="mode-card" data-mode="time_travel" disabled title="ETW 不提供完整指令录制与逆向执行。"><strong><span class="radio"></span>时间旅行</strong><p>完整指令级录制、回放与逆向执行尚未实现。当前不可用。</p></button></div><details class="advanced-options" open><summary>高级选项</summary><div class="advanced-body"><label><input type="checkbox" checked disabled>包含系统事件（ETW）</label><label class="disabled-option"><input type="checkbox" disabled>捕获内存快照（不可用）</label><label class="disabled-option"><input type="checkbox" disabled>自动采集子进程（不可用）</label><label class="disabled-option"><input type="checkbox" disabled>指令级上下文（不可用）</label><label class="duration-label">采集时长 <input id="capture-duration" class="select-control" type="number" min="1" max="3600" step="1" value="${state.durationSeconds}" ${running?'disabled':''}> 秒</label><span class="muted">1～3600 秒 · 最多 100,000 个事件</span></div></details></div><div class="capture-section"><h2 class="section-heading" style="font-size:16px;margin-bottom:4px"><span style="font-size:19px">▧</span>PE 文件检查</h2><div class="pe-form"><input id="pe-path" class="filter-input" placeholder="输入本机 EXE / DLL 的完整路径" value="${esc(state.pePath)}" aria-label="PE 文件路径"><button class="button-secondary compact" data-action="inspect-pe" ${!window.__TAURI__?.core?.invoke?'disabled':''}>检查 PE</button></div>${state.pe?`<p class="pe-result">${esc(state.pe.name||'')} · ${esc(state.pe.arch)} · ${esc(state.pe.format)} · ${state.pe.sections?.length||0} 个节 · 入口 RVA ${esc(state.pe.entry_point_rva)}<br>静态文件头检查，不代表已执行路径。</p>`:''}</div><div class="capture-footnote"><span>ⓘ</span><span>采集能力以本机采集器报告为准。权限不足、提供程序不可用及事件丢失会记录在诊断信息中。</span></div></section><div class="capture-side"><section class="card capture-capabilities"><div class="card-title"><span>▣　将要采集的内容</span></div>${groups.map(([title,rows])=>`<div class="cap-group"><h3>⌄　${title}</h3>${rows.map(([id,name,unsupported])=>`<div class="capability-row"><span>${name}</span>${capabilityStatus(id,unsupported)}</div>`).join('')}</div>`).join('')}<div class="card-body"><p class="muted" style="font-size:11px">没有采集到的项目显示“未采集”，不补零、不生成模拟遥测。</p></div></section>${running?`<div class="capture-progress" role="status"><strong>● ${state.capture.ready===false?'正在启动采集器':'正在采集'} · PID ${state.pid}</strong><p>已运行 ${Math.floor((Date.now()-state.captureStarted)/1000)} 秒 / ${state.durationSeconds} 秒</p><div class="progress-track"><span style="width:${percent}%"></span></div></div>`:`<div class="runtime-notice ${state.runtime?.collector_available?'success':''}">${esc(runtimeReason())}</div>`}<div class="capture-actions">${running?`<button class="button-secondary" data-action="stop-capture" ${state.busy?'disabled':''}>■ 停止并保存</button>`:`<button class="button-secondary" data-action="import">打开记录</button><button class="button-primary" data-action="start-capture" ${!process||!state.runtime?.collector_available||state.busy?'disabled':''}>▶ 开始采集</button>`}</div></div></div>`;
}
function renderFooter() {
  const events=arr('events'),duration=state.trace?.run?.duration_ms || 120000;
  const current=selectedEvent();
  const status=state.capture?.status==='running'?'正在采集':state.trace?state.example?'示例数据':'运行记录':'未开始采集';
  const left=current?Math.max(0,current.start_ms-duration/state.zoom/2):0;
  const start=state.zoom>1?Math.min(left,Math.max(0,duration-duration/state.zoom)):0;
  const end=start+duration/state.zoom;
  const shown=events.filter(e=>e.start_ms>=start&&e.start_ms<=end);
  const sampled=shown.length>1600?shown.filter((_,i)=>i%Math.ceil(shown.length/1600)===0 || shown[i].id===state.selectedId):shown;
  document.querySelector('#timeline-footer').innerHTML=`<div class="timeline-footer-head"><strong>⌁　执行时间线</strong><span class="footer-position">${status}　 │　 ${fmtTime(current?.start_ms??0)}${state.trace?`　/　${fmtTime(duration)}`:''}</span><div class="footer-controls"><button data-action="zoom-out" aria-label="缩小时间线">−</button><input id="timeline-zoom" type="range" min="1" max="10" step="1" value="${state.zoom}" aria-label="时间线缩放"><button data-action="zoom-in" aria-label="放大时间线">＋</button></div></div><div class="footer-track">${sampled.map(e=>`<button class="footer-event ${itemClass(e)} ${String(e.id)===String(state.selectedId)?'selected':''}" style="left:${Math.min(99.7,(e.start_ms-start)/(end-start)*100)}%" data-select="${esc(e.id)}" aria-label="${esc(itemLabel(e))}" title="${esc(itemLabel(e))} · ${fmtTime(e.start_ms)}"></button>`).join('')}${current&&current.start_ms>=start&&current.start_ms<=end?`<span class="chart-playhead" style="left:${(current.start_ms-start)/(end-start)*100}%"></span>`:''}</div><div class="footer-labels">${Array.from({length:11},(_,i)=>`<span style="left:${i*10}%">${((start+(end-start)*i/10)/1000).toFixed(state.trace?1:0)} s</span>`).join('')}</div>`;
}
function render() {
  const view=document.querySelector('#view');
  const oldScroll=new Map([...view.querySelectorAll('.scroll-panel,.table-wrap,.inspector,.view-body,.capture-main,.capture-capabilities,.flow-canvas,.timeline-chart')].map((el,i)=>[`${el.className}-${i}`,el.scrollTop]));
  const lenses={overview:renderOverview,timeline:renderTimeline,flow:renderFlow,state:renderState,io:renderIO,compare:renderCompare,capture:renderCapture};
  try { view.innerHTML=(state.error&&state.lens!=='capture'?`<div class="error-banner" role="alert">${esc(state.error)}</div>`:'')+(lenses[state.lens]||renderCapture)(); }
  catch(error) {view.innerHTML=header('无法显示当前镜片','运行记录已保留。')+`<div class="error-banner">${esc(errorMessage(error))}</div>`;console.error(error);}
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.lens===state.lens));
  document.querySelector('#data-source').textContent=state.trace?state.example?'示例数据':state.trace.run.target?.name||'运行记录':'未加载运行记录';
  document.querySelector('#data-source').classList.toggle('example',state.example);
  document.querySelector('#sidebar-session').innerHTML=state.trace?`<small>目标进程</small><strong>${esc(state.trace.run.target?.name||'未记录')}</strong><small>数据来源</small><span class="${state.example?'amber':''}">${state.example?'示例数据':esc(label(state.trace.run.capture_mode||'导入记录'))}</span><small>当前选择</small><strong title="${esc(state.selectedId||'')}">${esc(selected()?itemLabel(selected()):'未选择')}</strong>`:'';
  renderFooter();
  [...view.querySelectorAll('.scroll-panel,.table-wrap,.inspector,.view-body,.capture-main,.capture-capabilities,.flow-canvas,.timeline-chart')].forEach((el,i)=>{const y=oldScroll.get(`${el.className}-${i}`);if(y)el.scrollTop=y;});
}
async function inspectPE() {
  const path=state.pePath.trim();if(!path){notify('请输入本机 EXE 或 DLL 的完整路径。',true);return;}
  try {state.pe=await invoke('inspect_pe',{path});state.error='';render();notify('PE 文件头检查完成。');}catch(error){reportError(error);}
}
async function openDivergence(lens) {
  const a=state.traces.get(state.compareA),b=state.traces.get(state.compareB);
  if(!a||!b)return;
  const divergence=TraceCore.firstDivergence(a,b);
  if(!divergence||['partial','incomparable'].includes(divergence.kind))return;
  const trace=divergence.failed?b:a,item=divergence.failed||divergence.normal;
  installTrace(trace,{example:state.examples.has(String(trace.run.id)),lens});state.selectedId=item?.id||null;render();
}
function handleAction(action) {
  const handlers={
    example:()=>document.querySelector('#example-dialog').showModal(),
    'close-dialog':()=>document.querySelector('#example-dialog').close(),
    'close-diagnostics':()=>document.querySelector('#diagnostics-dialog').close(),
    diagnostics:()=>{document.querySelector('#diagnostics-body').innerHTML=arr('diagnostics').length?arr('diagnostics').map(d=>`<div class="evidence-item"><div><strong>${esc(d.code||d.id||'诊断记录')}</strong><span>${esc(d.severity||d.level||'')}</span></div><p>${esc(d.message||d.detail||d.reason||JSON.stringify(d))}</p></div>`).join(''):'<p class="muted">当前运行记录没有附加采集诊断。</p>';document.querySelector('#diagnostics-dialog').showModal();},
    import:()=>document.querySelector('#trace-file').click(),
    'compare-import':()=>document.querySelector('#compare-file').click(),
    'refresh-processes':refreshProcesses,'refresh-runs':refreshRuns,
    'start-capture':startCapture,'stop-capture':stopCapture,save:saveTrace,
    'export-mtp':()=>downloadTrace('mtp'),'export-perfetto':()=>downloadTrace('perfetto'),
    'inspect-pe':inspectPE,'graph-reset':()=>{state.graphMode='all';state.graphTo='';render();},
    'more-rows':()=>{state.rowLimit+=250;render();},
    divergence:()=>openDivergence('timeline'),'divergence-state':()=>openDivergence('state'),
    'zoom-out':()=>{state.zoom=Math.max(1,state.zoom-1);renderFooter();},
    'zoom-in':()=>{state.zoom=Math.min(10,state.zoom+1);renderFooter();}
  };
  if(handlers[action])Promise.resolve(handlers[action]()).catch(reportError);
}
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-lens],[data-action],[data-select],[data-example],[data-io-tab],[data-compare-event]');
  if(!button||button.disabled)return;
  if(button.dataset.lens){state.lens=button.dataset.lens;render();}
  else if(button.dataset.action)handleAction(button.dataset.action);
  else if(button.dataset.select)selectItem(button.dataset.select);
  else if(button.dataset.example)openExample(button.dataset.example);
  else if(button.dataset.ioTab){state.ioTab=button.dataset.ioTab;render();}
  else if(button.dataset.compareEvent){const trace=state.traces.get(button.dataset.runId);if(trace){installTrace(trace,{example:state.examples.has(button.dataset.runId),lens:'compare'});state.selectedId=button.dataset.compareEvent;render();}}
});
document.addEventListener('keydown',event=>{
  if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-select],[data-compare-event]')&&!event.target.matches('button')){event.preventDefault();event.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}
});
document.addEventListener('change',async event=>{
  const el=event.target;
  if(el.id==='process-select'){state.pid=Number(el.value)||null;render();}
  if(el.id==='capture-duration')state.durationSeconds=Number(el.value);
  if(el.id==='run-select')await loadStoredTrace(el.value);
  if(el.id==='compare-a')await loadStoredTrace(el.value,{compareSide:'compareA'});
  if(el.id==='compare-b')await loadStoredTrace(el.value,{compareSide:'compareB'});
  if(el.id==='graph-mode'){state.graphMode=el.value;render();}
  if(el.id==='graph-target'){state.graphTo=el.value;state.graphMode='path';render();}
  if(el.id==='timeline-zoom'){state.zoom=Number(el.value);renderFooter();}
  if(el.id==='trace-file'||el.id==='compare-file') {
    const file=el.files?.[0];if(!file)return;
    if(file.size>150*1024*1024){reportError(new Error('记录文件超过 150 MB 限制。'));el.value='';return;}
    await importTrace(await file.text(),{compare:el.id==='compare-file'});el.value='';
  }
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.id==='global-search'||el.id==='timeline-filter') {
    const position=el.selectionStart;state.query=el.value;state.rowLimit=250;state.lens='timeline';render();
    const replacement=document.getElementById(el.id);replacement?.focus();if(replacement?.type==='search')replacement.setSelectionRange(position,position);
  }
  if(el.id==='pe-path')state.pePath=el.value;
  if(el.id==='capture-duration')state.durationSeconds=Number(el.value);
});
window.Microscope={getState:()=>state,importTrace,loadStoredTrace,select:selectItem,startCapture,stopCapture,render,refreshProcesses,openExample};
(async function boot(){
  render();
  if(!window.__TAURI__?.core?.invoke) {
    state.runtime={platform:'浏览器预览',collector_available:false,reason:'浏览器预览无法访问 Windows 进程。请使用 Windows 桌面客户端开始采集；此处仍可导入和分析记录。',capabilities:[]};render();return;
  }
  try {state.runtime=await invoke('runtime_status');render();if(state.runtime.collector_available)await refreshProcesses();await refreshRuns();}
  catch(error){state.runtime={platform:'未知',collector_available:false,reason:errorMessage(error),capabilities:[]};reportError(error);}
})();
