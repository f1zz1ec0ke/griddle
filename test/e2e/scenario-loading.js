'use strict';
module.exports={name:'loading',experience:'choose',description:'visible startup progress, both kitchens prepared and saves untouched',
 async beforeLoad(page){
  await page.addInitScript(()=>{
   window.bootAudit={frames:[],progress:[]};
   const record=()=>{
    const ui=window.GriddleLoading,bar=document.getElementById('boot-progress');
    if(bar){bootAudit.frames.push({p:bar.value,visible:!document.getElementById('boot-screen').hidden,mode:document.body.dataset.experience,graphics:!!window.THREE});}
    if(!ui?.ready&&!ui?.failed)requestAnimationFrame(record);
   };requestAnimationFrame(record);
   new MutationObserver(()=>{
    const bar=document.getElementById('boot-progress');if(!bar||!bar.hasAttribute('value'))return;
    const value=bar.value,label=document.getElementById('boot-label').textContent,last=bootAudit.progress.at(-1);
    if(last?.value!==value||last?.label!==label)bootAudit.progress.push({value,label});
   }).observe(document,{subtree:true,attributes:true,attributeFilter:['value'],childList:true,characterData:true});
  });
  await page.route('**/js/vendor/three.min.js',async route=>{await new Promise(resolve=>setTimeout(resolve,250));await route.continue();});
 },
 async beforeReady(k){
  k.ok(await k.page.locator('#boot-screen').isVisible(),'the loading screen is visible before preparation finishes');
  k.ok(await k.page.evaluate(()=>!window.GriddleLoading?.ready),'mode selection has not been unlocked early');
  await k.shot('preparing');
 },
 async run(k){
  const audit=await k.page.evaluate(()=>({
   prepared:game.vp.prepared&&realMode.prepared,phase:game.phase,time:game.state.t,realTime:realMode.world.time,
   held:realMode.held,started:!!realMode.started,save:localStorage.getItem('griddle.real.v1'),
   detached:game.vp.shaderSamples.parent===null&&realMode.shaderSamples.parent===null,
   frames:bootAudit.frames,progress:bootAudit.progress,focus:document.activeElement.id,
  }));
  k.ok(audit.prepared&&audit.detached,'both modes finish compilation and remove their sample food');
  k.ok(audit.frames.some(f=>f.visible&&!f.graphics),'the loading screen paints before the graphics engine has downloaded');
  k.ok(audit.phase==='order'&&audit.time===0&&audit.realTime===0&&!audit.started&&!audit.save&&!audit.held,'preparation never cooks, grabs food or creates a save');
  k.ok(audit.progress.length>20&&audit.progress.every((q,i)=>q.value>=0&&q.value<=1&&(!i||q.value>=audit.progress[i-1].value)),'progress advances monotonically through completed jobs');
  for(const mode of ['Original','Real'])k.ok(audit.frames.some(f=>f.visible&&f.mode==='loading')&&audit.progress.some(q=>q.label==='Compiling '+mode+' shaders'&&q.value>0&&q.value<1),mode+' compilation reports intermediate progress');
  k.ok(audit.frames.filter(f=>f.p>1/3&&f.p<1&&f.visible).length>10,'the browser paints loading progress between shader batches');
  k.ok(await k.page.locator('#mode-choice').isVisible()&&!await k.page.locator('#boot-screen').isVisible()&&audit.focus==='choose-legacy','mode selection appears once both kitchens are ready, with keyboard focus');
  await k.shot('ready');
  await k.page.locator('#choose-real').click();
  k.ok(await k.page.evaluate(()=>realMode.prepared&&!realMode.preparing&&!realMode.preparation),'entering Real mode needs no second compilation wait');
  await k.page.locator('#real-leave').click();await k.page.locator('#choose-legacy').click();
  k.ok(await k.page.evaluate(()=>document.body.dataset.experience==='legacy'&&game.vp.prepared),'Original mode is ready when selected');
  const variants=await k.page.evaluate(()=>{
   const vp=game.vp,P=BurgerPhysics,known=new Set(vp.renderer.info.programs.map(p=>p.id)),out=[];
   for(const [stove,pan] of [['gas','castiron'],['electric','carbonsteel'],['induction','stainless'],['charcoal','castiron'],['gas','nonstick']]){
    vp.setStove(stove);vp.setPan(pan);vp.setMode('stove');
    const s=P.createState({stove,pan}),p=P.makePatty({massG:150,thicknessMm:20,fatFrac:.2,tempC:6,dimple:true,work:.4,salt:'surface'});P.placePatty(s,p);
    p.cheeses.push({mass:.02,melt:.5});s.stove.knob=7;s.lid=true;P.addFat(s,'canola',8);s.pan.water=.03;P.roomAir(s);
    s.items=['bun','bacon','egg','onions'].map(kind=>P.makeItem(kind,{half:'top'}));
    for(const cut of [false,true])for(const smoke of [false,true]){
     s.room.upper=s.room.lower=smoke?1:0;vp.setCutaway(cut);vp.update(s,0,0);
    }
    out.push({stove,pan,newShaders:vp.renderer.info.programs.filter(p=>!known.has(p.id)).length});
   }return out;
  });
  k.log('Original shader coverage: '+JSON.stringify(variants));
  for(const variant of variants)k.ok(variant.newShaders===0,'Original equipment, food and cutaway use prepared shaders '+JSON.stringify(variant));
  const saved=await k.page.evaluate(()=>{realMode.world.portion.mass=125;realMode.world.station('induction').state.stove.knob=4;realMode.save();return localStorage.getItem('griddle.real.v1');});
  const errors=k.consoleErrors.length;
  await k.page.route('**/js/real-mode.js*',route=>route.abort());await k.page.reload({waitUntil:'load'});
  await k.page.waitForFunction(()=>window.GriddleLoading?.failed);
  k.ok(await k.page.locator('#boot-retry').isVisible(),'a missing startup file shows a recovery action');
  k.ok(await k.page.evaluate(()=>localStorage.getItem('griddle.real.v1'))===saved,'failed startup preserves the saved kitchen');
  await k.shot('retry');k.consoleErrors.splice(errors);
  await k.page.unroute('**/js/real-mode.js*');
  await Promise.all([k.page.waitForNavigation({waitUntil:'load'}),k.page.locator('#boot-retry').click()]);
  await k.page.waitForFunction(()=>window.GriddleLoading?.ready,null,{timeout:180000});
  k.ok(await k.page.evaluate(()=>localStorage.getItem('griddle.real.v1'))===saved,'successful preparation also leaves the saved kitchen untouched');
  await k.page.locator('#choose-resume').click();
  k.ok(await k.page.evaluate(()=>realMode.world.portion.mass===125&&realMode.world.station('induction').state.stove.knob===4&&realMode.paused),'the saved kitchen resumes paused with its portion and heat controls intact');
 },
};
