/* A parked probe follows the food's actual transform and samples its live thermal grid. */
(function(root){
  'use strict';
  const T=root.THREE;
  function foodMesh(r,e){return e?.station?r.stations.get(e.station)?.views.get(e.food)?.group:r.meshes.get(e?.id)?.mesh;}
  function park(r,p){
    const food=r.world.get(p.id),tool=r.heldEntity(),meat=foodMesh(r,food),mesh=r.meshes.get(tool?.id)?.mesh;
    if(!p.valid||p.depth<.0006||food?.kind!=='patty'||!meat||!mesh)return false;
    meat.updateWorldMatrix(true,false);mesh.updateWorldMatrix(true,false);
    const tip=meat.worldToLocal(mesh.localToWorld(new T.Vector3(...r.grip(tool).tip))),rotation=meat.getWorldQuaternion(new T.Quaternion()).invert().multiply(mesh.getWorldQuaternion(new T.Quaternion()));
    const a={x:tip.x/(food.food.D/2),z:tip.z/(food.food.D/2),depth:1-tip.y/food.food.h,rotation:rotation.toArray()};
    if(!r.world.parkProbe(tool,food,a))return false;
    r.held=null;r.toast('Probe stays in. Right click it to remove.');return true;
  }
  function render(r){
    for(const tool of r.world.entities){
      const a=tool.probeAttachment;if(!a)continue;
      const food=r.world.get(a.foodId),meat=foodMesh(r,food),mesh=r.meshes.get(tool.id)?.mesh;if(!meat||!mesh)continue;
      meat.updateWorldMatrix(true,false);
      const tip=meat.localToWorld(new T.Vector3(a.x*food.food.D/2,(1-a.depth)*food.food.h,a.z*food.food.D/2));
      const rotation=meat.getWorldQuaternion(new T.Quaternion()).multiply(new T.Quaternion(...a.rotation));
      r.scene.add(mesh);mesh.quaternion.copy(rotation);mesh.position.copy(tip).sub(new T.Vector3(...r.grip(tool).tip).applyQuaternion(rotation));mesh.scale.setScalar(1);mesh.updateWorldMatrix(true,false);tool.pos=mesh.position.toArray();
    }
  }
  root.RealProbeView={park,render,foodMesh};
})(window);
