/* npm run perf:render [-- --gpu --compare=HEAD] — report frame delivery separately from CPU submission. */
'use strict';
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process'),{runScenario,OUT}=require('./helper');
const args=process.argv.slice(2),gpu=args.includes('--gpu'),base=args.find(a=>a.startsWith('--compare='))?.slice(10),root=path.resolve(__dirname,'../..');
const reports=[];
function summarize(rows){
 const values=key=>rows.map(r=>r[key]).filter(v=>v!==null),mean=key=>{const a=values(key);return a.reduce((n,v)=>n+v,0)/a.length;},percentile=(key,p)=>{const a=values(key).sort((a,b)=>a-b);return a[Math.min(a.length-1,Math.floor(a.length*p))];};
 return {frames:rows.length,frameMs:mean('interval'),frameP95:percentile('interval',.95),submitMedian:percentile('submitMs',.5),submitP95:percentile('submitMs',.95),submitMax:percentile('submitMs',1),updateMs:mean('updateMs'),updateMax:percentile('updateMs',1),drawCalls:mean('calls'),triangles:mean('triangles'),newShaders:rows.reduce((n,r)=>n+r.newShaders,0)};
}
(async()=>{
 for(const revision of [...(base?[base]:[]),'working']){
  const result=await runScenario('perf-render-'+revision.replace(/[^\w-]/g,'_'),async k=>{
   await k.page.evaluate(async()=>{if(realMode.preparation)await realMode.preparation;});
   const report=await k.page.evaluate(async()=>{
    const r=realMode,w=r.world,gl=r.renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info'),rows=[];r.active=false;r.renderer.info.autoReset=false;
    const graphics=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),prepared=r.prepared||false;
    for(const phase of ['empty','cooking']){
     if(phase==='cooking')for(const id of ['gas','electric','induction','charcoal']){w.portion={mass:150,salt:1,work:0};w.placeFood(w.form([0,.964,-.88]),id);const st=w.station(id);st.state.stove.knob=7;if(st.panId)w.pourInto(st.panId,'canola',8);}
     let last;for(let i=0;i<49;i++){
      await new Promise(requestAnimationFrame);
      const start=performance.now();w.player.yaw=-i*Math.PI/12;w.player.pitch=-.2;r.move(0);r.renderEntities(0);const updateMs=performance.now()-start,programs=r.renderer.info.programs.length;
      r.renderer.info.reset();const submitStart=performance.now();r.renderer.render(r.scene,r.camera);
      // Keep first-use allocation and shader costs; only that frame's delivery interval is unknown.
      rows.push({phase,interval:last===undefined?null:start-last,updateMs,submitMs:performance.now()-submitStart,calls:r.renderer.info.render.calls,triangles:r.renderer.info.render.triangles,newShaders:r.renderer.info.programs.length-programs});last=start;
     }
    }
    r.renderer.info.autoReset=true;return {graphics,prepared,rows,memory:r.renderer.info.memory};
   });
   report.revision=revision;report.phases=Object.fromEntries(['empty','cooking'].map(phase=>[phase,summarize(report.rows.filter(r=>r.phase===phase))]));reports.push(report);
   k.log(JSON.stringify({revision,graphics:report.graphics,prepared:report.prepared,phases:report.phases}));
  },'real',{gpu,beforeLoad:async page=>{
   // Deterministic procedural noise for a useful comparison, independent of render timing.
   await page.addInitScript(()=>{let seed=918273;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);});
   if(revision==='working')return;
   const sources=new Map();await page.route('**/*',async route=>{
    const rel=decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//,'');
    if(rel!=='index.html'&&!rel.startsWith('js/')&&!rel.startsWith('css/'))return route.continue();
    if(!sources.has(rel))sources.set(rel,execFileSync('git',['show',revision+':'+rel],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']}));
    return route.fulfill({body:sources.get(rel),contentType:rel.endsWith('.html')?'text/html':rel.endsWith('.css')?'text/css':'text/javascript'});
   });
  }});
  if(result.error)throw result.error;
 }
 const file=path.join(OUT,gpu?'render-perf-gpu.json':'render-perf-software.json');fs.writeFileSync(file,JSON.stringify(reports,null,2));console.log('Saved '+file);
})().catch(error=>{console.error(error);process.exitCode=1;});
