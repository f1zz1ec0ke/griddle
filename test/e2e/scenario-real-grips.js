'use strict';
module.exports={name:'real-grips',experience:'real',description:'held objects, tool payloads, level cookware and release',async run(k){
 const result=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,results=[],failures=[];
  const prepare=kind=>w.addIngredient(kind,[0,.96,-.88]);
  const items=[...w.entities,...['meat','egg','tomato','pickles','onion','bunWhole','cheeseBlock','lettuce','bacon'].map(prepare)];
  for(const kind of ['tomato','pickles','onion','bunWhole','cheeseBlock'])items.push(...w.slice(prepare(kind)));
  w.bowl={mass:150,salt:0,work:0};w.scoop(2);const patty=w.form([0,.96,-.88]);items.push(patty);
  const egg=prepare('egg');w.makeFood(egg,'egg');items.push(egg);
  function settle(e){
   for(const q of w.entities)if(q.held){q.held=false;q.payload=null;}
   if(e.kind==='pan')w.liftPan(e);e.held=true;r.held=e.id;r.left=false;r.action=null;r.hover=null;r.grabControl=null;
   r.renderEntities(0);for(let i=0;i<20;i++)r.animateHands(.05);r.renderEntities(0);r.scene.updateMatrixWorld(true);
  }
  for(const e of items){
   settle(e);const mesh=r.meshes.get(e.id).mesh,g=r.grip(e);
   if(e.kind!=='glove'){
    const contact=r.arms[1].hand.localToWorld(new T.Vector3(...g.contact));
    const grip=r.heldAnchor.localToWorld(new T.Vector3());
    if(contact.distanceTo(grip)>.001)failures.push(e.kind+' loses hand contact');
    if(mesh.scale.x!==1||mesh.scale.z!==1)failures.push(e.kind+' changes size when held');
   }
   results.push(e.kind==='pan'?e.panType:e.kind);
  }
  const spatula=w.entities.find(e=>e.kind==='spatula');settle(spatula);spatula.payload=patty.id;patty.held=true;r.renderEntities(0);r.scene.updateMatrixWorld(true);
  const tip=r.meshes.get(spatula.id).mesh.localToWorld(new T.Vector3(0,.003,-.02));
  const bounds=new T.Box3().setFromObject(r.meshes.get(patty.id).mesh);
  const payloadGap=bounds.min.y-tip.y;
  const pan=w.entities.find(e=>e.kind==='pan');settle(pan);
  w.dockPan(pan,'gas');w.placeFood(patty,'gas');w.liftPan(pan);pan.held=true;const source=pan.parked;
  BurgerPhysics.addFat(source,'canola',5);w.player.pitch=-1.1;r.move(0);for(let i=0;i<20;i++)r.animateHands(.05);r.renderEntities(0);r.scene.updateMatrixWorld(true);
  const carriedMeatBottom=new T.Box3().setFromObject(r.meshes.get(patty.id).mesh).min.y;
  const panFloor=r.meshes.get(pan.id).mesh.localToWorld(new T.Vector3(0,.004,0)).y;
  const oil=r.meshes.get(pan.id).oilView,oilWidth=new T.Box3().setFromObject(oil.oil).getSize(new T.Vector3()).x;
  const panUp=new T.Vector3(0,1,0).transformDirection(r.meshes.get(pan.id).mesh.matrixWorld);
  const glove=w.entities.find(e=>e.kind==='glove');settle(glove);glove.payload=pan.id;pan.held=true;for(let i=0;i<20;i++)r.animateHands(.05);r.renderEntities(0);
  const gloved=r.arms[1].hand.userData.rig.gloved;
  // Returning to the rest must shed both the carrying rotation and glove pose.
  r.hover={data:{type:'rest',entity:pan.id},point:new T.Vector3(...pan.home)};r.placeHeld(r.hover);
  r.held=null;glove.held=false;for(let i=0;i<20;i++)r.animateHands(.05);r.renderEntities(0);
  const released=r.meshes.get(pan.id).mesh.parent===r.scene&&!r.arms[1].hand.userData.rig.gloved;
  const onions=items.find(e=>e.kind==='onions'),spoon=w.entities.find(e=>e.kind==='spoon');
  const matrix=new T.Matrix4(),read=()=>{r.meshes.get(onions.id).view.onionInst.getMatrixAt(0,matrix);return {radius:Math.hypot(matrix.elements[12],matrix.elements[14]),size:new T.Vector3().setFromMatrixScale(matrix).length()};};
  settle(spoon);const spread=read();spoon.payload=onions.id;onions.held=true;r.renderEntities(0);const gathered=read();
  spoon.payload=null;onions.held=false;r.renderEntities(0);const restored=read();
  w.detach(patty);const buns=w.slice(prepare('bunWhole'));w.assemble(patty,buns[0]);w.assemble(buns[1],patty);patty.cut=true;
  settle(patty);w.player.pitch=-.25;w.player.yaw=.8;r.move(0);for(let i=0;i<20;i++)r.animateHands(.05);r.renderEntities(0);
  const meat=r.meshes.get(patty.id).mesh,cutFollows=Math.abs(r.meshes.get(buns[0].id).clip.distanceToPoint(meat.getWorldPosition(new T.Vector3())))<.001;
  r.renderer.render(r.scene,r.camera);
  return {count:results.length,results,failures,payloadGap,panUp:panUp.y,gloved,released,carriedGap:carriedMeatBottom-panFloor,oilVisible:oil.oil.visible,oilWidth,spread,gathered,restored,cutFollows};
 });
 k.ok(result.count>=40,'all tools, cookware and prepared ingredient fixtures visited');
 k.ok(!result.failures.length,result.failures.join(', ')||'every grip remains attached at full scale');
 k.near(result.payloadGap,0,.012,'patty rests on the spatula blade');
 k.near(result.panUp,1,.001,'pan stays level while looking down');
 k.near(result.carriedGap,0,.003,'carried patty stays on the pan floor');
 k.ok(result.oilVisible&&result.oilWidth<.4,'carried oil uses the shared film inside the pan');
 k.ok(result.gloved&&result.released,'glove carries cookware and releases cleanly');
 k.ok(result.gathered.radius<result.spread.radius*.25,'spoon gathers the slivers');
 k.near(result.gathered.size,result.spread.size,.00001,'gathering preserves individual sliver size');
 k.near(result.restored.radius,result.spread.radius,.00001,'placed onions regain their spread');
 k.ok(result.cutFollows,'cutaway follows a held burger when the chef turns');
 await k.shot('held-burger');
}};
