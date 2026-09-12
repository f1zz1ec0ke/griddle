/* First-person practice: physical targets, assisted hands and independent cooking stations. */
(function(root){
  'use strict';
  const T=root.THREE,P=root.BurgerPhysics,VA=root.KitchenAssets,$=id=>document.getElementById(id),clamp=P.clamp;
  const LABELS={bunWhole:'whole bun',meat:'mince pack',pickles:'whole pickle',onion:'whole onion',cheeseBlock:'cheese block',tomatoSlice:'tomato slice',pickleSlice:'pickle slice',coal:'charcoal bag',press:'smash plate',glove:'oven glove'};
  class RealMode {
    constructor(game){
      this.game=game;this.canvas=$('view');this.renderer=game.vp.renderer;this.world=new root.RealKitchen.Kitchen();this.scene=new T.Scene();this.scene.background=new T.Color(0xc5dce0);this.scene.fog=new T.Fog(0xc5dce0,12,30);
      this.camera=new T.PerspectiveCamera(72,innerWidth/innerHeight,.025,40);this.scene.add(this.camera);
      this.keys=new Set();this.ray=new T.Raycaster();this.meshes=new Map();this.panTemplates=new Map();this.targets=[];this.surfaces=[];this.colliders=[];this.stations=new Map();this.held=null;this.left=false;this.active=false;this.paused=true;this.action=null;this.acc=0;this.clock=0;this.savedAt=0;this.velocityY=0;this.ground=0;this.look=new T.Vector2();
      this.buildRoom();this.buildStations();this.buildChef();this.bind();this.resize();
      this.airView={scene:this.scene,room:{userData:{windows:[]}}};root.BurgerRender.Viewport.prototype._buildRoomSmoke.call(this.airView);
      for(const cloud of this.airView.roomClouds){cloud.userData.y+=1.3;cloud.userData.x*=1.4;cloud.userData.z*=1.4;}
      this.renderEntities(0);
    }
    material(color,kind='paint'){return VA.material(kind,color);}
    box(w,h,d,x,y,z,color,kind='paint',parent=this.scene){const m=new T.Mesh(VA.roundedBox(w,h,d,Math.min(.018,Math.min(w,h,d)*.15),3),this.material(color,kind));m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;parent.add(m);return m;}
    ball(r,x,y,z,color,parent=this.scene){const m=new T.Mesh(new T.SphereGeometry(r,24,16),this.material(color));m.position.set(x,y,z);m.castShadow=true;parent.add(m);return m;}
    tube(points,r,color,parent=this.scene,kind='steel'){const m=new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p))),32,r,10,false),this.material(color,kind));m.castShadow=true;parent.add(m);return m;}
    label(text,x,y,z,size=.2,parent=this.scene){const c=document.createElement('canvas');c.width=512;c.height=128;const cx=c.getContext('2d');cx.fillStyle='#f7eed8';cx.fillRect(0,0,512,128);cx.fillStyle='#405749';cx.textAlign='center';cx.font='bold 42px Georgia';cx.fillText(text,256,81);const tx=new T.CanvasTexture(c);tx.encoding=T.sRGBEncoding;const m=new T.Mesh(new T.PlaneGeometry(size*4,size),new T.MeshBasicMaterial({map:tx}));m.position.set(x,y,z);parent.add(m);return m;}
    target(mesh,data){mesh.userData.realTarget=data;this.targets.push(mesh);return mesh;}
    surface(w,d,x,y,z,name){const m=this.box(w,.018,d,x,y-.009,z,0xe0ccb0,'stone');this.target(m,{type:'surface',name});this.surfaces.push({x,z,w,d,y});return m;}
    cabinet(w,d,x,z){this.box(w,.84,d,x,.46,z,0x709482);this.colliders.push({x,z,w,d,y:0,top:.92});this.surface(w+.04,d+.04,x,.93,z,'counter');for(let i=0;i<Math.ceil(w/.6);i++){const xx=x-w/2+(i+.5)*w/Math.ceil(w/.6);this.box(w/Math.ceil(w/.6)-.035,.69,.024,xx,.48,z-d/2-.02,0x648572);this.box(.15,.012,.025,xx,.75,z-d/2-.045,0xb89955,'steel');}}
    buildRoom(){
      this.scene.add(new T.HemisphereLight(0xfff6dc,0x587166,.6));const sun=new T.DirectionalLight(0xffedd1,1.2);sun.position.set(-3,7,4);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-6,right:6,top:6,bottom:-6,near:.1,far:20});sun.shadow.normalBias=.01;this.scene.add(sun);
      this.scene.environment=this.game.vp.scene.environment;
      this.target(this.box(8,.1,8,0,-.06,0,0xd4c5aa,'stone'),{type:'surface',name:'floor'});
      const tileGeo=new T.BoxGeometry(.497,.009,.497),tiles=new T.InstancedMesh(tileGeo,this.material(0xffffff,'stone'),256),dummy=new T.Object3D();let n=0;
      for(let x=0;x<16;x++)for(let z=0;z<16;z++){dummy.position.set(-3.75+x*.5,0,-3.75+z*.5);dummy.updateMatrix();tiles.setMatrixAt(n,dummy.matrix);tiles.setColorAt(n++,new T.Color((x+z)%2?0xaebba3:0xf0e4ce).convertSRGBToLinear());}tiles.receiveShadow=true;this.scene.add(tiles);
      for(const x of [-4,4])this.box(.1,3.2,8,x,1.6,0,0xe8deca);this.box(8,3.2,.1,0,1.6,-4,0xe8deca);
      for(const x of [-2.65,2.65])this.box(2.7,3.2,.1,x,1.6,4,0xe8deca);this.box(2.6,.9,.1,0,.45,4,0xe8deca);this.box(2.6,.65,.1,0,2.875,4,0xe8deca);
      this.box(8,.06,8,0,3.22,0,0xf3ead9);this.box(10,.04,8,0,-.04,8,0x729263);
      for(let i=0;i<9;i++){const b=this.ball(.5,-4+i, .6,7+(i%2),0x719456);b.scale.y=1.4;this.box(.11,1.8,.11,-4+i,.8,7+(i%2),0x88704a,'wood');}
      for(const x of [-1.3,1.3])this.box(.07,1.75,.13,x,1.75,4,0xfaf0d9);for(const y of [.9,2.6])this.box(2.7,.07,.13,0,y,4,0xfaf0d9);
      this.windowHinge=new T.Group();this.windowHinge.position.set(-1.25,.95,3.94);this.scene.add(this.windowHinge);
      const glass=new T.Mesh(new T.PlaneGeometry(2.5,1.6),new T.MeshPhysicalMaterial({color:0xc5e2df,transparent:true,opacity:.16,side:T.DoubleSide}));glass.position.set(1.25,.8,0);this.windowHinge.add(glass);this.target(glass,{type:'window',name:'garden window'});
      const handle=this.box(.035,.15,.05,2.36,.72,-.03,0xc3a668,'steel',this.windowHinge);this.target(handle,{type:'window',name:'window handle'});
      this.cabinet(4.65,.80,0,.95);this.cabinet(3.9,1.15,0,-.86);
      this.surface(.62,.46,0,.957,-.88,'chopping board').material=this.material(0xb58b57,'wood');
      this.boardTarget=this.target(this.box(.62,.025,.46,0,.946,-.88,0xb58b57,'wood'),{type:'board',name:'chopping board'});
      // A real open mixing bowl, placed beside the board.
      const profile=[[0,0],[.10,0],[.15,.025],[.185,.13],[.19,.15],[.18,.15],[.17,.12],[.14,.03],[.09,.013],[0,.013]].map(a=>new T.Vector2(...a));
      const bowl=new T.Mesh(new T.LatheGeometry(profile,64),this.material(0xbdc9c7,'steel'));bowl.position.set(-.72,.94,-.88);bowl.castShadow=true;this.scene.add(bowl);this.target(bowl,{type:'bowl',name:'mixing bowl'});
      this.mince=this.ball(.14,-.72,.985,-.88,0xa95048);this.mince.scale.y=.2;this.target(this.mince,{type:'bowl',name:'mixed mince'});
      this.label('PREP',0,1.05,-1.48,.09).rotation.y=Math.PI;
      // Separate rim, walls and bottom leave an actual opening in the worktop.
      this.box(1.2,.70,.7,2.6,.36,2.7,0x709482);this.colliders.push({x:2.6,z:2.7,w:1.2,d:.7,y:0,top:.93});
      for(const x of [2.135,3.065])this.surface(.31,.74,x,.93,2.7,'sink counter');for(const z of [2.425,2.975])this.surface(.62,.19,2.6,.93,z,'sink counter');
      const cavity=this.box(.58,.025,.37,2.6,.755,2.7,0x829590,'steel');this.target(cavity,{type:'sink',name:'sink'});
      for(const x of [2.3,2.9])this.target(this.box(.022,.18,.40,x,.835,2.7,0x9eaeaa,'steel'),{type:'sink',name:'sink'});
      for(const z of [2.5,2.9])this.target(this.box(.62,.18,.022,2.6,.835,z,0x9eaeaa,'steel'),{type:'sink',name:'sink'});
      const drain=new T.Mesh(new T.CylinderGeometry(.027,.027,.004,32),this.material(0x354b48,'steel'));drain.position.set(2.6,.77,2.7);this.scene.add(drain);
      this.tube([[2.84,.94,2.88],[2.84,1.22,2.88],[2.73,1.3,2.84],[2.6,1.23,2.76]],.016,0xbba064);this.target(this.box(.07,.025,.06,2.89,.99,2.87,0xbba064,'steel'),{type:'tap',name:'tap'});
      this.waterStream=this.box(.009,.44,.009,2.6,.998,2.76,0xb0d5d6);this.waterStream.visible=false;
      for(const x of [-3.73,-2.87])this.box(.05,1.95,.8,x,.98,1.7,0xefead6);for(const y of [.03,1.93])this.box(.85,.05,.8,-3.3,y,1.7,0xefead6);this.box(.85,1.9,.045,-3.3,.98,2.08,0xe1e8da);this.colliders.push({x:-3.30,z:1.7,w:.90,d:.8,y:0,top:2});
      for(const y of [.45,.85,1.25,1.65])this.box(.79,.02,.64,-3.30,y,1.67,0xffffff);
      this.fridgeDoor=new T.Group();this.fridgeDoor.position.set(-3.77,0,1.28);this.scene.add(this.fridgeDoor);this.target(this.box(.91,1.92,.055,.455,.98,0,0xf7f0dc,'paint',this.fridgeDoor),{type:'fridge',name:'fridge door'});this.target(this.box(.022,.45,.045,.82,1.2,-.04,0xbba064,'steel',this.fridgeDoor),{type:'fridge',name:'fridge handle'});
      const supplies=['meat','egg','bacon','bunWhole','tomato','pickles','onion','cheeseBlock','lettuce'];
      supplies.forEach((kind,i)=>{const m=this.prop(kind);m.position.set(-3.52+(i%3)*.23,.49+Math.floor(i/3)*.4,1.45);this.scene.add(m);m.traverse(o=>{if(o.isMesh)this.target(o,{type:'supply',kind,name:LABELS[kind]||kind});});});
      for(const x of [-2.9,-2.3])this.box(.04,1.1,.82,x,.55,-1.3,0x445951);this.box(.60,.14,.82,-2.6,.07,-1.3,0x445951);this.box(.60,.30,.82,-2.6,.95,-1.3,0x445951);this.box(.60,.66,.035,-2.6,.47,-.90,0x273430);this.colliders.push({x:-2.6,z:-1.3,w:.64,d:.82,y:0,top:1.1});
      this.ovenDoor=new T.Group();this.ovenDoor.position.set(-2.6,.14,-1.73);this.scene.add(this.ovenDoor);const ovenGlass=this.box(.59,.65,.028,0,.325,0,0x273430,'paint',this.ovenDoor);ovenGlass.material.transparent=true;ovenGlass.material.opacity=.45;this.target(ovenGlass,{type:'ovenDoor',name:'oven door'});this.target(this.box(.4,.026,.04,0,.59,-.04,0xc1a464,'steel',this.ovenDoor),{type:'ovenDoor',name:'oven handle'});
      this.target(this.box(.045,.045,.04,-2.78,.96,-1.746,0xbfa775,'steel'),{type:'ovenKnob',name:'oven temperature'});
      this.target(this.box(.48,.016,.65,-2.6,.53,-1.32,0xa4b1ab,'steel'),{type:'ovenRack',name:'oven rack'});
      this.label('OVEN',-2.52,.96,-1.757,.04);
      this.box(.50,.6,.5,2.75,.3,-2.8,0x64796b);this.target(this.box(.52,.025,.52,2.75,.61,-2.8,0x31483e),{type:'bin',name:'compost & waste'});
      this.target(this.box(.95,2.4,.055,2.7,1.2,-3.94,0xaf8759,'wood'),{type:'exit',name:'kitchen door'});this.label('TAKE A BREATHER',2.7,1.8,-3.9,.11);
      for(const x of [-1.5,0,1.5]){this.tube([[x,3.2,0],[x,2.65,0]],.006,0x403e35);const shade=new T.Mesh(new T.ConeGeometry(.22,.23,48,1,true),this.material(0xc5a469));shade.material.side=T.DoubleSide;shade.position.set(x,2.56,0);this.scene.add(shade);this.ball(.04,x,2.46,0,0xfff2cc);}
      for(const e of this.world.entities.filter(e=>e.home)){const pan=e.kind==='pan',rest=this.box(pan?.66:.19,.006,pan?.46:.21,e.home[0],e.home[1]-.009,e.home[2],pan?0x9eaea5:0x637e6b,pan?'steel':'paint');this.target(rest,{type:'rest',entity:e.id,name:(pan?e.label:LABELS[e.kind]||e.kind)+' rest'});}
      for(const x of [-2.77,-2.13])this.box(.022,1.8,.035,x,.9,3.34,0x819289,'steel');
    }
    buildStations(){
      for(const st of this.world.stations){
        const vp=new root.BurgerRender.Viewport(this.canvas,{renderer:this.renderer,textures:this.game.vp});vp.setStove(st.id==='oven'?'gas':st.id);vp.setMode('stove');vp.scene.background=null;vp.scene.fog=null;vp.scene.position.set(st.x,.94,st.z);this.scene.add(vp.scene);this.stations.set(st.id,vp);
        if(st.id==='oven'){vp.scene.position.set(-2.6,1.01,-.98);vp.stove.visible=false;vp.board.visible=false;vp.setPan('nonstick');const template=vp.panGroup.clone(true);template.position.y=-vp.PAN_Y;template.traverse(o=>{if(o.geometry)o.geometry=o.geometry.clone();if(o.material)o.material=o.material.clone();});this.panTemplates.set('nonstick',template);continue;}
        if(st.panId){vp.setPan(st.state.pan.id);const template=vp.panGroup.clone(true);template.position.y=-vp.PAN_Y;template.traverse(o=>{if(o.geometry)o.geometry=o.geometry.clone();if(o.material)o.material=o.material.clone();});this.panTemplates.set(st.state.pan.id,template);}
        if(st.id==='charcoal'){vp.scene.position.y=.55;this.box(.75,.51,.75,st.x,.255,st.z,0x536c5d);this.colliders.push({x:st.x,z:st.z,w:.8,d:.8,y:0,top:1.1});}
        this.target(vp.panMesh,{type:'station',id:st.id,name:st.id==='charcoal'?'grill grate':st.id+' pan'});
        if(vp.lid)vp.lid.traverse(o=>{if(o.isMesh)this.target(o,{type:'panLid',id:st.id,name:'pan lid'});});
        const area=new T.Mesh(new T.CylinderGeometry(st.id==='charcoal'?.27:.17,st.id==='charcoal'?.27:.17,.045,32),new T.MeshBasicMaterial({visible:false}));area.position.y=vp.panFloorY;vp.scene.add(area);this.target(area,{type:'station',id:st.id,name:st.id+' cooking surface'});
        if(vp.hobDial)vp.hobDial.traverse(o=>{if(o.isMesh)this.target(o,{type:'knob',id:st.id,name:st.id+' dial'});});
        if(st.id==='induction'){
          for(const [x,action] of [[.11,'power'],[.068,'down'],[-.112,'up']]){const b=this.box(.025,.006,.025,x,.944,-.218+st.z,0x303937);b.material.visible=false;b.position.x+=st.x;this.target(b,{type:'button',id:st.id,action,name:'induction '+action});}
        }
        if(st.id==='charcoal'){
          this.target(this.box(.045,.028,.045,st.x+.32,.71,st.z,0xb5a27b,'steel'),{type:'knob',id:st.id,name:'lower air intake'});
          if(vp.ventWheel)vp.ventWheel.traverse(o=>{if(o.isMesh)this.target(o,{type:'vent',id:st.id,name:'top vent'});});
          this.target(this.box(.07,.035,.05,st.x,.96,st.z-.31,0xb6975c,'wood'),{type:'grillLid',id:st.id,name:'kettle lid'});
        }
        this.label(st.id.toUpperCase(),st.x,.87,st.z-.44,.045);
      }
      // A render adapter for loose food uses the same established cooking meshes.
      this.looseView={scene:this.scene,panFloorY:.94,clock:0,claimTexBudget:()=>true,tinted:this.game.vp.tinted.bind(this.game.vp)};for(const k of ['noise','noiseFine','marble','marbleCut','spots','blotch'])this.looseView[k]=this.game.vp[k];
    }
    prop(kind){
      const g=new T.Group();const box=(w,h,d,x,y,z,c,k)=>this.box(w,h,d,x,y,z,c,k,g),ball=(r,x,y,z,c)=>this.ball(r,x,y,z,c,g);
      if(['spatula','tongs','spoon','knife','probe','press','cloth','glove','lid','tray'].includes(kind)){
        if(kind==='press'){box(.14,.012,.14,0,.008,0,0x788582,'steel');this.tube([[-.04,.02,0],[-.04,.07,0],[.04,.07,0],[.04,.02,0]],.009,0x9a754d,g,'wood');}
        else if(kind==='lid'){const m=ball(.14,0,0,0,0xa0b5b0);m.scale.y=.22;ball(.018,0,.046,0,0x493d31);}
        else if(kind==='tray'){box(.25,.015,.32,0,.01,0,0xbcc6bf,'steel');}
        else if(kind==='cloth'||kind==='glove'){box(.12,.018,.16,0,.01,0,kind==='glove'?0xb96043:0xead7b8);if(kind==='glove')ball(.028,-.055,.017,.025,0xb96043);}
        else {box(.025,.018,.14,0,.013,.08,0x9b704a,'wood');box(kind==='knife'?.026:kind==='probe'?.004:.065,.004,.12,0,.012,-.05,0xc5ceca,'steel');if(kind==='tongs')box(.012,.008,.22,.032,.017,0,0xb9c4bf,'steel');if(kind==='spoon'){const m=ball(.031,0,.012,-.09,0xb39160);m.scale.y=.20;}}
      }else if(['salt','oil','water','ketchup','mayo','mustard','lighter'].includes(kind)){
        const c={salt:0xeee0c2,oil:0xc4a53b,water:0x84b6c5,ketchup:0xb8482e,mayo:0xf2e5bc,mustard:0xcba42f,lighter:0xc87b45}[kind];box(.045,.11,.045,0,.055,0,c);box(.036,.017,.036,0,.116,0,0x685640);
      }else if(kind==='meat'){box(.16,.025,.12,0,.015,0,0xf0dec4);const m=ball(.07,0,.04,0,0xa95349);m.scale.set(1,.35,.7);}
      else if(kind==='egg'){const m=ball(.03,0,.033,0,0xe4c69d);m.scale.y=1.25;}
      else if(kind==='tomato'){const m=ball(.045,0,.036,0,0xbe4430);m.scale.y=.8;ball(.01,0,.075,0,0x527045);}
      else if(kind==='pickles'){const m=ball(.025,0,.028,0,0x718445);m.scale.z=2.4;}
      else if(kind==='onion'){ball(.043,0,.04,0,0xb69771);}
      else if(kind==='bunWhole'){const m=ball(.055,0,.028,0,0xc99a50);m.scale.y=.55;}
      else if(kind==='cheeseBlock'||kind==='cheese')box(.095,kind==='cheeseBlock'?.045:.003,.085,0,.01,0,0xeac759);
      else if(kind==='tomatoSlice'||kind==='pickleSlice'){const m=new T.Mesh(new T.CylinderGeometry(kind==='tomatoSlice'?.04:.025,kind==='tomatoSlice'?.04:.025,.005,40),this.material(kind==='tomatoSlice'?0xc3472f:0x87a15a));m.position.y=.004;g.add(m);for(let i=0;i<5;i++){const a=i*1.26;const seed=ball(.004,Math.cos(a)*.015,.008,Math.sin(a)*.015,0xd4c888);seed.scale.y=.15;}}
      else if(kind==='lettuce'){const m=ball(.045,0,.008,0,0x7b9f53);m.scale.set(1.2,.15,1);}
      else if(kind==='coal'||kind==='wood')box(.12,.17,.07,0,.085,0,kind==='coal'?0x49554c:0xa0764b,'wood');
      else box(.065,.025,.08,0,.012,0,0xd5ad74);
      return g;
    }
    buildChef(){
      this.body=new T.Group();this.scene.add(this.body);const torso=this.ball(.28,0,1.12,.035,0xece0c8,this.body);torso.scale.set(.78,1.05,.53);const belly=this.ball(.24,0,.94,-.08,0xf0e5ce,this.body);belly.scale.set(1,.9,.85);const apron=this.ball(.235,0,.94,-.09,0x547b67,this.body);apron.scale.set(.92,.87,.86);
      for(const x of [-.12,.12]){this.box(.14,.61,.16,x,.43,0,0x424c43,'paint',this.body);this.box(.15,.10,.27,x,.055,-.065,0x343b34,'rubber',this.body);}
      this.arms=[];
      for(const side of [-1,1]){
        const arm=new T.Group();this.camera.add(arm);
        const limb=(r1,r2,color)=>{const geo=new T.CylinderGeometry(r1,r2,.25,24);geo.rotateX(Math.PI/2);const m=new T.Mesh(geo,this.material(color));arm.add(m);return m;};
        const upper=limb(.059,.052,0xeee2c9),fore=limb(.042,.030,0xbd886b),hand=new T.Group();arm.add(hand);const palm=this.ball(.041,0,0,0,0xc48f72,hand);palm.scale.set(1,.45,1.15);
        const fingers=[];
        for(let i=0;i<4;i++){const f=this.ball(.010,(i-1.5)*.019,-.002,-.045,0xc48f72,hand);f.scale.set(.85,.85,2.8-Math.abs(i-1.5)*.35);f.rotation.x=.2;fingers.push(f);const nail=this.ball(.0065,(i-1.5)*.019,.005,-.061,0xdab39a,hand);nail.scale.set(.9,.18,1.3);}
        const thumb=this.ball(.014,side*-.037,-.002,-.015,0xc48f72,hand);thumb.scale.set(.9,.8,1.9);thumb.rotation.y=side*.6;
        const cuff=this.box(.116,.12,.05,0,0,.10,0xe9ddc4,'paint',upper);
        this.arms.push({side,upper,fore,hand,fingers,position:new T.Vector3(side*.22,-.23,-.44)});
      }
      this.heldAnchor=new T.Group();this.arms[1].hand.add(this.heldAnchor);this.heldAnchor.position.set(0,.02,-.04);this.heldAnchor.rotation.x=-.45;
      this.portionMesh=this.ball(.045,0,.025,-.04,0xa65349,this.heldAnchor);this.portionMesh.material.bumpMap=VA.texture('mince').relief;this.portionMesh.material.bumpScale=.001;
      for(const g of [this.body,...this.arms.map(a=>a.hand)])g.traverse(o=>{if(o.material){o.material.roughness=.9;o.material.clearcoat=0;}});
    }
    bind(){
      const gate=e=>this.active&&document.body.dataset.experience==='real';
      window.addEventListener('keydown',e=>{if(!gate(e))return;e.stopImmediatePropagation();if(['KeyW','KeyA','KeyS','KeyD','Space','ControlLeft','ControlRight','ShiftLeft','ShiftRight'].includes(e.code))e.preventDefault();if(e.code==='Escape'){this.pause();return;}if(!this.paused)this.keys.add(e.code);},true);
      window.addEventListener('keyup',e=>{if(gate(e)){e.stopImmediatePropagation();this.keys.delete(e.code);}},true);
      window.addEventListener('blur',()=>{if(this.active)this.pause();});document.addEventListener('visibilitychange',()=>{if(document.hidden&&this.active)this.pause();});
      document.addEventListener('pointerlockchange',()=>{if(this.active&&document.pointerLockElement!==this.canvas)this.pause();});
      this.canvas.addEventListener('pointermove',e=>{if(!gate(e)||this.paused)return;e.stopImmediatePropagation();if(this.left&&this.grabControl){this.turn(this.grabControl,e.movementX);return;}this.world.player.yaw-=e.movementX*.0022;this.world.player.pitch=clamp(this.world.player.pitch-e.movementY*.0022,-1.43,1.35);},true);
      this.canvas.addEventListener('pointerdown',e=>{if(!gate(e))return;e.preventDefault();e.stopImmediatePropagation();if(this.paused)return;if(e.button===2)this.toggleGrab();else if(e.button===0){this.left=true;this.use();}},true);
      window.addEventListener('pointerup',e=>{if(gate(e)){e.stopImmediatePropagation();if(e.button===0){this.left=false;this.grabControl=null;}}},true);
      this.canvas.addEventListener('contextmenu',e=>{if(gate(e)){e.preventDefault();e.stopImmediatePropagation();}},true);
      this.canvas.addEventListener('wheel',e=>{if(gate(e)){e.preventDefault();e.stopImmediatePropagation();}},{capture:true,passive:false});
      window.addEventListener('resize',()=>this.resize());
    }
    resize(){this.camera.aspect=innerWidth/innerHeight;this.camera.updateProjectionMatrix();if(this.active)this.renderer.setSize(innerWidth,innerHeight,false);}
    start(resume=false){
      if(resume){try{const raw=localStorage.getItem('griddle.real.v1');if(!raw){$('choose-status').textContent='No Real kitchen saved yet.';return;}this.load(JSON.parse(raw));}catch(e){$('choose-status').textContent='Could not load this kitchen. Your saved file was kept.';return;}}
      this.active=true;document.body.dataset.experience='real';$('mode-choice').hidden=true;$('real-hud').hidden=false;this.resize();this.move(0);this.pause();this.last=performance.now();if(!this.running){this.running=true;requestAnimationFrame(t=>this.frame(t));}
    }
    resume(){this.canvas.requestPointerLock()?.catch(()=>{this.pause();this.toast('Click Resume again to let the mouse control your view.');});this.game.audio.start();this.paused=false;$('real-pause').hidden=true;}
    pause(){this.paused=true;this.left=false;this.grabControl=null;this.keys.clear();this.game.audio.stop();if(document.pointerLockElement===this.canvas)document.exitPointerLock();if(this.active)$('real-pause').hidden=false;this.save();}
    save(){try{this.world.heldId=this.held;localStorage.setItem('griddle.real.v1',JSON.stringify(this.world.snapshot()));$('real-save-status').textContent='Kitchen saved.';}catch(e){$('real-save-status').textContent='Save unavailable—keep this tab open.';}}
    load(data){
      const next=root.RealKitchen.Kitchen.restore(data);for(const r of this.meshes.values()){if(r.view){r.mesh.parent?.remove(r.mesh);r.view.dispose();}else this.dispose(r.mesh);}this.meshes.clear();this.world=next;this.held=next.heldId||null;this.ground=0;this.velocityY=0;this.action=null;this.left=false;this.grabControl=null;this.keys.clear();this.acc=0;
    }
    leave(){this.pause();this.active=false;document.body.dataset.experience='choose';$('real-pause').hidden=true;$('real-hud').hidden=true;$('mode-choice').hidden=false;}
    dispose(mesh){mesh.parent?.remove(mesh);mesh.traverse(o=>{o.geometry?.dispose();for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[]){for(const k of ['map','bumpMap','roughnessMap'])if(m[k]&&!VA.shared.has(m[k]))m[k].dispose();m.dispose();}});}
    toast(text){$('real-toast').textContent=text;$('real-toast').hidden=false;this.toastUntil=performance.now()+3200;}
    heldEntity(){return this.world.get(this.held);}
    focus(){
      this.scene.updateMatrixWorld(true);this.ray.setFromCamera(new T.Vector2(0,0),this.camera);this.ray.far=1.75;
      const candidates=this.targets.filter(o=>{let q=o;while(q){if(!q.visible)return false;if(q===this.scene)return true;q=q.parent;}return false;});
      const hits=this.ray.intersectObjects(candidates,false);
      for(const hit of hits){const d=hit.object.userData.realTarget;if(!d)continue;if(d.entity===this.held)continue;if(d.type==='supply'&&!this.world.doors.fridge)continue;return {data:d,point:hit.point,object:hit.object};}return null;
    }
    turn(d,dx){const st=this.world.station(d.id);if(d.type==='ovenKnob'){const oven=this.world.station('oven').state;this.ovenDrag=clamp((this.ovenDrag??oven.oven.target)+dx*1.5,0,250);P.setOven(oven,this.ovenDrag<40?0:this.ovenDrag);return;}if(d.type==='vent')P.setTopVent(st.state,clamp(st.state.grill.topVent+dx*.008,0,1));else P.setKnob(st.state,clamp(st.state.stove.knob+dx*.035,0,10));}
    animate(kind,fn,duration=.65){if(this.action)return;this.action={kind,time:0,duration,fn,done:false};}
    hot(e){if(e.kind==='pan')return (e.pan.Tcenter||e.pan.T)>55;if(e.kind==='tray')return (e.trayT||21)>55;return e.food?(e.kind==='patty'?P.centerT(e.food):P.itemT(e.food))>55:false;}
    blocked(e){if(e?.station==='oven'&&!this.world.doors.oven)return 'Open the oven first.';if(e?.food&&(e.station||e.panCarrier)&&this.world.owner(e).lid)return 'Lift the lid first.';return null;}
    toggleGrab(){
      if(this.action)return;const h=this.heldEntity(),t=this.hover;
      if(h){if(!t){this.toast('Look at a counter, tool rest or cooking surface.');return;}
        const food=this.foodAt(t),pan=t.data.type==='station'?this.world.get(this.world.station(t.data.id).panId):food,picked=h.kind==='glove'?pan:food;
        if(!h.payload&&picked&&((h.kind==='glove'&&['pan','tray'].includes(picked.kind))||(h.kind==='spatula'&&['patty','egg','bun'].includes(picked.kind))||(h.kind==='tongs'&&picked.kind==='bacon')||(h.kind==='spoon'&&picked.kind==='onions'))){if(picked.kind!=='pan'&&picked.station&&this.world.owner(picked).lid){this.toast('Lift the lid first.');return;}this.carry(h,picked);return;}
        this.placeHeld(t);return;}
      if(!t)return;const d=t.data;
      if(d.type==='bowl'&&this.world.portion.mass>0){this.world.scoop(25/90,true);return;}
      if(this.world.portion.mass>0){this.toast('Shape the mince on the board, or return it to the bowl first.');return;}
      if(d.type==='supply'){const e=this.world.addIngredient(d.kind,t.point.toArray());this.pick(e);return;}
      if(d.type==='panLid'){const lid=this.world.entities.find(e=>e.kind==='lid'&&e.station===d.id);if(lid)this.pick(lid);return;}
      let e=d.entity?this.world.get(d.entity):null;if(d.type==='rest')return;if(e?.stackRoot)e=this.world.get(e.stackRoot);
      if(d.type==='station'){const st=this.world.station(d.id);e=this.world.get(st.panId);}
      if(!e)return;
      if(this.hot(e)){this.animate('retract',()=>{},.5);this.toast('Hot! Pick up the oven glove first.');return;}
      this.pick(e);
    }
    pick(e){const error=this.blocked(e);if(error){this.toast(error);return;}if(e.kind==='lid'&&(e.station||e.panCarrier)){if(e.panCarrier){const pan=this.world.get(e.panCarrier);pan.parked.lid=false;pan.lidId=null;e.panCarrier=null;}else this.world.station(e.station).state.lid=false;e.station=null;}else if(e.kind==='pan')this.world.liftPan(e);else if(e.kind==='tray')this.world.liftTray(e);else this.world.detach(e);e.held=true;this.held=e.id;this.animate('grab',()=>{},.35);}
    carry(tool,e){const error=this.blocked(e);if(error){this.toast(error);return;}if(e.kind==='pan')this.world.liftPan(e);else if(e.kind==='tray')this.world.liftTray(e);else this.world.detach(e);tool.payload=e.id;e.held=true;this.animate('grab',()=>{},.4);}
    placeHeld(t){
      const tool=this.heldEntity(),e=tool?.payload?this.world.get(tool.payload):tool,d=t.data;if(!e)return;
      const release=()=>{e.held=false;if(tool.payload)tool.payload=null;else this.held=null;};
      if(d.type==='entity'){const target=this.world.get(d.entity);if(target&&(target.kind==='tray'?this.world.putOnTray(e,target):this.world.assemble(e,target))){release();return;}}
      if(d.type==='rest'){const original=this.world.get(d.entity);if(original?.id===e.id){e.pos=e.home.slice();release();return;}this.toast('That rest belongs to another tool.');return;}
      if(d.type==='bin'){if(e.home||e.kind==='pan'){this.toast('Keep the cookware—return it to a counter or its rest.');return;}this.world.discard(e);release();return;}
      if(d.type==='station'||d.type==='ovenRack'){
        const id=d.type==='ovenRack'?'oven':d.id;
        if(e.kind==='tray'&&id==='oven'){const error=this.world.ovenTray(e);if(error){this.toast(error);return;}}
        else if(e.kind==='pan'){const error=this.world.dockPan(e,id);if(error){this.toast(error);return;}}
        else if(e.food){const error=this.world.placeFood(e,id);if(error){this.toast(error);return;}}
        else{this.toast('Left click to use that here, or put it on a counter.');return;}
        release();return;
      }
      if(!['surface','board','sink'].includes(d.type)){this.toast('Place it on a counter or its tool rest.');return;}
      e.pos=[t.point.x,t.point.y+.008,t.point.z];release();
      if(e.home&&Math.hypot(e.pos[0]-e.home[0],e.pos[2]-e.home[2])<.18)e.pos=e.home.slice();
      const support=this.surfaces.find(s=>Math.abs(e.pos[0]-s.x)<=s.w/2&&Math.abs(e.pos[2]-s.z)<=s.d/2);
      if(support){const mx=support.w/2-Math.abs(e.pos[0]-support.x),mz=support.d/2-Math.abs(e.pos[2]-support.z);if(Math.min(mx,mz)<(e.kind==='pan'?.07:.012)){e.fall=.03;e.slide=mx<mz?[Math.sign(e.pos[0]-support.x),0]:[0,Math.sign(e.pos[2]-support.z)];}}
    }
    foodAt(t){if(!t)return null;if(t.data.entity){const e=this.world.get(t.data.entity);return e?.stackRoot?this.world.get(e.stackRoot):e;}if(t.data.type==='station')return this.world.entities.find(e=>e.station===t.data.id&&e.kind!=='pan'&&e.food&&!e.discarded);return null;}
    use(){
      if(this.action)return;const t=this.hover,h=this.heldEntity();if(!t)return;const d=t.data,e=this.foodAt(t);
      if(d.type==='sink'){const washing=h?.payload?this.world.get(h.payload):h;if(washing?.kind==='pan'){if(!this.world.doors.tap){this.toast('Turn on the tap first.');return;}this.animate('wash',()=>this.toast(P.washPan(washing.parked||this.world.owner(washing))?'Pan washed.':'Empty the pan before washing it.'));return;}}
      if(['knob','ovenKnob','vent'].includes(d.type)){this.grabControl=d;this.ovenDrag=null;return;}
      if(d.type==='button'){const s=this.world.station(d.id).state;P.setKnob(s,d.action==='power'?(s.stove.knob?0:5):clamp(s.stove.knob+(d.action==='up'?1:-1),0,10));this.animate('press',()=>{},.25);return;}
      const toggles={fridge:'fridge',ovenDoor:'oven',window:'window',tap:'tap'};if(toggles[d.type]){this.world.doors[toggles[d.type]]=!this.world.doors[toggles[d.type]];this.animate('reach',()=>{},.35);return;}
      if(d.type==='exit'){this.pause();return;}
      if(d.type==='grillLid'){P.toggleLid(this.world.station('charcoal').state);this.animate('reach',()=>{},.5);return;}
      if(d.type==='panLid'){if(!h){const lid=this.world.entities.find(e=>e.kind==='lid'&&e.station===d.id);if(lid)this.pick(lid);}else this.toast('Put the tool down and lift the lid.');return;}
      if(this.blocked(e)){this.toast(this.blocked(e));return;}
      if(d.type==='bowl'){
        if(h?.kind==='meat'){this.animate('pour',()=>{this.world.bowl.mass+=500;h.discarded=true;this.held=null;});return;}
        if(h?.kind==='spoon'||h?.kind==='salt'||!h)return;
        this.toast('Add mince and salt, mix with the spoon, or hold left click with an empty hand to portion.');return;
      }
      if(d.type==='board'&&!h&&this.world.portion.mass>=25){this.animate('form',()=>{this.world.form([t.point.x,t.point.y+.01,t.point.z]);},1.2);return;}
      if(h?.kind==='knife'&&e){if(e.station||e.held){this.toast('Put it on the chopping board first.');return;}if(e.kind==='patty'){this.animate('slice',()=>{P.peek(this.world.owner(e),e.food);e.cut=true;this.toast(P.donenessOf(P.centerT(e.food)).label+' · '+Math.round(P.centerT(e.food))+' °C at the centre');});}else this.animate('slice',()=>this.world.slice(e),.9);return;}
      if(h&&['ketchup','mayo','mustard'].includes(h.kind)&&e){this.animate('pour',()=>{if(!this.world.assemble(h,e))this.toast('Build a bun and patty first.');});return;}
      if(h?.kind==='glove'){
        const pan=d.type==='station'?this.world.get(this.world.station(d.id).panId):e;
        if(pan&&['pan','tray'].includes(pan.kind)&&!h.payload)this.carry(h,pan);return;
      }
      if(e?.food&&h){
        const s=this.world.owner(e);
        if(s.lid&&e.station){this.toast('Lift the lid first.');return;}
        if(h.kind==='spatula'&&['patty','egg','bun'].includes(e.kind)||h.kind==='tongs'&&e.kind==='bacon'||h.kind==='spoon'&&e.kind==='onions'){
          if(e.station==='oven'){this.toast('Right click to lift it from the rack.');return;}
          this.animate(e.kind==='onions'?'stir':'flip',()=>{if(e.kind==='patty')P.flipPatty(s,e.food);else P.flipItem(s,e.food);});return;
        }
        if(h.kind==='press'&&e.kind==='patty'){this.animate('smash',()=>P.pressPatty(s,true,e.food),1.0);return;}
        if(h.kind==='probe'){this.animate('probe',()=>this.toast(Math.round(e.kind==='patty'?P.centerT(e.food):P.itemT(e.food))+' °C'),.65);return;}
        if(h.kind==='cheese'&&e.kind==='patty'){if(P.addCheese(s,e.food)){h.discarded=true;this.held=null;}else this.toast('Cheese goes on a patty on the heat (up to four slices).');return;}
        if(h.kind==='salt')return;
      }
      if(d.type==='station'){
        const st=this.world.station(d.id),s=st.state;
        if(h?.kind==='egg'){this.animate('crack',()=>{h.kind='egg';this.world.makeFood(h,'egg');const error=this.world.placeFood(h,d.id);if(error)this.toast(error);else this.held=null;},.9);return;}
        if(h?.kind==='lighter'&&s.grill){s.grill.lit=true;s.grill.Tfire=Math.max(s.grill.Tfire,400);P.setKnob(s,5);this.animate('press',()=>{},.35);return;}
        if(h?.kind==='coal'&&s.grill){P.addCoals(s,.25);this.animate('pour',()=>{});return;}
        if(h?.kind==='wood'&&s.grill){P.addWood(s,'hickory');this.animate('grab',()=>{});return;}
        if(h?.kind==='spoon'&&s.grill){this.animate('stir',()=>P.stirCoals(s));return;}
        if(h?.kind==='cloth'){this.animate('wipe',()=>P.wipeStove(s));return;}
        if(h?.kind==='lid'){s.lid=true;h.station=d.id;h.held=false;this.held=null;this.animate('reach',()=>{});return;}
        if(h?.food){this.animate('place',()=>{const error=this.world.placeFood(h,d.id);if(error)this.toast(error);else this.held=null;});return;}
        if(['oil','water'].includes(h?.kind))return;
      }
      if(d.type==='board'&&h?.kind==='knife'){const q=this.world.entities.find(q=>!q.discarded&&!q.held&&Math.hypot(q.pos[0],q.pos[2]+.88)<.4&&['tomato','pickles','onion','bunWhole','cheeseBlock'].includes(q.kind));if(q)this.animate('slice',()=>this.world.slice(q),.9);return;}
      if(!h&&e&&this.world.portion.mass>0){this.toast('Form your portion on the board first.');return;}
      if(!h&&d.type==='surface'&&this.world.portion.mass>=25)this.animate('form',()=>this.world.form([t.point.x,t.point.y+.01,t.point.z]),1.2);
    }
    continuous(dt){
      const h=this.heldEntity(),t=this.hover;if(!this.left||!t||this.action||this.grabControl)return;const d=t.data;
      if(d.type==='bowl'){
        if(!h)this.world.scoop(dt,this.keys.has('ControlLeft')||this.keys.has('ControlRight'));
        else if(h.kind==='spoon')this.world.bowl.work=clamp(this.world.bowl.work+dt*.025,0,1);
        else if(h.kind==='salt')this.world.bowl.salt+=dt*.6;
      }
      const e=this.foodAt(t);if(this.blocked(e))return;if(h?.kind==='salt'&&e?.kind==='patty'){e.salt=(e.salt||0)+dt*.6;if(e.food.salt==='none'){e.food.salt='surface';e.food.whc0+=.02;}}
      const stationId=d.type==='station'?d.id:e?.station;
      if(stationId&&h){const st=this.world.station(stationId),s=st.state;if(s.lid||!st.panId)return;if(h.kind==='oil'&&!s.grill)P.addFat(s,'canola',dt*5);if(h.kind==='water'&&!s.grill)root.BurgerPanWater.add(s.pan,dt*.02,21);}
    }
    move(dt){
      const p=this.world.player,crouch=this.keys.has('ControlLeft')||this.keys.has('ControlRight'),height=crouch?1.06:1.72,speed=(this.keys.has('ShiftLeft')||this.keys.has('ShiftRight')?2.7:1.55)*(crouch?.55:1);
      let x=(this.keys.has('KeyD')?1:0)-(this.keys.has('KeyA')?1:0),z=(this.keys.has('KeyS')?1:0)-(this.keys.has('KeyW')?1:0),length=Math.hypot(x,z)||1;x/=length;z/=length;if(this.grabControl)x=z=0;
      const dx=(x*Math.cos(p.yaw)+z*Math.sin(p.yaw))*speed*dt,dz=(-x*Math.sin(p.yaw)+z*Math.cos(p.yaw))*speed*dt;
      if(this.keys.has('Space')&&p.y<=this.ground+.001){this.velocityY=3.4;this.keys.delete('Space');}
      this.velocityY-=9.8*dt;const oldY=p.y;p.y+=this.velocityY*dt;this.ground=0;
      for(const c of this.colliders)if(Math.abs(p.x-c.x)<c.w/2+.15&&Math.abs(p.z-c.z)<c.d/2+.15&&oldY>=c.top-.01&&p.y<=c.top&&this.velocityY<0)this.ground=Math.max(this.ground,c.top);
      if(p.y<this.ground){p.y=this.ground;this.velocityY=0;}
      const blocked=(xx,zz)=>this.colliders.some(c=>p.y<c.top-.03&&p.y+height>c.y&&Math.abs(xx-c.x)<c.w/2+.20&&Math.abs(zz-c.z)<c.d/2+.20);
      if(!blocked(p.x+dx,p.z))p.x=clamp(p.x+dx,-3.75,3.75);if(!blocked(p.x,p.z+dz))p.z=clamp(p.z+dz,-3.75,3.75);
      this.eyeHeight=(this.eyeHeight??1.72)+(height-(this.eyeHeight??1.72))*Math.min(1,dt*12);
      const lean=.14+Math.max(0,-p.pitch-.4)*.20;
      this.camera.position.set(p.x-Math.sin(p.yaw)*lean,p.y+this.eyeHeight,p.z-Math.cos(p.yaw)*lean);this.camera.rotation.set(p.pitch,p.yaw,0,'YXZ');this.body.position.set(p.x,p.y,p.z);this.body.rotation.y=p.yaw;this.body.scale.y=crouch?.72:1;
    }
    renderEntities(dt){
      for(const e of this.world.entities){
        if(['pan','lid'].includes(e.kind)&&e.station){const r=this.meshes.get(e.id);if(r)r.mesh.visible=false;continue;}
        let rec=this.meshes.get(e.id);
        if(e.discarded){if(rec){if(rec.view){rec.mesh.parent?.remove(rec.mesh);rec.view.dispose();}else this.dispose(rec.mesh);this.meshes.delete(e.id);}continue;}
        if(e.food&&e.station){if(rec){rec.mesh.visible=false;}continue;}
        if(rec&&rec.food!==e.food){if(rec.view){rec.mesh.parent?.remove(rec.mesh);rec.view.dispose();}else this.dispose(rec.mesh);this.meshes.delete(e.id);rec=null;}
        if(!rec){let mesh,view;
          if(e.food&&e.kind!=='pan'){view=e.kind==='patty'?new root.BurgerRender.PattyView(this.looseView,e.food):new root.BurgerRender.ItemView(this.looseView,e.food);mesh=view.group;}
          else if(e.kind==='pan'){const pan=this.panTemplates.get(e.panType).clone(true);mesh=new T.Group();mesh.add(pan);mesh.traverse(o=>{if(o.geometry)o.geometry=o.geometry.clone();if(o.material)o.material=o.material.clone();});this.scene.add(mesh);}
        else{mesh=this.prop(e.stackRoot&&['mayo','ketchup','mustard'].includes(e.kind)?'cheese':e.kind);if(e.stackRoot&&['mayo','ketchup','mustard'].includes(e.kind))mesh.traverse(o=>{if(o.material)o.material.color.setHex({mayo:0xf1dfb2,ketchup:0xb44227,mustard:0xc9a435}[e.kind]).convertSRGBToLinear();});this.scene.add(mesh);}
          rec={mesh,view,food:e.food};this.meshes.set(e.id,rec);mesh.traverse(o=>{if(o.isMesh)this.target(o,{type:'entity',entity:e.id,name:LABELS[e.kind]||e.label});});
        }
        const m=rec.mesh;m.visible=true;
        if(e.fall&&!e.held){if(e.slide){e.pos[0]+=e.slide[0]*dt*.9;e.pos[2]+=e.slide[1]*dt*.9;}e.fall+=9.8*dt;e.pos[1]-=e.fall*dt;m.rotation.z=Math.min(.7,m.rotation.z+dt*2);if(e.pos[1]<.035){e.pos[1]=.035;e.fall=0;e.slide=null;}}
        if(rec.view){if(e.kind==='patty'){if(rec.view.cutaway!==!!e.cut)rec.view.setCutaway(!!e.cut,0);rec.view.update(this.world.owner(e),dt,'rest',{x:e.pos[0],y:e.pos[1],z:e.pos[2]},'stove');}else rec.view.update(this.world.owner(e),dt,'rest',{x:e.pos[0],y:e.pos[1],z:e.pos[2]},'stove');}
        if(e.panCarrier){const panMesh=this.meshes.get(e.panCarrier)?.mesh;if(panMesh){panMesh.add(m);if(e.kind==='lid')m.position.set(0,.035,0);else m.position.set(e.food.pos.x,.012,e.food.pos.y);}continue;}
        if(e.trayCarrier&&!e.station){const tray=this.world.get(e.trayCarrier),trayMesh=this.meshes.get(tray.id)?.mesh;if(trayMesh){const n=tray.cargo.indexOf(e.id);trayMesh.add(m);m.position.set(n%2?.06:-.06,.024,n<2?-.075:.075);}continue;}
        if(e.held){if(m.parent!==this.heldAnchor)this.heldAnchor.add(m);m.position.set(0,this.heldEntity()?.payload===e.id?.04:0,-.04);m.scale.setScalar(e.kind==='pan'?.85:1);}
        else {if(m.parent!==this.scene)this.scene.add(m);m.position.set(...e.pos);m.scale.setScalar(1);}
      }
      for(const st of this.world.stations){const vp=this.stations.get(st.id);
        if(st.panId&&vp.panSpec.id!==st.state.pan.id)vp.setPan(st.state.pan.id);
        if(vp.lid)vp.lid.traverse(o=>{if(o.isMesh&&!o.userData.realTarget)this.target(o,{type:'panLid',id:st.id,name:'pan lid'});});
        vp.update(st.state,dt,0);if(st.id==='oven')vp.stove.visible=false;
        if(st.id!=='charcoal')vp.panGroup.visible=!!st.panId;
        for(const e of this.world.entities.filter(e=>e.station===st.id&&e.food&&e.kind!=='pan')){
          const v=e.kind==='patty'?vp.views.get(e.food):vp.itemViews.get(e.food);if(v){v.group.traverse(o=>{if(o.isMesh&&!o.userData.realTarget)this.target(o,{type:'entity',entity:e.id,name:e.label});});const w=v.group.getWorldPosition(new T.Vector3());e.pos=[w.x,w.y,w.z];}
        }
      }
      for(const root of this.world.entities.filter(e=>!e.discarded&&e.kind==='patty'&&e.food.assembly?.length)){
        const layers=root.food.assembly,parts=layers.map((l,i)=>l.patty?this.world.entities.find(e=>e.food===(l.meat||root.food)):l.item?this.world.entities.find(e=>e.food===l.item):this.world.entities.find(e=>e.stackRoot===root.id&&e.layer===i));
        const heights=layers.map((l,i)=>l.patty?(l.meat||root.food).h+(l.meat||root.food).cheeses.length*.0015:l.item?this.meshes.get(parts[i]?.id)?.view?.layerH()||.01:window.BurgerAssembly.cold[l.cold].height||.004);
        const layout=window.BurgerAssembly.stackLayout(root.food,P,heights);let y=0;
        for(let i=0;i<parts.length;i++){const part=parts[i],rec=this.meshes.get(part?.id);if(rec){
          if(root.held){this.heldAnchor.add(rec.mesh);rec.mesh.position.set(0,.04+y,-.04);}else{this.scene.add(rec.mesh);rec.mesh.position.set(root.pos[0],root.pos[1]+y,root.pos[2]);}
          rec.mesh.scale.y=layout[i].scale;if(part!==root)part.pos=[root.pos[0],root.pos[1]+y,root.pos[2]];
          if(root.cut&&part!==root){if(!rec.clip){rec.clip=new T.Plane(new T.Vector3(0,0,1),-root.pos[2]);rec.mesh.traverse(o=>{if(o.material){o.material.clippingPlanes=[rec.clip];o.material.needsUpdate=true;}});}rec.clip.constant=-root.pos[2];}
        }y+=heights[i]*layout[i].scale;}
      }
      this.targets=this.targets.filter(o=>o.parent);
      this.fridgeDoor.rotation.y+=((this.world.doors.fridge?-1.7:0)-this.fridgeDoor.rotation.y)*Math.min(1,dt*7);
      this.ovenDoor.rotation.x+=((this.world.doors.oven?-1.45:0)-this.ovenDoor.rotation.x)*Math.min(1,dt*7);
      this.windowHinge.rotation.y+=((this.world.doors.window?-.8:0)-this.windowHinge.rotation.y)*Math.min(1,dt*5);this.waterStream.visible=this.world.doors.tap;
      this.mince.visible=this.world.bowl.mass>0;this.mince.scale.y=.1+Math.min(.5,this.world.bowl.mass/2000);
      if(this.airView){const rooms=this.world.stations.map(s=>P.roomAir(s.state));root.BurgerRender.Viewport.prototype._updateRoomAir.call(this.airView,{t:this.world.time,room:{upper:rooms.reduce((v,r)=>v+r.upper,0),lower:rooms.reduce((v,r)=>v+r.lower,0),opening:rooms[0].opening}});}
    }
    animateHands(dt){
      this.portionMesh.visible=this.world.portion.mass>0;this.portionMesh.scale.setScalar(Math.cbrt(Math.max(1,this.world.portion.mass)/150));
      let reach=this.left?.65:0;if(this.action){this.action.time+=dt;const u=this.action.time/this.action.duration;reach=Math.sin(Math.PI*u);if(u>=.55&&!this.action.done){this.action.done=true;this.action.fn();}if(u>=1)this.action=null;}
      for(const a of this.arms){const assisting=this.action&&['crack','form','smash','slice','grab'].includes(this.action.kind);const r=a.side===1?reach:assisting?reach*.8:0;
        const end=new T.Vector3(a.side*(.23-.09*r),-.23+.09*r,-.44-.20*r);
        if(r>0&&this.hover){const contact=this.camera.worldToLocal(this.hover.point.clone());if(contact.length()>1.1)contact.setLength(1.1);contact.y+=.05;contact.x+=a.side*.04;end.lerp(contact,r);}
        if(this.action?.kind==='stir')end.x+=Math.sin(this.action.time*14)*.045;
        a.position.lerp(end,Math.min(1,dt*18));a.hand.position.copy(a.position);a.hand.rotation.x=this.action?.kind==='flip'?-Math.sin(this.action.time/this.action.duration*Math.PI)*1.3:this.action?.kind==='slice'?Math.sin(this.action.time*22)*.45:0;
        for(const finger of a.fingers)finger.rotation.x=(a.side===1&&this.heldEntity()?1.1:.2)+r*.35;
        const shoulder=new T.Vector3(a.side*.25,-.20,.015),elbow=new T.Vector3(a.side*.31,-.37,-.18);
        for(const [mesh,start,finish] of [[a.upper,shoulder,elbow],[a.fore,elbow,a.position]]){mesh.position.copy(start).add(finish).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(new T.Vector3(0,0,1),finish.clone().sub(start).normalize());mesh.scale.z=start.distanceTo(finish)/.25;}
      }
    }
    hint(){
      const t=this.hover,h=this.heldEntity();let text='';if(t){const d=t.data;text=d.name||'Counter';if(['knob','ovenKnob','vent'].includes(d.type)){const s=this.world.station(d.id||'oven').state;const value=d.type==='ovenKnob'?Math.round(s.oven.target)+' °C':d.type==='vent'?Math.round(s.grill.topVent*100)+'%':s.stove.knob.toFixed(1)+'/10';text+=' · '+value+'\nHold left click + move mouse to turn';}
        else if(d.type==='bowl')text+=' · '+Math.round(this.world.bowl.mass)+' g · '+this.world.bowl.salt.toFixed(1)+' g salt\n'+(h?'Hold left click to mix / season':'Hold left click to take mince · Right click returns 25 g');
        else if(d.type==='supply')text+='\nRight click to take one';else text+='\n'+(h?'Left click: use · Right click: place':'Left click: interact · Right click: pick up');}
      $('real-hint').textContent=text;$('real-hint').hidden=!text;
      $('real-hands').textContent=(h?'Holding '+(LABELS[h.kind]||h.label):'Hands free')+(this.world.portion.mass>0?'\nPortion '+Math.round(this.world.portion.mass)+' g · '+this.world.portion.salt.toFixed(1)+' g salt\nLeft click the board to shape':'');
    }
    frame(now){
      const dt=Math.min(.05,Math.max(0,(now-this.last)/1000));this.last=now;
      if(this.active){if(!this.paused){this.clock+=dt;this.move(dt);this.hover=this.focus();this.continuous(dt);this.acc+=dt;while(this.acc>=.05){this.world.step(.05);this.acc-=.05;}this.animateHands(dt);if(this.clock-this.savedAt>15){this.save();this.savedAt=this.clock;}
        const nearest=this.world.stations.reduce((a,b)=>Math.hypot(a.x-this.world.player.x,a.z-this.world.player.z)<Math.hypot(b.x-this.world.player.x,b.z-this.world.player.z)?a:b);this.game.audio.update(nearest.state.diag,nearest.state.stove.knob/10,dt);
      }
        this.renderEntities(this.paused?0:dt);this.hint();if(now>this.toastUntil)$('real-toast').hidden=true;this.renderer.render(this.scene,this.camera);
      }requestAnimationFrame(t=>this.frame(t));
    }
  }
  root.RealMode=RealMode;
  root.addEventListener('DOMContentLoaded',()=>{
    const menu=document.createElement('section');menu.id='mode-choice';menu.innerHTML='<div class="experience-card"><h1>griddle.</h1><p>Your kitchen. Your kind of cooking.</p><div class="experience-options"><button id="choose-legacy">Legacy<small>The original simulation</small></button><button id="choose-real">Real<small>Step into the kitchen</small></button></div><button id="choose-resume">Resume Real kitchen</button><p id="choose-status" role="status"></p></div>';document.body.append(menu);
    const hud=document.createElement('div');hud.id='real-hud';hud.hidden=true;hud.innerHTML='<div id="real-badge">griddle.<small>REAL KITCHEN · PRACTICE</small></div><div id="real-crosshair"></div><div id="real-hint"></div><div id="real-hands"></div><div id="real-toast" hidden></div><div id="real-controls">WASD · move / Shift · jog / Space · jump / Ctrl · crouch<br>Left click · interact / Right click · pick up & place / Esc · pause</div>';document.body.append(hud);
    const pause=document.createElement('section');pause.id='real-pause';pause.hidden=true;pause.innerHTML='<div class="experience-card"><h1>Take your time.</h1><p>Open the fridge, bring mince to the bowl, mix and portion it. Tools live on the island. Every station keeps cooking while you work elsewhere.</p><p>Hold left click to reach, turn, pour or season. Right click picks up or places. Right click the bowl to return 25 g from your portion.</p><button id="real-resume">Apron on · Resume</button><button id="real-save">Save kitchen</button><button id="real-leave">Mode selection</button><p id="real-save-status"></p></div>';document.body.append(pause);
    const enter=resume=>{root.realMode ||= new RealMode(root.game);root.realMode.start(resume);};
    $('choose-legacy').onclick=()=>{document.body.dataset.experience='legacy';menu.hidden=true;root.game.vp.resize();};$('choose-real').onclick=()=>enter(false);$('choose-resume').onclick=()=>enter(true);
    $('real-resume').onclick=()=>root.realMode.resume();$('real-save').onclick=()=>root.realMode.save();$('real-leave').onclick=()=>root.realMode.leave();
    const back=document.createElement('button');back.textContent='Mode selection';back.onclick=()=>{root.game.setPaused(true);document.body.dataset.experience='choose';menu.hidden=false;};document.querySelector('#kitchen-menu .menu-content').append(back);
  });
})(window);
