/* Static, low-poly scenery. Coordinates keep the existing cooking surface at y = 0. */
(function (root) {
  'use strict';
  root.buildKitchenRoom = function (T, scene) {
    const room = new T.Group(); room.name = 'Daylight kitchen'; scene.add(room);
    // Asset references let the first-person kitchen reuse these exact meshes and materials.
    const assets=room.userData.assets={};
    const mark=()=>room.children.length;
    const asset=(name,start,origin)=>assets[name]={nodes:room.children.slice(start),origin};
    let part;
    const A=root.KitchenAssets,cube = new T.BoxGeometry(1, 1, 1), materials = new Map(),shapes=new Map();
    const mat = (color, metalness = 0) => {
      const key = color + ':' + metalness;
      if (!materials.has(key)) {
        const wood=[0xb98b59,0xc79b66,0xc8b997,0xbaa079,0xb2976f,0x8d7658].includes(color);
        const stone=[0xf3e8d1,0xd5c4a5].includes(color);
        const m=A.material(metalness?'steel':wood?'wood':stone?'stone':'paint',color);
        if(metalness)m.metalness=1;
        if([0xe8deca,0xe5d9c3].includes(color)){m.roughness=.94;m.clearcoat=0;}
        materials.set(key,m);
      }
      return materials.get(key);
    };
    const cream = 0xe8deca, sage = 0x6e947c, darkSage = 0x496f59, oak = 0xb98b59, brass = 0xb68b43;
    function box(w,h,d,x,y,z,color,metalness=0) {
      const key=[w,h,d].join(':');
      // Visible furniture edges catch the window light; walls remain inexpensive boxes.
      const rounded=Math.max(w,h,d)<2 && Math.min(w,h,d)>.011;
      if(rounded&&!shapes.has(key))shapes.set(key,A.roundedBox(w,h,d,Math.min(.009,Math.min(w,h,d)*.18),2));
      const m = new T.Mesh(rounded?shapes.get(key):cube, mat(color, metalness)); if(!rounded)m.scale.set(w,h,d);m.position.set(x,y,z);
      m.receiveShadow = true; m.castShadow = true; room.add(m); return m;
    }
    function cylinder(r1,r2,h,x,y,z,color) {
      const m = new T.Mesh(new T.CylinderGeometry(r1,r2,h,32),mat(color,color===brass?1:0));m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;room.add(m);return m;
    }
    function tube(points,r,color,metal=0) {
      const curve=new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p)));
      const mesh=new T.Mesh(new T.TubeGeometry(curve,40,r,10,false),mat(color,metal));
      mesh.castShadow=mesh.receiveShadow=true;room.add(mesh);return mesh;
    }
    function turned(profile,x,y,z,color,metal=0) {
      const curve=new T.CatmullRomCurve3(profile.map(p=>new T.Vector3(p[0],p[1],0)));
      const points=curve.getPoints(profile.length*4).map(p=>new T.Vector2(Math.max(0,p.x),p.y));
      const mesh=new T.Mesh(new T.LatheGeometry(points,48),mat(color,metal));
      mesh.position.set(x,y,z);mesh.castShadow=mesh.receiveShadow=true;room.add(mesh);return mesh;
    }
    function foliage(x,y,z,size,color,seed=0) {
      const geo=new T.SphereGeometry(size,24,16),pos=geo.attributes.position;
      for(let i=0;i<pos.count;i++){
        const a=pos.getX(i)/size,b=pos.getY(i)/size,c=pos.getZ(i)/size;
        const d=1+.09*Math.sin(a*9+seed)*Math.sin(b*7+c*6)+.05*Math.cos(c*11+a*3);
        pos.setXYZ(i,a*size*d,b*size*d,c*size*d);
      }
      geo.computeVertexNormals();const material=mat(color);material.roughness=.95;material.clearcoat=0;
      const mesh=new T.Mesh(geo,material);mesh.position.set(x,y,z);mesh.castShadow=true;room.add(mesh);return mesh;
    }
    function plant(x,y,z,size=1) {
      cylinder(.052*size,.039*size,.10*size,x,y+.05*size,z,0xb96f50);
      cylinder(.046*size,.046*size,.008*size,x,y+.103*size,z,0x554734);
      const rim=new T.Mesh(new T.TorusGeometry(.05*size,.004*size,8,32),mat(0xb96f50));rim.rotation.x=Math.PI/2;rim.position.set(x,y+.101*size,z);room.add(rim);
      const leaves=new T.BufferGeometry(),pos=[],idx=[];
      for(let j=0;j<=10;j++){
        const t=j/10,w=Math.sin(t*Math.PI)*.024;
        for(const side of [-1,0,1])pos.push(w*side,.055*t+.018*Math.sin(t*Math.PI)*(1-Math.abs(side)),.095*t);
        if(j<10)for(let k=0;k<2;k++){const a=j*3+k;idx.push(a,a+3,a+1,a+1,a+3,a+4);}
      }
      leaves.setAttribute('position',new T.Float32BufferAttribute(pos,3));leaves.setIndex(idx);leaves.computeVertexNormals();
      for(let i=0;i<11;i++) {
        const a=i*2.4,leafMat=mat(i%2?0x648847:0x3d6c3e);leafMat.side=T.DoubleSide;leafMat.roughness=.7;leafMat.clearcoat=.08;
        const m=new T.Mesh(leaves,leafMat);m.position.set(x,y+(.105+(i%3)*.035)*size,z);m.scale.setScalar(size*(.7+(i%3)*.15));m.rotation.y=a;m.rotation.x=(i%3)*-.35;m.castShadow=true;room.add(m);
      }
    }
    // A real floor and four walls, with a wide opening for the garden window.
    box(5.6,.06,5.6,0,-.91,0,0xd4c5aa);
    const tiles=new T.InstancedMesh(cube,mat(0xffffff),196), dummy=new T.Object3D();
    const color=new T.Color();let n=0;
    for(let ix=0;ix<14;ix++)for(let iz=0;iz<14;iz++) {
      dummy.position.set(-2.6+ix*.4,-.875,-2.6+iz*.4);dummy.scale.set(.396,.008,.396);dummy.updateMatrix();tiles.setMatrixAt(n,dummy.matrix);
      tiles.setColorAt(n++,color.setHex((ix+iz)%2?0xc4c5ae:0xeee3ce).convertSRGBToLinear());
    }
    tiles.receiveShadow=true;room.add(tiles);
    box(.09,2.65,5.6,-2.8,.425,0,cream);
    // Right wall is built around an opening, not covered by a picture.
    box(.09,2.65,1.5,2.8,.425,-2.05,cream);box(.09,2.65,2.8,2.8,.425,1.4,cream);
    box(.09,.96,1.3,2.8,-.42,-.65,cream);box(.09,.51,1.3,2.8,1.495,-.65,cream);
    box(1.15,2.65,.09,-2.225,.425,-2.8,0xe5d9c3);
    box(3.6,2.65,.09,1.0,.425,-2.8,0xe5d9c3);
    box(.85,.53,.09,-1.225,1.485,-2.8,0xe5d9c3);
    // A full-height oak door, inset panels and a brass lever.
    part=mark();
    box(.83,2.08,.045,-1.225,.17,-2.8,oak);
    for(const x of [-1.675,-.775])box(.065,2.17,.09,x,.205,-2.74,0xf9f0dc);
    box(.97,.065,.09,-1.225,1.30,-2.74,0xf9f0dc);
    for(const y of [-.36,.59])box(.62,.75,.018,-1.225,y,-2.765,0xc79b66);
    box(.04,.12,.025,-.94,.13,-2.745,brass,.65);
    box(.13,.022,.04,-.98,.15,-2.72,brass,.65);
    asset('door',part,[-1.225,-.87,-2.8]);
    box(1.95,2.65,.09,-1.825,.425,1.95,cream);box(1.95,2.65,.09,1.825,.425,1.95,cream);
    box(1.7,1,.09,0,-.4,1.95,cream);box(1.7,.48,.09,0,1.51,1.95,cream);
    for(const x of [-2.75,2.75])box(.018,.10,5.5,x,-.81,0,0xf8efd9);
    box(5.5,.10,.022,0,-.81,-2.745,0xf8efd9);box(5.5,.10,.022,0,-.81,1.895,0xf8efd9);
    // A real garden beyond the walls. Distinct depths provide parallax through
    // either window; no scenery card is attached to the glass.
    part=mark();
    box(8,.07,7,0,-.87,5.5,0x77915c);
    box(4,.07,5,4.85,-.87,0,0x77915c);
    box(2.2,.04,1.05,0,-.81,2.56,0xc8b997);
    for(let i=0;i<7;i++)box(.52,.028,.43,.12*Math.sin(i*.8),-.815,3.25+i*.53,0xd4c8aa);
    for(const x of [-1.7,1.7]) {
      box(.85,.20,2.25,x,-.76,3.95,oak);box(.77,.02,2.17,x,-.65,3.95,0x514a32);
      for(let j=0;j<7;j++)plant(x+(j%2?.16:-.16),-.64,3.05+j*.29,1.1+(j%3)*.22);
    }
    // Fence, trees and layered shrubs sit metres behind the near planting.
    for(let i=0;i<29;i++)box(.20,1.05,.07,-3.5+i*.25,-.34,7.0, i%3?0xbaa079:0xb2976f);
    for(const y of [-.55,-.05])box(7.25,.07,.10,0,y,6.93,0x8d7658);
    function tree(x,z,size) {
      cylinder(.065*size,.09*size,1.25*size,x,-.84+.625*size,z,0x786248);
      for(let j=0;j<9;j++) {
        const a=j*2.4,dx=Math.cos(a)*.31*size,dz=Math.sin(a)*.31*size,cy=-.84+(1.12+(j%3)*.21)*size;
        tube([[x,-.84+.65*size,z],[x+dx*.4,cy-.25*size,z+dz*.4],[x+dx,cy,z+dz]],.018*size,0x786248);
        const canopy=foliage(x+dx,cy,z+dz,.30*size,[0x668154,0x81975d,0x728d50][j%3],j);canopy.scale.y=1.18;
      }
    }
    tree(-2.25,5.2,1.5);tree(2.4,5.65,1.8);tree(.6,7.7,2.0);tree(4.8,-.6,1.6);
    for(let i=0;i<12;i++) {
      const bush=foliage(-3.1+i*.56,-.56,6.35+(i%3)*.17,.32,i%2?0x94a46a:0x69875b,i);bush.scale.set(1.3,.9,1);
    }
    asset('garden',part,[0,-.87,1.95]);
    const windows=[];
    function windowFrame(x,y,z,w,h,rotation=0) {
      const frame=new T.Group();frame.position.set(x,y,z);frame.rotation.y=rotation;room.add(frame);
      const beam=(w,h,d,x,y,z,color)=>{const m=new T.Mesh(cube,mat(color));m.scale.set(w,h,d);m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;frame.add(m);return m;};
      for(const x of [-w/2,w/2])beam(.055,h+.08,.18,x,0,0,0xf9f0dc);
      for(const y of [-h/2,h/2])beam(w+.08,.055,.18,0,y,0,0xf9f0dc);
      beam(w+.18,.045,.22,0,-h/2-.035,-.03,oak);
      for(const side of [-1,1]) {
        const hinge=new T.Group();hinge.name='Window leaf hinge';hinge.userData.side=side;hinge.position.x=side*(w/2-.035);frame.add(hinge);
        const leaf=new T.Group();leaf.position.x=-side*(w/4-.025);hinge.add(leaf);
        const part=(ww,hh,dd,xx,yy,color)=>{const m=new T.Mesh(cube,mat(color));m.scale.set(ww,hh,dd);m.position.set(xx,yy,-.045);m.castShadow=true;leaf.add(m);};
        for(const xx of [-w/4+.025,w/4-.025])part(.035,h-.04,.045,xx,0,0xf9f0dc);
        for(const yy of [-h/2+.025,0,h/2-.025])part(w/2-.03,.035,.045,0,yy,0xf9f0dc);
        part(.018,.10,.055,-side*(w/4-.075),-.08,brass);
        const glass=new T.Mesh(new T.PlaneGeometry(w/2-.07,h-.08),new T.MeshPhysicalMaterial({color:0xc7e5df,transparent:true,opacity:.10,roughness:.08,metalness:.1,side:T.DoubleSide,depthWrite:false}));
        glass.position.z=-.04;leaf.add(glass);windows.push({hinge,side});
      }
    }
    part=mark();windowFrame(0,.70,1.95,1.7,1.2);asset('window',part,[0,.70,1.95]);
    windowFrame(2.8,.65,-.65,1.3,1.18,Math.PI/2);
    room.userData.windows=windows;
    part=mark();plant(-.63,.088,1.79,.85);asset('herb',part,[-.63,.088,1.79]);plant(.64,.088,1.79,.65);
    // Small framed prints keep the other orbit directions from becoming blank walls.
    for(const z of [-.65,.05]) {
      part=mark();
      box(.035,.57,.43,-2.735,.65,z,oak);
      box(.015,.50,.36,-2.711,.65,z,0xf4e7c8);
      // Raised botanical artwork: a curved stem and tapered leaves over warm paper.
      tube([[-2.697,.46,z+.06],[-2.697,.62,z],[-2.697,.83,z-.035]],.003,0x62764e);
      for(let i=0;i<7;i++) {
        const shape=new T.Shape();shape.moveTo(0,0);shape.bezierCurveTo(.03,.01,.04,.055,0,.08);shape.bezierCurveTo(-.025,.045,-.02,.012,0,0);
        const leaf=new T.Mesh(new T.ShapeGeometry(shape,12),mat(z<0?0xb86f4b:0x82946c));leaf.material.side=T.DoubleSide;
        leaf.rotation.set(0,Math.PI/2,(i%2?1:-1)*.8);leaf.position.set(-2.692,.49+i*.045,z+.04-i*.012);room.add(leaf);
      }
      asset(z<0?'print-warm':'print-green',part,[-2.735,.65,z]);
    }
    // Cabinets sit against the wall, leaving a clear walking aisle around the island.
    for(let i=0;i<6;i++) {
      const x=-1.5+i*.60;
      part=mark();
      box(.594,i === 3 ? .56 : .78,.52,x,i === 3 ? -.57 : -.46,1.58,sage);
      box(.55,.66,.025,x,-.42,1.303,darkSage);
      box(.49,.60,.029,x,-.42,1.284,sage);
      box(.14,.013,.023,x,-.15,1.258,brass,.65);
      asset('cabinet'+i,part,[x,-.87,1.58]);
    }
    // Four countertop sections leave an actual opening over the basin.
    box(1.87,.05,.64,-.905,-.045,1.57,0xf3e8d1);
    box(1.31,.05,.64,1.185,-.045,1.57,0xf3e8d1);
    box(.50,.05,.13,.28,-.045,1.315,0xf3e8d1);
    box(.50,.05,.19,.28,-.045,1.795,0xf3e8d1);
    box(3.6,.11,.035,0,.035,1.865,0xd5ddd0);
    // Continuous drawn basin with rounded corners and a gently sloping floor.
    part=mark();
    const basinPos=[],basinIdx=[],basinRings=9,basinSegments=96;
    for(let j=0;j<basinRings;j++){
      const t=j/(basinRings-1),w=.205+.04*Math.sin(t*Math.PI/2),d=.112+.043*Math.sin(t*Math.PI/2),y=-.159+.141*t*t;
      for(let i=0;i<basinSegments;i++){
        const a=i/basinSegments*Math.PI*2,c=Math.cos(a),v=Math.sin(a);
        basinPos.push(.28+w*Math.sign(c)*Math.pow(Math.abs(c),.35),y,1.54+d*Math.sign(v)*Math.pow(Math.abs(v),.35));
        if(j<basinRings-1){const n=j*basinSegments+i,k=j*basinSegments+(i+1)%basinSegments;basinIdx.push(n,k,n+basinSegments,k,k+basinSegments,n+basinSegments);}
      }
    }
    const basinGeo=new T.BufferGeometry();basinGeo.setAttribute('position',new T.Float32BufferAttribute(basinPos,3));basinGeo.setIndex(basinIdx);basinGeo.computeVertexNormals();
    const basinMat=A.material('steel',0xc4cecd);basinMat.side=T.DoubleSide;basinMat.roughness=.28;
    const basin=new T.Mesh(basinGeo,basinMat);basin.name='Drawn sink basin';basin.receiveShadow=true;room.add(basin);
    box(.414,.012,.23,.28,-.163,1.54,0xc4cecd,1);
    const rim=[];for(let i=0;i<=96;i++){const a=i/96*Math.PI*2,c=Math.cos(a),v=Math.sin(a);rim.push([.28+.247*Math.sign(c)*Math.pow(Math.abs(c),.35),-.016,1.54+.157*Math.sign(v)*Math.pow(Math.abs(v),.35)]);}tube(rim,.004,0xc4cecd,1);
    const flangePos=[],flangeIdx=[];
    for(let i=0;i<96;i++){
      const a=i/96*Math.PI*2,c=Math.cos(a),v=Math.sin(a),m=Math.max(Math.abs(c),Math.abs(v));
      flangePos.push(...rim[i],.28+.258*c/m,-.018,1.54+.168*v/m);
      const k=i*2,n=((i+1)%96)*2;flangeIdx.push(k,n,k+1,n,n+1,k+1);
    }
    const flangeGeo=new T.BufferGeometry();flangeGeo.setAttribute('position',new T.Float32BufferAttribute(flangePos,3));flangeGeo.setIndex(flangeIdx);flangeGeo.computeVertexNormals();room.add(new T.Mesh(flangeGeo,basinMat));
    cylinder(.025,.025,.003,.28,-.154,1.54,brass);
    for(let i=0;i<8;i++){const a=i*Math.PI/4;cylinder(.0025,.0025,.001,.28+Math.cos(a)*.015,-.152,1.54+Math.sin(a)*.015,0x303d3b);}
    cylinder(.023,.025,.012,.215,-.009,1.74,brass);
    tube([[.215,0,1.74],[.215,.16,1.74],[.215,.22,1.69],[.215,.20,1.59],[.215,.16,1.58]],.010,brass,1);
    cylinder(.013,.013,.015,.215,.154,1.58,brass);
    const tapLever=tube([[.239,.035,1.74],[.262,.046,1.74],[.277,.085,1.74]],.005,brass,1);tapLever.name='Tap lever';
    asset('sink',part,[.28,-.018,1.54]);
    for(const x of [-1.34,1.34]) {
      box(.70,.62,.30,x,.83,1.72,sage);
      for(const dx of [-.17,.17]) {
        box(.326,.57,.022,x+dx,.83,1.554,darkSage);
        box(.286,.53,.026,x+dx,.83,1.539,sage);
        box(.014,.09,.024,x+dx+(dx<0?.10:-.10),.70,1.512,brass,.7);
      }
    }
    // Tall fridge and a little open shelf on the opposite wall.
    part=mark();
    // Same rounded enclosure, now hollow so the shared doors can open in Real mode.
    for(const x of [-2.49,-1.91]){const side=new T.Mesh(A.roundedBox(.03,1.43,.58,.006,4),A.material('paint',0xece4d1));side.position.set(x,-.12,1.52);side.castShadow=true;room.add(side);}
    for(const y of [-.82,.58]){const cap=new T.Mesh(A.roundedBox(.58,.03,.58,.006,4),A.material('paint',0xece4d1));cap.position.set(-2.20,y,1.52);cap.castShadow=true;room.add(cap);}
    box(.58,1.4,.025,-2.2,-.12,1.798,0xece4d1);
    asset('fridge-shell',part,[-2.20,-.835,1.52]);part=mark();
    for(const [y,h] of [[.18,.80],[-.49,.49]]){
      const door=new T.Mesh(A.roundedBox(.57,h,.055,.025,5),A.material('paint',0xfaf0da));door.position.set(-2.20,y,1.207);door.castShadow=true;room.add(door);
      tube([[-1.98,y-.10,1.176],[-1.98,y-.08,1.14],[-1.98,y+.08,1.14],[-1.98,y+.10,1.176]],.009,brass,1);
    }
    asset('fridge-doors',part,[-2.20,-.835,1.52]);part=mark();
    box(.52,.043,.025,-2.20,-.79,1.213,0x496058);
    for(let i=0;i<9;i++)box(.026,.004,.005,-2.39+i*.046,-.788,1.197,0x303b38);
    asset('fridge-trim',part,[-2.20,-.835,1.52]);part=mark();
    box(.095,.018,.006,-2.35,.46,1.176,brass,1);
    asset('fridge-badge',part,[-2.20,-.835,1.52]);
    box(1.18,.035,.23,.75,.55,-2.63,oak);
    for(let i=0;i<5;i++){
      const x=.40+i*.063,h=.20+(i%2)*.04,y=.57+h/2,c=[0xb9694a,0x8da293,0xd9b56b][i%3];
      box(.047,h-.009,.113,x,y,-2.62,0xe7dcc4);
      for(const dx of [-.026,.026])box(.005,h,.124,x+dx,y,-2.62,c);
      box(.054,h,.01,x,y,-2.559,c);
      for(const dy of [-h*.35,h*.35])box(.043,.004,.002,x,y+dy,-2.553,brass);
      box(.026,.018,.002,x,y+.025,-2.553,0xe7dcc4);
    }
    plant(1.07,.57,-2.62,1.05);
    // Island: pale stone, sage joinery, warm timber end panels, proper toe kick.
    box(1.55,.052,1.08,.10,-.027,0,0xd5c4a5);
    box(.46,.73,.94,-.375,-.447,0,sage);
    box(.46,.73,.94,.575,-.447,0,sage);
    box(.49,.73,.04,.10,-.447,.45,darkSage);
    box(.49,.06,.94,.10,-.78,0,darkSage);
    box(1.41,.04,.94,.10,-.072,0,sage);
    box(1.29,.10,.83,.10,-.84,0,0x56645a);
    for(const x of [-.375,.575]) {
      box(.443,.64,.025,x,-.42,-.485,darkSage);box(.397,.588,.028,x,-.42,-.502,sage);
      box(.13,.012,.025,x,-.18,-.524,brass,.65);
    }
    for(const x of [-.614,.814])box(.018,.72,.95,x,-.443,0,oak);
    // Built-in oven: open cavity, glazed front and a rack holding up to four patties.
    part=mark();
    box(.45,.085,.04,.10,-.125,-.497,0x484d47);
    for(const [i,x] of [-.035,.235].entries()){
      const bezel=cylinder(.025,.025,.005,x,-.125,-.525,brass);bezel.rotation.x=Math.PI/2;
      const knob=cylinder(.019,.021,.025,x,-.125,-.54,0x303b38);knob.rotation.x=Math.PI/2;
      const pointer=new T.Mesh(A.roundedBox(.0025,.009,.0015,.0003,1),mat(0xf7ead1));pointer.position.set(x,-.114,-.554);room.add(pointer);
      for(let j=0;j<7;j++){
        const a=-Math.PI*.75+j*Math.PI*1.5/6;
        const tick=new T.Mesh(cube,mat(0xe8deca));tick.scale.set(.0014,.004,.001);tick.position.set(x+Math.sin(a)*.032,-.125+Math.cos(a)*.032,-.519);tick.rotation.z=-a;room.add(tick);
      }
      knob.name=i?'Oven temperature knob':'Oven function knob';
    }
    box(.026,.52,.035,-.132,-.435,-.50,0x484d47);box(.026,.52,.035,.332,-.435,-.50,0x484d47);
    box(.48,.055,.035,.10,-.71,-.50,0x484d47);
    // Dark enamel liner separates the appliance from the surrounding cabinetry.
    box(.44,.52,.012,.10,-.435,.422,0x333c3b);
    box(.012,.52,.88,-.122,-.435,-.02,0x414b49);box(.012,.52,.88,.322,-.435,-.02,0x414b49);
    box(.44,.012,.88,.10,-.698,-.02,0x333c3b);box(.44,.012,.88,.10,-.175,-.02,0x333c3b);
    asset('oven-shell',part,[.10,-.935,0]);part=mark();
    const glass=new T.Mesh(cube,new T.MeshPhysicalMaterial({color:0xaaa899,transparent:true,opacity:.20,roughness:.1,depthWrite:false}));
    glass.scale.set(.435,.50,.009);glass.position.set(.10,-.435,-.51);room.add(glass);
    tube([[-.07,-.225,-.526],[-.05,-.225,-.56],[.25,-.225,-.56],[.27,-.225,-.526]],.011,brass,1);
    for(const y of [-.29,-.62])box(.42,.018,.014,.10,y,-.52,0x303b38);
    asset('oven-door',part,[.10,-.935,0]);part=mark();
    for(let i=0;i<5;i++)for(const x of [-.11,.31])tube([[x,-.36-i*.056,-.4],[x,-.36-i*.056,.35]],.004,0x777b76,1);
    for(let i=0;i<10;i++)tube([[-.10+i*.044,-.488,-.415],[-.10+i*.044,-.488,.385]],.004,0x777b76,1);
    box(.44,.012,.014,.10,-.492,-.43,0x777b76,.7);
    asset('oven-rack',part,[.10,-.935,0]);
    // Small props stay outside the pan, food-drag and plating areas.
    plant(-.55,0,.39,.6);
    for(let i=0;i<2;i++) {
      const x=-.44+i*.065;
      part=mark();
      turned([[0,0],[.024,0],[.027,.005],[.025,.018],[.017,.039],[.015,.057],[.022,.07],[.025,.083],[.02,.095],[0,.10]],x,0,.40,i?0xdbbb8a:0x574b3b);
      cylinder(.004,.004,.005,x,.103,.40,brass);
      asset(i?'salt-mill':'pepper-mill',part,[x,0,.40]);
    }
    // Two tucked-in stools give the island a readable human scale.
    for(const x of [-.32,.48]) {
      turned([[0,-.024],[.125,-.024],[.139,-.013],[.14,0],[.133,.013],[.07,.01],[0,.008]],x,-.36,-.85,oak);
      for(const dx of [-.08,.08])for(const dz of [-.08,.08])tube([[x+dx*1.4,-.86,-.85+dz*1.4],[x+dx,-.38,-.85+dz]],.012,darkSage);
      const foot=new T.Mesh(new T.TorusGeometry(.123,.006,10,48),mat(brass,1));foot.rotation.x=Math.PI/2;foot.position.set(x,-.69,-.85);room.add(foot);
    }
    // No ceiling slab: overhead camera stays useful. Pendant shades sit off the cooking axis.
    for(const x of [-.50,.65]) {
      part=mark();
      cylinder(.003,.003,.34,x,1.43,.22,0x63574a);
      const shade=turned([[.128,0],[.131,.008],[.124,.023],[.099,.043],[.077,.071],[.044,.115],[.025,.134],[.018,.14]],x,1.13,.22,0xc99655);
      shade.material=shade.material.clone();shade.material.side=T.DoubleSide;
      cylinder(.019,.019,.028,x,1.284,.22,brass);
      const lip=new T.Mesh(new T.TorusGeometry(.128,.003,10,64),mat(0xf5dfb8));lip.rotation.x=Math.PI/2;lip.position.set(x,1.132,.22);room.add(lip);
      const bulb=new T.Mesh(new T.SphereGeometry(.024,24,16),new T.MeshBasicMaterial({color:0xffe0a0}));
      bulb.position.set(x,1.145,.22);room.add(bulb);
      asset('pendant',part,[x,1.13,.22]);
    }
    return room;
  };
})(window);
