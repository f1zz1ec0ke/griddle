'use strict';
module.exports={name:'real-placement',experience:'real',description:'food settles flat after animated pickup, placement and carrier transfers',async run(k){
 const results=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[],check=(name,ok,detail)=>out.push({name,ok:!!ok,detail});
  r.paused=true;document.getElementById('real-pause').hidden=true;
  const get=kind=>w.entities.find(e=>e.kind===kind&&!e.discarded),spatula=get('spatula');
  function aim(data,point){
   r.contact.reset();r.action=null;r.releaseHold(false);Object.assign(w.player,{x:point.x,z:point.z-.85,y:0});
   for(let i=0;i<8;i++){r.move(0);const d=point.clone().sub(r.camera.position);w.player.yaw=Math.atan2(-d.x,-d.z);w.player.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));}
   r.move(0);r.hover={data,point};
  }
  function settle(){for(let i=0;i<64;i++){r.animateHands(1/60);r.renderEntities(1/60);}}
  function normal(e){return new T.Vector3(0,1,0).applyQuaternion(r.contact.mesh(e).getWorldQuaternion(new T.Quaternion()));}
  function flat(e,name){const n=normal(e);check(name,(e.kind==='patty'?n.y:Math.abs(n.y))>1-1e-8,n.toArray());}
  function pickup(e,tool=null){
   r.held=tool?.id||null;if(tool)tool.held=true;r.renderEntities(0);
   aim({type:'entity',entity:e.id},r.contact.pickupPoint(e,tool));r.toggleGrab();settle();
   check('pickup completes before placement',tool?tool.payload===e.id:r.held===e.id);
  }
  function place(e,data,point){
   aim(data,point);r.interaction.yaw=.73;r.toggleGrab();settle();check('placement releases the food',!e.held);flat(e,'placed food settles flat');
   const q=r.contact.mesh(e).getWorldQuaternion(new T.Quaternion());settle();check('the settled orientation stays stable',q.angleTo(r.contact.mesh(e).getWorldQuaternion(new T.Quaternion()))<1e-6);
  }
  w.portion={mass:150,salt:0,work:0};const patty=w.form([.3,.962,-.88]);r.renderEntities(0);
  for(const tool of [null,spatula]){
   pickup(patty,tool);place(patty,{type:'board'},new T.Vector3(.5,.962,-.88));
   check('counter placement preserves the chosen yaw',Math.abs(patty.yaw-.73)<1e-8);
  }
  pickup(patty,spatula);place(patty,{type:'station',id:'gas'},new T.Vector3(-1.5,.98,.95));
  check('the patty reaches the stove pan',patty.station==='gas');
  pickup(patty,spatula);const plate=get('plate');place(patty,{type:'entity',entity:plate.id},new T.Vector3(...plate.pos));
  check('the patty reaches the plate',patty.trayCarrier===plate.id);
  pickup(patty,spatula);const pan=w.entities.find(e=>e.kind==='pan'&&!e.station);pan.pos=[.4,.962,-.88];pan.yaw=.4;r.renderEntities(0);
  place(patty,{type:'entity',entity:pan.id},new T.Vector3(pan.pos[0],pan.pos[1]+.005,pan.pos[2]));check('the patty reaches the counter pan',patty.panCarrier===pan.id);
  pickup(patty,spatula);w.doors.oven=true;const oven=new T.Vector3(...RealKitchen.fixturePoint('oven',[0,.544,-.02]));place(patty,{type:'ovenRack'},oven);check('the patty reaches the oven',patty.station==='oven');
  pickup(patty,spatula);const [bottom,top]=w.slice(w.addIngredient('bunWhole',[0,.962,-.88]));r.renderEntities(0);
  place(patty,{type:'entity',entity:bottom.id},new T.Vector3(...bottom.pos));check('the patty assembles on the bottom bun',w.layers(patty).length===2);flat(bottom,'bottom bun keeps its cut face up');
  pickup(top,spatula);place(top,{type:'entity',entity:patty.id},new T.Vector3(patty.pos[0],patty.pos[1]+patty.food.h,patty.pos[2]));
  pickup(patty,spatula);place(patty,{type:'entity',entity:plate.id},new T.Vector3(...plate.pos));for(const e of [patty,bottom,top])flat(e,'each burger layer stays flat on the plate');
  check('the buns retain their bottom and top orientations',normal(bottom).y<-.999&&normal(top).y>.999);
  // ItemView food also shares the handoff interpolation: preserve intentional face flips only.
  for(const kind of ['egg','bun','bacon','onions']){
   let food;if(kind==='bun')[food]=w.slice(w.addIngredient('bunWhole',[.5,.962,-.88]));else{food=w.addIngredient(kind,[.5,.962,-.88]);w.makeFood(food,kind);}
   r.action=null;r.held=null;spatula.held=false;spatula.payload=null;r.renderEntities(0);pickup(food);place(food,{type:'board'},new T.Vector3(.5,.962,-.62));
   w.discard(food);r.renderEntities(0);
  }
  pan.pos=pan.home.slice();pan.yaw=0;
  r.held=null;spatula.held=false;r.action=null;r.contact.reset();aim({type:'entity',entity:patty.id},new T.Vector3(...patty.pos));r.renderEntities(0);r.hint();r.renderer.render(r.scene,r.camera);
  return out;
 });
 for(const c of results.filter(c=>!c.ok))k.log('FAILED: '+c.name+' '+JSON.stringify(c.detail));
 for(const c of results)k.ok(c.ok,c.name+(c.detail?' '+JSON.stringify(c.detail):''));
 await k.shot('flat-burger');
}};
