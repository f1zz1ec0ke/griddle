const test=require('node:test'),assert=require('node:assert/strict'),{Kitchen}=require('../js/real-model'),P=require('../js/physics');
const A=require('../js/assembly');
function patty(k){k.bowl={mass:500,salt:5,work:.2};k.scoop(2);return k.form([0,.96,-.9]);}
test('successive cuts conserve ingredient mass, and cheese carries its slice mass into cooking',()=>{
 const k=new Kitchen(),block=k.addIngredient('cheeseBlock',[0,.95,0]);let total=0,count=0;
 while(!block.discarded&&count<30){const [slice]=k.cut(block,3);assert.ok(slice);total+=slice.massG;count++;slice.pos[0]=2+count*.1;}
 assert.ok(Math.abs(total-400)<1e-8);assert.equal(count,10);assert.deepEqual(k.cut(block),[]);
 const p=patty(k),slice=k.entities.find(e=>e.kind==='cheese');k.placeFood(p,'gas');assert.ok(k.addCheese(slice,p));assert.equal(p.food.cheeses[0].mass,slice.massG/1000);assert.equal(k.addCheese(slice,p),false);k.step(.05);assert.ok(Number.isFinite(p.food.cheeses[0].T));
 const onion=k.addIngredient('onion',[-1,.95,0]),[cut]=k.cut(onion,8);assert.equal(cut.massG,8);assert.ok(Math.abs(P.itemMass(cut.food)-.008)<1e-8);assert.ok(cut.food.D<.1);assert.equal(cut.food.Dcov,cut.food.D);
});
test('mince blends and patty thickness survive portion return and saves',()=>{
 const k=new Kitchen();k.addMince(k.addIngredient('meatLean',[0,1,0]));k.addMince(k.addIngredient('meatRich',[0,1,0]));assert.equal(k.bowl.fatFrac,.2);
 k.scoop(2);k.scoop(.5,true);assert.equal(k.bowl.mass+k.portion.mass,1000);assert.equal(k.portion.fatFrac,.2);
 k.settings.thicknessMm=10;const p=k.form([0,.95,0]);k.scoop(1.5);k.settings.thicknessMm=30;const q=k.form([.3,.95,0]);assert.equal(p.food.massKg0,q.food.massKg0);assert.ok(q.food.h>p.food.h*2);assert.ok(q.food.D<p.food.D);
 const saved=Kitchen.restore(k.snapshot());assert.equal(saved.settings.thicknessMm,30);assert.equal(saved.bowl.fatFrac,.2);
});
test('seasoning quantity has a bounded response and excess is recognised at tasting',()=>{
 const k=new Kitchen();k.bowl={mass:500,salt:0,work:0};k.scoop(2);const p=k.form([0,.95,0]),plain=p.food.whc0;
 k.applySeasoning(p,.01);assert.ok(p.food.whc0>plain&&p.food.whc0<plain+.001);
 k.applySeasoning(p,1.43);const useful=p.food.whc0;k.applySeasoning(p,10);assert.equal(p.food.whc0,useful);assert.ok(k.taste(p).notes.includes('Far too salty.'));
 const copy=Kitchen.restore(k.snapshot());assert.deepEqual(copy.get(p.id).food.saltGrams,p.food.saltGrams);
});
test('probe samples both radial position and actual depth without altering the grid',()=>{
 const k=new Kitchen(),e=patty(k),p=e.food;for(let z=0;z<p.Nz;z++)for(let r=0;r<p.Nr;r++)p.T[z*p.Nr+r]=10+z*2+r*3;
 const before=p.T.slice();assert.equal(k.probe(e,0,p.h),10);assert.equal(k.probe(e,p.D/2,0),10+(p.Nz-1)*2+(p.Nr-1)*3);
 assert.ok(Math.abs(k.probe(e,p.D/4,p.h/2)-(10+(p.Nz-1)+(p.Nr-1)*1.5))<1e-8);assert.deepEqual(p.T,before);
 assert.ok(Math.abs(k.probe(e,p.D/2*3.5/p.Nr,p.h*(1-4.5/p.Nz))-(10+4*2+3*3))<1e-8);
});
test('aimed heat-zone placement preserves the chosen point and a blocked transfer is atomic',()=>{
 const k=new Kitchen(),p=patty(k);assert.equal(k.placeFood(p,'gas',{x:.025,y:0}),null);assert.ok(Math.abs(p.food.pos.x-.025)<1e-6);
 k.station('induction').state.lid=true;assert.match(k.placeFood(p,'induction',{x:0,y:0}),/lid/);assert.equal(p.station,'gas');assert.equal(k.station('gas').state.patties[0],p.food);
});
test('burger reworking preserves layer state, then a plate carries and saves the whole build',()=>{
 const k=new Kitchen(),p=patty(k),b=k.slice(k.addIngredient('bunWhole',[0,.95,0])),[tomato]=k.cut(k.addIngredient('tomato',[.3,.95,0]),9);
 assert.ok(k.assemble(p,b[0]));assert.ok(k.assemble(tomato,p));const layer=p.food.assembly.at(-1);A.coldNode(layer);layer.T=44;layer.wilt=.7;
 assert.ok(k.assemble(b[1],p));assert.equal(k.peel(p),b[1]);assert.equal(k.peel(p),tomato);assert.equal(tomato.coldState.T,44);assert.equal(tomato.coldState.wilt,.7);
 assert.ok(k.assemble(tomato,p));assert.equal(p.food.assembly.at(-1).height,.009);assert.equal(p.food.assembly.at(-1).T,44);assert.ok(k.assemble(b[1],p));
 const plate=k.entities.find(e=>e.kind==='plate');assert.ok(k.putOnTray(p,plate));assert.equal(k.peel(p),null);const copy=Kitchen.restore(k.snapshot());assert.equal(copy.get(p.id).trayCarrier,plate.id);assert.equal(copy.get(p.id).food.assembly[0].item,copy.get(b[0].id).food);
 p.food.peakCenter=75;p.food.T.fill(20);const report=k.taste(p);assert.ok(report.notes.includes('Cold at the centre.'));assert.ok(report.notes.includes('The fresh toppings have wilted.'));assert.ok(!('score' in report));
});
test('peeling a double burger releases each patty and the original bun exactly once',()=>{
 const k=new Kitchen(),p=patty(k),q=patty(k),b=k.slice(k.addIngredient('bunWhole',[0,.95,0]));k.assemble(p,b[0]);k.assemble(q,p);const grid=q.food.T;
 assert.equal(k.peel(p),q);assert.equal(q.food.T,grid);assert.equal(q.food.assembledTo,null);assert.equal(q.stackRoot,null);assert.equal(k.peel(p),p);assert.equal(b[0].stackRoot,null);assert.equal(b[0].food.assembledTo,null);assert.equal(p.food.assembly.length,0);
 assert.equal(k.loose.patties.filter(e=>e===p.food||e===q.food).length,2);assert.ok(k.assemble(p,b[0]));
});
test('Real portions conserve mince and salt when taking and returning meat',()=>{
 const k=new Kitchen();k.bowl={mass:500,salt:5,work:.3};k.scoop(2);assert.equal(k.portion.mass,180);assert.equal(k.portion.salt,1.8);k.scoop(.5,true);assert.equal(k.portion.mass,135);assert.equal(k.bowl.mass+k.portion.mass,500);assert.equal(k.bowl.salt+k.portion.salt,5);const e=k.form([0,.95,0]);assert.equal(e.food.massKg0,.135);assert.equal(e.food.salt,'mixed');assert.equal(k.portion.mass,0);
});
test('Real stations heat independently and food transfer retains its exact grid',()=>{
 const k=new Kitchen(),e=patty(k);P.setKnob(k.station('gas').state,10);P.setKnob(k.station('electric').state,4);
 for(let i=0;i<200;i++)k.step(.05);
 assert.ok(k.station('gas').state.pan.Tcenter>k.station('induction').state.pan.Tcenter);assert.ok(k.station('electric').state.pan.Tcenter>21);
 assert.equal(k.placeFood(e,'gas'),null);const grid=e.food.T;k.detach(e);assert.equal(k.placeFood(e,'induction'),null);assert.equal(e.food.T,grid);assert.equal(k.station('gas').state.patties.length,0);assert.equal(k.loose.patties.length,0);assert.equal(k.station('induction').state.patties[0],e.food);
});
test('a loaded pan carries its thermal state and food between stations without duplicating either',()=>{
 const k=new Kitchen(),e=patty(k);k.placeFood(e,'gas');const pan=k.get(k.station('gas').panId),other=k.get(k.station('electric').panId),metal=pan.pan;
 k.liftPan(other);k.liftPan(pan);assert.equal(e.panCarrier,pan.id);assert.equal(k.owner(e),pan.parked);assert.equal(k.station('gas').state.patties.length,0);k.step(.05);assert.equal(k.dockPan(pan,'electric'),null);assert.equal(k.station('electric').state.pan,metal);assert.equal(e.station,'electric');assert.equal(e.panCarrier,null);assert.equal(k.station('electric').state.patties[0],e.food);
});
test('Real saves preserve loaded-pan references and resume identical simulation',()=>{
 const k=new Kitchen(),e=patty(k);k.placeFood(e,'gas');const pan=k.get(k.station('gas').panId);k.liftPan(pan);const copy=Kitchen.restore(k.snapshot());assert.equal(copy.get(e.id).food,copy.get(pan.id).parked.patties[0]);k.step(.05);copy.step(.05);assert.deepEqual(copy.get(e.id).food,k.get(e.id).food);
});
test('preparation is required and the oven door gates placing food',()=>{
 const k=new Kitchen(),tomato=k.addIngredient('tomato',[0,.95,0]);assert.match(k.placeFood(tomato,'gas'),/Prepare/);assert.equal(k.slice(tomato).length,4);assert.ok(tomato.discarded);const e=patty(k);assert.match(k.placeFood(e,'oven'),/Open/);k.doors.oven=true;assert.equal(k.placeFood(e,'oven'),null);assert.equal(e.food.where,'oven');k.detach(e);assert.equal(e.food.where,'rest');
});
test('physical assembly retains cooking state, and discarding removes its ingredient references',()=>{
 const k=new Kitchen(),p=patty(k),buns=k.slice(k.addIngredient('bunWhole',[0,.96,0])),tomato=k.slice(k.addIngredient('tomato',[0,.96,0]))[0];
 assert.ok(k.assemble(p,buns[0]));assert.ok(k.assemble(tomato,p));assert.ok(k.assemble(buns[1],p));assert.equal(p.food.assembly.length,4);assert.equal(p.food.assembly[0].item,buns[0].food);assert.match(k.placeFood(p,'gas'),/assembled/);
 const restored=Kitchen.restore(k.snapshot());assert.equal(restored.get(p.id).food.assembly[0].item,restored.get(buns[0].id).food);k.discard(p);assert.equal(k.loose.patties.length,0);assert.equal(k.loose.items.length,0);assert.equal(k.get(buns[0].id),undefined);
});
test('a loaded oven tray carries its patties out together without duplicate ownership',()=>{
 const k=new Kitchen(),p=patty(k),tray=k.entities.find(e=>e.kind==='tray');assert.ok(k.putOnTray(p,tray));assert.match(k.ovenTray(tray),/Open/);k.doors.oven=true;assert.equal(k.ovenTray(tray),null);assert.equal(p.food.where,'oven');k.liftTray(tray);assert.equal(p.food.where,'rest');assert.equal(p.trayCarrier,tray.id);assert.deepEqual(tray.cargo,[p.id]);assert.equal(k.station('oven').state.patties.length,0);assert.equal(k.loose.patties.length,1);
});
test('pan lids travel with cookware and do not reappear after removal',()=>{
 const k=new Kitchen(),gas=k.station('gas'),pan=k.get(gas.panId),lid=k.entities.find(e=>e.kind==='lid');lid.station='gas';gas.state.lid=true;
 k.liftPan(pan);assert.equal(pan.parked.lid,true);assert.equal(lid.panCarrier,pan.id);assert.equal(gas.state.lid,false);
 assert.equal(k.dockPan(pan,'gas'),null);assert.equal(lid.station,'gas');assert.equal(gas.state.lid,true);
 lid.station=null;gas.state.lid=false;k.liftPan(pan);assert.equal(pan.lidId,null);assert.equal(k.dockPan(pan,'gas'),null);assert.equal(lid.station,null);assert.equal(gas.state.lid,false);
});
test('the spare non-stick pan starts on its own rack slot with a live cooling state',()=>{
 const k=new Kitchen(),pan=k.entities.find(e=>e.panType==='nonstick');assert.deepEqual(pan.pos,pan.home);assert.equal(pan.station,null);assert.equal(pan.pan,pan.parked.pan);k.step(.05);assert.ok(Number.isFinite(pan.pan.Tcenter));
});
test('a closed lid rejects placement without detaching food and cracking is idempotent',()=>{
 const k=new Kitchen(),p=patty(k);k.station('gas').state.lid=true;assert.match(k.placeFood(p,'gas'),/lid/);assert.equal(k.loose.patties[0],p.food);assert.equal(p.station,null);
 const egg=k.addIngredient('egg',[0,.95,0]);k.makeFood(egg,'egg');const food=egg.food;k.makeFood(egg,'egg');assert.equal(egg.food,food);assert.equal(k.loose.items.length,1);
});
test('free placement keeps an unobstructed choice and finds nearby space instead of intersecting food',()=>{
 const {clearPlacement}=require('../js/real-model'),f={minX:-.05,maxX:.05,minZ:-.05,maxZ:.05},surface={x:0,z:0,w:1,d:1};
 assert.deepEqual(clearPlacement([.48,.94,0],f,surface,[]),[.48,.94,0]);
 const blocker={minX:-.06,maxX:.06,minZ:-.06,maxZ:.06},pos=clearPlacement([0,.94,0],f,surface,[blocker]);assert.ok(pos);assert.ok(Math.abs(pos[0])>=.116||Math.abs(pos[2])>=.116);assert.equal(pos[1],.94);
 assert.equal(clearPlacement([0,.94,0],f,surface,[{minX:-1,maxX:1,minZ:-1,maxZ:1}]),null);
});
test('chef palms have finite outward-facing surfaces rather than inside-out faces',()=>{
 const previous=global.window;try{
  const T=require('../js/vendor/three.min.js');global.window={THREE:T};require('../js/visual-assets');require('../js/chef-rig');
  for(const side of [-1,1]){const hand=window.ChefRig.hand(side),g=hand.children[0].geometry,p=g.attributes.position,n=g.attributes.normal;let checked=0;
   for(let i=0;i<p.count;i++){assert.ok(Number.isFinite(n.getX(i)+n.getY(i)+n.getZ(i)));if(Math.hypot(p.getX(i),p.getY(i))>.005){assert.ok(p.getX(i)*n.getX(i)+p.getY(i)*n.getY(i)>0);checked++;}}
   assert.ok(checked>100);
  }
 }finally{if(previous===undefined)delete global.window;else global.window=previous;}
});
