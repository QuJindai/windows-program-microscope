/* Behavioral GUI verification. Native bridge scenarios below are explicitly mocked;
 * actual Windows collector/runtime acceptance is tests/windows + tests/runtime. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {spawn}=require('node:child_process');const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../..');const OUT=path.join(ROOT,'test-results/gui');
const normal=JSON.parse(fs.readFileSync(path.join(ROOT,'trace/sample-normal.json')));
const failure=JSON.parse(fs.readFileSync(path.join(ROOT,'trace/sample-failure.json')));
const results=[];let browser,server;
async function check(name,fn){await fn();results.push({name,status:'passed'});console.log('PASS',name);}
async function ready(url){for(let i=0;i<100;i++){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('Review server did not start');}
(async()=>{
 fs.mkdirSync(OUT,{recursive:true});
 const port=18000+Math.floor(Math.random()*9000),url=`http://127.0.0.1:${port}`;
 server=spawn(process.env.PYTHON || (process.platform==='win32'?'python':'python3'),['tools/serve.py','--port',String(port)],{cwd:ROOT,stdio:'ignore'});await ready(url);
 browser=await chromium.launch({...(process.env.PW_CHROMIUM_PATH?{executablePath:process.env.PW_CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
 const page=await context.newPage();const errors=[];const fixtureRequests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/examples/'))fixtureRequests.push(r.url());});
 await page.goto(url);await page.waitForFunction(()=>window.Microscope);
 await check('cold start has no implicit example or synthetic capture',async()=>{assert.equal((await page.evaluate(()=>Microscope.getState())).trace,null);assert.equal(fixtureRequests.length,0);assert.equal(await page.locator('[data-action="start-capture"]').isDisabled(),true);});
 await check('explicit example validates and remains labelled',async()=>{await page.locator('[data-action="example"]').first().click();await page.locator('[data-example="failure"]').click();await page.waitForFunction(()=>Microscope.getState().trace?.run.id);assert.equal((await page.evaluate(()=>Microscope.getState())).example,true);assert.match(await page.locator('body').innerText(),/示例数据/);});
 await check('all seven lenses fit 1440x900 and 1600x1000',async()=>{
  for(const [width,height] of [[1440,900],[1600,1000]]){
   await page.setViewportSize({width,height});
   for(const lens of ['overview','timeline','flow','state','io','compare','capture']){
    await page.locator(`.sidebar [data-lens="${lens}"]`).click();
    const box=await page.evaluate(()=>{const el=document.querySelector('#timeline-footer'),r=el.getBoundingClientRect();return{w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight,iw:innerWidth,ih:innerHeight,footer:{top:r.top,bottom:r.bottom}}});
    assert.ok(box.w<=box.iw+1,`${lens}: horizontal document overflow ${JSON.stringify(box)}`);assert.ok(box.h<=box.ih+1,`${lens}: vertical document overflow`);assert.ok(box.footer.top>=0&&box.footer.bottom<=height+1,`${lens}: footer offscreen`);
    await page.screenshot({path:path.join(OUT,`${width}-${lens}.png`)});
   }
  }
 });
 await check('event selection survives switching lenses',async()=>{const first=failure.events[2].id;await page.evaluate(id=>Microscope.select(id),first);for(const lens of ['timeline','flow','state','io']){await page.locator(`.sidebar [data-lens="${lens}"]`).click();assert.equal((await page.evaluate(()=>Microscope.getState())).selectedId,first);}});
 await check('invalid imported trace preserves the current valid trace',async()=>{const before=await page.evaluate(()=>Microscope.getState().trace.run.id);await page.locator('#trace-file').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"schema_version":"bogus","run":{}}')});await page.waitForFunction(()=>Microscope.getState().error);assert.equal(await page.evaluate(()=>Microscope.getState().trace.run.id),before);});
 await check('valid sample import replaces current data and preserves example provenance',async()=>{await page.locator('#trace-file').setInputFiles({name:'normal.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(normal))});await page.waitForFunction(id=>Microscope.getState().trace.run.id===id,normal.run.id);assert.equal(await page.evaluate(()=>Microscope.getState().example),true);});
 await check('MTP and Perfetto export contain active trace data',async()=>{
  for(const action of ['export-mtp','export-perfetto']){const downloadPromise=page.waitForEvent('download');await page.locator(`[data-action="${action}"]`).first().click();const d=await downloadPromise;const dest=path.join(OUT,d.suggestedFilename());await d.saveAs(dest);const data=JSON.parse(fs.readFileSync(dest));if(action==='export-mtp')assert.equal(data.run.id,normal.run.id);else assert.ok(Array.isArray(data.traceEvents)&&data.traceEvents.length>0);}
 });
 await check('compare accepts independent second trace',async()=>{await page.locator('#compare-file').setInputFiles({name:'failure.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(failure))});await page.waitForFunction(()=>Microscope.getState().lens==='compare');assert.match(await page.locator('body').innerText(),/首次|分叉|差异/);});
 await check('no uncaught browser errors',async()=>assert.deepEqual(errors,[]));
 await context.close();
 // A controlled bridge proves command wiring/failure handling only, never ETW truth.
 const nativeContext=await browser.newContext({viewport:{width:1440,height:900}});
 const captured=JSON.parse(JSON.stringify(normal));captured.run.id='bridge-fixture-test';delete captured.run.data_origin;captured.run.name='桥接测试记录';
 await nativeContext.addInitScript(({captured})=>{
  window.__calls=[];let active=false;let completed=false;const store=new Map();
  window.__TAURI__={core:{invoke:async(command,args={})=>{window.__calls.push({command,args});switch(command){
   case 'runtime_status':return{platform:'windows',collector_available:true,reason:null,capabilities:[{id:'process',available:true,status:'available'}]};
   case 'list_processes':return[{pid:4242,name:'BridgeTest.exe',path:'C:\\tests\\BridgeTest.exe',arch:'x64'}];
   case 'list_traces':return [...store.values()].map(t=>t.run);
   case 'start_capture':if(active)throw new Error('Capture already running');active=true;return{id:captured.run.id,status:'running',ready:true};
   case 'capture_status':return completed?{id:captured.run.id,status:'completed',trace:captured}:{id:captured.run.id,status:'running',ready:true};
   case 'stop_capture':active=false;completed=true;store.set(captured.run.id,captured);return{id:captured.run.id,status:'completed',trace:captured};
   case 'load_trace':if(!store.has(args.id))throw new Error('Missing record');return store.get(args.id);
   case 'save_trace':store.set(args.trace.run.id,args.trace);return args.trace.run;
   default:throw new Error(`Unsupported mocked command ${command}`);
  }}}};
 },{captured});
 const native=await nativeContext.newPage();await native.goto(url);await native.waitForFunction(()=>window.Microscope);
 await check('native bridge chooses PID and stops into saved trace (mocked bridge)',async()=>{
  if(await native.locator('[data-action="refresh-processes"]').count())await native.locator('[data-action="refresh-processes"]').click();
  await native.locator('#process-select').selectOption('4242');await native.locator('#capture-duration').fill('12');
  await native.locator('[data-action="start-capture"]').click();await native.waitForFunction(()=>Microscope.getState().capture?.status==='running');
  await native.locator('[data-action="stop-capture"]').first().click();await native.waitForFunction(()=>Microscope.getState().trace?.run.id==='bridge-fixture-test');
  const calls=await native.evaluate(()=>window.__calls);const start=calls.find(x=>x.command==='start_capture');assert.equal(start.args.pid,4242);assert.equal(start.args.durationSeconds,12);assert.ok(calls.some(x=>x.command==='stop_capture'));assert.equal(await native.evaluate(()=>Microscope.getState().example),false);
  await native.screenshot({path:path.join(OUT,'bridge-completed.png')});
 });
 await nativeContext.close();
 fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({status:'passed',tests:results,notes:['Bridge test is mocked; Windows ETW acceptance runs separately.']},null,2));
})().catch(e=>{console.error(e);fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'results.json'),JSON.stringify({status:'failed',tests:results,error:String(e)},null,2));process.exitCode=1;}).finally(async()=>{await browser?.close();server?.kill();});
