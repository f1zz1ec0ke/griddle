'use strict';
module.exports={name:'real',experience:'real',description:'physical prep, controls, movement and separate saves',async run(k){
 const page=k.page;
 await page.locator('#real-resume').click();await page.waitForFunction(()=>!realMode.paused);
 const overlaps=await page.evaluate(()=>{const r=realMode;r.scene.updateMatrixWorld(true);const items=r.world.entities.filter(e=>!e.station&&!e.held&&r.meshes.has(e.id)),hits=[];for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)if(new THREE.Box3().setFromObject(r.meshes.get(items[i].id).mesh).intersectsBox(new THREE.Box3().setFromObject(r.meshes.get(items[j].id).mesh)))hits.push(items[i].kind+'/'+items[j].kind);return hits;});k.ok(!overlaps.length,'resting tools have no intersecting bounds: '+overlaps.join(', '));
 async function aim(point,from){await page.evaluate(({point,from})=>{const r=realMode,p=r.world.player;Object.assign(p,{x:from[0],z:from[1],y:0});const d=new THREE.Vector3(...point).sub(new THREE.Vector3(p.x,1.72,p.z));p.yaw=Math.atan2(-d.x,-d.z);p.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));r.move(0);for(let i=0;i<5;i++){const v=new THREE.Vector3(...point).sub(r.camera.position);p.yaw=Math.atan2(-v.x,-v.z);p.pitch=Math.atan2(v.y,Math.hypot(v.x,v.z));r.move(0);}r.hover=r.focus();},{point,from});await page.waitForTimeout(100);}
 async function click(button='left'){await page.mouse.down({button});await page.mouse.up({button});await page.waitForFunction(()=>!realMode.action);}
 await aim([-3.3,1.1,1.25],[-3.3,.3]);await click();k.ok(await page.evaluate(()=>realMode.world.doors.fridge),'fridge opens physically');
 await aim([-3.52,.485,1.45],[-3.3,.3]);await click('right');k.ok(await page.evaluate(()=>realMode.heldEntity()?.kind==='meat'),'one mince pack picked up');
 await aim([-.72,1.0,-.88],[-.72,-1.9]);await click();k.ok(await page.evaluate(()=>realMode.world.bowl.mass===500),'mince reaches the bowl');
 await page.mouse.down();await page.waitForFunction(()=>realMode.world.portion.mass>120);await page.mouse.up();const before=await page.evaluate(()=>realMode.world.portion.mass);await click('right');k.near(await page.evaluate(()=>realMode.world.portion.mass),before-25,.01,'return exactly 25 g');
 await aim([0,.98,-.88],[0,-1.9]);await page.mouse.down();await page.waitForFunction(()=>realMode.world.portion.mass===0);await page.mouse.up();await page.waitForFunction(()=>!realMode.action);await click('right');k.ok(await page.evaluate(()=>realMode.heldEntity()?.kind==='patty'),'formed patty can be carried');
 await aim([-1.5,1.0,.95],[-1.5,.1]);await click('right');k.ok(await page.evaluate(()=>realMode.world.entities.some(e=>e.kind==='patty'&&e.station==='gas')),'patty physically placed in gas pan');
 await aim([-1.5,.97,.732],[-1.5,.1]);await page.mouse.down();await page.mouse.move(800,430,{steps:5});await page.mouse.up();k.ok(await page.evaluate(()=>realMode.world.station('gas').state.stove.knob>0),'drag turns the physical gas dial');
 await aim([-1.62,.944,-1.21],[-1.62,-1.95]);await click('right');k.ok(await page.evaluate(()=>realMode.heldEntity()?.kind==='spatula'),'shared spatula can be picked up');
 const meatPoint=await page.evaluate(()=>{const e=realMode.world.entities.find(e=>e.kind==='patty');return [e.pos[0],e.pos[1]+e.food.h*.5,e.pos[2]];});await aim(meatPoint,[-1.5,.1]);await click('right');k.ok(await page.evaluate(()=>!!realMode.heldEntity()?.payload),'spatula lifts food');
 await aim([-2.6,.62,-1.74],[-2.6,-2.6]);await click();k.ok(await page.evaluate(()=>realMode.world.doors.oven),'shared oven door opens');
 await aim([-2.6,.55,-1.32],[-2.6,-2.6]);await click('right');await page.waitForFunction(()=>realMode.world.entities.some(e=>e.kind==='patty'&&e.station==='oven'&&Math.abs(e.pos[1]-.544)<.003));k.near(await page.evaluate(()=>realMode.world.entities.find(e=>e.kind==='patty').pos[1]),.544,.003,'food rests on the oven rack');await k.shot('oven-transfer');
 await page.evaluate(()=>{const r=realMode;Object.assign(r.world.player,{x:0,z:-2.7,y:0,yaw:Math.PI,pitch:0});r.move(0);});
 await page.keyboard.down('w');await page.waitForTimeout(700);await page.keyboard.up('w');k.ok(await page.evaluate(()=>realMode.world.player.z>-2.7),'W walks forward');
 await page.keyboard.press('Space');await page.waitForFunction(()=>realMode.world.player.y>0);k.ok(await page.evaluate(()=>realMode.world.player.y>0),'jump leaves the floor');
 await page.keyboard.down('Control');await page.waitForFunction(()=>realMode.eyeHeight<1.3);await page.keyboard.up('Control');
 await page.keyboard.press('Escape');await page.waitForFunction(()=>realMode.paused);const t=await page.evaluate(()=>realMode.world.time);await page.waitForTimeout(300);k.near(await page.evaluate(()=>realMode.world.time),t,0,'pause freezes all stations');
 k.ok(await page.evaluate(()=>!!localStorage.getItem('griddle.real.v1')),'Real has its own saved kitchen');
 await page.locator('#real-leave').click();await page.locator('#choose-legacy').click();await page.locator('#btn-practice').click();k.ok(await page.evaluate(()=>game.mode==='practice'&&document.body.dataset.experience==='legacy'),'Legacy practice remains separately playable');
}};
