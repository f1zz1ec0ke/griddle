/* Finish the shared kitchen fixtures without replacing their models. */
(function(root){
  'use strict';
  const T=root.THREE,A=root.KitchenAssets;
  function decorate(r){
    const box=(w,h,d,x,y,z,c,k='paint')=>r.box(w,h,d,x,y,z,c,k);
    const slats=[],slat=(w,h,d,x,y,z,color)=>slats.push({w,h,d,x,y,z,color});
    // Painted wainscot, oak capping and a quieter floor palette give the room scale.
    for(const side of [-1,1]){
      box(.016,.82,7.84,side*3.94,.47,0,0x81907d);
      box(.035,.025,7.84,side*3.925,.892,0,0xb79467,'wood');
      for(let i=0;i<26;i++)slat(.006,.77,.007,side*3.927,.47,-3.75+i*.30,0x657b68);
    }
    box(7.8,.82,.016,0,.47,-3.94,0x81907d);
    box(7.8,.025,.035,0,.892,-3.925,0xb79467,'wood');
    for(let i=0;i<26;i++){const x=-3.75+i*.30;if(x>2.05&&x<3.4)continue;slat(.007,.77,.006,x,.47,-3.927,0x657b68);}
    // The window and appliances retain the original detailed assets.
    for(const x of [-1.5,0,1.5]){
      const warm=new T.PointLight(0xffdfac,.16,2.8,2);warm.position.set(x,2.38,0);r.scene.add(warm);
    }
    for(const [w,d,x,z] of [[4.65,.80,0,.95],[3.9,1.15,0,-.86]]){
      box(w+.05,.026,d+.05,x,.908,z,0xb39165,'wood');
      for(const side of [-1,1])box(w-.07,.020,.012,x,.82,z+side*(d/2-.02),0x354f42);
      const n=Math.round(w/.30);for(let i=0;i<n;i++)slat(.012,.67,.012,x-w/2+(i+.5)*w/n,.46,z+d/2-.01,0x55715e);
    }
    const panelDetail=new T.InstancedMesh(new T.BoxGeometry(1,1,1),A.material('paint',0xffffff),slats.length),dummy=new T.Object3D();
    slats.forEach((s,i)=>{dummy.position.set(s.x,s.y,s.z);dummy.scale.set(s.w,s.h,s.d);dummy.updateMatrix();panelDetail.setMatrixAt(i,dummy.matrix);panelDetail.setColorAt(i,new T.Color(s.color).convertSRGBToLinear());});panelDetail.name='Panel joinery';panelDetail.castShadow=panelDetail.receiveShadow=true;r.scene.add(panelDetail);
    // The grill's fuel and lighter have a proper preparation shelf beside it.
    r.cabinet(.56,.88,3.62,0);
    r.label('FIRE',3.33,.81,0,.027).rotation.y=-Math.PI/2;
    // Open shelves complement the oven, with useful visual separation from the prep bench.
    for(const y of [1.54,1.99]){
      box(.28,.035,1.10,-3.80,y,-1.3,0xab8456,'wood');
      for(const z of [-1.71,-.89]){box(.024,.19,.020,-3.91,y-.10,z,0x364d40,'steel');box(.21,.018,.018,-3.81,y-.025,z,0x364d40,'steel');}
    }
    for(const [z,scale] of [[-1.64,.58],[-1.25,.68]])r.reuse('herb',[-3.78,2.015,z],[scale,scale,scale]);
    for(const z of [-1.6,-1.32,-1.04]){const jar=new T.Mesh(new T.CylinderGeometry(.058,.053,.12,28),A.material('ceramic',0xc9cdb8));jar.position.set(-3.78,1.62,z);jar.castShadow=true;r.scene.add(jar);box(.116,.014,.116,-3.78,1.682,z,0xa4865e,'wood');}
    // A sink needs a backsplash and drainboard, not an isolated island of plumbing.
    box(1.18,.23,.025,2.6,1.045,3.955,0xc1caba,'ceramic');
    for(let i=0;i<8;i++)box(.21,.002,.003,3.02,.933,3.36+i*.055,0x9fae9f,'steel');
    const fixture=r.scene.getObjectByName('oven fixture');r.ovenKnobs=[];fixture.traverse(o=>{if(o.userData.ovenControl)r.ovenKnobs.push({mesh:o,angle:o.rotation.z,control:o.userData.ovenControl});});
    const light=new T.Mesh(new T.SphereGeometry(.008,12,8),new T.MeshStandardMaterial({color:0xb35e28,emissive:0xe98226,emissiveIntensity:0}));light.position.set(...root.RealKitchen.fixturePoint('oven',[.19,.96,-.466]));r.scene.add(light);r.ovenLamp=light;
    // Small readable labels on the working edge of the fridge shelves.
    const supplies=['80/20','EGGS','BACON','BUNS','TOMATO','PICKLE','ONION','CHEDDAR','LETTUCE','90/10','70/30'];
    supplies.forEach((text,i)=>{const p=root.RealKitchen.fixturePoint('fridge',[-.22+(i%3)*.23,.43+Math.floor(i/3)*.4,-.30]);r.label(text,...p,.018);});
    // Matte cloth keeps the chef's body consistent with the articulated hands.
    r.mince.material.map=A.texture('mince').map;r.mince.material.bumpMap=A.texture('mince').relief;r.mince.material.bumpScale=.0008;r.mince.material.roughness=.86;r.mince.material.clearcoat=0;
  }
  root.RealRoomDetail={decorate};
})(window);
