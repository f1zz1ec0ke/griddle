/* Static, low-poly scenery. Coordinates keep the existing cooking surface at y = 0. */
(function (root) {
  'use strict';
  root.buildKitchenRoom = function (T, scene) {
    const room = new T.Group(); room.name = 'Daylight kitchen'; scene.add(room);
    const cube = new T.BoxGeometry(1, 1, 1), materials = new Map();
    const mat = (color, metalness = 0) => {
      const key = color + ':' + metalness;
      if (!materials.has(key)) materials.set(key, new T.MeshStandardMaterial({color, roughness: metalness ? .35 : .82, metalness}));
      return materials.get(key);
    };
    const cream = 0xe8deca, sage = 0x6e947c, darkSage = 0x496f59, oak = 0xb98b59, brass = 0xb68b43;
    function box(w,h,d,x,y,z,color,metalness=0) {
      const m = new T.Mesh(cube, mat(color, metalness)); m.scale.set(w,h,d);m.position.set(x,y,z);
      m.receiveShadow = true; m.castShadow = true; room.add(m); return m;
    }
    function cylinder(r1,r2,h,x,y,z,color) {
      const m = new T.Mesh(new T.CylinderGeometry(r1,r2,h,16),mat(color));m.position.set(x,y,z);room.add(m);return m;
    }
    function plant(x,y,z,size=1) {
      cylinder(.052*size,.039*size,.10*size,x,y+.05*size,z,0xb96f50);
      cylinder(.046*size,.046*size,.008*size,x,y+.103*size,z,0x554734);
      const leaves = new T.SphereGeometry(1,7,5);
      for(let i=0;i<7;i++) {
        const a=i*2.4, m=new T.Mesh(leaves,mat(i%2?0x75945c:0x4f7758));
        m.position.set(x+Math.cos(a)*.045*size,y+(.17+(i%3)*.025)*size,z+Math.sin(a)*.045*size);
        m.scale.set(.024*size,.075*size,.036*size);m.rotation.z=Math.cos(a)*.8;room.add(m);
      }
    }
    // A real floor and four walls, with a wide opening for the garden window.
    box(5.6,.06,5.6,0,-.91,0,0xd4c5aa);
    const tiles=new T.InstancedMesh(cube,mat(0xffffff),196), dummy=new T.Object3D();
    const color=new T.Color();let n=0;
    for(let ix=0;ix<14;ix++)for(let iz=0;iz<14;iz++) {
      dummy.position.set(-2.6+ix*.4,-.875,-2.6+iz*.4);dummy.scale.set(.396,.008,.396);dummy.updateMatrix();tiles.setMatrixAt(n,dummy.matrix);
      tiles.setColorAt(n++,color.setHex((ix+iz)%2?0xc4c5ae:0xeee3ce));
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
    box(.83,2.08,.045,-1.225,.17,-2.8,oak);
    for(const x of [-1.675,-.775])box(.065,2.17,.09,x,.205,-2.74,0xf9f0dc);
    box(.97,.065,.09,-1.225,1.30,-2.74,0xf9f0dc);
    for(const y of [-.36,.59])box(.62,.75,.018,-1.225,y,-2.765,0xc79b66);
    box(.04,.12,.025,-.94,.13,-2.745,brass,.65);
    box(.13,.022,.04,-.98,.15,-2.72,brass,.65);
    box(1.95,2.65,.09,-1.825,.425,1.95,cream);box(1.95,2.65,.09,1.825,.425,1.95,cream);
    box(1.7,1,.09,0,-.4,1.95,cream);box(1.7,.48,.09,0,1.51,1.95,cream);
    for(const x of [-2.75,2.75])box(.018,.10,5.5,x,-.81,0,0xf8efd9);
    box(5.5,.10,.022,0,-.81,-2.745,0xf8efd9);box(5.5,.10,.022,0,-.81,1.895,0xf8efd9);
    // A real garden beyond the walls. Distinct depths provide parallax through
    // either window; no scenery card is attached to the glass.
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
      for(let j=0;j<5;j++) {
        const canopy=new T.Mesh(new T.SphereGeometry(.43*size,10,8),mat(j%2?0x668154:0x81975d));
        canopy.position.set(x+Math.cos(j*2.4)*.25*size,-.84+(1.2+(j%2)*.25)*size,z+Math.sin(j*2.4)*.22*size);
        canopy.scale.y=1.18;canopy.castShadow=true;room.add(canopy);
      }
    }
    tree(-2.25,5.2,1.5);tree(2.4,5.65,1.8);tree(.6,7.7,2.0);tree(4.8,-.6,1.6);
    for(let i=0;i<12;i++) {
      const bush=new T.Mesh(new T.SphereGeometry(.32,9,7),mat(i%2?0x94a46a:0x69875b));
      bush.position.set(-3.1+i*.56,-.56,6.35+(i%3)*.17);bush.scale.set(1.3,.9,1);room.add(bush);
    }
    const windows=[];
    function windowFrame(x,y,z,w,h,rotation=0) {
      const frame=new T.Group();frame.position.set(x,y,z);frame.rotation.y=rotation;room.add(frame);
      const beam=(w,h,d,x,y,z,color)=>{const m=new T.Mesh(cube,mat(color));m.scale.set(w,h,d);m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;frame.add(m);return m;};
      for(const x of [-w/2,w/2])beam(.055,h+.08,.18,x,0,0,0xf9f0dc);
      for(const y of [-h/2,h/2])beam(w+.08,.055,.18,0,y,0,0xf9f0dc);
      beam(w+.18,.045,.22,0,-h/2-.035,-.03,oak);
      for(const side of [-1,1]) {
        const hinge=new T.Group();hinge.position.x=side*(w/2-.035);frame.add(hinge);
        const leaf=new T.Group();leaf.position.x=-side*(w/4-.025);hinge.add(leaf);
        const part=(ww,hh,dd,xx,yy,color)=>{const m=new T.Mesh(cube,mat(color));m.scale.set(ww,hh,dd);m.position.set(xx,yy,-.045);m.castShadow=true;leaf.add(m);};
        for(const xx of [-w/4+.025,w/4-.025])part(.035,h-.04,.045,xx,0,0xf9f0dc);
        for(const yy of [-h/2+.025,0,h/2-.025])part(w/2-.03,.035,.045,0,yy,0xf9f0dc);
        part(.018,.10,.055,-side*(w/4-.075),-.08,brass);
        const glass=new T.Mesh(new T.PlaneGeometry(w/2-.07,h-.08),new T.MeshPhysicalMaterial({color:0xc7e5df,transparent:true,opacity:.10,roughness:.08,metalness:.1,side:T.DoubleSide,depthWrite:false}));
        glass.position.z=-.04;leaf.add(glass);windows.push({hinge,side});
      }
    }
    windowFrame(0,.70,1.95,1.7,1.2);
    windowFrame(2.8,.65,-.65,1.3,1.18,Math.PI/2);
    room.userData.windows=windows;
    plant(-.63,.088,1.79,.85);plant(.64,.088,1.79,.65);
    // Small framed prints keep the other orbit directions from becoming blank walls.
    for(const z of [-.65,.05]) {
      box(.035,.57,.43,-2.735,.65,z,oak);
      box(.015,.50,.36,-2.711,.65,z,0xf4e7c8);
      const print=new T.Mesh(new T.CircleGeometry(.11,24),mat(z<0?0xb86f4b:0x82946c));
      print.rotation.y=Math.PI/2;print.position.set(-2.698,.65,z);room.add(print);
    }
    // Cabinets sit against the wall, leaving a clear walking aisle around the island.
    for(let i=0;i<6;i++) {
      const x=-1.5+i*.60;
      box(.594,i === 3 ? .56 : .78,.52,x,i === 3 ? -.57 : -.46,1.58,sage);
      box(.55,.66,.025,x,-.42,1.303,darkSage);
      box(.49,.60,.029,x,-.42,1.284,sage);
      box(.14,.013,.023,x,-.15,1.258,brass,.65);
    }
    // Four countertop sections leave an actual opening over the basin.
    box(1.87,.05,.64,-.905,-.045,1.57,0xf3e8d1);
    box(1.31,.05,.64,1.185,-.045,1.57,0xf3e8d1);
    box(.50,.05,.13,.28,-.045,1.315,0xf3e8d1);
    box(.50,.05,.19,.28,-.045,1.795,0xf3e8d1);
    box(3.6,.11,.035,0,.035,1.865,0xd5ddd0);
    // Simple sink and curved brass tap, offset from the window plants.
    box(.50,.018,.32,.28,-.175,1.54,0xaabfbb);
    for(const x of [.039,.521])box(.018,.16,.32,x,-.09,1.54,0xd4ded7);
    for(const z of [1.389,1.691])box(.50,.16,.018,.28,-.09,z,0xd4ded7);
    cylinder(.025,.025,.005,.28,-.163,1.54,0x303d3b);
    const tap=new T.Mesh(new T.TorusGeometry(.065,.008,7,20,Math.PI),mat(brass,.7));
    tap.position.set(.28,.14,1.72);room.add(tap);
    cylinder(.008,.008,.15,.215,.055,1.72,brass);
    for(const x of [-1.34,1.34]) {
      box(.70,.62,.30,x,.83,1.72,sage);
      for(const dx of [-.17,.17]) {
        box(.326,.57,.022,x+dx,.83,1.554,darkSage);
        box(.286,.53,.026,x+dx,.83,1.539,sage);
        box(.014,.09,.024,x+dx+(dx<0?.10:-.10),.70,1.512,brass,.7);
      }
    }
    // Tall fridge and a little open shelf on the opposite wall.
    box(.61,1.43,.58,-2.20,-.12,1.52,0xf0e6d2);
    box(.57,.80,.025,-2.20,.18,1.216,0xfaf0da);box(.57,.49,.025,-2.20,-.49,1.216,0xfaf0da);
    box(.023,.25,.035,-1.98,.14,1.185,brass,.65);box(.023,.15,.035,-1.98,-.40,1.185,brass,.65);
    box(1.18,.035,.23,.75,.55,-2.63,oak);
    for(let i=0;i<5;i++)box(.055,.20+(i%2)*.04,.12,.40+i*.063,.66,-2.62,[0xb9694a,0x8da293,0xd9b56b][i%3]);
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
    box(.45,.085,.04,.10,-.125,-.497,0x484d47);
    for(const x of [-.035,.235])cylinder(.023,.023,.018,x,-.074,-.48,brass);
    box(.026,.52,.035,-.132,-.435,-.50,0x484d47);box(.026,.52,.035,.332,-.435,-.50,0x484d47);
    box(.48,.055,.035,.10,-.71,-.50,0x484d47);
    // Dark enamel liner separates the appliance from the surrounding cabinetry.
    box(.44,.52,.012,.10,-.435,.422,0x333c3b);
    box(.012,.52,.88,-.122,-.435,-.02,0x414b49);box(.012,.52,.88,.322,-.435,-.02,0x414b49);
    box(.44,.012,.88,.10,-.698,-.02,0x333c3b);box(.44,.012,.88,.10,-.175,-.02,0x333c3b);
    const glass=new T.Mesh(cube,new T.MeshPhysicalMaterial({color:0xaaa899,transparent:true,opacity:.20,roughness:.1,depthWrite:false}));
    glass.scale.set(.435,.50,.009);glass.position.set(.10,-.435,-.51);room.add(glass);
    box(.34,.022,.035,.10,-.225,-.535,brass,.65);
    for(let i=0;i<10;i++)box(.012,.008,.80,-.10+i*.044,-.488,-.015,0x777b76,.7);
    box(.44,.012,.014,.10,-.492,-.43,0x777b76,.7);
    // Small props stay outside the pan, food-drag and plating areas.
    plant(-.55,0,.39,.6);
    for(let i=0;i<2;i++) {
      cylinder(.022,.027,.09,-.44+i*.065,.045,.40,i?0xdbbb8a:0x574b3b);
      cylinder(.028,.028,.019,-.44+i*.065,.095,.40,oak);
    }
    // Two tucked-in stools give the island a readable human scale.
    for(const x of [-.32,.48]) {
      cylinder(.14,.14,.045,x,-.36,-.85,oak);
      for(const dx of [-.08,.08])for(const dz of [-.08,.08])box(.025,.48,.025,x+dx,-.62,-.85+dz,darkSage);
    }
    // No ceiling slab: overhead camera stays useful. Pendant shades sit off the cooking axis.
    for(const x of [-.50,.65]) {
      cylinder(.003,.003,.34,x,1.43,.22,0x63574a);
      const shade=new T.Mesh(new T.ConeGeometry(.13,.14,20,1,true),mat(0xc99655));
      shade.position.set(x,1.20,.22);room.add(shade);
      const bulb=new T.Mesh(new T.SphereGeometry(.024,10,8),new T.MeshBasicMaterial({color:0xffe0a0}));
      bulb.position.set(x,1.145,.22);room.add(bulb);
    }
    return room;
  };
})(window);
