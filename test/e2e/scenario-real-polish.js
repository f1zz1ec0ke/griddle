'use strict';
module.exports={name:'real-polish',experience:'real',description:'placement silhouettes, pinned actions, clear hints and safe probe release',async run(k){
 const checks=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[];
  const check=(name,value)=>out.push({name,value:!!value});
  function hold(e){r.interaction.probe=null;r.action=null;r.left=false;for(const q of w.entities){q.held=false;q.payload=null;}r.held=e?.id||null;if(e)e.held=true;r.renderEntities(0);}
  function aim(e,p){r.hover={data:e?{type:'entity',entity:e.id,name:e.label}:{type:'board',name:'Chopping board'},point:new T.Vector3(...p)};}
  function settle(){for(let i=0;i<25;i++)r.animateHands(.05);r.renderEntities(0);}
  const get=kind=>w.entities.find(e=>e.kind===kind);
  w.bowl={mass:150,salt:0,work:0};w.scoop(2);const burger=w.form([0,.962,-.88]),buns=w.slice(w.addIngredient('bunWhole',[0,.962,-.88]));w.assemble(burger,buns[0]);w.assemble(buns[1],burger);
  hold(burger);aim(null,[.30,.96,-.88]);settle();r.interaction.render();
  check('burger preview includes both buns and the patty',r.interaction.ghost.children.length===3);
  const box=new T.Box3().setFromObject(r.interaction.ghost);check('preview rests on the chosen surface',Math.abs(box.min.y-r.interaction.ghost.position.y)<.002);
  burger.held=false;r.held=null;burger.yaw=.35;r.renderEntities(0);check('turning a burger turns all its layers together',[burger,...buns].every(e=>Math.abs(r.meshes.get(e.id).mesh.rotation.y-.35)<.001));
  hold(get('probe'));aim(burger,burger.pos);r.left=true;r.use();const meat=r.meshes.get(burger.id).mesh;
  check('probing a built burger uses the visible meat height',r.interaction.probe.baseY>burger.pos[1]&&Math.abs(r.interaction.probe.baseY-meat.getWorldPosition(new T.Vector3()).y)<.001&&Math.abs(r.interaction.probe.height-burger.food.h*meat.scale.y)<.001);
  const spatula=get('spatula');hold(spatula);burger.yaw=.7;r.carry(spatula,burger);settle();r.hint();check('carried food retains its rotation',r.interaction.yaw===.7);check('hands label names both tool and food',document.getElementById('real-held-name').textContent==='spatula · burger');
  hold(get('knife'));aim(null,[0,.96,-.88]);r.animate('slice',()=>{},10);const target=r.action.target;r.hover.point.x=.6;r.action.time=4;settle();
  check('reaching stays attached to the original action target',target.point.x===0&&r.hover.point.x===.6);
  r.hint();check('long actions show progress',!document.getElementById('real-action').hidden&&document.getElementById('real-action').textContent==='Slicing');
  const salt=get('salt');hold(salt);const point=[salt.home[0]+.13,salt.home[1]-.002,salt.home[2]];aim(null,point);r.interaction.render();const before=r.interaction.ghost.position.clone();r.placeHeld(r.hover);
  check('placing near a tool rest no longer overrides the preview',new T.Vector3(...salt.pos).distanceTo(before)<.001);
  const probe=get('probe');hold(probe);aim(null,[.5,.96,-.5]);r.interaction.probe={id:burger.id,height:burger.food.h,depth:0,point:new T.Vector3(...burger.pos)};r.left=true;r.toggleGrab();r.renderEntities(0);check('putting down the probe cancels insertion safely',!r.interaction.probe);
  hold(get('plate'));aim(null,[0,.96,-.88]);r.hint();const hint=document.getElementById('real-hint').textContent;check('empty plate hint describes placement without claiming it can taste',hint.includes('place plate')&&!hint.includes('taste')&&!hint.includes('Left click: use'));
  // A new portion must find space beside an existing burger, never spawn inside it.
  hold(null);w.portion={mass:150,salt:0,work:0};aim(null,[0,.96,-.88]);r.left=true;r.use();settle();r.left=false;
  const formed=w.entities.filter(e=>e.kind==='patty').at(-1);check('forming respects occupied counter space',Math.hypot(formed.pos[0]-burger.pos[0],formed.pos[2]-burger.pos[2])>(formed.food.D+burger.food.D)/2);
  hold(spatula);r.carry(spatula,formed);settle();aim(null,[.3,.96,-.88]);r.interaction.render();r.hint();document.getElementById('real-pause').hidden=true;return out;
 });
 for(const c of checks)k.ok(c.value,c.name);await k.shot('placement');
}};
