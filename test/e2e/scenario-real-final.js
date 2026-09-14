'use strict';
module.exports={name:'real-final',experience:'real',description:'interrupted holds, loaded pans, cutaway recovery and cooking feedback',async run(k){
 const page=k.page;
 await page.locator('#real-resume').click();
 async function aim(point,from){await page.evaluate(({point,from})=>{const r=realMode,p=r.world.player;r.contact.reset();Object.assign(p,{x:from[0],z:from[1],y:0});for(let i=0;i<8;i++){r.move(0);const d=new THREE.Vector3(...point).sub(r.camera.position);p.yaw=Math.atan2(-d.x,-d.z);p.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));}r.move(0);r.hover=r.focus();},{point,from});}
 const panId=await page.evaluate(()=>{const r=realMode,w=r.world,pan=w.entities.find(e=>e.panType==='nonstick');w.pourInto(pan.id,'water',100);r.pick(pan);r.action=null;r.renderEntities(0);return pan.id;});
 await page.mouse.move(700,300);await aim([0,.936,-.36],[0,-1.9]);await k.frames(4);
 await page.mouse.down();await page.mouse.move(700,430,{steps:5});
 await page.waitForFunction(()=>realMode.interaction.techniques.control?.kind==='tilt'&&realMode.heldEntity().tilt>.3);
 await page.mouse.down({button:'right'});await page.mouse.up({button:'right'});await page.waitForFunction(()=>!realMode.action);
 const afterPlace=await page.evaluate(id=>({held:realMode.held,control:realMode.interaction.techniques.control?.kind,water:realMode.world.get(id).pan.water}),panId);
 await k.frames(5);const later=await page.evaluate(id=>realMode.world.get(id).pan.water,panId);await page.mouse.up();
 k.ok(!afterPlace.held&&!afterPlace.control&&Math.abs(later-afterPlace.water)<.001,'placing a tilted pan ends its pour and leaves the remaining water in it');
 await page.evaluate(()=>realMode.pause());await k.frames(2);
 const checks=await page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,P=BurgerPhysics,out=[],check=(name,ok)=>out.push({name,ok:!!ok}),get=kind=>w.entities.find(e=>e.kind===kind);
  r.paused=true;document.getElementById('real-pause').hidden=true;
  function hold(e){r.action=null;r.left=false;r.activity=null;r.grabControl=null;r.interaction.techniques.control=null;r.interaction.probe=null;r.contact.reset();for(const q of w.entities){q.held=false;q.payload=null;}r.held=e?.id||null;if(e)e.held=true;r.renderEntities(0);}
  function target(data,point){r.contact.reset();Object.assign(w.player,{x:point.x,z:point.z-.85,y:0});for(let i=0;i<8;i++){r.move(0);const d=point.clone().sub(r.camera.position);w.player.yaw=Math.atan2(-d.x,-d.z);w.player.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));}r.move(0);r.hover={data,point};}
  function settle(){for(let i=0;i<45;i++){r.continuous(.025);r.animateHands(.025);r.renderEntities(.025);}}
  const pan=w.entities.find(e=>e.panType==='nonstick');hold(pan);target({type:'sink'},new T.Vector3(2.6,.82,3.57));r.left=true;r.use();r.interaction.drag({movementX:0,movementY:70});r.continuous(.05);r.pause();check('pause ends the physical hold as well as the mouse input',!r.interaction.techniques.control&&!r.left);
  document.getElementById('real-pause').hidden=true;hold(pan);target({type:'surface'},new T.Vector3(0,.936,-.36));r.left=true;r.use();r.interaction.drag({movementX:0,movementY:70});const amount=pan.pan.water;w.player.x-=3;r.move(0);r.continuous(.5);check('walking out of reach stops pouring at the old target',!r.interaction.techniques.control&&pan.pan.water===amount);
  const grill=w.station('charcoal'),rake=get('rake');hold(rake);target({type:'station',id:'charcoal'},new T.Vector3(grill.x,r.stations.get('charcoal').scene.position.y+r.stations.get('charcoal').panFloorY,grill.z));r.left=true;r.use();settle();const bank=grill.state.grill.bank;w.player.x-=3;r.move(0);r.interaction.drag({movementX:100,movementY:0});r.continuous(.5);check('a rake already touching the coals stops when the chef leaves',!r.interaction.techniques.control&&grill.state.grill.bank===bank);
  hold(null);w.portion={mass:150,salt:1,work:0};const meat=w.form([0,.964,-.85]);w.placeFood(meat,'gas');const cheese=w.addIngredient('cheese',[0,.96,0]);w.addCheese(cheese,meat);const lid=get('lid');lid.station='gas';w.station('gas').state.lid=true;
  hold(get('spatula'));target({type:'panLid',id:'gas'},new T.Vector3(-1.5,1.02,.95));r.interaction.peel();settle();check('E cannot lift cheese through a closed pan lid',cheese.cheeseCarrier===meat.id&&meat.food.cheeses.length===1);
  lid.station=null;w.station('gas').state.lid=false;w.detach(meat);hold(null);const [bottom,top]=w.slice(w.addIngredient('bunWhole',[.5,.964,-.85]));w.assemble(meat,bottom);w.assemble(top,meat);meat.cut=true;r.renderEntities(.05);
  const topRec=r.meshes.get(top.id),clipped=()=>{let count=0;topRec.mesh.traverse(o=>{for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])if(m.clippingPlanes?.length)count++;});return count;};const beforeClip=clipped();w.peel(meat);r.renderEntities(.05);check('a bun lifted from a cut burger becomes whole again',beforeClip>0&&clipped()===0);
  const egg=w.addIngredient('egg',[.2,.936,-.85]);w.makeFood(egg,'egg');w.placeFood(egg,pan.id);r.renderEntities(0);hold(pan);r.renderEntities(0);w.player.z-=.2;r.move(.1);r.renderEntities(.1);check('loaded cookware keeps its food attached while carried',r.meshes.get(egg.id).mesh.parent===r.meshes.get(pan.id).mesh&&w.owner(egg)===pan.parked&&egg.food.where==='pan');
  // Restore a clean loaded oven pan to inspect the same ownership through the HUD and save.
  hold(null);const ovenPan=w.get(w.station('induction').panId);w.doors.oven=true;w.ovenPan(ovenPan);r.renderEntities(0);target({type:'entity',entity:ovenPan.id},new T.Vector3(...ovenPan.pos));r.hint();check('oven-pan feedback names the oven heat source',document.getElementById('real-heat-detail').textContent.includes('Oven'));
  check('the audited kitchen can still be restored',!!RealKitchen.Kitchen.restore(w.snapshot()));
  hold(null);Object.assign(w.player,{x:0,z:-1.9,y:0,yaw:Math.PI,pitch:-.45});r.move(0);r.hover=r.focus();r.hint();r.renderer.render(r.scene,r.camera);return out;
 });for(const c of checks)k.ok(c.ok,c.name);await k.shot('final-kitchen');
}};
