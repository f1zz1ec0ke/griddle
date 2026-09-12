'use strict';
module.exports={name:'real-layout',experience:'real',description:'wall fixtures, physical targets, pan temperature and render resource lifetime',async run(k){
 const checks=await k.page.evaluate(()=>{
  const r=realMode,w=r.world,T=THREE,out=[],check=(name,ok)=>out.push({name,ok:!!ok});
  const bounds=name=>new T.Box3().setFromObject(r.scene.getObjectByName(name+' fixture'));
  r.scene.updateMatrixWorld(true);
  check('sink and fridge sit close to the rear wall',[bounds('sink'),bounds('fridge')].every(b=>b.max.z>3.8&&b.max.z<4.05));
  check('oven backs onto the left wall',bounds('oven').min.x< -3.8&&bounds('oven').min.x> -4.05);
  check('grill and pan rack use the perimeter',w.station('charcoal').x===3.45&&w.entities.filter(e=>e.kind==='pan').every(e=>e.home[2]===3.65));
  const tap=r.targets.find(o=>o.userData.realTarget.type==='tap'),at=new T.Box3().setFromObject(tap).getCenter(new T.Vector3());
  Object.assign(w.player,{x:2.6,z:2.55,y:0});for(let i=0;i<5;i++){r.move(0);const d=at.clone().sub(r.camera.position);w.player.yaw=Math.atan2(-d.x,-d.z);w.player.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));}r.move(0);r.hover=r.focus();check('tap remains reachable through ray picking',r.hover?.data.type==='tap');
  r.use();check('relocated tap operates',w.doors.tap);r.action=null;
  const pan=w.station('gas').state.pan,temperature=pan.Tcenter;pan.Tcenter=178;r.hover={data:{type:'station',id:'gas',name:'gas pan'},point:new T.Vector3(-1.5,.96,.95)};r.game.fahrenheit=false;r.hint();check('looking at a pan shows its centre temperature',document.getElementById('real-heat').textContent.includes('178 °C'));
  r.game.fahrenheit=true;r.hint();check('pan temperature respects Fahrenheit preference',document.getElementById('real-heat').textContent.includes('352 °F'));r.game.fahrenheit=false;pan.Tcenter=temperature;
  // Exercise actual GPU upload and disposal, after warming the reusable shaders.
  r.hover={data:{type:'button',id:'induction',action:'power'},point:new T.Vector3(1.61,.95,.732)};r.use();r.action=null;
  check('induction starts before ingredient handling',w.station('induction').state.stove.knob>0);
  for(const [i,kind] of ['oil','salt','water'].entries()){const e=w.entities.find(e=>e.kind===kind);r.pick(e);r.action=null;r.placeHeld({data:{type:'surface'},point:new T.Vector3(1.90,.93,.65+i*.16)});}
  for(let i=0;i<20;i++)w.step(.05);
  function cycle(){w.portion={mass:150,salt:0,work:0};const e=w.form([0,.96,-.88]);r.renderEntities(0);r.renderer.render(r.scene,r.camera);w.discard(e);r.renderEntities(0);r.renderer.render(r.scene,r.camera);}
  Object.assign(w.player,{x:0,z:-1.85,y:0,yaw:Math.PI,pitch:-.65});r.move(0);for(let i=0;i<5;i++)r.animateHands(.05);
  cycle();cycle();const before={...r.renderer.info.memory};for(let i=0;i<12;i++)cycle();const after=r.renderer.info.memory;
  check('repeated patty creation and disposal keeps GPU geometry and texture counts stable',before.geometries===after.geometries&&before.textures===after.textures);
  document.getElementById('real-pause').hidden=true;r.hover=null;r.hint();return out;
 });for(const c of checks)k.ok(c.ok,c.name);await k.shot('kitchen');
}};
