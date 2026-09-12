'use strict';
module.exports={name:'real-usability',experience:'real',description:'crouch, precise food selection, utensil reach and valid previews',async run(k){
 const checks=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[],check=(name,ok)=>out.push({name,ok:!!ok});r.paused=false;
  function hold(e){r.action=null;r.left=false;for(const q of w.entities){q.held=false;q.payload=null;}r.held=e?.id||null;if(e)e.held=true;r.renderEntities(0);}
  function aim(point,x,z){Object.assign(w.player,{x,z,y:0});for(let i=0;i<6;i++){r.move(0);const d=point.clone().sub(r.camera.position);w.player.yaw=Math.atan2(-d.x,-d.z);w.player.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));}r.move(0);r.hover=r.focus();}
  window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyC',bubbles:true}));for(let i=0;i<20;i++)r.move(.05);check('C crouches',r.eyeHeight<1.1);window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyC',bubbles:true}));for(let i=0;i<20;i++)r.move(.05);check('releasing C stands up',r.eyeHeight>1.7);
  window.dispatchEvent(new KeyboardEvent('keydown',{code:'ControlLeft',bubbles:true}));r.move(.05);check('Control no longer crouches',r.eyeHeight>1.7);window.dispatchEvent(new KeyboardEvent('keyup',{code:'ControlLeft',bubbles:true}));
  const spatula=w.entities.find(e=>e.kind==='spatula');hold(spatula);
  const near=w.addIngredient('egg',[0,.95,0]),far=w.addIngredient('egg',[0,.95,0]);w.makeFood(near,'egg');w.makeFood(far,'egg');w.placeFood(near,'gas',{x:0,y:-.065});w.placeFood(far,'gas',{x:0,y:.065});r.renderEntities(0);
  r.hover={data:{type:'station',id:'gas'},point:new T.Vector3(-1.5,.97,1.015)};
  check('pan fallback chooses the aimed egg rather than the first egg',r.foodAt(r.hover)===far);r.use();for(let i=0;i<20;i++)r.animateHands(.05);check('only the aimed egg flips',far.food.flips===1&&near.food.flips===0);
  r.hover={data:{type:'station',id:'gas'},point:new T.Vector3(-1.63,.97,.95)};check('empty pan space does not silently select another egg',!r.foodAt(r.hover));
  r.renderEntities(0);const group=r.stations.get('gas').itemViews.get(far.food).group,box=new T.Box3().setFromObject(group),point=box.getCenter(new T.Vector3());point.y=box.max.y-.002;aim(point,-3.4,.95);
  check('a spatula can target food beyond bare-hand reach',r.camera.position.distanceTo(point)>1.75&&r.hover?.data.entity===far.id);
  r.hint();check('the selection marker identifies the aimed egg',r.focusRing.visible&&Math.abs(r.focusRing.position.z-far.pos[2])<.001);
  r.hover={data:{type:'station',id:'gas'},point:new T.Vector3(-1.5,.97,.95)};r.interaction.render();check('spatula placement ghost stays hidden over a pan',!r.interaction.ghost?.visible);
  r.hover={data:{type:'surface'},point:new T.Vector3(.25,.93,-.5)};r.interaction.render();check('valid counter placement still has a preview',r.interaction.ghost?.visible);
  w.portion={mass:150,salt:0,work:0};const p=w.form([0,.96,-.88]);hold(p);w.station('gas').state.lid=true;r.hover={data:{type:'station',id:'gas'},point:new T.Vector3(-1.5,.97,.95)};r.interaction.render();check('a closed pan hides the food placement preview',!r.interaction.ghost.visible);w.station('gas').state.lid=false;
  const buns=w.slice(w.addIngredient('bunWhole',[.4,.96,-.88]));hold(buns[1]);r.hover={data:{type:'entity',entity:p.id},point:new T.Vector3(...p.pos)};r.placeHeld(r.hover);check('invalid bun assembly explains the required first step and retains the bun',r.held===buns[1].id&&document.getElementById('real-toast').textContent.includes('bottom bun'));
  hold(buns[0]);r.placeHeld(r.hover);check('placing the bottom bun onto a patty starts the burger',p.food.assembly.length===2&&!r.held);
  hold(null);w.station('gas').state.lid=false;r.renderEntities(0);aim(point,-2.7,.8);check('bare-hand selection agrees with the highlighted food',r.hover?.data.entity===far.id);r.hint();r.paused=true;document.getElementById('real-pause').hidden=true;return out;
 });for(const c of checks)k.ok(c.ok,c.name);await k.shot('egg-selection');
}};
