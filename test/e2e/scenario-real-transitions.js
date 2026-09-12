'use strict';
module.exports={name:'real-transitions',experience:'real',description:'covered cookware, loaded tools, egg loss and paused motion',async run(k){
 const results=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[];
  const check=(name,value)=>out.push({name,value:!!value});
  const get=kind=>w.entities.find(e=>e.kind===kind);
  function hold(e){r.action=null;r.left=false;for(const q of w.entities)q.held=false;r.held=e?.id||null;if(e)e.held=true;r.renderEntities(0);}
  function aim(e,type='entity',id){r.hover={data:e?{type,entity:e.id,name:e.label}:{type,id},point:new T.Vector3(...(e?.pos||[0,.95,.95]))};}
  const pan=w.get(w.station('gas').panId),lid=get('lid'),glove=get('glove');lid.station='gas';w.station('gas').state.lid=true;
  hold(glove);aim(null,'station','gas');r.toggleGrab();
  check('glove lifts a covered pan with its lid',glove.payload===pan.id&&lid.panCarrier===pan.id);
  if(glove.payload){glove.payload=null;pan.held=false;w.dockPan(pan,'gas');}
  lid.station=null;lid.panCarrier=null;pan.lidId=null;w.station('gas').state.lid=false;
  const spoon=get('spoon'),onions=w.addIngredient('onions',[0,.95,-.88]);w.makeFood(onions,'onions');hold(spoon);r.carry(spoon,onions);r.action=null;r.left=true;aim(null,'bowl');const work=w.bowl.work;r.continuous(1);
  check('a loaded spoon cannot mix the bowl',w.bowl.work===work);r.left=false;spoon.payload=null;onions.held=false;
  w.portion={mass:150,salt:0,work:0};const p=w.form([0,.95,-.88]),plate=get('plate');w.putOnTray(p,plate);hold(plate);aim(null,'ovenDoor');const open=w.doors.oven;r.use();
  check('holding a tasting plate still allows opening the oven',w.doors.oven!==open&&r.action?.kind!=='taste');
  hold(spoon);aim(plate);r.use();check('pointing a spoon at a plate does not taste food',r.action?.kind!=='taste');
  hold(null);aim(plate);r.use();check('an empty hand can taste a plated burger',r.action?.kind==='taste');
  hold(null);const falling=w.addIngredient('tomato',[.2,.6,-.8]);falling.fall=.5;falling.slide=[1,0];const position=falling.pos.slice();r.paused=true;const raf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;try{r.last=1000;r.frame(1100);}finally{window.requestAnimationFrame=raf;}
  check('pause freezes falling ingredients',falling.pos.every((v,i)=>v===position[i]));
  const egg=w.addIngredient('egg',[0,.95,0]);w.makeFood(egg,'egg');w.placeFood(egg,'charcoal');w.step(.05);r.renderEntities(0);
  check('an egg lost through the grill is no longer selectable',!w.get(egg.id));
  let restored=false;try{restored=!!RealKitchen.Kitchen.restore(w.snapshot());}catch(e){}
  check('a kitchen saves and restores after an egg falls through the grill',restored);
  const whole=w.addIngredient('egg',[.3,.95,-.88]);w.detach(p);w.placeFood(p,'electric');const diameter=p.food.D;p.food.D=w.station('electric').state.pan.floorR*2;hold(whole);aim(p);r.use();
  check('a full pan rejects cracking before the shell animation',!whole.food&&!r.action&&!r.interaction.shells);p.food.D=diameter;w.detach(p);
  // Build, close, plate and taste through the live input handlers.
  const buns=w.slice(w.addIngredient('bunWhole',[0,.95,-.88]));hold(null);r.paused=false;
  function click(button){r.canvas.dispatchEvent(new PointerEvent('pointerdown',{button,bubbles:true}));window.dispatchEvent(new PointerEvent('pointerup',{button,bubbles:true}));for(let i=0;i<30;i++)r.animateHands(.05);r.renderEntities(0);}
  aim(get('spatula'));click(2);aim(p);click(2);aim(buns[0]);click(2);
  check('spatula places the patty onto its bottom bun',p.food.assembly?.length===2&&!get('spatula').payload);
  aim(buns[1]);click(2);aim(p);click(2);check('spatula closes the burger without duplicating its bun',p.food.assembly?.length===3&&buns[1].stackRoot===p.id);
  aim(p);click(0);check('a built burger does not play a fake flip',!r.action&&document.getElementById('real-toast').textContent.includes('layer'));
  aim(p);click(2);aim(plate);click(2);check('the complete burger transfers from spatula to tasting plate',p.trayCarrier===plate.id&&plate.cargo.length===1&&!get('spatula').payload);
  aim(get('spatula'),'rest');r.hover.data.entity=get('spatula').id;click(2);w.lastTasting=null;aim(p);click(0);
  check('aiming at the plated burger tastes it without needing to hit the plate rim',!!w.lastTasting&&!document.getElementById('real-tasting').hidden);
  r.save();const copy=RealKitchen.Kitchen.restore(w.snapshot());check('completed service restores every burger layer and its plate',copy.get(p.id).food.assembly.length===3&&copy.get(plate.id).cargo[0]===p.id);
  Object.assign(w.player,{x:0,z:-1.85,y:0,yaw:Math.PI,pitch:-.65});r.move(0);r.paused=true;document.getElementById('real-pause').hidden=true;r.hint();
  return out;
 });
 for(const result of results)k.ok(result.value,result.name);
 await k.shot('completed-service');
}};
