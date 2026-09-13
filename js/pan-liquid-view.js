/* Visible water uses the solver's mass, wet area and temperature. Fixed meshes, no frame allocations. */
(function(root){
  'use strict';
  const T=root.THREE,segments=64,rings=12,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  class WaterView{
    constructor(parent){
      const geometry=new T.BufferGeometry(),vertices=new Float32Array((1+segments*rings)*3),indices=[];
      for(let i=0;i<segments;i++)indices.push(0,1+(i+1)%segments,1+i);
      for(let j=0;j<rings-1;j++)for(let i=0;i<segments;i++){const a=1+j*segments+i,b=1+j*segments+(i+1)%segments;indices.push(a,b,a+segments,b,b+segments,a+segments);}
      geometry.setAttribute('position',new T.BufferAttribute(vertices,3));geometry.setIndex(indices);
      this.group=new T.Group();parent.add(this.group);this.group.visible=false;
      this.mesh=new T.Mesh(geometry,new T.MeshPhysicalMaterial({color:0xaed2ce,transparent:true,opacity:.32,roughness:.07,metalness:0,clearcoat:1,clearcoatRoughness:.045,envMapIntensity:.9,depthWrite:false,side:T.DoubleSide}));this.mesh.receiveShadow=true;this.mesh.frustumCulled=false;this.group.add(this.mesh);
      const edgeGeo=new T.BufferGeometry();edgeGeo.setAttribute('position',new T.BufferAttribute(new Float32Array(segments*3),3));
      this.edge=new T.LineLoop(edgeGeo,new T.LineBasicMaterial({color:0xd5efdf,transparent:true,opacity:.34,depthWrite:false}));this.edge.frustumCulled=false;this.group.add(this.edge);
      this.bubbles=new T.InstancedMesh(new T.TorusGeometry(1,.12,5,12),new T.MeshPhysicalMaterial({color:0xe6f2db,transparent:true,opacity:.48,roughness:.1,clearcoat:1,depthWrite:false}),32);this.bubbles.instanceMatrix.setUsage(T.DynamicDrawUsage);this.bubbles.frustumCulled=false;this.group.add(this.bubbles);this.dummy=new T.Object3D();this.lastMass=0;this.radius=0;
    }
    boundary(a){return this.radius*(1+this.irregular*(.55*Math.sin(a*3+.7)+.28*Math.sin(a*5)+.17*Math.sin(a*9+1.2)));}
    surfaceHeight(x,z,f){const r=Math.hypot(x-this.cx,z-this.cz),wave=(Math.sin(r*330-this.time*12)*this.pour*.00035+Math.sin(x*510+this.time*9)*Math.cos(z*460-this.time*7)*this.heat*.00013)*Math.sin(f*Math.PI);return Math.max(.00005,this.depth+wave-(x-this.cx)*this.sx-(z-this.cz)*this.sz)+.0003*f**14;}
    heightAt(x,z){if(!this.group.visible)return 0;const f=Math.hypot(x-this.cx,z-this.cz)/this.boundary(Math.atan2(z-this.cz,x-this.cx));return f>=1?0:(this.surfaceHeight(x,z,f)+.00007)*clamp((1-f)*20,0,1);}
    update(pan,time,floorY,enabled=true){
      this.group.visible=enabled&&pan.water>1e-6;
      if(!this.group.visible){this.lastMass=0;return;}
      if(pan.water>this.lastMass+.000001)this.pouredAt=time;
      this.lastMass=pan.water;
      const area=Math.min(Math.PI*pan.floorR**2,.003*Math.pow(pan.water/.005,2/3));
      this.radius=Math.sqrt(area/Math.PI)*.985;this.irregular=.055*clamp(1-this.radius/pan.floorR,0,1);
      this.depth=Math.min(.035,pan.water/1000/area);this.group.position.y=floorY+.00022;
      const sx=pan.slopeX||0,sz=pan.slopeZ||0,slope=Math.hypot(sx,sz),travel=Math.min(pan.floorR-this.radius*1.06,slope*pan.floorR*2);
      this.cx=slope?-sx/slope*Math.max(0,travel):0;this.cz=slope?-sz/slope*Math.max(0,travel):0;
      const gradient=Math.min(slope,this.depth/Math.max(.001,this.radius)*.85);this.sx=slope?sx/slope*gradient:0;this.sz=slope?sz/slope*gradient:0;
      const heat=clamp(((pan.waterT||20)-94)/6,0,1),pour=Math.exp(-Math.max(0,time-(this.pouredAt??-20))*2.2),a=this.mesh.geometry.attributes.position,edge=this.edge.geometry.attributes.position;
      this.time=time;this.heat=heat;this.pour=pour;
      for(let i=0;i<a.count;i++){
        const ring=i?1+Math.floor((i-1)/segments):0,angle=i?((i-1)%segments)/segments*Math.PI*2:0,f=ring/rings,r=f*this.boundary(angle),x=this.cx+Math.cos(angle)*r,z=this.cz+Math.sin(angle)*r;
        const y=this.surfaceHeight(x,z,f);a.setXYZ(i,x,y,z);if(ring===rings)edge.setXYZ((i-1)%segments,x,y,z);
      }
      a.needsUpdate=edge.needsUpdate=true;this.mesh.geometry.computeVertexNormals();
      this.mesh.material.opacity=.22+Math.min(.18,this.depth*35);this.bubbles.visible=heat>.05;
      if(this.bubbles.visible){const d=this.dummy;for(let i=0;i<32;i++){const angle=i*2.399,r=Math.sqrt((i+.5)/32)*this.radius*.88,u=(time*(1.1+heat)+i*.618)%1,scale=(.001+u*.003)*heat,x=this.cx+Math.cos(angle)*r,z=this.cz+Math.sin(angle)*r;d.position.set(x,this.surfaceHeight(x,z,r/this.radius)+.00035+Math.sin(u*Math.PI)*.0008,z);d.rotation.set(-Math.PI/2,0,angle);d.scale.setScalar(scale*Math.sin(u*Math.PI));d.updateMatrix();this.bubbles.setMatrixAt(i,d.matrix);}this.bubbles.instanceMatrix.needsUpdate=true;}
    }
  }
  root.PanWaterView=WaterView;
})(window);
