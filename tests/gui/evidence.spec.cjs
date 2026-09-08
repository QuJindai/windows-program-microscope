/* Additional evidence and capture-race browser regressions. Native calls are mocked. */
'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../..');
const sample=JSON.parse(fs.readFileSync(path.join(ROOT,'app/examples/failure.json')));
let browser,server;
const passed=[];
const check=async(name,fn)=>{await fn();passed.push(name);console.log('PASS',name);};
(async()=>{
  server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;const file=path.join(ROOT,'app',pathname==='/'?'index.html':pathname);if(!file.startsWith(path.join(ROOT,'app'))){res.writeHead(403).end();return;}try{res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({...(process.env.PW_CHROMIUM_PATH?{executablePath:process.env.PW_CHROMIUM_PATH}:{}),args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(url);
  await page.waitForFunction(()=>window.Microscope);
  await check('example marker survives direct file import and repeated export/import',async()=>{
    assert.equal(sample.run.data_origin,'example');
    await page.evaluate(trace=>Microscope.importTrace(trace),sample);
    assert.equal(await page.evaluate(()=>Microscope.getState().example),true);
    const again=await page.evaluate(()=>JSON.parse(JSON.stringify(Microscope.getState().trace)));
    await page.evaluate(trace=>Microscope.importTrace(trace),again);
    assert.equal(await page.evaluate(()=>Microscope.getState().example),true);
  });
  const modified=structuredClone(sample);modified.run.id='gui-derived';delete modified.run.data_origin;
  modified.evidence.forEach(e=>e.truth='DERIVED');modified.events[5].duration_ms=0;modified.events[5].duration_observed=false;
  modified.counters=[{id:'process_cpu_percent',name:'Process CPU',unit:'%',samples:[{timestamp_ms:0,value:10},{timestamp_ms:1000,value:25}],evidence_ids:['ev_process']},{id:'working_set_bytes',name:'Working set',unit:'bytes',samples:[{timestamp_ms:0,value:1048576},{timestamp_ms:1000,value:2097152}],evidence_ids:['ev_process']}];
  await check('counter charts and metrics require explicit samples',async()=>{
    await page.evaluate(trace=>Microscope.importTrace(trace),modified);
    assert.match(await page.locator('.overview-header').innerText(),/25.0%/);
    assert.match(await page.locator('.overview-header').innerText(),/2.0 MB/);
    await page.locator('.sidebar [data-lens="timeline"]').click();assert.equal(await page.locator('.counter-chart').count(),2);
  });
  await check('unknown operation duration stays unknown and derived evidence stays derived',async()=>{
    await page.evaluate(()=>Microscope.select('f6'));
    assert.match(await page.locator('.selected-heading').innerText(),/未采集/);
    await page.locator('.sidebar [data-lens="state"]').click();
    const boundary=page.locator('.state-bottom .card').last();assert.equal(await boundary.locator('.badge.real').count(),0);assert.ok(await boundary.locator('.badge.derived').count()>0);
  });
  await check('provenance displays multiple incoming branches and graph path follows explicit edges',async()=>{
    const branched=structuredClone(modified);branched.run.id='branched';branched.edges.push({id:'branch-extra',from:'v_expected_crc',to:'v_result',type:'CAUSES',label:'recorded test branch'});
    await page.evaluate(trace=>Microscope.importTrace(trace),branched);await page.evaluate(()=>Microscope.select('v_result'));
    await page.locator('.sidebar [data-lens="state"]').click();
    assert.ok(await page.locator('.origin-item[data-select="v_expected_crc"]').count()>0);assert.ok(await page.locator('.origin-item[data-select="v_actual_crc"]').count()>0);
    await page.locator('.sidebar [data-lens="flow"]').click();await page.evaluate(()=>Microscope.select('v_expected_crc'));
    await page.locator('#graph-target').selectOption('f10');assert.ok(await page.locator('.graph-edge.path-edge').count()>0);
  });
  await check('unmatched thread sets are labelled incomparable rather than equivalent',async()=>{
    const left=structuredClone(modified);left.run.id='compare-left';
    const right=structuredClone(modified);right.run.id='compare-right';
    right.threads.forEach(t=>{t.id+=10000;t.name=`unmatched-${t.id}`;});right.events.forEach(e=>e.thread_id+=10000);right.io.forEach(e=>e.thread_id+=10000);
    await page.evaluate(t=>Microscope.importTrace(t),left);await page.evaluate(t=>Microscope.importTrace(t,{compare:true}),right);
    await page.locator('#compare-a').selectOption('compare-left');await page.locator('#compare-b').selectOption('compare-right');
    assert.match(await page.locator('.compare-inspector').innerText(),/无可比较线程/);
    assert.equal(await page.locator('[data-action="divergence"]').count(),0);
  });
  await check('IO projection does not duplicate its linked event on system tracks',async()=>{
    const trace=structuredClone(sample);
    trace.events=[{...trace.events[0],id:'linked-file',kind:'file',label:'single-file-read'}];
    trace.io=[{...trace.io[0],id:'linked-io',kind:'file',type:'file',event_id:'linked-file',label:'single-file-read',evidence_ids:trace.events[0].evidence_ids}];
    trace.edges=[];trace.values=[];
    await page.evaluate(t=>Microscope.importTrace(t),trace);
    await page.locator('.sidebar [data-lens="timeline"]').click();
    const track=page.locator('.lane').filter({has:page.locator('.lane-label',{hasText:'文件 I/O'})});
    assert.equal(await track.locator('.event-bar').count(),1);
  });
  await page.close();
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  await context.addInitScript(({sample})=>{
    let session=0;window.__deferred=[];window.__calls=[];
    window.__TAURI__={core:{invoke:async(command,args={})=>{
      window.__calls.push({command,args});
      const trace=JSON.parse(JSON.stringify(sample));trace.run.id=`capture-${session}`;delete trace.run.data_origin;
      if(command==='runtime_status')return{platform:'windows',collector_available:true,capabilities:[{id:'process',available:true}]};
      if(command==='list_processes')return[{pid:321,name:'Mock.exe',path:'C:\\Mock.exe',arch:'x64'}];
      if(command==='list_traces')return[];
      if(command==='start_capture'){session++;return{id:`capture-${session}`,status:'running',ready:true};}
      if(command==='capture_status')return new Promise(resolve=>window.__deferred.push({id:args.id,resolve}));
      if(command==='stop_capture')return{id:args.id,status:'completed',trace};
      throw new Error(`Unexpected mocked command ${command}`);
    }}};
  },{sample});
  const native=await context.newPage();await native.goto(url);await native.waitForFunction(()=>Microscope.getState().processes.length);
  await check('late poll from stopped session cannot resurrect it or replace a newer capture',async()=>{
    await native.locator('[data-action="start-capture"]').click();await native.waitForFunction(()=>window.__deferred.length===1);
    await native.locator('[data-action="stop-capture"]').click();await native.waitForFunction(()=>Microscope.getState().capture.status==='completed');
    await native.locator('.sidebar [data-lens="capture"]').click();await native.locator('[data-action="start-capture"]').click();
    await native.waitForFunction(()=>Microscope.getState().capture.id==='capture-2');
    await native.evaluate(()=>{const pending=window.__deferred[0];pending.resolve({id:pending.id,status:'running',ready:true});});
    await native.waitForTimeout(100);
    assert.equal(await native.evaluate(()=>Microscope.getState().capture.id),'capture-2');assert.equal(await native.evaluate(()=>Microscope.getState().capture.status),'running');
  });
  await check('failed capture keeps its validated partial trace and explicit failure',async()=>{
    await native.waitForFunction(()=>window.__deferred.some(p=>p.id==='capture-2'));
    await native.evaluate(sample=>{const trace=JSON.parse(JSON.stringify(sample));trace.run.id='capture-2';delete trace.run.data_origin;window.__deferred.find(p=>p.id==='capture-2').resolve({id:'capture-2',status:'failed',error:'Probe stopped unexpectedly',trace});},sample);
    await native.waitForFunction(()=>Microscope.getState().capture.status==='failed'&&Microscope.getState().trace.run.id==='capture-2');
    assert.equal(await native.evaluate(()=>Microscope.getState().example),false);assert.match(await native.locator('[role="alert"]').innerText(),/已保留部分记录/);
  });
  await context.close();
  console.log(`${passed.length} evidence GUI regressions passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server?.close();});
