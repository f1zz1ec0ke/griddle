/* Contextual physical actions; the model owns their results and the shared assets own their look. */
(function(root){
  'use strict';
  const T=root.THREE,P=root.BurgerPhysics;
  class Techniques{
    constructor(r){this.r=r;this.control=null;this.spills=new Map();this.butter=new Map();this.motion=new Map();}
    reset(){this.control=null;this.motion.clear();for(const map of [this.spills,this.butter]){for(const m of map.values())this.r.dispose(m);map.clear();}if(this.stream)this.stream.visible=false;this.alarm=null;}
    use(){
      const r=this.r,w=r.world,h=r.heldEntity(),held=h?.payload?w.get(h.payload):h,t=r.hover,e=r.foodAt(t),st=r.interaction.cookingTarget(t);
      if(r.action)return true;
      if(e?.kind==='timer'&&!held){
        if(t.object?.userData.timerDial){this.control={kind:'timer',seconds:w.timer.duration,drag:0};return true;}
        r.animate('press',()=>w.toggleTimer(),.28);return true;
      }
      if(held?.kind==='ashpan'&&t?.data.type==='bin'){w.doors.bin=true;r.animate('pour',()=>{held.ash=0;r.toast('Ash emptied. Return the catcher under the grill.');});return true;}
      if(held?.kind==='pan'&&held.parked&&!held.parked.lid&&t&&['surface','board','sink','entity','station'].includes(t.data.type)){
        if(t.data.type==='sink'&&held.pan.water+held.pan.oil<.0001)return false;
        this.control={kind:'tilt',id:held.id,target:t,angle:0};return true;
      }
      if(h?.payload)return false;
      if(h?.kind==='butter'&&st?.panId){if(st.state.lid){r.toast('Lift the lid first.');return true;}const point=r.interaction.panPoint(t,st.id);r.animate('pour',()=>r.toast(w.pourInto(st.id,'butter',15,point)?'Butter added.':'Open the pan first.'),.65);return true;}
      if(h?.kind==='spoon'&&e?.kind==='patty'&&e.food.where==='pan'){
        const error=w.basteProblem(e);if(error){r.toast(error);return true;}
        r.animate('baste',()=>{w.baste(e);r.toast('Basting.');},1.0);return true;
      }
      if(h?.kind==='rake'&&st?.state.grill){
        if(st.state.lid){r.toast('Open the grill first.');return true;}
        const control={kind:'rake',id:st.id,bank:st.state.grill.bank,ready:false};
        r.animate('stir',()=>{P.stirCoals(st.state);control.ready=true;},.65);this.control=control;return true;
      }
      if(h?.kind==='brush'&&st?.state.grill){if(st.state.lid){r.toast('Open the grill first.');return true;}r.animate('wipe',()=>r.toast(P.washPan(st.state)?'Grate brushed clean.':'Move the food off the grate first.'),.9);return true;}
      if(h?.kind==='cloth'&&t&&['surface','board','sink'].includes(t.data.type)){r.animate('wipe',()=>r.toast(w.wipeSpill(t.point)?'Spill wiped up.':'Counter wiped.'),.65);return true;}
      return false;
    }
    drag(event){
      const r=this.r,c=this.control;if(!r.left||!c)return false;
      if(c.kind==='timer'){c.drag+=event.movementX;r.world.setTimer(c.seconds+c.drag*3);}
      if(c.kind==='rake')c.bank=P.clamp(c.bank+event.movementX*.004,0,1);
      if(c.kind==='tilt')c.angle=P.clamp(c.angle+event.movementY*.008,0,.95);
      return true;
    }
    continuous(dt){
      const r=this.r,w=r.world,c=this.control;
      if(!r.left&&c){this.control=null;return false;}
      if(!c)return false;
      if(c.kind==='tilt'){
        const pan=w.get(c.id);if(!pan){this.control=null;return false;}pan.tilt=c.angle;
        const target=r.interaction.cookingTarget(c.target),destination=c.target.data.type==='sink'?'sink':target?.id;
        const result=w.drain(pan,dt,destination,c.target.point);
        r.activity={kind:'drain',point:c.target.point,water:result.water,oil:result.oil,panId:pan.id};
      }else if(c.kind==='rake'&&c.ready){P.setBank(w.station(c.id).state,c.bank);r.activity={kind:'rake',point:r.hover?.point};}
      return true;
    }
    hint(t){
      const r=this.r,w=r.world,h=r.heldEntity(),held=h?.payload?w.get(h.payload):h,e=r.foodAt(t),st=r.interaction.cookingTarget(t),c=this.control;
      if(c?.kind==='tilt')return 'Drag down to tilt · Release to level the pan';
      if(e?.kind==='timer'&&!held)return this.timerText()+' · Drag the dial to set · Click the button to start / pause';
      if(e?.kind==='ashpan'&&!held)return 'Right click: remove cold ash catcher · Empty it into the bin';
      if(held?.kind==='ashpan')return t?.data.type==='bin'?'Left click: empty ash':'Right click: return the ash catcher';
      if(held?.kind==='pan'&&held.parked)return t?.data.type==='sink'&&held.pan.water+held.pan.oil<.0001?'Left click: wash · Tap must be on':'Hold left click + drag down: pour · Right click: place';
      if(h?.kind==='butter'&&st?.panId)return 'Left click: add a knob of butter';
      if(h?.kind==='spoon'&&e?.kind==='patty'&&e.food.where==='pan')return 'Left click: baste with pan fat';
      if(h?.kind==='rake'&&st?.state.grill)return 'Hold left click + drag: bank / spread coals';
      if(h?.kind==='brush'&&st?.state.grill)return 'Left click: brush the empty grate';
      if(h&&['oil','water'].includes(h.kind)&&st?.panId)return 'Hold left click: pour '+h.kind;
      if(w.topPart(e)?.cheeseCarrier)return 'E: lift the top cheese slice · Use a spatula while hot';
      return '';
    }
    timerText(){const t=this.r.world.timer,n=Math.ceil(t.remaining);return Math.floor(n/60)+':'+String(n%60).padStart(2,'0')+(t.rang?' · Done':t.running?'':' · Paused');}
    render(dt){
      const r=this.r,w=r.world,timer=w.timer;
      if(timer.rang&&this.alarm!==timer.finishedAt){this.alarm=timer.finishedAt;r.toast('Timer finished.');r.audio.effect('timer',new T.Vector3(...w.entities.find(e=>e.kind==='timer').pos));}
      const display=document.getElementById('real-timer'),label=document.getElementById('real-timer-value');if(display){display.hidden=!timer.running&&!timer.rang;const text=this.timerText();if(label.textContent!==text)label.textContent=text;display.dataset.done=timer.rang?'true':'false';}
      for(const e of w.entities)if(e.kind==='timer'){const m=r.meshes.get(e.id)?.mesh;m?.traverse(o=>{if(o.userData.timerNeedle){const a=-timer.remaining/3600*Math.PI*2;o.rotation.y=a;o.position.x=-Math.sin(a)*.007;o.position.z=-Math.cos(a)*.007;}});}
      for(const e of w.entities)if(e.kind==='pan'){
        const m=e.station?r.stations.get(e.station)?.panMesh:r.meshes.get(e.id)?.mesh;if(!m)continue;m.updateWorldMatrix(true,false);
        const p=m.getWorldPosition(new T.Vector3()),rotation=m.getWorldQuaternion(new T.Quaternion()),a=this.motion.get(e.id)||{p:p.clone(),vx:0,vz:0,sx:0,sz:0};
        const step=Math.max(.001,dt||.016),vx=(p.x-a.p.x)/step,vz=(p.z-a.p.z)/step;
        const acceleration=new T.Vector3(P.clamp((vx-a.vx)/step,-8,8),0,P.clamp((vz-a.vz)/step,-8,8)).applyQuaternion(rotation.clone().invert());
        const xAxis=new T.Vector3(1,0,0).applyQuaternion(rotation),zAxis=new T.Vector3(0,0,1).applyQuaternion(rotation);
        a.sx+=(xAxis.y+acceleration.x*.018-a.sx)*Math.min(1,step*8);a.sz+=(zAxis.y+acceleration.z*.018-a.sz)*Math.min(1,step*8);
        e.pan.slopeX=a.sx;e.pan.slopeZ=a.sz;a.p.copy(p);a.vx=vx;a.vz=vz;this.motion.set(e.id,a);
        if(this.control?.id!==e.id)e.tilt=(e.tilt||0)*Math.exp(-step*14);
      }
      const alive=new Set();for(const spill of w.spills){alive.add(spill.id);let m=this.spills.get(spill.id);
        if(!m){m=new T.Mesh(root.BurgerRender.Viewport.prototype.puddleGeometry(64,spill.id*.37),new T.MeshPhysicalMaterial({color:0xaa9250,transparent:true,opacity:.52,roughness:.10,clearcoat:1,depthWrite:false}));m.rotation.x=-Math.PI/2;m.receiveShadow=true;r.scene.add(m);this.spills.set(spill.id,m);}
        const mass=spill.water+spill.oil,radius=Math.min(.38,Math.sqrt(mass/.5));m.scale.set(radius,radius*.78,1);m.position.set(spill.pos[0],spill.pos[1]+.001,spill.pos[2]);m.material.color.setHex(spill.oil>spill.water?0xbda365:0x9fbfc0);m.material.opacity=.25+Math.min(.35,mass*10);
      }for(const [id,m] of this.spills)if(!alive.has(id)){r.dispose(m);this.spills.delete(id);}
      this.renderButter(dt);this.renderAsh();this.renderDrain();
    }
    renderButter(dt){
      const r=this.r,alive=new Set(),tool=r.world.entities.find(e=>e.kind==='butter');let source;r.meshes.get(tool?.id)?.mesh.traverse(o=>{if(o.userData.butterBlock)source=o;});if(!source)return;
      for(const pan of r.world.entities.filter(e=>e.kind==='pan')){
        const vp=r.stations.get(pan.station),parent=vp?.panGroup||r.meshes.get(pan.id)?.mesh,floor=vp?.panFloorY??.004;if(!parent)continue;
        for(const b of pan.pan.butter||[]){alive.add(b.id);let m=this.butter.get(b.id);
          if(!m){m=new T.Mesh(source.geometry.clone(),source.material.clone());m.castShadow=m.receiveShadow=true;m.userData.elapsed=0;this.butter.set(b.id,m);
            if(r.action?.kind==='pour'&&r.heldEntity()?.kind==='butter'){const grip=r.grip(tool);r.heldAnchor.updateWorldMatrix(true,false);m.userData.start=r.heldAnchor.localToWorld(r.gripPoint(grip,grip.spout));}
          }
          if(m.parent!==parent)parent.add(m);const scale=Math.cbrt(b.mass/920/(.067*.023*.034)),soft=1+.18*P.clamp((b.T-21)/9,0,1);m.scale.set(scale*soft,scale/(soft*soft),scale*soft);m.position.set(b.x,floor+.023*m.scale.y/2,b.z);
          m.userData.elapsed+=dt||0;if(m.userData.start){const u=P.clamp(m.userData.elapsed/.23,0,1);if(u<1){parent.updateWorldMatrix(true,false);const start=parent.worldToLocal(m.userData.start.clone());m.position.lerp(start,1-u);m.position.y+=Math.sin(u*Math.PI)*.015;}else delete m.userData.start;}
        }
      }
      for(const [id,m] of this.butter)if(!alive.has(id)){r.dispose(m);this.butter.delete(id);}
    }
    renderAsh(){
      const r=this.r,w=r.world,e=w.entities.find(e=>e.kind==='ashpan'),rec=r.meshes.get(e?.id);if(!rec)return;
      if(!rec.ash){const original=r.stations.get('charcoal').ashDisc;rec.ash=new T.Mesh(original.geometry.clone(),original.material.clone());rec.ash.material.color.setHex(0x9c9687);rec.ash.rotation.x=-Math.PI/2;rec.ash.scale.setScalar(.40);rec.mesh.add(rec.ash);r.target(rec.ash,{type:'entity',entity:e.id,name:'ash catcher'});}
      const home=!e.held&&e.pos.every((v,i)=>Math.abs(v-e.home[i])<.01),g=w.station('charcoal').state.grill,mass=home?g.ash+g.ashBowl:e.ash||0;rec.ash.visible=mass>1e-5;rec.ash.position.y=Math.min(.043,.010+mass/(250*Math.PI*.08**2));
    }
    renderDrain(){
      const r=this.r,a=r.activity;
      if(!this.stream){this.stream=new T.Mesh(new T.CylinderGeometry(1,1,1,10),new T.MeshPhysicalMaterial({color:0xc9b87a,transparent:true,opacity:.65,roughness:.1,clearcoat:1,depthWrite:false}));r.scene.add(this.stream);}
      this.stream.visible=false;
      if(r.action?.kind==='baste'&&r.action.done&&!r.action.cancelled&&r.action.time/r.action.duration<.91){
        const h=r.heldEntity(),food=r.foodAt(r.action.target);if(!h||!food)return;const grip=r.grip(h);r.heldAnchor.updateWorldMatrix(true,false);
        const from=r.heldAnchor.localToWorld(r.gripPoint(grip,grip.tip)),to=new T.Vector3(food.pos[0],food.pos[1]+food.food.h,food.pos[2]),delta=to.clone().sub(from);if(from.y<to.y+.005)return;
        this.stream.visible=true;this.stream.position.copy(from).add(to).multiplyScalar(.5);this.stream.scale.set(.0012,delta.length(),.0012);this.stream.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());this.stream.material.color.setHex(0xc6a658);return;
      }
      if(a?.kind!=='drain'||!(a.water+a.oil>1e-7))return;
      const pan=r.world.get(a.panId),m=r.meshes.get(pan?.id)?.mesh;if(!m)return;m.updateWorldMatrix(true,false);
      const sx=pan.pan.slopeX||0,sz=pan.pan.slopeZ||0,len=Math.hypot(sx,sz)||1,radius=pan.pan.floorR;
      const from=m.localToWorld(new T.Vector3(-sx/len*radius,.036,-sz/len*radius)),to=a.point.clone(),delta=to.clone().sub(from);
      this.stream.visible=true;this.stream.position.copy(from).add(to).multiplyScalar(.5);this.stream.scale.set(.0022,delta.length(),.0022);this.stream.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());this.stream.material.color.setHex(a.oil>a.water?0xc6a658:0xb6d9df);
    }
  }
  root.RealTechniques=Techniques;
})(window);
