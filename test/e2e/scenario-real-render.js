'use strict';
module.exports={name:'real-render',experience:'real',description:'cached shadows, prepared shaders and idle GPU uploads',async run(k){
 await k.page.waitForFunction(()=>realMode.prepared,null,{timeout:120000});
 const checks=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[];r.active=false;document.getElementById('real-pause').hidden=true;
  out.push({name:'shader preparation leaves the saved simulation unchanged',ok:JSON.stringify(w.snapshot())===localStorage.getItem('griddle.real.v1')});
  const target=new T.WebGLRenderTarget(360,220);target.texture.encoding=r.renderer.outputEncoding;
  function capture(cached){r.shadowCache.enabled=cached;r.renderer.setRenderTarget(target);r.renderer.render(r.scene,r.camera);const pixels=new Uint8Array(360*220*4);r.renderer.readRenderTargetPixels(target,0,0,360,220,pixels);r.renderer.setRenderTarget(null);return pixels;}
  function compare(name){const reference=capture(false),cached=capture(true);let max=0,different=0;for(let i=0;i<reference.length;i++){const d=Math.abs(reference[i]-cached[i]);max=Math.max(max,d);if(d>1)different++;}out.push({name,ok:max<=1,detail:{max,different}});}
  w.player.yaw=Math.PI;w.player.pitch=-.35;r.move(0);r.renderEntities(0);compare('fixed room shadows match a complete shadow render');
  r.fridgeDoor.rotation.y=1.7;r.ovenDoor.rotation.x=-1.2;r.binLid.rotation.x=1;r.windowHinges.forEach(h=>h.rotation.y=h.userData.side*.8);compare('open doors and windows keep live shadows');
  w.portion={mass:150,salt:0,work:0};const meat=w.form([0,.964,-.88]);w.placeFood(meat,'gas');const pan=w.get(w.station('gas').panId);w.liftPan(pan);pan.held=true;r.held=pan.id;r.animateHands(.05);r.renderEntities(0);compare('carried cookware, food and hands keep live shadows');
  const shaders=r.renderer.info.programs.length;
  for(const kind of ['egg','bacon','onions','bun']){const e=w.addIngredient(kind,[0,.964,-.88]);w.makeFood(e,kind,{half:'top'});}
  r.renderEntities(0);
  const onions=w.entities.find(e=>e.kind==='onions');r.interaction.makeGhost(onions,r.meshes.get(onions.id).mesh);
  for(const rec of r.meshes.values())if(rec.view)rec.mesh.traverse(o=>{if(o.isMesh)o.frustumCulled=false;});
  for(const fog of [r.airView.cleanFog,r.airView.smokeFog]){r.scene.fog=fog;capture(true);}
  out.push({name:'new food, instanced placement previews and smoke use prepared shaders',ok:r.renderer.info.programs.length===shaders,detail:{newPrograms:r.renderer.info.programs.length-shaders}});
  r.scene.fog=r.airView.cleanFog;r.interaction.clearGhost();
  const sun=r.scene.children.find(o=>o.isDirectionalLight);sun.position.x-=.7;compare('moving a light rebuilds its cached room shadow');
  const vp=r.stations.get('gas'),steam=vp.steam,drop=vp.spatter;
  steam.parts.length=0;drop.parts.length=0;steam.update(0,0,()=>[0,0,0]);drop.update(0,()=>false);
  const versions=[steam.geo.attributes.position.version,drop.mesh.instanceMatrix.version];
  for(let i=0;i<10;i++){steam.update(.016,0,()=>[0,0,0]);drop.update(.016,()=>false);}
  out.push({name:'empty effects stay hidden without uploading buffers',ok:!steam.points.visible&&!drop.mesh.visible&&steam.geo.attributes.position.version===versions[0]&&drop.mesh.instanceMatrix.version===versions[1]});
  steam.spawn(0,0,0);drop.spawn({x:0,y:0,z:0});steam.update(.016,0,()=>[0,0,0]);drop.update(.016,()=>true);
  out.push({name:'effects wake up and upload only their live particles',ok:steam.points.visible&&drop.mesh.visible&&steam.geo.drawRange.count===1&&drop.mesh.count===1&&drop.mesh.instanceMatrix.updateRange.count===16});
  out.push({name:'shader samples stay outside the visible kitchen',ok:r.prepared&&r.shaderSamples.parent===null});
  out.push({name:'shadow copies produce no WebGL errors',ok:r.renderer.getContext().getError()===0});
  target.dispose();r.shadowCache.enabled=r.renderer.capabilities.isWebGL2;r.renderer.render(r.scene,r.camera);return out;
 });for(const check of checks)k.ok(check.ok,check.name+(check.detail?' '+JSON.stringify(check.detail):''));await k.shot('kitchen');
}};
