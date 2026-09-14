/* Reach from a planted stance, make contact, then change ownership. Rendering interpolates the handoff. */
(function(root){
  'use strict';
  const T=root.THREE,P=root.BurgerPhysics,contactActions=new Set(['flip','smash','slice','grab','place','stir','wipe','wash','baste','form']);
  class Contact{
    constructor(r){
      this.r=r;this.pending=new Map();this.base=new T.Vector3();this.hasBase=false;this.amount=0;
      this.torso=new T.Group();this.torso.position.y=.8;
      for(const m of r.body.children.slice())if(!r.legs.includes(m)){r.body.remove(m);this.torso.add(m);m.position.y-=.8;}r.body.add(this.torso);
    }
    reset(){this.pending.clear();this.amount=0;this.hasBase=false;this.point=null;}
    ease(lo,hi,x){const t=P.clamp((x-lo)/(hi-lo),0,1);return t*t*(3-2*t);}
    prepare(action){
      const r=this.r,t=action.target,e=r.foodAt(t);if(!t)return;
      if(['flip','stir'].includes(action.kind)&&e?.food&&e.kind!=='pan')t.point.set(e.pos[0],e.pos[1]+.004,e.pos[2]);
      if(action.kind==='smash'&&e?.food)t.point.set(e.pos[0],e.pos[1]+e.food.h,e.pos[2]);
      if(action.kind==='place'){const h=r.heldEntity(),held=h?.payload?r.world.get(h.payload):h,plan=r.interaction.placement(t,held);if(plan)t.point.set(...plan.pos);}
      action.contact=contactActions.has(action.kind);action.entityId=e?.id;
      // Fixture animations move the hand, not the camera. Remember held work through its release.
      const held=r.heldEntity();
      action.lean=action.contact||!!held&&(['pour','crack','discard'].includes(action.kind)||action.kind==='press'&&held.kind==='lighter'&&!['button','bin'].includes(t.data.type));
    }
    lean(dt,refresh=false){
      const r=this.r,a=r.action,control=r.interaction.techniques.control;
      const working=r.left&&(r.grabControl||control||r.interaction.probe||r.activity);
      const point=a?a.lean?a.target?.point:null:working?(control?.target.point||r.interaction.probe?.point||r.activity?.point||r.hover?.point):null;
      if(!refresh){const p=r.world.player;if(this.player&&Math.hypot(p.x-this.player.x,p.y-this.player.y,p.z-this.player.z)>.6){this.amount=0;this.point=null;}this.player={x:p.x,y:p.y,z:p.z};}
      if(!refresh){this.base.copy(r.camera.position);this.hasBase=true;}if(!this.hasBase)return;
      r.camera.position.copy(this.base);
      const u=a?a.time/a.duration:0,strength=point?(a?(u<.36?this.ease(0,.36,u):u<.72?1:1-this.ease(.72,1,u)):.65):0;
      this.amount+=(strength-this.amount)*Math.min(1,Math.max(dt,0)*20);
      if(point)this.point=point.clone();if(!this.point||this.amount<.001){this.torso.rotation.x=0;return;}
      const held=r.heldEntity(),item=held?.kind==='glove'&&held.payload?r.world.get(held.payload):held,profile=item?r.grip(item):null;
      const reach=profile?r.gripPoint(profile,profile.tip||[0,0,0]).length():0;
      const distance=this.point.distanceTo(this.base),shift=P.clamp(distance-(.54+Math.min(.18,reach*.7)),0,.95)*this.amount;
      // Move along the sight line: leaning must not move the reticle off its target.
      const direction=r.camera.getWorldDirection(new T.Vector3());r.camera.position.addScaledVector(direction,shift);
      const forward=Math.hypot(direction.x,direction.z)*shift;
      r.camera.position.x=P.clamp(r.camera.position.x,-3.88,3.88);r.camera.position.z=P.clamp(r.camera.position.z,-3.88,3.88);
      this.torso.rotation.x=-Math.min(.65,forward/.80);r.camera.updateWorldMatrix(true,false);
    }
    commit(){
      const r=this.r,a=r.action;if(!a)return;const u=a.time/a.duration;
      if(u>=.55&&!a.done){
        const tooFar=a.target&&r.camera.position.distanceTo(a.target.point)>Math.max(2.25,a.startDistance+.3);
        if(tooFar){a.done=true;a.cancelled=true;r.toast('Move a little closer to reach it.');return;}
        let ready=true;
        if(a.contact&&a.target){
          const h=r.heldEntity(),item=h?.kind==='glove'&&h.payload?r.world.get(h.payload):h,p=item?r.grip(item):null;
          r.heldAnchor.updateWorldMatrix(true,false);
          const tip=r.heldAnchor.localToWorld(p?r.gripPoint(p,p.tip||[0,0,0]):new T.Vector3());
          a.contactGap=tip.distanceTo(a.target.point);ready=a.contactGap<(a.kind==='grab'||a.kind==='form'?.13:.06);
          if(a.kind==='wash'||a.kind==='place'&&item?.kind==='pan')ready=a.contactGap<.18;
        }
        if(ready){a.done=true;if(a.entityId&&!r.world.get(a.entityId))r.toast('That item has moved.');else{a.fn();r.audio.effect(a.kind,a.target?.point);}}
        else if(u>=.78){a.done=true;a.cancelled=true;r.toast('Move a little closer to reach it.');}
      }
      if(u>=1&&r.action===a)r.action=null;
    }
    mesh(e){const r=this.r;if(e.station){const vp=r.stations.get(e.station);return e.kind==='pan'?vp?.panMesh:(e.kind==='patty'?vp?.views:vp?.itemViews)?.get(e.food)?.group;}return r.meshes.get(e.id)?.mesh;}
    pickupPoint(e,tool){
      const m=this.mesh(e);if(!m)return new T.Vector3(...e.pos);m.updateWorldMatrix(true,false);
      if(tool&&tool.kind!=='glove'){const box=new T.Box3().setFromObject(m),point=box.getCenter(new T.Vector3());point.y=box.min.y+.002;return point;}
      return m.localToWorld(new T.Vector3(...this.r.grip(e).grip));
    }
    transfer(e){
      const carrier=this.r.world.get(e.cheeseCarrier),m=this.mesh(carrier||e);if(!m)return;m.updateWorldMatrix(true,false);
      const position=carrier?m.localToWorld(new T.Vector3(0,carrier.food.h+Math.max(0,carrier.food.cheeses.indexOf(e.sliceState))*.0015,0)):m.getWorldPosition(new T.Vector3());
      const rotation=m.getWorldQuaternion(new T.Quaternion());if(carrier)rotation.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),e.sliceState.rot||0));
      this.pending.set(e.id,{position,rotation,time:0});
    }
    transfers(dt){
      const r=this.r;
      for(const [id,move] of this.pending){const e=r.world.get(id),m=e&&this.mesh(e);if(!m){this.pending.delete(id);continue;}move.time+=dt;const u=this.ease(0,.22,move.time);if(u>=1){this.pending.delete(id);continue;}
        m.updateWorldMatrix(true,false);const end=m.getWorldPosition(new T.Vector3()),rotation=m.getWorldQuaternion(new T.Quaternion());
        end.lerp(move.position,1-u);rotation.slerp(move.rotation,1-u);m.parent.updateWorldMatrix(true,false);m.position.copy(m.parent.worldToLocal(end));m.quaternion.copy(m.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(rotation));
      }
    }
  }
  root.RealContact=Contact;
})(window);
