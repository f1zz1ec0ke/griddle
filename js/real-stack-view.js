/* The same food meshes, settled into a build. Layer coordinates stay local to its carrier. */
(function(root){
  'use strict';
  const T=root.THREE,P=root.BurgerPhysics,A=root.BurgerAssembly;
  function render(r,dt){
    const w=r.world;
    for(const base of w.entities.filter(e=>!e.discarded&&!e.stackRoot&&w.layers(e).length)){
      const layers=w.layers(base),parts=layers.map((l,i)=>l.patty?w.entities.find(e=>e.food===(l.meat||base.food)):l.item?w.entities.find(e=>e.food===l.item):w.entities.find(e=>e.stackRoot===base.id&&e.layer===i));
      const heights=layers.map((l,i)=>l.patty?(l.meat||base.food).h+(l.meat||base.food).cheeses.length*.0015:l.item?r.meshes.get(parts[i]?.id)?.view?.layerH()||.01:l.cheese?r.meshes.get(parts[i]?.id)?.height||.0014:l.height||A.cold[l.cold].height||.004);
      const layout=A.stackLayout(w.stackState(base),P,heights),starts=[],yaw=base.yaw||0,c=Math.cos(yaw),s=Math.sin(yaw);let y=0;
      for(let i=0;i<parts.length;i++){
        const part=parts[i],rec=r.meshes.get(part?.id),q=layout[i];starts[i]=y;
        const desiredY=q.base!=null?starts[q.base]:y;
        if(rec){
          const fresh=rec.stackOwner!==base.id||!dt;rec.stackOwner=base.id;
          // New ingredients land immediately; the existing soft layers settle under their weight.
          const blend=r.presentation.preferences.motion?1-Math.exp(-dt*14):1;
          rec.stackY=fresh?desiredY:P.lerp(rec.stackY,desiredY,blend);rec.stackScale=fresh?q.scale:P.lerp(rec.stackScale,q.scale,blend);
          const x=q.x||0,z=q.z||0,scale=rec.stackScale;
          rec.mesh.rotation.y=base.held?0:yaw;
          let lift=(rec.lift||0)*scale;if(part.kind==='bun'){rec.mesh.rotation.x=part.food.half==='top'?0:Math.PI;lift=part.food.half==='top'?0:heights[i]*scale;}
          rec.stackLift=lift;
          const at=new T.Vector3(x,rec.stackY+lift,z);
          if(base.trayCarrier){const plate=r.meshes.get(base.trayCarrier)?.mesh;if(plate){plate.add(rec.mesh);at.y+=.008;rec.mesh.position.copy(at);}}
          else if(base.held){r.heldAnchor.add(rec.mesh);const tool=r.heldEntity(),onTool=tool?.payload===base.id,grip=r.grip(onTool?tool:base);rec.mesh.position.copy(onTool?r.gripPoint(grip,grip.tip).add(at):r.gripPoint(grip,at.toArray()));}
          else{r.scene.add(rec.mesh);rec.mesh.position.set(base.pos[0]+x*c+z*s,base.pos[1]+at.y,base.pos[2]-x*s+z*c);}
          rec.mesh.scale.y=scale*(part.sliceMm&&['tomatoSlice','pickleSlice'].includes(part.kind)?part.sliceMm/({tomatoSlice:6,pickleSlice:4}[part.kind]):1);
          if(part.kind==='egg')rec.mesh.scale.x=rec.mesh.scale.z=1+(1-scale)*.12;
          if(base.cut&&part!==base){if(!rec.clip){rec.clip=new T.Plane();rec.mesh.traverse(o=>{if(o.material){o.material.clippingPlanes=[rec.clip];o.material.needsUpdate=true;}});}const meat=r.meshes.get(base.id).mesh;rec.clip.setFromNormalAndCoplanarPoint(new T.Vector3(0,0,1).applyQuaternion(meat.getWorldQuaternion(new T.Quaternion())),meat.getWorldPosition(new T.Vector3()));}
        }
        y+=q.advance??heights[i]*q.scale;
      }
      if(base.trayCarrier){const plate=r.meshes.get(base.trayCarrier)?.mesh;if(plate){plate.updateWorldMatrix(true,false);base.pos=plate.localToWorld(new T.Vector3(0,.008,0)).toArray();}}
    }
  }
  root.RealStackView={render};
})(window);
