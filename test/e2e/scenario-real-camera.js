'use strict';
module.exports={name:'real-camera',experience:'real',description:'interaction camera stays put for fixtures and leans for hands-on work',async run(k){
 const results=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[],check=(name,ok,detail)=>out.push({name,ok:!!ok,detail});
  const item=kind=>w.entities.find(e=>e.kind===kind&&!e.discarded);
  r.paused=true;document.getElementById('real-pause').hidden=true;
  function fixture(type,match=()=>true){
   r.scene.updateMatrixWorld(true);
   const object=r.targets.find(o=>o.userData.realTarget.type===type&&match(o.userData.realTarget,o));
   return {data:object.userData.realTarget,object,point:new T.Box3().setFromObject(object).getCenter(new T.Vector3())};
  }
  function aim(target,held=null,distance=.85){
   r.action=null;r.releaseHold(false);r.interaction.probe=null;r.contact.reset();r.keys.clear();r.eyeHeight=1.72;r.probeLean=0;
   for(const e of w.entities)e.held=false;r.held=held?.id||null;if(held)held.held=true;
   w.portion.mass=0;r.renderEntities(0);
   Object.assign(w.player,{x:target.point.x,z:target.point.z-distance,y:0});
   for(let i=0;i<8;i++){r.move(0);const d=target.point.clone().sub(r.camera.position);w.player.yaw=Math.atan2(-d.x,-d.z);w.player.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));}
   r.move(0);r.hover=target;
  }
  function run(start,after=()=>{},beforeRelease=()=>{}){
   const base=r.camera.position.clone(),rotation=r.camera.quaternion.clone(),fov=r.camera.fov;let peak=0,turned=false;
   start();after();
   for(let i=0;i<48;i++){r.move(.025);r.continuous(.025);r.animateHands(.025);r.renderEntities(.025);peak=Math.max(peak,r.camera.position.distanceTo(base));turned ||= r.camera.quaternion.angleTo(rotation)>1e-6||r.camera.fov!==fov;}
   beforeRelease();r.releaseHold();for(let i=0;i<32;i++){r.move(.025);r.continuous(.025);r.animateHands(.025);}
   check('interaction returns to the normal view without changing look or FOV',!turned&&r.camera.position.distanceTo(base)<.001);
   return peak;
  }
  const click=()=>{r.left=true;r.use();};
  // A held utensil must not turn an unrelated fixture press into close-up work.
  for(const held of [null,item('spoon')])for(const [type,key] of [['fridge','fridge'],['ovenDoor','oven'],['window','window'],['tap','tap'],['bin','bin'],['grillLid',null]]){
   aim(fixture(type),held);const before=key?w.doors[key]:w.station('charcoal').state.lid;
   const peak=run(click),after=key?w.doors[key]:w.station('charcoal').state.lid;
   check(type+' operates without a camera push'+(held?' while holding a spoon':''),before!==after&&peak<1e-6,peak);
  }
  for(const held of [null,item('lighter')]){
   aim(fixture('button',d=>d.id==='induction'&&d.action==='power'),held);const before=w.station('induction').state.stove.knob;
   const peak=run(click);check('hob buttons stay at normal distance'+(held?' with the lighter held':''),w.station('induction').state.stove.knob!==before&&peak<1e-6,peak);
  }
  const timer=item('timer');aim(fixture('entity',(d,o)=>d.entity===timer.id&&o.userData.timerButton));
  const timerBefore=w.timer.running,timerPeak=run(click);check('timer button operates without zoom',w.timer.running!==timerBefore&&timerPeak<1e-6,timerPeak);
  for(const type of ['knob','ovenKnob','vent']){
   aim(fixture(type));const peak=run(click,()=>r.turn(r.grabControl,12));check(type+' keeps its close working view',peak>.05,peak);
  }
  aim(fixture('entity',(d,o)=>d.entity===timer.id&&o.userData.timerDial));const duration=w.timer.duration;
  const dialPeak=run(click,()=>r.interaction.drag({movementX:20,movementY:0}));check('timer dial zooms and adjusts',w.timer.duration!==duration&&dialPeak>.05,dialPeak);
  const emptyPan={data:{type:'station',id:'gas'},point:new T.Vector3(-1.5,.98,.95)};
  for(const held of [null,item('spatula')]){
   aim(emptyPan,held);const peak=run(click);check('holding click on an empty pan does not zoom'+(held?' with a tool':''),peak<1e-6,peak);
  }
  aim(fixture('fridge'));r.left=true;r.use();r.hover=emptyPan;
  let drift=0;for(let i=0;i<48;i++){r.continuous(.025);r.animateHands(.025);drift=Math.max(drift,r.camera.position.distanceTo(r.contact.base));}
  check('holding a door click while looking elsewhere cannot start a zoom',drift<1e-6,drift);
  const spoon=item('spoon');aim({data:{type:'entity',entity:spoon.id},point:r.contact.pickupPoint(spoon)});
  const pickupPeak=run(()=>r.toggleGrab());check('picking up a tool still leans and completes',r.held===spoon.id&&pickupPeak>.05,pickupPeak);
  const counter={data:{type:'board'},point:new T.Vector3(.5,.962,-.88)};aim(counter,spoon);
  const placePeak=run(()=>r.toggleGrab());check('placing the held tool still leans and completes',!r.held&&placePeak>.05,placePeak);
  w.doors.fridge=true;aim(fixture('supply',d=>d.kind==='meat'));
  const supplyPeak=run(()=>r.toggleGrab());check('taking food from the fridge keeps the pickup lean',r.heldEntity()?.kind==='meat'&&supplyPeak>.05,supplyPeak);
  aim(fixture('bowl'),r.heldEntity());const meatPeak=run(click);check('adding held mince leans and finishes after releasing the pack',w.bowl.mass>0&&!r.held&&meatPeak>.05,meatPeak);
  aim(fixture('bowl'));const portionPeak=run(click);check('scooping mince retains the close working view',w.portion.mass>0&&portionPeak>.05,portionPeak);
  aim(counter);w.portion.mass=150;const formPeak=run(click);check('forming a portion retains the close working view',w.portion.mass===0&&formPeak>.05,formPeak);
  for(const kind of ['oil','water']){
   aim(emptyPan,item(kind));const before=w.station('gas').state.pan[kind],peak=run(click);
   check('pouring '+kind+' keeps its working view',w.station('gas').state.pan[kind]>before&&peak>.05,peak);
  }
  aim(fixture('bowl'),spoon);const work=w.bowl.work,mixPeak=run(click);check('mixing with the spoon keeps its working view',w.bowl.work>work&&mixPeak>.05,mixPeak);
  aim(emptyPan,item('lid'));const lidPeak=run(click);check('placing a held lid still leans and covers the pan',w.station('gas').state.lid&&lidPeak>.05,lidPeak);
  const patty=item('patty');aim({data:{type:'entity',entity:patty.id},point:new T.Vector3(...patty.pos)},item('probe'),.55);
  let probeContact;const probePeak=run(click,()=>{},()=>{const p=r.interaction.probe;probeContact={valid:p?.valid,depth:p?.depth,temperature:p?.temperature};});
  check('probing still zooms and leaves the probe in the food',!!w.attachedProbe(patty)&&probePeak>.05,{peak:probePeak,...probeContact});
  // A rejected bare-hand pickup must not pull the view towards a hot surface.
  const pan=w.get(w.station('gas').panId);pan.pan.T=pan.pan.Tcenter=200;aim(emptyPan);
  const hotPeak=run(()=>r.toggleGrab());check('a rejected hot pickup stays at normal distance',!r.held&&hotPeak<1e-6,hotPeak);
  return out;
 });
 for(const c of results.filter(c=>!c.ok))k.log('FAILED: '+c.name+' '+JSON.stringify(c.detail));
 for(const c of results)k.ok(c.ok,c.name+(c.detail===undefined?'':' ('+(typeof c.detail==='number'?c.detail.toFixed(4)+' m':JSON.stringify(c.detail))+')'));
}};
