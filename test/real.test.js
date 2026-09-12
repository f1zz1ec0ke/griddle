const test=require('node:test'),assert=require('node:assert/strict'),{Kitchen}=require('../js/real-model'),P=require('../js/physics');
function patty(k){k.bowl={mass:500,salt:5,work:.2};k.scoop(2);return k.form([0,.96,-.9]);}
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
