/* Real mode interaction detail. Existing meshes and solvers remain the source of truth. */
(function(root){
  'use strict';
  const T=root.THREE,P=root.BurgerPhysics;
  class RealInteraction {
    constructor(real){this.r=real;this.yaw=0;this.probe=null;this.ghost=null;this.ghostId=null;this.reportUntil=0;}
    reset(){this.probe=null;this.yaw=0;this.reportUntil=0;this.clearGhost();this.clearShells();}
    clearGhost(){if(this.ghost){this.ghost.parent?.remove(this.ghost);this.ghost.traverse(o=>o.material?.dispose());this.ghost=null;}this.ghostId=null;}
    wheel(event){
      const r=this.r,w=r.world,h=r.heldEntity(),step=Math.sign(event.deltaY);
      if(this.probe){this.probe.depth=P.clamp(this.probe.depth+step*.001,0,this.probe.height);this.probe.manual=true;}
      else if(w.portion.mass>0)w.settings.thicknessMm=P.clamp(w.settings.thicknessMm-step,8,35);
      else if(h?.kind==='knife')w.settings.sliceMm=P.clamp(w.settings.sliceMm-step,2,12);
      else if(h)this.yaw+=step*Math.PI/12;
    }
    drag(event){
      if(!this.probe||!this.r.left)return false;
      this.probe.depth=P.clamp(this.probe.depth+event.movementY*.0003,0,this.probe.height);this.probe.manual=true;return true;
    }
    peel(){
      const r=this.r,w=r.world,h=r.heldEntity(),e=r.foodAt(r.hover),stack=e?.food?.assembly;
      if(r.action||!stack?.length)return;
      const top=w.topPart(e),compatible=h&&!h.payload&&({spatula:['patty','bun','egg'],tongs:['bacon'],spoon:['onions']}[h.kind]||[]).includes(top?.kind);
      if(h&&!compatible){r.toast('Free your hands or use the matching utensil.');return;}
      if(!h&&top&&r.hot(top)){r.toast('Hot! Use the matching utensil to lift this layer.');return;}
      if(stack.at(-1).cold&&root.BurgerAssembly.cold[stack.at(-1).cold].sauce){r.toast('Use the cloth to wipe away the top sauce.');return;}
      if(e.trayCarrier){r.toast('Move the burger off the plate before rebuilding it.');return;}
      r.animate('grab',()=>{const part=w.peel(e);if(part){if(h)r.carry(h,part);else r.pick(part);r.toast('Layer lifted. Place it, replace it, or discard it.');}},.4);
    }
    use(){
      const r=this.r,w=r.world,h=r.heldEntity(),t=r.hover,e=r.foodAt(t),d=t?.data;
      if(r.action)return true;
      const plate=h?.kind==='plate'?h:d?.entity?w.get(d.entity):null;
      if(plate?.kind==='plate'&&plate.cargo?.length){
        const burger=w.get(plate.cargo[0]);if(burger?.kind!=='patty'){r.toast('Put a patty or built burger on the tasting plate.');return true;}
        r.animate('taste',()=>{w.taste(burger);this.reportUntil=performance.now()+14000;},.9);return true;
      }
      if(!t)return false;
      if(h?.kind==='cloth'&&e?.food?.assembly?.at(-1)?.cold){
        const top=e.food.assembly.at(-1);if(root.BurgerAssembly.cold[top.cold].sauce){r.animate('wipe',()=>{const part=w.peel(e);if(part){part.discarded=true;r.toast('Sauce wiped away.');}});return true;}
      }
      if(h?.kind==='knife'&&e&&!e.food&&['tomato','pickles','onion','cheeseBlock','bunWhole'].includes(e.kind)){
        if(e.held||e.station||e.trayCarrier){r.toast('Put it on the board first.');return true;}
        r.animate('slice',()=>{const out=w.cut(e,w.settings.sliceMm);r.toast(!out.length?'Make space beside the ingredient first.':e.discarded?'Finished slicing.':'Slice cut.');},.65);return true;
      }
      if(!h&&w.portion.mass>=25&&['board','surface'].includes(d.type)){
        const point=t.point.clone();r.animate('form',()=>{if(r.left)w.form([point.x,point.y+.002,point.z]);},1.2);return true;
      }
      if(['meat','meatLean','meatRich'].includes(h?.kind)&&d.type==='bowl'){
        r.animate('pour',()=>{w.addMince(h);r.held=null;});return true;
      }
      if(h?.kind==='probe'&&(e?.kind==='pan'||t.data.type==='station')){r.toast('Aim at food to probe it.');return true;}
      if(h?.kind==='probe'&&e?.food){
        if(r.blocked(e)){r.toast(r.blocked(e));return true;}
        const height=e.kind==='patty'?e.food.h:.013;
        const point=t.point.clone();point.y=e.pos[1]+height;
        this.probe={id:e.id,height,depth:0,radius:P.clamp(Math.hypot(t.point.x-e.pos[0],t.point.z-e.pos[2]),0,(e.food.D||.1)/2),point,manual:false};return true;
      }
      if(h?.kind==='egg'&&!h.food&&d.type==='station'){
        const st=w.station(d.id);if(st.state.lid||(!st.panId&&d.id!=='charcoal')){r.toast('Open a cooking surface first.');return true;}
        this.makeShells(h);
        r.animate('crack',()=>{w.makeFood(h,'egg');const error=w.placeFood(h,d.id,this.panPoint(t,d.id));if(error)r.toast(error);else r.held=null;},1.0);return true;
      }
      return false;
    }
    continuous(dt){
      const r=this.r,e=r.world.get(this.probe?.id);
      if(this.probe){if(!r.left||r.heldEntity()?.kind!=='probe'||!e){this.probe=null;return false;}
        if(!this.probe.manual)this.probe.depth=Math.min(this.probe.height,this.probe.depth+dt*.004);
        return true;}
      return false;
    }
    probePose(profile){
      const r=this.r,p=this.probe;if(!p)return null;
      const tip=p.point.clone();tip.y-=p.depth;
      const rotation=r.camera.getWorldQuaternion(new T.Quaternion()).invert().multiply(new T.Quaternion().setFromEuler(new T.Euler(-Math.PI/2+.55,r.world.player.yaw,0,'YXZ')));
      return {rotation,position:r.camera.worldToLocal(tip).sub(r.gripPoint(profile,profile.tip).applyQuaternion(rotation))};
    }
    panPoint(t,id){const st=this.r.world.station(id);return {x:t.point.x-st.x,y:t.point.z-st.z};}
    counterPlacement(e,point){
      const r=this.r,desired=[point.x,point.y+.002,point.z],surface=r.surfaces.filter(s=>Math.abs(desired[0]-s.x)<=s.w/2&&Math.abs(desired[2]-s.z)<=s.d/2&&s.y<=desired[1]+.015).sort((a,b)=>b.y-a.y)[0]||{x:0,z:0,w:8,d:8};
      const obstacles=[];for(const other of r.world.entities){if(other===e||other.held||other.discarded||other.station||other.stackRoot||other.panCarrier||other.trayCarrier||Math.abs(other.pos[1]-desired[1])>.10)continue;const f=this.footprint(other);obstacles.push({minX:other.pos[0]+f.minX,maxX:other.pos[0]+f.maxX,minZ:other.pos[2]+f.minZ,maxZ:other.pos[2]+f.maxZ});}
      if(desired[1]>.90&&desired[1]<1.10)obstacles.push({minX:-.91,maxX:-.53,minZ:-1.07,maxZ:-.69});
      return root.RealKitchen.clearPlacement(desired,this.footprint(e,this.yaw),surface,obstacles);
    }
    shapeSize(){
      const w=this.r.world,q=w.portion,key=[q.mass,q.fatFrac,q.work,w.settings.thicknessMm].join('/');
      if(this.shapeKey!==key){const p=P.makePatty({massG:Math.max(25,q.mass),fatFrac:q.fatFrac??.2,work:q.work,thicknessMm:w.settings.thicknessMm});this.shape={D:p.D,h:p.h};this.shapeKey=key;}return this.shape;
    }
    footprint(e,yaw=e.yaw||0){
      const radius=e.food&&e.kind!=='pan'?(e.food.Dcov||e.food.D)/2:null;
      const f=radius?{minX:-radius,maxX:radius,minZ:-radius,maxZ:radius}:this.r.meshes.get(e.id)?.footprint||{minX:-.05,maxX:.05,minZ:-.05,maxZ:.05},c=Math.cos(yaw),s=Math.sin(yaw);
      const corners=[f.minX,f.maxX].flatMap(x=>[f.minZ,f.maxZ].map(z=>[x*c+z*s,-x*s+z*c]));
      return {minX:Math.min(...corners.map(p=>p[0])),maxX:Math.max(...corners.map(p=>p[0])),minZ:Math.min(...corners.map(p=>p[1])),maxZ:Math.max(...corners.map(p=>p[1]))};
    }
    makeShells(egg){
      this.clearShells();const mesh=this.r.meshes.get(egg.id)?.mesh;if(!mesh)return;
      const centre=mesh.getWorldPosition(new T.Vector3());this.shells=[];
      for(const side of [-1,1]){const shell=this.r.copyModel(mesh);this.r.scene.add(shell);shell.position.copy(centre);shell.quaternion.copy(mesh.getWorldQuaternion(new T.Quaternion()));const plane=new T.Plane();shell.traverse(o=>{if(o.material){o.material.clippingPlanes=[plane];o.material.side=T.DoubleSide;}});this.shells.push({shell,plane,side,centre:centre.clone(),rotation:shell.quaternion.clone()});}
    }
    clearShells(){for(const part of this.shells||[])this.r.dispose(part.shell);this.shells=null;}
    render(){
      const r=this.r,h=r.heldEntity(),e=h?.payload?r.world.get(h.payload):h,t=r.hover;
      if(this.shells){if(r.action?.kind!=='crack')this.clearShells();else{if(h&&!h.food)r.meshes.get(h.id).mesh.visible=false;const u=r.action.time/r.action.duration;for(const p of this.shells){if(h&&!h.food){const original=r.meshes.get(h.id)?.mesh;if(original)p.centre.copy(original.getWorldPosition(new T.Vector3()));}p.shell.position.copy(p.centre);p.shell.quaternion.copy(p.rotation);p.shell.position.x+=p.side*Math.sin(u*Math.PI)*.045;p.shell.rotation.z=p.side*u*.7;p.plane.setFromNormalAndCoplanarPoint(new T.Vector3(p.side,0,0),p.shell.position);}}}
      const report=document.getElementById('real-tasting');if(report){report.hidden=performance.now()>this.reportUntil||!r.world.lastTasting;report.textContent=r.world.lastTasting?'Your cook\n'+r.world.lastTasting.notes.join('\n'):'';}
      if(this.probe){
        if(!r.left){this.probe=null;}else{
          const p=this.probe,food=r.world.get(p.id),grip=r.grip(h);r.camera.updateMatrixWorld(true);
          const tip=r.meshes.get(h.id).mesh.localToWorld(new T.Vector3(...grip.tip)),wanted=p.point.clone();wanted.y-=p.depth;
          p.valid=tip.distanceTo(wanted)<.004;
          p.temperature=p.valid?r.world.probe(food,Math.hypot(tip.x-food.pos[0],tip.z-food.pos[2]),P.clamp(food.pos[1]+p.height-tip.y,0,p.height)):null;
        }
      }
      const station=t?.data.type==='station'?t.data.id:t?.data.entity?r.world.get(t.data.entity)?.station:null;
      if(!e||!t||r.action||this.probe||(!['board','surface'].includes(t.data.type)&&!station)){if(this.ghost)this.ghost.visible=false;return;}
      const source=r.meshes.get(e.id)?.mesh;if(!source)return;
      if(this.ghostId!==e.id){this.clearGhost();this.ghost=source.clone(true);this.ghost.traverse(o=>{if(o.isMesh)o.material=new T.MeshBasicMaterial({color:0x6ec7a0,transparent:true,opacity:.24,depthWrite:false});});r.scene.add(this.ghost);this.ghostId=e.id;}
      const g=this.ghost;g.visible=true;g.scale.copy(source.scale);g.rotation.set(0,this.yaw,0);g.position.copy(t.point);g.position.y+=.003;let valid=true;
      if(station&&e.food&&e.kind!=='pan'){const st=r.world.station(station),to=r.world.placement(e,station,this.panPoint(t,station));valid=to.ok&&!st.state.lid&&(st.panId||station==='charcoal')&&!e.stackRoot&&!e.food.assembly?.length;if(valid){g.position.x=st.x+to.pos.x;g.position.z=st.z+to.pos.y;g.position.y=this.r.stations.get(station).scene.position.y+this.r.stations.get(station).panFloorY;}}
      else if(station)valid=e.kind==='pan'&&!r.world.station(station).panId;
      else {const point=this.counterPlacement(e,t.point);valid=!!point;if(point)g.position.set(...point);}
      g.traverse(o=>{if(o.material)o.material.color.setHex(valid?0x6ec7a0:0xe78069);});
    }
    hint(){
      const r=this.r,w=r.world,h=r.heldEntity(),e=r.foodAt(r.hover);
      if(this.probe)return this.probe.valid?`${this.probe.temperature?.toFixed(1)||'…'} °C · ${(this.probe.depth*1000).toFixed(1)} mm deep\nMove mouse up/down or scroll to probe · Release to withdraw`:'Move closer to insert the probe. Release to withdraw.';
      if(w.portion.mass>0)return `Scroll: patty thickness ${w.settings.thicknessMm} mm · ${Math.round((w.portion.fatFrac??.2)*100)}% fat\nHold left click on the board to shape`;
      if(h?.kind==='knife'&&e&&!e.food)return `Scroll: ${w.settings.sliceMm} mm slices · Left click: one cut`;
      if(h?.kind==='salt'&&e?.kind==='patty')return `${(e.salt||0).toFixed(1)} g salt · ${((e.salt||0)/(e.food.massKg0*10)).toFixed(1)}% of meat\nHold left click: season`;
      if(h?.kind==='cloth'&&e?.food?.assembly?.at(-1)?.cold&&root.BurgerAssembly.cold[e.food.assembly.at(-1).cold].sauce)return 'Left click: wipe off the top sauce';
      if(e?.food?.assembly?.length&&(!h||['spatula','tongs','spoon'].includes(h.kind)))return 'E: lift the top layer · Right click: lift the burger';
      if(h?.kind==='plate'||r.hover?.data.entity&&w.get(r.hover.data.entity)?.kind==='plate')return 'Place a burger on the plate · Left click: taste';
      if(h)return 'Scroll: rotate placement';return '';
    }
  }
  root.RealInteraction=RealInteraction;
})(window);
