'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const P=require('../js/physics'),O=require('../js/oil-film'),A=require('../js/assembly'),S=require('../js/session');
function state(){return P.createState({stove:'gas',pan:'castiron'});}
function patty(s,T=70){const p=P.makePatty({id:1,massG:150,thicknessMm:20,fatFrac:.2,tempC:T,target:'medium'});P.placePatty(s,p,{x:0,y:0});return p;}
test('room smoke gathers overhead, lingers after cooking and clears through an open window',()=>{
  const s=state();s.diag.smoke=1;
  for(let i=0;i<2400;i++)P.stepRoom(s,.05);
  assert.ok(s.room.upper>.2 && s.room.upper>s.room.lower && s.room.lower>0);
  s.diag.smoke=0;const before=s.room.upper+s.room.lower;P.stepRoom(s,.05);
  assert.ok(s.room.upper+s.room.lower>before*.99,'switching the heat off does not instantly clear the room');
  const opened=S.decode(S.encode(s));P.toggleWindow(opened);
  for(let i=0;i<2400;i++){P.stepRoom(s,.05);P.stepRoom(opened,.05);}
  assert.ok(opened.room.upper+opened.room.lower<(s.room.upper+s.room.lower)*.25);
  const frozen=JSON.stringify(opened.room);P.stepRoom(opened,0);assert.equal(JSON.stringify(opened.room),frozen);
  const copy=S.decode(S.encode(opened));P.stepRoom(opened,.05);P.stepRoom(copy,.05);assert.deepEqual(copy.room,opened.room);
});
test('oil film conserves mass through pooling, food movement, addition and removal',()=>{
  const s=state(),pan=s.pan;pan.T=180;pan.oil=.012;O.sync(pan);
  const initial=Array.from(pan.film.mass),food={D:.09,pos:{x:0,y:0}};
  for(let i=0;i<300;i++) O.step(pan,[food],.05);
  assert.notDeepEqual(Array.from(pan.film.mass),initial);
  const centre=O.depth(pan,0,0);food.pos.x=.065;
  for(let i=0;i<300;i++) O.step(pan,[food],.05);
  assert.ok(O.depth(pan,0,0)>centre,'vacated trail fills back in');
  pan.oil+=.004;O.deposit(pan,.004,-.06,0);
  pan.oil*=.7;O.sync(pan);
  assert.ok(Math.abs(pan.film.mass.reduce((a,b)=>a+b,0)-pan.oil)<1e-12);
  assert.ok(pan.film.mass.every((m,i)=>m>=0 && (pan.film.mask[i] || m===0)));
  pan.oil=0;O.sync(pan);assert.equal(pan.film.mass.reduce((a,b)=>a+b,0),0);
});
test('local oil contact distinguishes a poured pool from a dry part of the pan',()=>{
  const pan=state().pan;pan.oil=.005;O.deposit(pan,.005,-.065,0,.015);
  const wet=O.contactMass(pan,{D:.025,pos:{x:-.065,y:0}}),dry=O.contactMass(pan,{D:.025,pos:{x:.065,y:0}});
  assert.ok(wet>dry*10);
  const before=pan.oil;
  assert.equal(O.take(pan,{D:.02,pos:{x:.065,y:0}},.001),0,'a dry bun cannot soak up a distant pool');
  O.sweep(pan,{x:-.09,y:0},{x:0,y:0},.018);
  assert.ok(Math.abs(pan.film.mass.reduce((a,b)=>a+b,0)-before)<1e-12,'a spatula trail displaces, never deletes oil');
});
test('dry hot oil has no boiling bubbles; water causes them, avocado keeps its smoke point',()=>{
  const s=state();P.addFat(s,'avocado',10);s.pan.Tr.fill(260);s.pan.T=s.pan.Tcenter=260;
  P.step(s,.05);assert.equal(s.pan.smokeOil,0);assert.equal(s.diag.oilBubble,0);
  s.pan.water=.001;P.step(s,.05);assert.ok(s.diag.oilBubble>0);
  s.pan.Tr.fill(285);s.pan.T=s.pan.Tcenter=285;P.step(s,.05);assert.ok(s.pan.smokeOil>0);
});
test('oven gives up exactly its boundary heat load and a loaded oven heats more slowly',()=>{
  const empty=state(),loaded=state();const p=patty(loaded,6);p.where='oven';
  for(const s of [empty,loaded]) s.oven={T:180,target:180};
  P.step(empty,.05);P.step(loaded,.05);
  assert.ok(loaded.oven.loadW>0);
  assert.ok(Math.abs((empty.oven.T-loaded.oven.T)*1800-loaded.oven.loadW*.05)<1e-8);
  for(let i=0;i<400;i++){P.step(empty,.05);P.step(loaded,.05);}
  assert.ok(loaded.oven.T<empty.oven.T);assert.ok(P.centerT(p)>6);
});
test('stack contact conserves energy and cold toppings warm while cooling the patty',()=>{
  const s=state(),p=patty(s);p.where='rest';A.add(s,p,'patty');A.add(s,p,'tomato');
  const a=A.surface(p,p.assembly[0],true),b=A.surface(p,p.assembly[1],false),before=a.T*a.C+b.T*b.C;
  A.exchange(a,b,.45,1);
  const aa=A.surface(p,p.assembly[0],true),bb=A.surface(p,p.assembly[1],false);
  assert.ok(Math.abs(aa.T*aa.C+bb.T*bb.C-before)<1e-8);assert.ok(aa.T<a.T && bb.T>b.T);
  for(let i=0;i<400;i++)P.step(s,.05);
  assert.ok(p.assembly[1].T>6);assert.ok(p.T.every(Number.isFinite));
});
test('warm buns insulate the patty and their interiors take heat from their contact faces',()=>{
  const bare=state(),built=state(),p=patty(bare),q=patty(built);p.where=q.where='rest';
  const buns=P.addItem(built,'bun',{tempC:70});for(const b of buns)P.removeItem(built,b);
  A.add(built,q,buns[0].id);A.add(built,q,'patty');A.add(built,q,buns[1].id);
  for(let i=0;i<1200;i++){P.step(bare,.05);P.step(built,.05);}
  const mean=p=>p.T.reduce((a,b)=>a+b,0)/p.T.length;
  assert.ok(mean(q)>mean(p),'covered faces lose less heat than bare meat');
  assert.ok(buns.every(b=>[b.face.T,b.up.T,b.body.T].every(t=>Number.isFinite(t)&&t<70&&t>20)));
});
test('bun cover insulates, undo restores exposed cooling, and film/stack saves resume identically',()=>{
  const s=state(),p=patty(s);p.where='rest';A.add(s,p,'patty');A.add(s,p,'mayo');
  const bc={bottom:{h:15},top:{h:14,T:22,RH:.5}};A.cover(p,bc);assert.equal(bc.top.h,0);
  A.pop(p);const open={bottom:{h:15},top:{h:14,T:22,RH:.5}};A.cover(p,open);assert.equal(open.top.h,14);
  A.add(s,p,'lettuce');P.addFat(s,'canola',10);P.step(s,.05);
  const copy=S.decode(S.encode(s));copy.stove.profile=P.STOVES[copy.stove.id].profile;
  for(let i=0;i<20;i++){P.step(s,.05);P.step(copy,.05);}
  assert.deepEqual(copy.pan.film.mass,s.pan.film.mass);assert.deepEqual(copy.patties[0].T,p.T);assert.equal(copy.patties[0].assembly[1].T,p.assembly[1].T);
});
