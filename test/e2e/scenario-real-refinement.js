'use strict';
module.exports={name:'real-refinement',experience:'real',description:'thin-food pickup, bun-first builds, parked probes, water and settled layers',async run(k){
 const page=k.page;
 await page.locator('#real-resume').click();
 async function aim(point,from){await page.evaluate(({point,from})=>{const r=realMode,p=r.world.player;Object.assign(p,{x:from[0],z:from[1],y:0});r.eyeHeight=1.72;r.probeLean=0;for(let i=0;i<8;i++){r.move(0);const v=new THREE.Vector3(...point).sub(r.camera.position);p.yaw=Math.atan2(-v.x,-v.z);p.pitch=Math.atan2(v.y,Math.hypot(v.x,v.z));}r.move(0);r.hover=r.focus();},{point,from});}
 async function click(){await page.mouse.down({button:'right'});await page.mouse.up({button:'right'});await page.waitForFunction(()=>!realMode.action);}
 const bacon=await page.evaluate(()=>{const r=realMode,e=r.world.addIngredient('bacon',[0,.962,-.88]);r.renderEntities(0);return e.id;});
 await aim([0,.969,-.88],[0,-1.9]);await click();k.ok(await page.evaluate(id=>realMode.held===id,bacon),'real right click picks bacon off the board');
 await aim([.20,.962,-.75],[0,-1.9]);await click();k.ok(await page.evaluate(id=>!realMode.held&&!realMode.world.get(id).held,bacon),'right click places bacon on a free counter spot');
 const point=await page.evaluate(id=>{const r=realMode,e=r.world.get(id);e.yaw=1.2;e.food.shrink=.35;r.renderEntities(0);return [e.pos[0],e.pos[1]+.006,e.pos[2]];},bacon);
 await aim(point,[0,-1.9]);await click();k.ok(await page.evaluate(id=>realMode.held===id,bacon),'rotated and reshaped bacon can be picked up again');
 const prep=await page.evaluate(baconId=>{
  const r=realMode,w=r.world,T=THREE,out=[],check=(name,ok)=>out.push({name,ok:!!ok});w.discard(w.get(baconId));r.held=null;r.action=null;r.paused=true;document.getElementById('real-pause').hidden=true;
  const [bottom,top]=w.slice(w.addIngredient('bunWhole',[0,.962,-.88])),plate=w.entities.find(e=>e.kind==='plate');w.putOnTray(bottom,plate);
  const hold=e=>{r.action=null;r.left=false;for(const q of w.entities)q.held=false;r.held=e?.id||null;if(e)e.held=true;r.renderEntities(0);};
  const target=e=>r.hover={data:{type:'entity',entity:e.id},point:new T.Vector3(...e.pos)};
  const sauce=w.entities.find(e=>e.kind==='mayo');hold(sauce);target(bottom);r.use();for(let i=0;i<20;i++)r.animateHands(.05);check('sauce can dress a bare bottom bun through left click',w.layers(bottom).some(l=>l.cold==='mayo'));
  const tomato=w.addIngredient('tomatoSlice',[0,.96,0]);tomato.sliceMm=4;hold(tomato);target(bottom);r.interaction.render();check('a bun-first topping has a valid placement preview',r.interaction.ghost?.visible);r.placeHeld(r.hover);
  const cheese=w.addIngredient('cheese',[0,.96,0]);cheese.massG=20;hold(cheese);target(bottom);r.placeHeld(r.hover);check('tomato and cheese sit below the future patty',w.layers(bottom).length===4&&!r.held);
  const thermal=BurgerCheese.surface(cheese.sliceState);thermal.add((70-thermal.T)*thermal.C);hold(null);target(bottom);r.interaction.peel();check('hot cheese asks for a utensil',!r.action&&!r.held);const spatula=w.entities.find(e=>e.kind==='spatula');hold(spatula);target(bottom);r.interaction.peel();for(let i=0;i<20;i++)r.animateHands(.05);r.renderEntities(0);check('the spatula can lift a warm cheese layer',spatula.payload===cheese.id);const before=cheese.sliceState.T;w.step(.05);check('removed cheese keeps cooling',cheese.sliceState.T<before);r.placeHeld(r.hover);check('the warm slice can go back on the bun',cheese.stackRoot===bottom.id&&!spatula.payload);
  hold(top);target(top);r.hint();check('the crown is identified as the top bun',document.getElementById('real-held-name').textContent==='top bun');hold(null);target(bottom);r.hint();check('a dressed bottom bun is named clearly',document.getElementById('real-target-name').textContent==='dressed bottom bun');
  r.renderEntities(0);const rec=r.meshes.get(bottom.id),plateMesh=r.meshes.get(plate.id).mesh,expected=plateMesh.localToWorld(new T.Vector3(0,.008,0));check('the dressed bun stays seated on its plate',Math.abs(bottom.pos[1]-expected.y)<.0001&&rec.mesh.parent===plateMesh);
  r.refinement={bottom:bottom.id,top:top.id,cheese:cheese.id,plate:plate.id};r.renderEntities(0);return out;
 },bacon);for(const c of prep)k.ok(c.ok,c.name);
 const plateAt=await page.evaluate(()=>realMode.world.get(realMode.refinement.plate).pos);await aim([plateAt[0],plateAt[1]+.04,plateAt[2]],[.5,-1.7]);await page.evaluate(()=>{realMode.renderEntities(0);realMode.hint();realMode.renderer.render(realMode.scene,realMode.camera);});await k.shot('dress-the-bun');
 const stack=await page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[],check=(name,ok)=>out.push({name,ok:!!ok}),q=r.refinement,bottom=w.get(q.bottom),top=w.get(q.top);
  w.bowl={mass:200,salt:1.6,work:.15};w.scoop(2);const meat=w.form([0,.96,-.88]);meat.food.T.fill(70);meat.food.faceDown.brown=meat.food.faceUp.brown=1.7;
  r.held=meat.id;meat.held=true;r.renderEntities(0);r.hover={data:{type:'entity',entity:bottom.id},point:new T.Vector3(...bottom.pos)};r.placeHeld(r.hover);
  check('adding meat preserves the dressed bun and plate',meat.food.assembly.length===5&&meat.trayCarrier===q.plate);
  const egg=w.addIngredient('egg',[0,.96,0]);w.makeFood(egg,'egg');egg.food.yolkSet=.6;egg.food.setTop=egg.food.setBot=1;w.assemble(egg,meat);
  const pickles=[];for(let i=0;i<4;i++){const e=w.addIngredient('pickleSlice',[0,.96,0]);e.sliceMm=6;w.assemble(e,meat);pickles.push(e);}
  w.assemble(top,meat);r.renderEntities(0);const ys=pickles.map(e=>r.meshes.get(e.id).mesh.getWorldPosition(new T.Vector3()).y);check('pickle coins spread across one level instead of stacking vertically',Math.max(...ys)-Math.min(...ys)<.001&&new Set(pickles.map(e=>e.pos[0].toFixed(4))).size>2);check('the egg yields beneath the crown and toppings',r.meshes.get(egg.id).mesh.scale.y<.8);
  const bounds=new T.Box3();for(const e of w.entities.filter(e=>e===meat||e.stackRoot===meat.id))bounds.expandByObject(r.meshes.get(e.id).mesh);check('the loaded burger stays below 12 cm',bounds.max.y-bounds.min.y<.12);
  const saved=w.snapshot();r.load(saved);r.renderEntities(0);check('the complete build restores with its original cheese slice',r.world.get(q.cheese).sliceState===r.world.get(meat.id).food.assembly[3].cheese);r.refinement={...q,meat:meat.id};r.hint();r.renderer.render(r.scene,r.camera);return out;
 });for(const c of stack)k.ok(c.ok,c.name);await k.shot('settled-burger');
 const probe=await page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[],check=(name,ok)=>out.push({name,ok:!!ok});w.bowl={mass:160,salt:1.3,work:.1};w.scoop(2);const food=w.form([0,.962,-.88]),tool=w.entities.find(e=>e.kind==='probe');
  r.held=tool.id;tool.held=true;r.action=null;r.left=true;Object.assign(w.player,{x:0,z:-1.45,y:0,yaw:Math.PI,pitch:-1});r.move(0);r.renderEntities(0);r.hover={data:{type:'entity',entity:food.id},point:new T.Vector3(food.pos[0],food.pos[1]+food.food.h,food.pos[2])};r.use();r.interaction.probe.depth=.007;r.interaction.probe.manual=true;
  for(let i=0;i<40;i++){r.move(.05);r.animateHands(.05);r.renderEntities(.05);}check('the probe reaches real meat at the selected depth',r.interaction.probe.valid);window.dispatchEvent(new MouseEvent('mouseup',{button:0,bubbles:true}));r.renderEntities(0);r.hint();check('release leaves the probe inserted and frees the hand',tool.probeAttachment?.foodId===food.id&&!r.held);
  food.food.T.fill(65);food.pos[0]+=.2;food.yaw=.6;food.food.h*=.9;r.renderEntities(0);r.hint();const mesh=r.meshes.get(tool.id).mesh,meat=r.meshes.get(food.id).mesh,tip=meat.worldToLocal(mesh.localToWorld(new T.Vector3(...r.grip(tool).tip)));check('the parked tip follows moving and shrinking meat',Math.abs(tip.y/food.food.h-(1-tool.probeAttachment.depth))<.0001);check('live probe reading stays visible with free hands',!document.getElementById('real-probe').hidden&&document.getElementById('real-probe-value').textContent.includes('65.0'));
  r.refinement.probe={food:food.id,tool:tool.id,attachment:{...tool.probeAttachment}};const spatula=w.entities.find(e=>e.kind==='spatula');w.placeFood(food,'gas');r.held=spatula.id;spatula.held=true;r.renderEntities(0);r.hover={data:{type:'entity',entity:food.id},point:new T.Vector3(...food.pos)};r.use();check('flipping asks for the probe to be removed first',!r.action&&document.getElementById('real-toast').textContent.includes('probe'));check('a lid cannot cover an inserted probe',!!w.lidProblem('gas'));
  spatula.held=false;r.held=null;r.renderEntities(0);r.hover={data:{type:'entity',entity:tool.id},point:new T.Vector3(...tool.pos)};Object.assign(w.player,{x:-1.5,z:.1,y:0,yaw:Math.PI,pitch:-.8});r.move(0);r.toggleGrab();for(let i=0;i<30;i++)r.animateHands(.05);check('right click retrieves the probe',r.held===tool.id&&!tool.probeAttachment);r.action=null;r.placeHeld({data:{type:'rest',entity:tool.id},point:new T.Vector3(...tool.home)});r.renderEntities(0);r.hint();return out;
 });for(const c of probe)k.ok(c.ok,c.name);
 await page.evaluate(()=>{const r=realMode,w=r.world,q=r.refinement.probe;w.parkProbe(w.get(q.tool),w.get(q.food),q.attachment);r.renderEntities(0);});
 await aim([-1.5,1.02,.95],[-1.5,.1]);await page.evaluate(()=>{const r=realMode;for(let i=0;i<25;i++)r.animateHands(.05);r.renderEntities(0);r.hint();document.getElementById('real-toast').hidden=true;r.renderer.render(r.scene,r.camera);});await k.shot('probe-left-in');
 const restored=await page.evaluate(()=>{const r=realMode,ids=r.refinement,saved=r.world.snapshot();r.load(saved);r.refinement=ids;r.renderEntities(0);r.hint();const tool=r.world.get(ids.probe.tool),ok=tool.probeAttachment&&Number.isFinite(r.world.probeReading(tool).temperature)&&!document.getElementById('real-probe').hidden;delete tool.probeAttachment;tool.pos=tool.home.slice();return ok;});k.ok(restored,'a parked probe restores as a live physical instrument');
 const water=await page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[],check=(name,ok)=>out.push({name,ok:!!ok}),st=w.station('induction'),vp=r.stations.get(st.id),bottle=w.entities.find(e=>e.kind==='water');
  r.held=bottle.id;bottle.held=true;r.left=true;r.action=null;r.hover={data:{type:'station',id:st.id},point:new T.Vector3(st.x,.96,st.z)};r.continuous(2);r.left=false;bottle.held=false;r.held=null;r.renderEntities(0);const surface=vp.waterView;check('pouring water creates a visible pool from its real mass',st.state.pan.water>.039&&surface.group.visible&&surface.depth>.001);
  BurgerPhysics.addFat(st.state,'canola',5);r.renderEntities(0);check('oil and water both remain visible',vp.oil.visible&&surface.group.visible&&surface.heightAt(0,0)>0);
  const positions=vp.oil.geometry.attributes.position;check('oil rides above the water locally',positions.getZ((positions.count-1)/2)>=surface.depth);
  st.state.pan.Tr.fill(180);st.state.pan.T=st.state.pan.Tcenter=180;BurgerPhysics.setKnob(st.state,5);st.state.pan.waterT=100;vp.waterView.update(st.state.pan,10,vp.panFloorY);check('hot water makes surface bubbles',surface.bubbles.visible);
  r.refinement.waterStation=st.id;r.hint();return out;
 });for(const c of water)k.ok(c.ok,c.name);
 await aim([1.5,.965,.95],[1.5,.05]);await page.evaluate(()=>{const r=realMode;for(let i=0;i<25;i++)r.animateHands(.05);r.renderEntities(0);r.hint();document.getElementById('real-toast').hidden=true;r.renderer.render(r.scene,r.camera);});await k.shot('water-and-oil');
 const last=await page.evaluate(()=>{
  const r=realMode,w=r.world,out=[],check=(name,ok)=>out.push({name,ok:!!ok}),st=w.station('induction'),pan=w.get(st.panId);w.liftPan(pan);pan.pos=[.2,.94,2.9];r.renderEntities(0);check('water follows a pan off the hob',r.meshes.get(pan.id).oilView.waterView.group.visible&&!r.stations.get('induction').panGroup.visible);
  const view=r.meshes.get(pan.id).oilView.waterView,geo=view.mesh.geometry;for(let i=0;i<100;i++)view.update(pan.pan,i*.1,.004);check('liquid animation reuses its geometry',geo===view.mesh.geometry);pan.pan.water=0;view.update(pan.pan,12,.004);check('an evaporated pool disappears',!view.group.visible);
  check('the logo uses the original colourful burger asset',document.querySelector('#real-badge img')?.getAttribute('src')==='assets/icons/burger.svg');check('the chef has a slightly slimmer body',r.body.scale.z===.88);return out;
 });for(const c of last)k.ok(c.ok,c.name);
}};
