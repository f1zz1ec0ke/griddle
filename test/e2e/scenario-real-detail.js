'use strict';
// Bounded scene fixtures exercise the same input handlers and hand solver as live play.
module.exports={name:'real-detail',experience:'real',description:'preparation, probe contact, placement, reworking, tasting and spatial audio',async run(k){
 const result=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,checks=[];
  const check=(name,ok)=>checks.push({name,ok:!!ok});
  const get=kind=>w.entities.find(e=>e.kind===kind&&!e.discarded);
  function hold(e){for(const q of w.entities){q.held=false;q.payload=null;}r.held=e?.id||null;if(e)e.held=true;r.action=null;r.left=false;r.grabControl=null;r.interaction.probe=null;r.renderEntities(0);}
  function hover(e,point){r.hover={data:e?{type:'entity',entity:e.id}:{type:'board'},point:new T.Vector3(...point)};}
  function finish(){for(let i=0;i<30;i++){if(r.interaction.probe)r.move(.05);r.animateHands(.05);}r.renderEntities(0);}
  function left(){r.left=true;r.use();}
  function up(){window.dispatchEvent(new MouseEvent('mouseup',{button:0,bubbles:true}));}
  function wheel(deltaY){r.canvas.dispatchEvent(new WheelEvent('wheel',{deltaY,bubbles:true,cancelable:true}));}
  r.paused=false;
  w.bowl={mass:150,salt:0,work:0,fatFrac:.1};w.scoop(2);hold(null);hover(null,[0,.96,-.88]);wheel(-1);left();finish();up();
  const patty=get('patty');check('scroll selects thickness and holding shapes the portion',patty&&w.settings.thicknessMm===21&&w.portion.mass===0);
  const tomato=w.addIngredient('tomato',[.2,.96,-.88]);hold(get('knife'));hover(tomato,tomato.pos);wheel(1);left();finish();up();
  check('one knife stroke produces one measured slice',w.entities.filter(e=>e.kind==='tomatoSlice').length===1&&tomato.remainingMm===75);
  left();finish();up();check('a second stroke cuts another distinct slice',w.entities.filter(e=>e.kind==='tomatoSlice').length===2);
  const salt=get('salt');hold(salt);hover(patty,patty.pos);left();r.continuous(.5);up();check('holding salt adds a measured surface dose',patty.food.saltGrams.surface>0);
  // Stand close to the board and look down; the real arm limit must allow insertion.
  Object.assign(w.player,{x:0,z:-1.45,y:0,yaw:Math.PI,pitch:-1.0});r.move(0);
  const probe=get('probe');hold(probe);hover(patty,[patty.pos[0],patty.pos[1]+patty.food.h,patty.pos[2]]);left();wheel(1);wheel(1);finish();
  const p=r.interaction.probe;check('probe tip reaches the chosen food instead of teleporting the hand',p?.valid);check('probe reads a finite temperature at selected depth',p?.depth===.002&&Number.isFinite(p.temperature));
  up();r.interaction.continuous(.05);check('releasing parks the probe in the patty and frees the hand',!r.interaction.probe&&probe.probeAttachment?.foodId===patty.id&&!r.held);hover(probe,probe.pos);r.toggleGrab();finish();check('right click removes the parked probe',r.held===probe.id&&!probe.probeAttachment);
  const egg=w.addIngredient('egg',[.4,.96,-.88]);hold(egg);r.hover={data:{type:'station',id:'electric'},point:new T.Vector3(0,.97,.95)};left();r.animateHands(.3);r.renderEntities(0);
  check('cracking opens two halves of the existing egg asset',r.interaction.shells?.length===2&&r.interaction.shells[0].shell.position.distanceTo(r.interaction.shells[1].shell.position)>.05);
  finish();up();check('one cracked egg lands on the aimed cooking station',egg.station==='electric'&&w.station('electric').state.items.filter(e=>e.id===egg.id).length===1&&!r.interaction.shells);
  hold(patty);hover(null,[-.2,.96,-.88]);wheel(1);r.interaction.render();const preview=r.interaction.ghost.position.clone();r.placeHeld(r.hover);
  check('rotated counter preview agrees with committed placement',Math.abs(patty.yaw-Math.PI/12)<1e-8&&new T.Vector3(...patty.pos).distanceTo(preview)<.002);
  const buns=w.slice(w.addIngredient('bunWhole',[0,.96,-.88]));w.assemble(patty,buns[0]);w.assemble(buns[1],patty);hold(null);hover(patty,patty.pos);
  window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyE',bubbles:true}));finish();check('E lifts the top bun and reopens the burger',r.held===buns[1].id&&patty.food.assembly.length===2);
  r.placeHeld(r.hover);check('the lifted bun can be replaced',patty.food.assembly.length===3&&!r.held);
  const plate=get('plate');hold(patty);hover(plate,plate.pos);r.placeHeld(r.hover);hold(plate);hover(null,[0,.96,-.88]);left();finish();up();
  check('tasting a plated burger shows a concise report',w.lastTasting?.notes.length>=5&&!document.getElementById('real-tasting').hidden);
  r.audio.start();const sources=w.stations.map(s=>({id:s.id,state:s.state,position:new T.Vector3(s.x,.95,s.z)}));r.audio.update(sources,r.camera.position,r.camera.getWorldDirection(new T.Vector3()),.05);
  check('five station voices share one context with independent spatial panners',r.audio.voices.size===5&&[...r.audio.voices.values()].every(v=>v.voice.ctx===r.audio.ctx&&v.pan.panningModel==='HRTF'));
  r.pause();check('pause silences every station voice',[...r.audio.voices.values()].every(v=>!v.voice.enabled));
  r.audio.start();r.audio.update(sources,r.camera.position,r.camera.getWorldDirection(new T.Vector3()),.05);check('resuming restores the existing spatial voices',[...r.audio.voices.values()].every(v=>v.voice.enabled)&&r.audio.voices.size===5);r.audio.stop();
  Object.assign(w.player,{x:0,z:-2.0,y:0,pitch:-.45});r.eyeHeight=1.72;r.probeLean=0;r.move(0);finish();document.getElementById('real-pause').hidden=true;r.hint();
  return checks;
 });
 for(const c of result)k.ok(c.ok,c.name);await k.shot('tasting');
}};
