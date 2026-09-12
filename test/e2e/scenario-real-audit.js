'use strict';
module.exports={name:'real-audit',experience:'real',description:'long-session cleanup, hot handling, cookware ownership and save recovery',async run(k){
 const checks=await k.page.evaluate(()=>{
  const r=realMode,T=THREE,P=BurgerPhysics,out=[];let w=r.world;
  const check=(name,value)=>out.push({name,value:!!value});
  const get=kind=>w.entities.find(e=>e.kind===kind);
  function hold(e){r.action=null;r.left=false;r.interaction.probe=null;for(const q of w.entities){q.held=false;q.payload=null;}r.held=e?.id||null;if(e)e.held=true;r.renderEntities(0);}
  function aim(e,type='entity',id){r.hover={data:e?{type,entity:e.id,name:e.label}:{type,id},point:new T.Vector3(...(e?.pos||[0,.95,.95]))};}
  function patty(){w.portion={mass:150,salt:0,work:0};return w.form([0,.96,-.88]);}
  const targets=r.targets.length,entities=w.entities.length;
  for(let i=0;i<30;i++){const e=w.addIngredient('tomato',[0,.95,-.88]);r.renderEntities(0);w.discard(e);r.renderEntities(0);}
  check('thirty discard cycles leave no stale click targets',r.targets.length===targets);
  check('discarded inventory is retired from the live scene',w.entities.length===entities);
  const p=patty();p.food.T.fill(6);for(let j=0;j<p.food.Nr;j++)p.food.T[j]=180;hold(null);aim(p);r.toggleGrab();check('a hot surface protects a raw-centred patty from bare hands',!r.held&&r.action?.kind==='retract'&&document.getElementById('real-toast').textContent.includes('spatula'));
  p.food.T.fill(20);const spoon=get('spatula');hold(spoon);r.carry(spoon,p);r.action=null;const other=patty();w.placeFood(other,'gas');aim(other);const flips=other.food.flips;r.use();check('a loaded utensil cannot flip another item',other.food.flips===flips&&!r.action&&document.getElementById('real-toast').textContent.includes('carried'));
  hold(null);const pan=w.get(w.station('gas').panId);w.liftPan(pan);hold(get('lid'));aim(null,'station','gas');r.use();check('a loose lid cannot disappear onto an empty hob',r.held===get('lid').id&&!w.station('gas').state.lid);
  hold(pan);Object.assign(w.player,{x:.4,z:-2.2,yaw:2.8,pitch:-.4});r.move(0);for(let i=0;i<25;i++)r.animateHands(.05);r.renderEntities(0);
  const pos=r.meshes.get(other.id).mesh.getWorldPosition(new T.Vector3());check('food coordinates follow the carried pan',new T.Vector3(...other.pos).distanceTo(pos)<.004);
  r.save();const snapshot=w.snapshot(),foodId=other.id,panId=pan.id;
  r.load(snapshot);w=r.world;r.renderEntities(0);check('loaded pan and its food survive save and resume',r.held===panId&&w.get(foodId).panCarrier===panId&&w.get(panId).parked.patties[0]===w.get(foodId).food);
  const good=w,broken=GriddleSession.decode(w.snapshot());broken.heldId=999999;let rejected=false;try{r.load(GriddleSession.encode(broken));}catch(e){rejected=true;}check('a broken save cannot replace the current kitchen',rejected&&r.world===good);
  const baseline=r.targets.length;for(let i=0;i<3;i++){r.load(snapshot);w=r.world;r.renderEntities(0);}check('repeated resume does not accumulate click targets',r.targets.length===baseline);
  const falling=w.addIngredient('tomato',[.2,.2,-.8]);falling.fall=2;falling.slide=[1,0];r.action=null;r.pick(falling);check('catching a falling object clears its old fall motion',falling.fall===0&&!falling.slide);
  // Rack slots remain fixed when a neighbour is removed.
  hold(null);w.doors.oven=true;const a=patty(),b=patty(),c=patty();w.placeFood(a,'oven');w.placeFood(b,'oven');w.placeFood(c,'oven');r.renderEntities(0);const before=c.pos.slice();w.detach(b);r.renderEntities(0);check('removing food does not teleport its rack neighbours',new T.Vector3(...c.pos).distanceTo(new T.Vector3(...before))<.001);
  check('oven food is centred inside the actual oven',a.pos[0]>-2.92&&a.pos[0]<-2.28&&c.pos[0]>-2.92&&c.pos[0]<-2.28);
  r.save();check('audited kitchen still restores with valid ownership',!!RealKitchen.Kitchen.restore(w.snapshot()));
  const raf=window.requestAnimationFrame,start=w.time;window.requestAnimationFrame=()=>0;
  try{r.action=null;r.paused=false;r.acc=0;r.last=1000;r.frame(1100);check('a 100 ms frame advances two stable cooking steps',Math.abs(w.time-start-.1)<1e-8);}finally{window.requestAnimationFrame=raf;}
  r.action=null;r.paused=true;hold(null);Object.assign(w.player,{x:-2.6,z:-2.4,y:0,yaw:Math.PI,pitch:-.82});r.move(0);for(let i=0;i<25;i++){r.animateHands(.05);r.renderEntities(.05);}r.keys.add('ControlLeft');w.player.pitch=-.42;for(let i=0;i<30;i++)r.move(.05);r.keys.clear();r.hover=r.focus();document.getElementById('real-pause').hidden=true;r.hint();return out;
 });
 for(const c of checks)k.ok(c.value,c.name);await k.shot('kitchen');
}};
