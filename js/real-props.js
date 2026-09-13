/* Real-only props. Food and cookware with an established model stay with the shared builders. */
(function(root){
  'use strict';
  const T=root.THREE,A=root.KitchenAssets;
  const labels=new Map();
  function decal(text,color='#34483e'){
    const key=text+color;if(labels.has(key))return labels.get(key);
    const c=document.createElement('canvas');c.width=256;c.height=128;const ctx=c.getContext('2d');
    ctx.fillStyle='#f1e9d5';ctx.fillRect(0,0,256,128);ctx.strokeStyle=color;ctx.lineWidth=3;ctx.strokeRect(10,10,236,108);
    ctx.fillStyle=color;ctx.textAlign='center';ctx.font='600 25px sans-serif';ctx.fillText(text.toUpperCase(),128,76);
    const tex=new T.CanvasTexture(c);tex.encoding=T.sRGBEncoding;A.shared.add(tex);labels.set(key,tex);return tex;
  }
  function build(r,kind){
    const supported=['tongs','spoon','knife','press','cloth','glove','tray','oil','water','ketchup','mayo','mustard','lighter','meat','meatLean','meatRich','egg','tomato','pickles','onion','coal','wood','butter','brush','rake','timer','ashpan'];
    if(!supported.includes(kind))return null;
    const g=new T.Group();g.name='Real '+kind;
    const mat=(type,color)=>A.material(type,color),steel=mat('steel',0xc1cac5),wood=mat('wood',0x785139);
    const mesh=(geo,m,x=0,y=0,z=0,parent=g)=>{const o=new T.Mesh(geo,m);o.position.set(x,y,z);o.castShadow=o.receiveShadow=true;parent.add(o);return o;};
    const box=(w,h,d,x,y,z,m)=>mesh(A.roundedBox(w,h,d,.004,3),m,x,y,z);
    const lathe=(profile,m,x=0,y=0,z=0)=>mesh(new T.LatheGeometry(profile.map(p=>new T.Vector2(...p)),48),m,x,y,z);
    const tube=(points,radius,m)=>mesh(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p))),24,radius,8,false),m);
    const badge=(text,w,h,x,y,z)=>{const o=mesh(new T.PlaneGeometry(w,h),new T.MeshStandardMaterial({map:decal(text),roughness:.82,side:T.DoubleSide}),x,y,z);o.rotation.y=Math.PI;return o;};
    const rivet=(x,y,z)=>{const o=mesh(new T.CylinderGeometry(.0022,.0022,.001,12),steel,x,y,z);return o;};
    if(kind==='timer'){
      lathe([[0,0],[.042,0],[.048,.007],[.048,.025],[.042,.036],[0,.036]],mat('enamel',0x91b5a5));
      const face=mesh(new T.CircleGeometry(.039,48),mat('paint',0xf0e4c9),0,.037,0);face.rotation.x=-Math.PI/2;
      for(let i=0;i<12;i++){const a=i*Math.PI/6,tick=box(.0012,.0007,i%3? .004:.007,Math.sin(a)*.033,.038,Math.cos(a)*.033,steel);tick.rotation.y=a;}
      const dial=lathe([[0,0],[.018,0],[.019,.012],[.015,.023],[0,.025]],mat('steel',0xc0c8c0),0,.038,0);dial.userData.timerDial=true;
      const mark=box(.002,.001,.010,0,.063,-.007,mat('paint',0x40564a));mark.userData.timerNeedle=true;
      const button=box(.021,.012,.016,0,.010,-.052,mat('enamel',0xe1b05e));button.userData.timerButton=true;
    }else if(kind==='butter'){
      lathe([[0,0],[.054,0],[.060,.004],[.060,.009],[.052,.013],[0,.007]],mat('ceramic',0xe9ddbe)).scale.z=.7;
      box(.067,.023,.034,0,.019,0,mat('paint',0xe9ca75)).userData.butterBlock=true;for(let i=0;i<3;i++)box(.0006,.023,.035,-.015+i*.015,.019,0,mat('paint',0xc8a957));
    }else if(kind==='ashpan'){
      lathe([[0,0],[.083,0],[.087,.010],[.095,.046],[.090,.049],[.082,.012],[0,.008]],steel);
      tube([[-.026,.027,-.091],[-.026,.027,-.13],[.026,.027,-.13],[.026,.027,-.091]],.005,wood);
    }else if(kind==='brush'||kind==='rake'){
      box(.027,.022,.17,0,.023,.068,wood);for(const z of [.018,.12])rivet(0,.034,z);
      tube([[0,.023,-.017],[0,.03,-.10]],.004,steel);
      box(kind==='rake'?.075:.065,.012,.035,0,.020,-.11,kind==='rake'?steel:wood);
      if(kind==='rake')for(let i=0;i<5;i++)tube([[-.033+i*.0165,.02,-.115],[-.033+i*.0165,.004,-.145]],.0025,steel);
      else for(let i=0;i<9;i++)for(let j=0;j<4;j++)tube([[-.026+i*.0065,.015,-.097-j*.008],[-.026+i*.0065,.003,-.103-j*.008]],.0007,steel);
    }else if(['knife','spoon','tongs'].includes(kind)){
      box(.024,.016,.135,0,.014,.071,wood);for(const z of [.035,.103])rivet(0,.0225,z);
      if(kind==='knife'){
        const shape=new T.Shape();shape.moveTo(-.004,.012);shape.lineTo(-.022,-.10);shape.quadraticCurveTo(-.018,-.134,.004,-.145);shape.lineTo(.022,.012);shape.closePath();
        const blade=mesh(new T.ExtrudeGeometry(shape,{depth:.0018,bevelEnabled:true,bevelSegments:2,steps:1,bevelSize:.0006,bevelThickness:.0004}),steel,0,.013,0);blade.rotation.x=Math.PI/2;
        box(.030,.022,.010,0,.014,.005,steel);
      }else if(kind==='spoon'){
        tube([[0,.014,.02],[0,.018,-.025],[0,.01,-.06]],.005,wood);
        const bowl=lathe([[0,0],[.014,.001],[.025,.006],[.032,.014],[.032,.017],[.028,.013],[.02,.009],[0,.007]],wood,0,.002,-.09);bowl.scale.z=1.22;
      }else{
        for(const side of [-1,1]){
          tube([[side*.010,.013,.11],[side*.025,.016,.03],[side*.032,.016,-.065],[side*.025,.012,-.10]],.006,steel);
          const scallop=box(.024,.006,.047,side*.025,.011,-.101,steel);scallop.rotation.y=side*.12;
          for(let i=0;i<4;i++)box(.023,.002,.002,side*.025,.015,-.086-i*.009,steel);
        }
        const loop=mesh(new T.TorusGeometry(.016,.0024,8,24),steel,0,.015,.146);loop.rotation.x=Math.PI/2;
      }
    }else if(kind==='press'){
      lathe([[0,0],[.079,0],[.086,.004],[.086,.01],[.079,.015],[0,.015]],mat('iron',0x49514d));
      tube([[-.04,.014,0],[-.04,.058,0],[.04,.058,0],[.04,.014,0]],.008,steel);
      const handle=mesh(new T.CylinderGeometry(.013,.013,.088,24),wood,0,.067,0);handle.rotation.z=Math.PI/2;
    }else if(kind==='tray'){
      box(.25,.004,.32,0,.003,0,steel);
      for(const side of [-1,1]){box(.005,.017,.32,side*.123,.01,0,steel);box(.25,.017,.005,0,.01,side*.158,steel);}
      const rim=mat('steel',0xcbd0c9);for(const side of [-1,1])tube([[side*.126,.016,-.14],[side*.137,.024,-.11],[side*.137,.024,.11],[side*.126,.016,.14]],.003,rim);
    }else if(kind==='cloth'){
      const geo=new T.PlaneGeometry(.13,.17,18,22),p=geo.attributes.position;for(let i=0;i<p.count;i++)p.setZ(i,.003+Math.sin(p.getX(i)*75)*.002+Math.cos(p.getY(i)*44)*.0015);geo.computeVertexNormals();
      const fabric=mat('paint',0xded5bd);fabric.side=T.DoubleSide;fabric.roughness=1;fabric.clearcoat=0;const cloth=mesh(geo,fabric,0,.004,0);cloth.rotation.x=-Math.PI/2;
      for(const x of [-.05,.05])tube([[x,.009,-.075],[x+.001,.009,0],[x,.009,.075]],.0012,mat('paint',0x758e80));
    }else if(kind==='glove'){
      const shape=new T.Shape();shape.moveTo(-.04,-.07);shape.lineTo(.04,-.07);shape.lineTo(.047,.012);shape.bezierCurveTo(.075,.055,.041,.087,.022,.06);shape.bezierCurveTo(.027,.102,-.037,.099,-.044,.06);shape.closePath();
      const fabric=mat('paint',0x9c5b43);fabric.roughness=.98;fabric.clearcoat=0;
      const glove=mesh(new T.ExtrudeGeometry(shape,{depth:.013,steps:1,bevelEnabled:true,bevelSize:.006,bevelThickness:.005,bevelSegments:4}),fabric,0,.022,0);glove.rotation.x=Math.PI/2;
      for(let i=0;i<4;i++)tube([[-.034,.029,-.046+i*.024],[0,.031,-.038+i*.024],[.033,.029,-.032+i*.024]],.0008,mat('paint',0xe0ae8c));
      box(.084,.025,.022,0,.014,.064,mat('paint',0xd9bea0));
    }else if(['oil','water','ketchup','mayo','mustard'].includes(kind)){
      const colors={oil:0x718054,water:0x689296,ketchup:0xa34b36,mayo:0xe6d7ad,mustard:0xc2a041},sauce=['ketchup','mayo','mustard'].includes(kind);
      const body=mat(sauce?'paint':'ceramic',colors[kind]);body.roughness=sauce?.42:.2;
      lathe([[0,0],[.020,0],[.026,.008],[.026,.080],[.020,.099],[.012,.110],[.012,.119],[0,.119]],body);
      const cap=mat('rubber',0x35473e);lathe([[0,0],[.014,0],[.014,.013],[.008,sauce?.026:.014],[.003,sauce?.035:.025],[0,sauce?.035:.025]],cap,0,.116,0);
      badge(kind,.039,.023,0,.061,-.0265);
    }else if(kind==='lighter'){
      box(.028,.072,.020,0,.036,.055,mat('paint',0xa45b3e));tube([[0,.071,.055],[0,.083,.028],[0,.083,-.082]],.006,steel);box(.015,.007,.02,0,.074,.057,mat('rubber',0x2c3834));
    }else if(kind.startsWith('meat')){
      const tray=mat('paint',0xdfd5bd);box(.16,.010,.12,0,.008,0,tray);for(const x of [-.077,.077])box(.006,.02,.116,x,.013,0,tray);for(const z of [-.056,.056])box(.155,.02,.006,0,.013,z,tray);
      const meat=mat('paint',0xb96559);meat.map=A.texture('mince').map;meat.bumpMap=A.texture('mince').relief;meat.bumpScale=.0008;meat.roughness=.82;meat.clearcoat=0;
      box(.138,.026,.096,0,.023,0,meat);
      const strands=new T.InstancedMesh(new T.CylinderGeometry(.002,.002,.125,7),meat,24),dummy=new T.Object3D();
      for(let i=0;i<24;i++){dummy.position.set(0,.037+Math.sin(i*1.7)*.001,-.044+i*.0038);dummy.rotation.set(0,Math.sin(i)*.03,Math.PI/2);dummy.updateMatrix();strands.setMatrixAt(i,dummy.matrix);}strands.castShadow=true;g.add(strands);
      const b=badge(kind==='meatLean'?'90 / 10':kind==='meatRich'?'70 / 30':'80 / 20',.047,.020,.047,.047,-.052);b.rotation.x=-.22;
    }else if(['egg','tomato','pickles','onion'].includes(kind)){
      const radius=kind==='egg'?.029:kind==='pickles'?.024:.043,geo=new T.SphereGeometry(radius,40,28),pos=geo.attributes.position;
      for(let i=0;i<pos.count;i++){const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i),a=Math.atan2(z,x),f=kind==='tomato'?1+.035*Math.cos(a*6):kind==='onion'?1+.014*Math.cos(a*14):kind==='pickles'?1+.025*Math.sin(a*11+y*300):1-.12*y/radius;pos.setXYZ(i,x*f,y,z*f);}geo.computeVertexNormals();
      const m=mat('paint',{egg:0xddc2a0,tomato:0xb63f2e,pickles:0x64814a,onion:0xb7864b}[kind]);m.roughness=kind==='tomato'?.39:.77;m.clearcoat=kind==='tomato'?.16:0;
      const food=mesh(geo,m,0,kind==='egg'?.037:kind==='pickles'?.025:kind==='tomato'?.036:.039,0);food.scale.set(1,kind==='egg'?1.24:kind==='tomato'?.84:kind==='onion'?.9:1,kind==='pickles'?2.4:1);
      if(kind==='tomato')for(let i=0;i<5;i++){const a=i*Math.PI*2/5,leaf=mesh(new T.ConeGeometry(.006,.024,3),mat('paint',0x527146),Math.cos(a)*.008,.073,Math.sin(a)*.008);leaf.rotation.set(Math.sin(a)*.9,0,-Math.cos(a)*.9);}
      if(kind==='onion'){lathe([[0,0],[.009,0],[.004,.014],[0,.018]],m,0,.073,0);for(let i=0;i<12;i++){const a=i*Math.PI/6;tube([[Math.cos(a)*.011,.003,Math.sin(a)*.011],[Math.cos(a)*.005,0,Math.sin(a)*.005]],.0006,wood);}}
    }else{
      const paper=mat('paint',kind==='coal'?0x3d534c:0xaf8b59);paper.roughness=.95;paper.clearcoat=0;box(.12,.15,.073,0,.078,0,paper);box(.118,.012,.050,0,.158,0,paper);badge(kind==='coal'?'charcoal':'hickory',.086,.052,0,.084,-.037);
      for(const x of [-.045,.045])tube([[x,0,-.03],[x,.075,-.037],[x,.153,-.024]],.001,mat('paint',0x9b987e));
    }
    return g;
  }
  root.RealProps={build,decal};
})(window);
