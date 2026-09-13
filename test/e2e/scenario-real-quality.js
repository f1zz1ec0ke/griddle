'use strict';
module.exports={name:'real-quality',experience:'real',description:'contextual HUD, preparation, plated rebuilds, previews and interaction feedback',async run(k){
 const page=k.page;
 await page.locator('#real-units').click();k.ok(await page.locator('#real-units').textContent()==='°F','units are available inside Real mode');await page.locator('#real-units').click();
 await page.locator('#real-sound').focus();await page.keyboard.press('Space');k.ok(await page.evaluate(()=>!realMode.presentation.preferences.sound),'pause controls remain keyboard operable');await page.keyboard.press('Space');
 await k.range('#real-sensitivity',1.5);await k.range('#real-fov',80);
 k.ok(await page.evaluate(()=>realMode.camera.fov===80&&realMode.presentation.preferences.sensitivity===1.5),'view preferences apply to the camera');
 await k.range('#real-fov',72);await k.range('#real-sensitivity',1);
 const checks=await page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,P=BurgerPhysics,out=[],check=(name,ok)=>out.push({name,ok:!!ok});r.paused=false;
  r.scene.updateMatrixWorld(true);check('garden geometry stays outside the room',r.scene.getObjectByName('Shared garden').children.every(o=>new T.Box3().setFromObject(o).min.z>=4.019));
  const knobs=r.ovenKnobs,heat=w.station('oven').state.oven;r.ovenDrag=null;r.turn({type:'ovenKnob',control:'temperature'},20);check('oven temperature can be set while power is off',heat.target===0&&w.settings.ovenSetpoint===210);r.turn({type:'ovenKnob',control:'power'},30);r.renderEntities(0);check('both oven dials have moving pointers and distinct functions',heat.target===210&&knobs.length===2&&knobs.every(q=>q.mesh.children.length===2&&Math.abs(q.mesh.rotation.z)>0));w.setOvenPower(false);
  function hold(e){r.action=null;r.left=false;r.activity=null;for(const q of w.entities){q.held=false;q.payload=null;}r.held=e?.id||null;if(e)e.held=true;r.renderEntities(0);}
  function settle(){for(let i=0;i<25;i++)r.animateHands(.05);r.renderEntities(0);}
  function target(e){
   const point=new T.Vector3(...e.pos);r.contact.reset();Object.assign(w.player,{x:point.x,z:point.z-.85,y:0});
   for(let i=0;i<6;i++){r.move(0);const d=point.clone().sub(r.camera.position);w.player.yaw=Math.atan2(-d.x,-d.z);w.player.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));}r.move(0);
   r.hover={data:{type:'entity',entity:e.id,name:e.label},point};
  }
  w.addMince(w.addIngredient('meat',[0,.96,-.88]));w.bowl.salt=4;w.scoop(150/90);const p=w.form([0,.962,-.88]);
  const tomato=w.addIngredient('tomato',[.16,.962,-.88]),slice=w.cut(tomato,6,r.interaction.supportAt(tomato.pos))[0];check('a prepared slice has a real support',slice&&slice.pos[1]===tomato.pos[1]);
  const buns=w.slice(w.addIngredient('bunWhole',[-.05,.962,-.59])),plate=w.entities.find(e=>e.kind==='plate'),spatula=w.entities.find(e=>e.kind==='spatula');
  w.putOnTray(buns[0],plate);hold(p);target(buns[0]);const preview=r.interaction.placement(r.hover,p);r.interaction.render();check('assembly has a valid preview',preview?.kind==='assemble'&&r.interaction.ghost.visible);r.placeHeld(r.hover);check('burger starts on the plate',p.trayCarrier===plate.id);
  hold(slice);target(p);r.placeHeld(r.hover);hold(buns[1]);target(p);r.placeHeld(r.hover);check('toppings and crown join the plated stack',p.food.assembly.length===4);
  hold(null);target(p);r.interaction.peel();settle();check('E lifts the crown directly from the plate',r.held===buns[1].id&&p.trayCarrier===plate.id);
  hold(null);target(p);r.interaction.peel();settle();check('E removes a cold topping from the plate',r.held===slice.id&&slice.stackRoot==null);
  const sauce=w.entities.find(e=>e.kind==='ketchup');hold(sauce);target(p);r.interaction.render();check('a sauce bottle cannot preview as a burger layer',!r.interaction.ghost.visible);
  const cheese=w.entity('cheese','cheese',[0,.96,0]);hold(cheese);target(buns[0]);r.placeHeld(r.hover);check('aiming at a burger layer still puts cheese on exposed meat',p.food.cheeses.length===1&&!r.held);
  hold(null);target(p);r.interaction.use();settle();r.hint();check('tasting produces a compact result',!document.getElementById('real-tasting').hidden&&document.querySelectorAll('#real-tasting p').length>=5);
  const marker=document.getElementById('real-hint').getBoundingClientRect();check('action hints leave the centre of the view clear',marker.top>innerHeight*.60);
  w.detach(p);while(w.layers(p).length||w.topPart(p)?.cheeseCarrier)w.peel(p);w.placeFood(p,'gas');hold(spatula);target(p);r.hint();check('food selection retains pan temperature feedback',!document.getElementById('real-heat').hidden&&document.getElementById('real-heat-name').textContent==='Gas');
  p.food.faceDown.brown=1.4;r.presentation.update(r.hover,p,spatula);check('browning is signalled without an event log',document.getElementById('real-cues').textContent.includes('Browning'));
  P.flipPatty(w.station('gas').state,p.food);r.presentation.update(r.hover,p,spatula);check('flipping clears the old underside cue',!document.getElementById('real-cues').textContent.includes('Browning'));
  r.hover={data:{type:'station',id:'gas'},point:new T.Vector3(-1.5,.98,.95)};r.interaction.render();check('a held utensil cannot preview inside a pan',!r.interaction.ghost.visible);
  const oil=w.entities.find(e=>e.kind==='oil');hold(oil);r.hover={data:{type:'station',id:'gas'},point:new T.Vector3(-1.5,.98,.95)};r.left=true;r.continuous(.2);check('pouring drives both oil and feedback',r.activity?.kind==='oil'&&w.station('gas').state.pan.oil>0);
  w.station('gas').state.lid=true;r.continuous(.2);for(let i=0;i<20;i++)r.animateHands(.05);check('blocked pouring has no phantom flow or pour pose',!r.activity&&r.pourBlend<.001);w.station('gas').state.lid=false;
  r.left=false;hold(spatula);target(p);let fired=false;r.animate('flip',()=>fired=true);const original=w.player.z;w.player.z-=3;r.move(0);settle();check('walking away cancels an unfinished action',!fired);w.player.z=original;r.move(0);
  const lid=w.entities.find(e=>e.kind==='lid');hold(lid);target(p);r.interaction.render();check('an uncovered pan accepts a lid preview',r.interaction.ghost.visible);r.placeHeld(r.hover);check('right click covers the pan even when aiming at food',w.station('gas').state.lid&&lid.station==='gas');r.pick(lid);settle();r.placeHeld({data:{type:'rest',entity:lid.id},point:new T.Vector3(...lid.home)});
  const tray=w.entities.find(e=>e.kind==='tray');hold(tray);w.doors.oven=true;r.hover={data:{type:'ovenRack'},point:new T.Vector3(...RealKitchen.fixturePoint('oven',[0,.54,-.02]))};const ovenPlan=r.interaction.placement(r.hover,tray);r.placeHeld(r.hover);check('oven tray preview agrees with its final rack position',ovenPlan&&new T.Vector3(...ovenPlan.pos).distanceTo(new T.Vector3(...tray.pos))<.001);
  const discarded=w.addIngredient('tomato',[0,.94,0]);hold(discarded);r.hover={data:{type:'bin'},point:new T.Vector3(3.65,.6,-3.1)};r.placeHeld(r.hover);settle();check('discarding opens the pedal bin and retires the ingredient',w.doors.bin&&!w.get(discarded.id));
  hold(null);Object.assign(w.player,{x:-2.8,z:-2.2,y:0,yaw:-2.35,pitch:-.23});r.move(0);r.hover=null;settle();r.hint();r.paused=true;document.getElementById('real-pause').hidden=true;document.getElementById('real-toast').hidden=true;r.renderer.render(r.scene,r.camera);return out;
 });for(const c of checks)k.ok(c.ok,c.name);await k.shot('finished-kitchen');
 await page.evaluate(()=>{const r=realMode;document.getElementById('real-tasting').hidden=true;r.interaction.reportUntil=0;Object.assign(r.world.player,{x:0,z:-1.92,y:0,yaw:Math.PI,pitch:-1.12});r.move(0);for(let i=0;i<20;i++)r.animateHands(.05);r.renderEntities(0);r.hint();r.renderer.render(r.scene,r.camera);});await k.shot('chef-and-prep');
 await page.evaluate(()=>{const r=realMode;r.world.player.pitch=-.45;r.move(0);r.hover=null;r.pick(r.world.entities.find(e=>e.kind==='knife'));for(let i=0;i<20;i++)r.animateHands(.05);r.renderEntities(0);r.hint();r.renderer.render(r.scene,r.camera);});await k.shot('held-knife');
 await page.evaluate(()=>{const r=realMode;r.pause();});await k.shot('pause');
 const saved=await page.evaluate(()=>realMode.world.entities.filter(e=>e.kind==='patty').length);
 await page.locator('#real-leave').click();await page.locator('#choose-new').click();
 k.ok(await page.evaluate(()=>!realMode.world.entities.some(e=>e.kind==='patty')&&!!localStorage.getItem('griddle.real.previous')),'a fresh kitchen retains a recoverable previous save');
 await page.locator('#real-leave').click();await page.locator('#choose-previous').click();
 k.ok(await page.evaluate(()=>realMode.world.entities.filter(e=>e.kind==='patty').length)===saved,'the previous kitchen restores through the menu');
 await page.reload();await page.locator('#choose-real').click();
 k.ok(await page.evaluate(()=>realMode.world.entities.filter(e=>e.kind==='patty').length)===saved,'entering Real mode after reload preserves the saved cook');
 await page.locator('#real-leave').click();await page.evaluate(()=>localStorage.setItem('griddle.real.v1','broken save'));await page.reload();await page.locator('#choose-real').click();await page.locator('#choose-real').click();
 k.ok(await page.evaluate(()=>document.body.dataset.experience==='choose'&&localStorage.getItem('griddle.real.v1')==='broken save'),'repeated failed entry preserves a damaged save');
}};
