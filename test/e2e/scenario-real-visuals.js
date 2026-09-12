'use strict';
module.exports={name:'real-visuals',experience:'real',description:'food support, shared assets and held cookware',async run(k){
 await k.page.locator('#real-resume').click();
 const result=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,base=.96,buns=w.slice(w.addIngredient('bunWhole',[0,base,-.88]));r.renderEntities(0);
  const bounds=e=>new THREE.Box3().setFromObject(r.meshes.get(e.id).mesh),loose=buns.map(e=>bounds(e).min.y);
  w.bowl={mass:150,salt:0,work:0};w.scoop(2);const patty=w.form([0,base,-.88]);w.assemble(patty,buns[0]);w.assemble(w.entities.find(e=>e.kind==='ketchup'),patty);w.assemble(buns[1],patty);r.renderEntities(0);
  const stackBottom=bounds(buns[0]).min.y,stackTop=bounds(buns[1]).max.y,meatTop=bounds(patty).max.y;
  const pan=w.get(w.station('gas').panId),glove=w.entities.find(e=>e.kind==='glove');w.liftPan(pan);r.held=glove.id;glove.held=pan.held=true;glove.payload=pan.id;r.animateHands(.05);r.renderEntities(0);
  const panScale=r.meshes.get(pan.id).mesh.scale.x,panParent=r.meshes.get(pan.id).mesh.parent===r.heldAnchor;
  r.world.player.pitch=-.45;r.move(0);r.renderer.render(r.scene,r.camera);
  return {loose,stackBottom,stackTop,meatTop,panScale,panParent,sharedSink:!!r.scene.getObjectByName('Shared sink'),sharedWindow:!!r.scene.getObjectByName('Shared window')};
 });
 result.loose.forEach(y=>k.near(y,.96,.002,'loose bun rests above the board'));
 k.near(result.stackBottom,.96,.002,'assembled bun remains on the board');k.ok(result.stackTop>result.meatTop,'crown sits above the meat');
 k.near(result.panScale,1,0,'carried pan keeps its actual size');k.ok(result.panParent,'carried pan follows the hand');k.ok(result.sharedSink&&result.sharedWindow,'room uses shared fixture assets');
 await k.shot('shared-kitchen-and-cookware');
}};
