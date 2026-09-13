/* First-person practice: physical targets, assisted hands and independent cooking stations. */
(function(root){
  'use strict';
  const T=root.THREE,P=root.BurgerPhysics,VA=root.KitchenAssets,$=id=>document.getElementById(id),clamp=P.clamp;
  const LABELS=root.RealBuildMethods.labels;
  class RealMode {
    constructor(game){
      this.game=game;this.canvas=$('view');this.renderer=game.vp.renderer;this.world=new root.RealKitchen.Kitchen();this.scene=new T.Scene();this.scene.background=new T.Color(0xc5dce0);this.scene.fog=new T.Fog(0xc5dce0,12,30);
      this.camera=new T.PerspectiveCamera(72,innerWidth/innerHeight,.025,40);this.scene.add(this.camera);
      this.keys=new Set();this.ray=new T.Raycaster();this.meshes=new Map();this.panTemplates=new Map();this.targets=[];this.surfaces=[];this.colliders=[];this.stations=new Map();this.held=null;this.left=false;this.active=false;this.paused=true;this.action=null;this.acc=0;this.clock=0;this.savedAt=0;this.velocityY=0;this.ground=0;this.look=new T.Vector2();
      this.buildRoom();this.buildStations();root.RealRoomDetail.decorate(this);this.buildReflections();this.buildChef();this.interaction=new root.RealInteraction(this);this.presentation=new root.RealPresentation.Presentation(this);this.audio=new root.SpatialKitchenAudio();this.bind();this.resize();
      this.airView={scene:this.scene,room:{userData:{windows:[]}}};root.BurgerRender.Viewport.prototype._buildRoomSmoke.call(this.airView);
      for(const cloud of this.airView.roomClouds){cloud.userData.y+=1.3;cloud.userData.x*=1.4;cloud.userData.z*=1.4;}
      this.renderEntities(0);
    }
    material(color,kind='paint'){const m=VA.material(kind,color);if([0xe8deca,0xf3ead9].includes(color)){m.roughness=.94;m.clearcoat=0;}return m;}
    box(w,h,d,x,y,z,color,kind='paint',parent=this.scene){const m=new T.Mesh(VA.roundedBox(w,h,d,Math.min(.018,Math.min(w,h,d)*.15),3),this.material(color,kind));m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;parent.add(m);return m;}
    ball(r,x,y,z,color,parent=this.scene){const m=new T.Mesh(new T.SphereGeometry(r,24,16),this.material(color));m.position.set(x,y,z);m.castShadow=true;parent.add(m);return m;}
    tube(points,r,color,parent=this.scene,kind='steel'){const m=new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p))),32,r,10,false),this.material(color,kind));m.castShadow=true;parent.add(m);return m;}
    label(text,x,y,z,size=.2,parent=this.scene){const c=document.createElement('canvas');c.width=512;c.height=128;const cx=c.getContext('2d');cx.fillStyle='#f7eed8';cx.fillRect(0,0,512,128);cx.fillStyle='#405749';cx.textAlign='center';cx.font='600 35px sans-serif';cx.fillText(text,256,81);const tx=new T.CanvasTexture(c);tx.encoding=T.sRGBEncoding;const m=new T.Mesh(new T.PlaneGeometry(size*4,size),new T.MeshBasicMaterial({map:tx}));m.position.set(x,y,z);m.rotation.y=Math.PI;parent.add(m);return m;}
    target(mesh,data){mesh.userData.realTarget=data;this.targets.push(mesh);return mesh;}
    reuse(name,pos=[0,0,0],scale=[1,1,1]){
      const source=this.game.vp.room.userData.assets[name],group=new T.Group();group.name='Shared '+name;
      if(!source)throw Error('Missing kitchen asset: '+name);
      for(const node of source.nodes){const copy=node.clone(true);copy.position.sub(new T.Vector3(...source.origin));copy.traverse(o=>{if(o.geometry)o.geometry=o.geometry.clone();if(o.material){o.material=o.material.clone();for(const key of ['map','bumpMap','roughnessMap'])if(o.material[key])VA.shared.add(o.material[key]);}});group.add(copy);}
      group.position.set(...pos);group.scale.set(...scale);this.scene.add(group);return group;
    }
    targetGroup(group,data){group.traverse(o=>{if(o.isMesh)this.target(o,data);});return group;}
    copyModel(source){const copy=source.clone(true);copy.traverse(o=>{if(o.geometry)o.geometry=o.geometry.clone();if(o.material){o.material=o.material.clone();for(const key of ['map','bumpMap','roughnessMap'])if(o.material[key])VA.shared.add(o.material[key]);}});return copy;}
    buildReflections(){
      const target=new T.WebGLCubeRenderTarget(128,{generateMipmaps:true,minFilter:T.LinearMipmapLinearFilter}),capture=new T.CubeCamera(.05,25,target);capture.position.set(0,1.25,.1);capture.update(this.renderer,this.scene);
      const pmrem=new T.PMREMGenerator(this.renderer);this.roomReflection=pmrem.fromCubemap(target.texture);this.scene.environment=this.roomReflection.texture;target.dispose();pmrem.dispose();
    }
    surface(w,d,x,y,z,name){const m=this.box(w,.018,d,x,y-.009,z,0xe0ccb0,'stone');this.target(m,{type:'surface',name});this.surfaces.push({x,z,w,d,y});return m;}
    cabinet(w,d,x,z){this.colliders.push({x,z,w,d,y:0,top:.93});this.surface(w+.04,d+.04,x,.93,z,'counter');const count=Math.ceil(w/.6);for(let i=0;i<count;i++){const xx=x-w/2+(i+.5)*w/count;this.reuse('cabinet0',[xx,.035,z],[w/count/.60,1.096,(d-.10)/.52]);}this.box(w-.12,.10,d-.10,x,.05,z,0x56645a);}
    fixtureStart(){return {nodes:new Set(this.scene.children),surfaces:this.surfaces.length,colliders:this.colliders.length};}
    fixtureEnd(name,start){
      const f=root.RealKitchen.fixtures[name],g=new T.Group();g.name=name+' fixture';
      for(const node of this.scene.children.slice())if(!start.nodes.has(node)){g.add(node);node.position.x-=f.from[0];node.position.z-=f.from[1];}
      g.position.set(f.to[0],0,f.to[1]);g.rotation.y=f.yaw;this.scene.add(g);
      for(const rect of [...this.surfaces.slice(start.surfaces),...this.colliders.slice(start.colliders)]){const p=root.RealKitchen.fixturePoint(name,[rect.x-f.from[0],0,rect.z-f.from[1]]),c=Math.abs(Math.cos(f.yaw)),s=Math.abs(Math.sin(f.yaw)),w=rect.w,d=rect.d;rect.x=p[0];rect.z=p[2];rect.w=w*c+d*s;rect.d=w*s+d*c;}
      return g;
    }
    buildRoom(){
      this.scene.add(new T.HemisphereLight(0xe9f2ff,0x645446,.38));const sun=new T.DirectionalLight(0xfff3db,1.0);sun.position.set(-1.2,3.0,3.5);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-4.2,right:4.2,top:4.2,bottom:-4.2,near:.1,far:14});sun.shadow.bias=-.00015;sun.shadow.normalBias=.003;this.scene.add(sun);
      const key=new T.SpotLight(0xfff0d8,.8,8,Math.PI/3,.8,1);key.position.set(.3,2.8,-.6);key.target.position.set(0,.9,0);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.bias=-.0004;key.shadow.radius=4;this.scene.add(key,key.target);
      this.scene.environment=this.game.vp.scene.environment;
      this.target(this.box(8,.1,8,0,-.06,0,0xd4c5aa,'stone'),{type:'surface',name:'floor'});
      const tileGeo=new T.BoxGeometry(.497,.009,.497),tiles=new T.InstancedMesh(tileGeo,this.material(0xffffff,'stone'),256),dummy=new T.Object3D();let n=0;
      for(let x=0;x<16;x++)for(let z=0;z<16;z++){dummy.position.set(-3.75+x*.5,0,-3.75+z*.5);dummy.updateMatrix();tiles.setMatrixAt(n,dummy.matrix);tiles.setColorAt(n++,new T.Color((x+z)%2?0x8f9c89:0xd5c9ae).convertSRGBToLinear());}tiles.receiveShadow=true;this.scene.add(tiles);
      for(const x of [-4,4])this.box(.1,3.2,8,x,1.6,0,0xe8deca);this.box(8,3.2,.1,0,1.6,-4,0xe8deca);
      for(const x of [-2.65,2.65])this.box(2.7,3.2,.1,x,1.6,4,0xe8deca);this.box(2.6,.9,.1,0,.45,4,0xe8deca);this.box(2.6,.65,.1,0,2.875,4,0xe8deca);
      this.box(8,.06,8,0,3.22,0,0xf3ead9);
      const garden=this.reuse('garden',[0,0,4]);garden.updateMatrixWorld(true);for(const node of garden.children.slice())if(new T.Box3().setFromObject(node).min.z<4.02)this.dispose(node);
      const windowFrame=this.targetGroup(this.reuse('window',[0,1.75,3.96],[1.47,1.33,1]),{type:'window',name:'garden window'});this.windowHinges=[];windowFrame.traverse(o=>{if(o.name==='Window leaf hinge')this.windowHinges.push(o);});
      this.reuse('herb',[-.95,.94,3.83]);this.reuse('herb',[.98,.94,3.83],[.8,.8,.8]);
      for(const x of [-3.94,3.94])this.box(.025,.12,7.9,x,.06,0,0xf8efd9);for(const z of [-3.94,3.94])this.box(7.9,.12,.025,0,.06,z,0xf8efd9);
      this.reuse('print-warm',[-3.94,1.70,-1.2],[1.25,1.25,1.25]);this.reuse('print-green',[-3.94,1.70,-.25],[1.25,1.25,1.25]);
      this.cabinet(4.65,.80,0,.95);this.cabinet(3.9,1.15,0,-.86);
      const board=this.copyModel(this.game.vp.board);board.visible=true;board.scale.set(1.3,1,1.3);board.position.set(0,.96,-.88);this.scene.add(board);this.boardTarget=this.targetGroup(board,{type:'board',name:'chopping board'});this.surfaces.push({x:0,z:-.88,w:.546,d:.39,y:.96});
      // A real open mixing bowl, placed beside the board.
      const profile=[[0,0],[.10,0],[.15,.025],[.185,.13],[.19,.15],[.18,.15],[.17,.12],[.14,.03],[.09,.013],[0,.013]].map(a=>new T.Vector2(...a));
      const bowl=new T.Mesh(new T.LatheGeometry(profile,64),this.material(0xbdc9c7,'steel'));bowl.position.set(-.72,.94,-.88);bowl.castShadow=true;this.scene.add(bowl);this.target(bowl,{type:'bowl',name:'mixing bowl'});
      this.mince=this.ball(.14,-.72,.985,-.88,0xa95048);this.mince.scale.y=.2;this.target(this.mince,{type:'bowl',name:'mixed mince'});
      let fixture=this.fixtureStart();
      this.reuse('cabinet3',[2.6,.035,2.7],[1.8,1.096,1.15]);this.colliders.push({x:2.6,z:2.7,w:1.2,d:.7,y:0,top:.93});
      for(const side of [-1,1])this.box(.025,.87,.71,2.6+side*.578,.483,2.7,0x6c8b70);this.box(1.18,.04,.028,2.6,.904,2.341,0x638269);
      for(const x of [2.176,3.024])this.surface(.332,.74,x,.93,2.7,'sink counter');for(const z of [2.431,2.969])this.surface(.516,.202,2.6,.93,z,'sink counter');
      const sink=this.reuse('sink',[2.6,.932,2.7]);sink.traverse(o=>{if(o.isMesh)this.target(o,{type:o.name==='Tap lever'?'tap':'sink',name:o.name==='Tap lever'?'tap':'sink'});});
      sink.updateMatrixWorld(true);const lever=sink.getObjectByName('Tap lever'),leverBox=new T.Box3().setFromObject(lever),leverSize=leverBox.getSize(new T.Vector3()).addScalar(.016),leverCentre=leverBox.getCenter(new T.Vector3());
      const tapHit=this.box(leverSize.x,leverSize.y,leverSize.z,leverCentre.x,leverCentre.y,leverCentre.z,0xffffff);tapHit.material.visible=false;tapHit.castShadow=tapHit.receiveShadow=false;this.target(tapHit,{type:'tap',name:'tap'});
      this.waterStream=this.box(.006,.31,.006,2.535,.951,2.74,0xb0d5d6);this.waterStream.visible=false;
      this.fixtureEnd('sink',fixture);fixture=this.fixtureStart();
      this.reuse('fridge-shell',[-3.3,0,1.7],[1.36,1.36,1.36]);this.reuse('fridge-trim',[-3.3,0,1.7],[1.36,1.36,1.36]);this.colliders.push({x:-3.30,z:1.7,w:.84,d:.8,y:0,top:1.95});
      for(const y of [.45,.85,1.25,1.65])this.box(.79,.02,.64,-3.30,y,1.67,0xffffff);
      this.fridgeDoor=new T.Group();this.fridgeDoor.position.set(-3.7,0,1.275);this.scene.add(this.fridgeDoor);const fridgeDoors=this.targetGroup(this.reuse('fridge-doors',[-3.3,0,1.7],[1.36,1.36,1.36]),{type:'fridge',name:'fridge handle'});this.fridgeDoor.attach(fridgeDoors);this.fridgeDoor.attach(this.reuse('fridge-badge',[-3.3,0,1.7],[1.36,1.36,1.36]));
      const supplies=['meat','egg','bacon','bunWhole','tomato','pickles','onion','cheeseBlock','lettuce','meatLean','meatRich'];
      supplies.forEach((kind,i)=>{const m=this.prop(kind);m.position.set(-3.52+(i%3)*.23,.46+Math.floor(i/3)*.4,1.45);this.scene.add(m);m.traverse(o=>{if(o.isMesh)this.target(o,{type:'supply',kind,name:LABELS[kind]||kind});});});
      this.fixtureEnd('fridge',fixture);fixture=this.fixtureStart();
      const oven=this.reuse('oven-shell',[-2.6,0,-1.29],[1.25,1.2,.85]);
      for(const knob of oven.children.filter(o=>o.name.includes('knob'))){
        const control=knob.name.includes('function')?'power':'temperature',dial=new T.Group();dial.name=knob.name+' pivot';dial.position.copy(knob.position);dial.userData.ovenControl=control;
        const pointer=oven.children.find(o=>o.isMesh&&!o.name&&Math.abs(o.position.x-knob.position.x)<.001&&o.position.z<knob.position.z&&o.position.distanceTo(knob.position)<.024);
        oven.add(dial);for(const part of [knob,pointer].filter(Boolean)){part.position.sub(dial.position);dial.add(part);}this.targetGroup(dial,{type:'ovenKnob',control,name:'oven '+control});
      }
      this.colliders.push({x:-2.6,z:-1.3,w:.64,d:.82,y:0,top:1.1});
      this.box(.64,.25,.80,-2.6,.125,-1.3,0x496f59);this.surface(.68,.84,-2.6,1.06,-1.3,'oven counter');
      this.ovenDoor=new T.Group();this.ovenDoor.position.set(-2.6,.276,-1.7235);this.scene.add(this.ovenDoor);const ovenDoor=this.targetGroup(this.reuse('oven-door',[-2.6,0,-1.29],[1.25,1.2,.85]),{type:'ovenDoor',name:'oven handle'});this.ovenDoor.attach(ovenDoor);
      this.targetGroup(this.reuse('oven-rack',[-2.6,0,-1.29],[1.25,1.2,.85]),{type:'ovenRack',name:'oven rack'});
      const rackTarget=this.box(.48,.01,.65,-2.6,.541,-1.32,0xa4b1ab,'steel');rackTarget.material.visible=false;this.target(rackTarget,{type:'ovenRack',name:'oven rack'});
      this.label('OVEN',-2.52,.96,-1.757,.04);
      this.fixtureEnd('oven',fixture);
      const bin=new T.Group();bin.position.set(3.65,0,-3.1);bin.name='Pedal bin';this.scene.add(bin);
      const binBody=new T.Mesh(new T.CylinderGeometry(.225,.195,.56,40),this.material(0x546a59));binBody.position.y=.30;binBody.castShadow=binBody.receiveShadow=true;bin.add(binBody);this.target(binBody,{type:'bin',name:'compost & waste'});
      this.binLid=new T.Group();this.binLid.position.set(0,.595,.2);bin.add(this.binLid);const lid=new T.Mesh(new T.CylinderGeometry(.236,.231,.020,40),this.material(0x33493d));lid.position.z=-.2;this.binLid.add(lid);this.target(lid,{type:'bin',name:'compost & waste'});
      this.target(this.box(.13,.02,.07,0,.035,-.225,0xb5b9aa,'steel',bin),{type:'bin',name:'bin pedal'});this.colliders.push({x:3.65,z:-3.1,w:.48,d:.48,y:0,top:.63});

      this.targetGroup(this.reuse('door',[2.7,0,-3.94],[1.08,1.08,1]),{type:'exit',name:'kitchen door'});
      for(const x of [-1.5,0,1.5])this.reuse('pendant',[x,2.68,0],[1.2,1.2,1.2]);
      for(const e of this.world.entities.filter(e=>e.home)){const pan=e.kind==='pan',rest=this.box(pan?.66:.19,.006,pan?.46:.21,e.home[0],e.home[1]-.003,e.home[2],pan?0x8d9b8f:0xd2c4a8,pan?'steel':'paint');this.target(rest,{type:'rest',entity:e.id,name:(pan?e.label:LABELS[e.kind]||e.kind)+' rest'});}
      for(const x of [-2.77,-2.13])this.box(.022,1.8,.035,x,.9,3.84,0x819289,'steel');
      this.colliders.push({x:-2.45,z:3.65,w:.7,d:.46,y:0,top:1.8});
    }
    buildStations(){
      for(const st of this.world.stations){
        const vp=new root.BurgerRender.Viewport(this.canvas,{renderer:this.renderer,textures:this.game.vp});vp.setStove(st.id==='oven'?'gas':st.id);vp.setMode('stove');vp.scene.background=null;vp.scene.fog=null;vp.scene.position.set(st.x,.94,st.z);this.scene.add(vp.scene);this.stations.set(st.id,vp);
        if(st.id==='oven'){vp.scene.position.set(st.x,1.01,st.z);vp.stove.visible=false;vp.board.visible=false;vp.setPan('nonstick');const template=vp.panMesh.clone(true);template.position.y=0;template.traverse(o=>{if(o.geometry)o.geometry=o.geometry.clone();if(o.material)o.material=o.material.clone();});this.panTemplates.set('nonstick',template);continue;}
        if(st.panId){vp.setPan(st.state.pan.id);const template=vp.panMesh.clone(true);template.position.y=0;template.traverse(o=>{if(o.geometry)o.geometry=o.geometry.clone();if(o.material)o.material=o.material.clone();});this.panTemplates.set(st.state.pan.id,template);}
        if(st.id==='charcoal'){vp.scene.position.y=.55;for(const x of [-.25,.25])for(const z of [-.25,.25])this.box(.035,.51,.035,st.x+x,.255,st.z+z,0x354a40,'steel');this.box(.62,.025,.62,st.x,.12,st.z,0x435c4c,'steel');this.colliders.push({x:st.x,z:st.z,w:.8,d:.8,y:0,top:1.1});}
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
    prop(kind){const model=this.propAsset(kind),group=new T.Group();group.add(model);const bounds=new T.Box3().setFromObject(model);model.position.y-=bounds.min.y;return group;}
    propAsset(kind){
      const detailed=root.RealProps.build(this,kind);if(detailed)return detailed;
      if(kind==='plate'){const plate=this.copyModel(this.game.vp.plate);plate.visible=true;plate.position.set(0,0,0);return plate;}
      if(kind==='meatLean'||kind==='meatRich')return this.propAsset('meat');
      // Use the original model builders, including their textures and dimensions.
      if(kind==='spatula')return this.game.vp._buildSpatula();
      if(kind==='probe'){const group=new T.Group(),probe=this.copyModel(this.game.vp.probeGroup);probe.visible=true;probe.position.set(0,0,0);probe.rotation.set(0,Math.PI/2,0);group.add(probe);return group;}
      if(kind==='lid'){const lid=this.copyModel(this.game.vp.lid);lid.visible=true;lid.position.set(0,0,0);return lid;}
      if(kind==='salt'){const mill=this.reuse('salt-mill');this.scene.remove(mill);return mill;}
      const cold={tomatoSlice:'tomato',pickleSlice:'pickles',lettuce:'lettuce'}[kind];if(cold)return root.BurgerRender.coldLayer(cold,.048,0,kind==='pickleSlice');
      if(['bunWhole','bacon'].includes(kind)){
        const group=new T.Group(),state=P.createState({});for(const half of kind==='bunWhole'?['bottom','top']:[null]){const item=P.makeItem(half?'bun':'bacon',{id:701,half}),view=new root.BurgerRender.ItemView(this.game.vp,item);view.update(state,0,half==='top'?'pan':'rest',{x:0,y:half==='top'?.022:0,z:0},'stove');group.add(view.group);}return group;
      }
      if(kind==='cheese'||kind==='cheeseBlock'){const geometry=root.CheeseMesh.create();root.CheeseMesh.update(geometry,{mass:.02,melt:0},{height:0,radius:.08,fried:true});const mesh=new T.Mesh(geometry,this.material(0xf3b73d));mesh.castShadow=mesh.receiveShadow=true;const group=new T.Group();group.add(mesh);if(kind==='cheeseBlock')mesh.scale.y=20;return group;}
      throw Error('Missing Real prop: '+kind);
    }

    buildChef(){
      this.body=new T.Group();this.body.scale.set(.96,1,.88);this.scene.add(this.body);const torso=this.ball(.28,0,1.12,.035,0xece0c8,this.body);torso.scale.set(.78,1.05,.53);const belly=this.ball(.24,0,.94,-.08,0xf0e5ce,this.body);belly.scale.set(1,.9,.85);const apron=root.ChefRig.apron();apron.castShadow=apron.receiveShadow=true;this.body.add(apron);
      this.legs=[];
      for(const x of [-.12,.12]){const leg=new T.Group();leg.position.set(x,.76,0);this.body.add(leg);this.legs.push(leg);const pants=new T.Mesh(root.ChefRig.loft([[-.31,.09,.085],[-.20,.083,.08],[0,.074,.075],[.23,.064,.071],[.31,.063,.069]]),this.material(0x435046));pants.rotation.x=Math.PI/2;pants.position.y=-.29;pants.castShadow=true;leg.add(pants);this.box(.15,.09,.27,0,-.695,-.065,0x343b34,'rubber',leg);this.box(.153,.015,.274,0,-.741,-.065,0x252d29,'rubber',leg);}
      const pocket=this.box(.15,.09,.008,0,.88,-.291,0x496c5a,'paint',this.body);pocket.rotation.x=-.12;

      this.arms=[];
      for(const side of [-1,1]){
        const arm=new T.Group();this.camera.add(arm);
        const limb=(r1,r2,color)=>{const geo=new T.CylinderGeometry(r1,r2,.25,24);geo.rotateX(Math.PI/2);const m=new T.Mesh(geo,this.material(color));arm.add(m);return m;};
        const upper=limb(.043,.050,0xeee2c9),fore=limb(.021,.033,0xbe8d73),hand=root.ChefRig.hand(side);arm.add(hand);
        fore.material.roughness=.76;fore.material.clearcoat=0;upper.material.roughness=.92;upper.material.clearcoat=0;
        const cuff=new T.Mesh(new T.CylinderGeometry(.048,.044,.037,24,1,true),upper.material);cuff.rotation.x=Math.PI/2;cuff.position.z=.108;upper.add(cuff);
        this.arms.push({side,upper,fore,hand,position:new T.Vector3(side*.22,-.23,-.44)});
      }
      this.heldAnchor=new T.Group();this.camera.add(this.heldAnchor);
      this.portionMesh=this.ball(.045,0,.037,0,0xa65349,this.heldAnchor);this.portionMesh.material.bumpMap=VA.texture('mince').relief;this.portionMesh.material.bumpScale=.001;
      this.body.traverse(o=>{if(o.material){o.material.roughness=.9;o.material.clearcoat=0;}});
    }
    bind(){
      const gate=e=>this.active&&document.body.dataset.experience==='real';
      window.addEventListener('keydown',e=>{if(!gate(e))return;e.stopImmediatePropagation();if(!this.paused&&['KeyW','KeyA','KeyS','KeyD','Space','KeyC','ShiftLeft','ShiftRight'].includes(e.code))e.preventDefault();if(e.code==='Escape'){this.pause();return;}if(!this.paused){this.keys.add(e.code);if(e.code==='KeyE'&&!e.repeat)this.interaction.peel();if(e.code==='Space'&&!e.repeat)this.jumpQueued=true;}},true);
      window.addEventListener('keyup',e=>{if(gate(e)){e.stopImmediatePropagation();this.keys.delete(e.code);}},true);
      window.addEventListener('blur',()=>{if(this.active)this.pause();});document.addEventListener('visibilitychange',()=>{if(document.hidden&&this.active)this.pause();});
      document.addEventListener('pointerlockchange',()=>{if(this.active&&document.pointerLockElement!==this.canvas)this.pause();});
      this.canvas.addEventListener('pointermove',e=>{if(!gate(e)||this.paused)return;e.stopImmediatePropagation();if(this.interaction.drag(e))return;if(this.left&&this.grabControl){this.turn(this.grabControl,e.movementX);return;}const sensitivity=.0022*this.presentation.preferences.sensitivity;this.world.player.yaw-=e.movementX*sensitivity;this.world.player.pitch=clamp(this.world.player.pitch-e.movementY*sensitivity,-1.43,1.35);},true);
      this.canvas.addEventListener('pointerdown',e=>{if(!gate(e))return;e.preventDefault();e.stopImmediatePropagation();if(this.paused)return;this.hover=this.focus();if(e.button===2)this.toggleGrab();else if(e.button===0){this.left=true;this.use();}},true);
      window.addEventListener('pointerup',e=>{if(gate(e)){e.stopImmediatePropagation();if(e.button===0){this.left=false;this.interaction.releaseProbe();this.grabControl=null;}}},true);
      this.canvas.addEventListener('contextmenu',e=>{if(gate(e)){e.preventDefault();e.stopImmediatePropagation();}},true);
      this.canvas.addEventListener('wheel',e=>{if(gate(e)){e.preventDefault();e.stopImmediatePropagation();if(!this.paused)this.interaction.wheel(e);}},{capture:true,passive:false});
      window.addEventListener('resize',()=>this.resize());
    }
    resize(){this.renderPending=true;this.camera.aspect=innerWidth/innerHeight;this.camera.updateProjectionMatrix();if(this.active)this.renderer.setSize(innerWidth,innerHeight,false);}
    start(resume=false){
      if(resume){try{const raw=localStorage.getItem('griddle.real.v1');if(!raw){$('choose-status').textContent='No Real kitchen saved yet.';return;}this.load(JSON.parse(raw));}catch(e){$('choose-status').textContent='Could not load this kitchen. Your saved file was kept.';return;}}
      this.started=true;this.active=true;document.body.dataset.experience='real';$('mode-choice').hidden=true;$('real-hud').hidden=false;this.resize();this.move(0);this.pause();this.last=performance.now();if(!this.running){this.running=true;requestAnimationFrame(t=>this.frame(t));}
    }
    resume(){this.canvas.requestPointerLock()?.catch(()=>{this.pause();this.toast('Click Resume again to let the mouse control your view.');});if(this.presentation.preferences.sound)this.audio.start();this.paused=false;$('real-pause').hidden=true;}
    pause(){this.renderPending=true;this.paused=true;this.left=false;this.grabControl=null;this.jumpQueued=false;this.keys.clear();this.walkX=this.walkZ=0;this.activity=null;this.audio.stop();this.interaction.probe=null;if(document.pointerLockElement===this.canvas)document.exitPointerLock();if(this.active){$('real-pause').hidden=false;this.presentation.settingLabels();$('real-resume').focus();}this.save();}
    save(){try{this.world.heldId=this.held;localStorage.setItem('griddle.real.v1',JSON.stringify(this.world.snapshot()));$('real-save-status').textContent='Kitchen saved.';}catch(e){$('real-save-status').textContent='Save unavailable—keep this tab open.';}}
    load(data){
      const next=root.RealKitchen.Kitchen.restore(data);this.interaction.reset();this.presentation.reset();for(const r of this.meshes.values()){r.oilView?.oilTexture.dispose();if(r.view){r.mesh.parent?.remove(r.mesh);r.view.dispose();}else this.dispose(r.mesh);}this.meshes.clear();this.world=next;this.held=next.heldId||null;this.ground=0;this.velocityY=0;this.action=null;this.left=false;this.grabControl=null;this.keys.clear();this.walkX=this.walkZ=0;this.acc=0;
      const p=next.player;if(this.colliders.some(c=>p.y<c.top&&Math.abs(p.x-c.x)<c.w/2+.20&&Math.abs(p.z-c.z)<c.d/2+.20)){p.x=0;p.z=-2.3;p.y=0;}
    }
    leave(){this.pause();this.active=false;document.body.dataset.experience='choose';$('real-pause').hidden=true;$('real-hud').hidden=true;$('mode-choice').hidden=false;}
    dispose(mesh){mesh.parent?.remove(mesh);mesh.traverse(o=>{o.geometry?.dispose();for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[]){for(const k of ['map','bumpMap','roughnessMap'])if(m[k]&&!VA.shared.has(m[k]))m[k].dispose();m.dispose();}});}
    toast(text){$('real-toast').textContent=this.game.tempText(text);$('real-toast').hidden=false;this.toastUntil=performance.now()+3200;}
    heldEntity(){return this.world.get(this.held);}
    nearestFood(t){
      if(t?.data.type!=='station')return null;
      const st=this.world.station(t.data.id),x=t.point.x-st.x,z=t.point.z-st.z;
      return this.world.entities.filter(e=>e.station===st.id&&e.kind!=='pan'&&e.food&&!e.discarded).map(e=>({e,d:Math.hypot(e.food.pos.x-x,e.food.pos.y-z),radius:(e.food.Dcov||e.food.D)/2})).filter(q=>q.d<=q.radius+.035).sort((a,b)=>a.d-b.d)[0]?.e||null;
    }
    focus(){
      const h=this.heldEntity(),assisted=h&&!h.payload&&['spatula','tongs','spoon'].includes(h.kind),targeting=!h||!h.payload&&['spatula','tongs','spoon','knife','probe','salt','press','cheese'].includes(h.kind);
      this.scene.updateMatrixWorld(true);this.ray.setFromCamera(new T.Vector2(0,0),this.camera);this.ray.far=assisted?2.1:1.75;
      const candidates=this.targets.filter(o=>{let q=o;while(q){if(!q.visible||q===this.heldAnchor)return false;if(q===this.scene)return true;q=q.parent;}return false;});
      const hits=this.ray.intersectObjects(candidates,false);
      for(const hit of hits){const d=hit.object.userData.realTarget;if(!d)continue;if(d.entity===this.held)continue;if(d.type==='supply'&&!this.world.doors.fridge)continue;
        let target={data:d,point:hit.point,object:hit.object};
        if(targeting&&d.type==='station'){const e=this.nearestFood(target);if(e){const view=this.stations.get(e.station),mesh=(e.kind==='patty'?view.views:view.itemViews).get(e.food)?.group;target={data:{type:'entity',entity:e.id,name:LABELS[e.kind]||e.label},point:mesh?new T.Box3().setFromObject(mesh).getCenter(new T.Vector3()):hit.point,object:hit.object};}}
        const reached=this.world.get(target.data.entity);if(hit.distance>1.75&&(!reached?.food||reached.kind==='pan'))return null;
        return target;
      }return null;
    }
    turn(d,dx){const st=this.world.station(d.id);if(d.type==='ovenKnob'){if(d.control==='power'){this.ovenDrag=clamp((this.ovenDrag??(this.world.station('oven').state.oven.target>0?1:0))+dx*.025,0,1);this.world.setOvenPower(this.ovenDrag>.5);}else this.world.setOvenTemperature(this.world.settings.ovenSetpoint+dx*1.5);return;}if(d.type==='vent')P.setTopVent(st.state,clamp(st.state.grill.topVent+dx*.008,0,1));else P.setKnob(st.state,clamp(st.state.stove.knob+dx*.035,0,10));}
    animate(kind,fn,duration=.65){if(this.action)return;const target=this.hover?{...this.hover,point:this.hover.point.clone()}:null;this.action={kind,time:0,duration,fn,done:false,target,startDistance:target?this.camera.position.distanceTo(target.point):0};}
    hot(e){
      if(e.kind==='pan')return (e.pan.Tcenter||e.pan.T)>55;if(e.kind==='tray')return (e.trayT||21)>55;
      const p=e.food;if(!p)return (e.sliceState?.T||0)>55;
      const itemHeat=it=>Math.max(P.itemT(it),...[it,...(it.regions||[])].flatMap(q=>['face','up','body','wBot','wTop','yolk','bot','top'].map(k=>q[k]?.T||0)));
      if(e.kind!=='patty')return itemHeat(p)>55;
      const layers=p.assembly||[];
      if(layers[0]?.item?.half==='bottom'&&layers.at(-1)?.item?.half==='top')return Math.max(itemHeat(layers[0].item),itemHeat(layers.at(-1).item))>55;
      return Math.max(P.centerT(p),P.layerMean(p,p.T,0),P.layerMean(p,p.T,p.Nz-1))>55;
    }
    blocked(e){if(e?.station==='oven'&&!this.world.doors.oven)return 'Open the oven first.';if(e?.kind!=='pan'&&e?.food&&(e.station||e.panCarrier)&&this.world.owner(e).lid)return 'Lift the lid first.';return null;}
    toggleGrab(){
      if(this.action)return;this.interaction.probe=null;const h=this.heldEntity(),t=this.hover;
      if(h){if(!t){this.toast('Look at a counter, tool rest or cooking surface.');return;}
        const food=this.foodAt(t),pan=t.data.type==='station'?this.world.get(this.world.station(t.data.id).panId):food,picked=h.kind==='glove'?pan:food;
        if(!h.payload&&picked&&((h.kind==='glove'&&['pan','tray'].includes(picked.kind))||(h.kind==='spatula'&&['patty','egg','bun','cheese'].includes(picked.kind))||(h.kind==='tongs'&&picked.kind==='bacon')||(h.kind==='spoon'&&picked.kind==='onions'))){if(picked.kind!=='pan'&&picked.station&&this.world.owner(picked).lid){this.toast('Lift the lid first.');return;}this.carry(h,picked);return;}
        this.placeHeld(t);return;}
      if(!t)return;const d=t.data;
      if(d.type==='bowl'&&this.world.portion.mass>0){this.world.scoop(25/90,true);return;}
      if(this.world.portion.mass>0){this.toast('Shape the mince on the board, or return it to the bowl first.');return;}
      if(d.type==='supply'){const e=this.world.addIngredient(d.kind,t.point.toArray());this.pick(e);return;}
      if(d.type==='panLid'){const lid=this.world.entities.find(e=>e.kind==='lid'&&e.station===d.id);if(lid)this.pick(lid);return;}
      let e=d.entity?this.world.get(d.entity):null;if(d.type==='rest')return;if(e?.stackRoot)e=this.world.get(e.stackRoot);
      if(d.type==='station'){const st=this.world.station(d.id);e=this.world.get(st.panId);}
      if(!e)return;
      if(this.hot(e)){this.animate('retract',()=>{},.5);this.toast('Hot! Use '+(['pan','tray'].includes(e.kind)?'the oven glove':e.kind==='bacon'?'tongs':e.kind==='onions'?'the spoon':'the spatula')+'.');return;}
      this.pick(e);
    }
    pick(e){if(e.probeAttachment)delete e.probeAttachment;const error=this.blocked(e);if(error){this.toast(error);return;}if(e.kind==='lid'&&(e.station||e.panCarrier)){if(e.panCarrier){const pan=this.world.get(e.panCarrier);pan.parked.lid=false;pan.lidId=null;e.panCarrier=null;}else this.world.station(e.station).state.lid=false;e.station=null;}else if(e.kind==='pan')this.world.liftPan(e);else if(['tray','plate'].includes(e.kind))this.world.liftTray(e);else this.world.detach(e);e.fall=0;e.slide=null;e.held=true;this.held=e.id;this.interaction.yaw=e.yaw||0;this.animate('grab',()=>{},.35);}
    carry(tool,e){const error=this.blocked(e);if(error){this.toast(error);return;}if(e.kind==='pan')this.world.liftPan(e);else if(['tray','plate'].includes(e.kind))this.world.liftTray(e);else this.world.detach(e);tool.payload=e.id;e.fall=0;e.slide=null;e.held=true;this.interaction.yaw=e.yaw||0;this.animate('grab',()=>{},.4);}
    placeHeld(t){
      const tool=this.heldEntity(),e=tool?.payload?this.world.get(tool.payload):tool;let d=t.data;if(!e)return;
      const plan=this.interaction.placement(t,e),release=()=>{e.yaw=plan?.yaw??this.interaction.yaw;e.held=false;if(tool.payload)tool.payload=null;else this.held=null;this.audio.effect(e.food?'food':'place',t.point);};
      if(d.type==='entity'){const hit=this.world.get(d.entity),target=hit?.stackRoot?this.world.get(hit.stackRoot):hit;if(e.kind==='cheese'&&target?.kind==='patty'&&this.world.addCheese(e,target)){release();return;}if(target&&(['tray','plate'].includes(target.kind)?this.world.putOnTray(e,target):!['ketchup','mayo','mustard'].includes(e.kind)&&this.world.assemble(e,target))){release();return;}if(target&&['tray','plate'].includes(target.kind)){this.toast('Not enough space on the '+target.kind+'.');return;}if(target?.station&&(e.food||['lid','pan'].includes(e.kind)))d={type:'station',id:target.station};else if(target&&(e.food||['tomatoSlice','pickleSlice','lettuce'].includes(e.kind))&&(target.food||target.stackRoot)){this.toast(this.world.assemblyProblem(e,target));return;}}
      if(d.type==='rest'){const original=this.world.get(d.entity);if(original?.id===e.id){e.pos=e.home.slice();release();return;}this.toast('That rest belongs to another tool.');return;}
      if(d.type==='bin'){if(e.home||e.kind==='pan'){this.toast('Keep the cookware—return it to a counter or its rest.');return;}this.world.doors.bin=true;this.animate('discard',()=>{this.world.discard(e);release();},.55);return;}
      if(d.type==='station'||d.type==='ovenRack'){
        const id=d.type==='ovenRack'?'oven':d.id;
        if(e.kind==='lid'){const st=this.world.station(id),problem=this.world.lidProblem(id);if(problem){this.toast(problem);return;}if(!st.panId||st.state.lid){this.toast('Put the lid on an uncovered pan.');return;}st.state.lid=true;e.station=id;}
        else if(e.kind==='tray'&&id==='oven'){const error=this.world.ovenTray(e);if(error){this.toast(error);return;}}
        else if(e.kind==='pan'){const error=this.world.dockPan(e,id);if(error){this.toast(error);return;}}
        else if(e.food){const error=this.world.placeFood(e,id,id==='oven'?null:this.interaction.panPoint(t,id));if(error){this.toast(error);return;}}
        else{this.toast('Left click to use that here, or put it on a counter.');return;}
        release();return;
      }
      if(!['surface','board','sink'].includes(d.type)){this.toast('Place it on a counter or its tool rest.');return;}
      const placement=this.interaction.counterPlacement(e,t.point);if(!placement){this.toast('Make a little space here first.');return;}e.pos=placement;release();
      const support=this.surfaces.find(s=>Math.abs(e.pos[0]-s.x)<=s.w/2&&Math.abs(e.pos[2]-s.z)<=s.d/2);
      if(support){const mx=support.w/2-Math.abs(e.pos[0]-support.x),mz=support.d/2-Math.abs(e.pos[2]-support.z);if(Math.min(mx,mz)<(e.kind==='pan'?.07:.012)){e.fall=.03;e.slide=mx<mz?[Math.sign(e.pos[0]-support.x),0]:[0,Math.sign(e.pos[2]-support.z)];}}
    }
    foodAt(t){if(!t)return null;if(t.data.entity){const e=this.world.get(t.data.entity);return e?.stackRoot?this.world.get(e.stackRoot):e;}return this.nearestFood(t);}
    use(){
      if(this.action)return;const t=this.hover,h=this.heldEntity();if(!t){this.interaction.use();return;}const d=t.data,e=this.foodAt(t);
      if(d.type==='sink'){const washing=h?.payload?this.world.get(h.payload):h;if(washing?.kind==='pan'){if(!this.world.doors.tap){this.toast('Turn on the tap first.');return;}this.animate('wash',()=>this.toast(P.washPan(washing.parked||this.world.owner(washing))?'Pan washed.':'Empty the pan before washing it.'));return;}}
      if(['knob','ovenKnob','vent'].includes(d.type)){this.grabControl=d;this.ovenDrag=null;return;}
      if(d.type==='button'){const s=this.world.station(d.id).state;P.setKnob(s,d.action==='power'?(s.stove.knob?0:5):clamp(s.stove.knob+(d.action==='up'?1:-1),0,10));this.animate('press',()=>{},.25);return;}
      const toggles={fridge:'fridge',ovenDoor:'oven',window:'window',tap:'tap'};if(toggles[d.type]){this.world.doors[toggles[d.type]]=!this.world.doors[toggles[d.type]];this.animate('reach',()=>{},.35);return;}
      if(d.type==='exit'){this.pause();return;}
      if(d.type==='bin'){this.world.doors.bin=!this.world.doors.bin;this.animate('press',()=>{},.25);return;}
      if(d.type==='grillLid'){const problem=this.world.lidProblem('charcoal');if(problem){this.toast(problem);return;}P.toggleLid(this.world.station('charcoal').state);this.animate('reach',()=>{},.5);return;}
      if(d.type==='panLid'){if(!h){const lid=this.world.entities.find(e=>e.kind==='lid'&&e.station===d.id);if(lid)this.pick(lid);}else this.toast('Put the tool down and lift the lid.');return;}
      if(this.blocked(e)){this.toast(this.blocked(e));return;}
      if(h?.payload){this.toast('Place the carried food or cookware first.');return;}
      if(this.interaction.use())return;
      if(d.type==='bowl'){
        if(h?.kind==='spoon'||h?.kind==='salt'||!h)return;
        this.toast('Add mince and salt, mix with the spoon, or hold left click with an empty hand to portion.');return;
      }
      if(h?.kind==='knife'&&e){if(e.station||e.held){this.toast('Put it on the chopping board first.');return;}if(e.kind==='patty'){if(this.world.attachedProbe(e)){this.toast('Remove the probe before cutting.');return;}this.animate('slice',()=>{P.peek(this.world.owner(e),e.food);e.cut=true;this.toast(P.donenessOf(P.centerT(e.food)).label+' · '+Math.round(P.centerT(e.food))+' °C at the centre');});}else this.animate('slice',()=>this.world.cut(e,this.world.settings.sliceMm,this.interaction.supportAt(e.pos)),.9);return;}
      if(h&&['ketchup','mayo','mustard'].includes(h.kind)&&e){const error=this.world.assemblyProblem(h,e);if(error){this.toast(error);return;}this.animate('pour',()=>this.world.assemble(h,e));return;}
      if(h?.kind==='glove'){
        const pan=d.type==='station'?this.world.get(this.world.station(d.id).panId):e;
        if(pan&&['pan','tray'].includes(pan.kind)&&!h.payload)this.carry(h,pan);return;
      }
      if(e?.food&&h){
        const s=this.world.owner(e);
        if(s.lid&&e.station){this.toast('Lift the lid first.');return;}
        if(h.kind==='spatula'&&['patty','egg','bun'].includes(e.kind)||h.kind==='tongs'&&e.kind==='bacon'||h.kind==='spoon'&&e.kind==='onions'){
          if(e.station==='oven'){this.toast('Right click to lift it from the rack.');return;}
          if(e.food.where!=='pan'){this.toast(e.food.assembly?.length?'Use E to lift a burger layer.':'Put it on a cooking surface first.');return;}
          if(this.world.attachedProbe(e)){this.toast('Remove the probe before flipping.');return;}
          this.animate(e.kind==='onions'?'stir':'flip',()=>{if(e.kind==='patty'){if(e.food.faceDown.stuck)P.scrape(s,e.food);P.flipPatty(s,e.food);}else P.flipItem(s,e.food);},e.kind==='onions'?.8:.65);return;
        }
        if(h.kind==='press'&&e.kind==='patty'){if(this.world.attachedProbe(e)){this.toast('Remove the probe before pressing.');return;}if(e.food.where!=='pan'){this.toast('Put the patty on a cooking surface first.');return;}this.animate('smash',()=>P.pressPatty(s,true,e.food),1.0);return;}
        if(h.kind==='cheese'&&e.kind==='patty'){if(this.world.addCheese(h,e)){this.held=null;}else this.toast('Add cheese to exposed meat, up to four slices.');return;}
        if(h.kind==='salt')return;
      }
      if(d.type==='station'||e?.station){
        const st=this.world.station(d.id||e.station),s=st.state;
        if(h?.kind==='lighter'&&s.grill){s.grill.lit=true;s.grill.Tfire=Math.max(s.grill.Tfire,400);P.setKnob(s,5);this.animate('press',()=>{},.35);return;}
        if(h?.kind==='coal'&&s.grill){P.addCoals(s,.25);this.animate('pour',()=>{});return;}
        if(h?.kind==='wood'&&s.grill){P.addWood(s,'hickory');this.animate('grab',()=>{});return;}
        if(h?.kind==='spoon'&&s.grill){this.animate('stir',()=>P.stirCoals(s));return;}
        if(h?.kind==='cloth'){this.animate('wipe',()=>P.wipeStove(s));return;}
        if(h?.kind==='lid'){const problem=this.world.lidProblem(st.id);if(problem){this.toast(problem);return;}if(!st.panId||s.grill){this.toast('Put this lid on a pan.');return;}s.lid=true;h.station=st.id;h.held=false;this.held=null;this.animate('reach',()=>{});return;}
        if(h?.food){this.animate('place',()=>{const error=this.world.placeFood(h,st.id,this.interaction.panPoint(t,st.id));if(error)this.toast(error);else this.held=null;});return;}
        if(['oil','water'].includes(h?.kind))return;
      }
      if(d.type==='board'&&h?.kind==='knife'){const q=this.world.entities.find(q=>!q.discarded&&!q.held&&Math.hypot(q.pos[0],q.pos[2]+.88)<.4&&['tomato','pickles','onion','bunWhole','cheeseBlock'].includes(q.kind));if(q)this.animate('slice',()=>this.world.cut(q,this.world.settings.sliceMm,this.interaction.supportAt(q.pos)),.9);return;}
      if(!h&&e&&this.world.portion.mass>0){this.toast('Form your portion on the board first.');return;}
    }
    continuous(dt){
      this.activity=null;
      if(this.interaction.continuous(dt))return;
      const h=this.heldEntity(),t=this.hover;if(!this.left||!t||this.action||this.grabControl||h?.payload)return;const d=t.data;
      if(d.type==='bowl'){
        if(!h){this.world.scoop(dt);if(this.world.portion.mass)this.activity={kind:'portion',point:t.point};}
        else if(h.kind==='spoon'&&this.world.bowl.mass){this.world.bowl.work=clamp(this.world.bowl.work+dt*.025,0,1);this.activity={kind:'mix',point:t.point};}
        else if(h.kind==='salt'){this.world.bowl.salt+=dt*.6;this.activity={kind:'salt',point:t.point};}
      }
      const e=this.foodAt(t);if(this.blocked(e))return;if(h?.kind==='salt'&&e?.kind==='patty'){const exposed=this.world.exposedPatty(e);if(exposed){this.world.applySeasoning(exposed,dt*.6);this.activity={kind:'salt',point:t.point};}}
      const stationId=d.type==='station'?d.id:e?.station;
      if(stationId&&h){const st=this.world.station(stationId),s=st.state;if(s.lid||!st.panId)return;if(h.kind==='oil'&&!s.grill){P.addFat(s,'canola',dt*5);this.activity={kind:'oil',point:t.point};}if(h.kind==='water'&&!s.grill){root.BurgerPanWater.add(s.pan,dt*.02,21);this.activity={kind:'water',point:t.point};}}
    }
    move(dt){
      const p=this.world.player,crouch=this.keys.has('KeyC'),height=crouch?1.06:this.interaction.probe?1.54:1.72,speed=(this.keys.has('ShiftLeft')||this.keys.has('ShiftRight')?2.7:1.55)*(crouch?.55:1);
      let x=(this.keys.has('KeyD')?1:0)-(this.keys.has('KeyA')?1:0),z=(this.keys.has('KeyS')?1:0)-(this.keys.has('KeyW')?1:0),length=Math.hypot(x,z)||1;x/=length;z/=length;if(this.grabControl)x=z=0;
      const blend=-Math.expm1(-dt*20);this.walkX=(this.walkX||0)+((x*Math.cos(p.yaw)+z*Math.sin(p.yaw))*speed-(this.walkX||0))*blend;this.walkZ=(this.walkZ||0)+((-x*Math.sin(p.yaw)+z*Math.cos(p.yaw))*speed-(this.walkZ||0))*blend;
      const dx=this.walkX*dt,dz=this.walkZ*dt;
      if(this.jumpQueued){if(p.y<=this.ground+.001)this.velocityY=3.4;this.jumpQueued=false;this.keys.delete('Space');}
      this.velocityY-=9.8*dt;const oldY=p.y;p.y+=this.velocityY*dt;this.ground=0;
      for(const c of this.colliders)if(Math.abs(p.x-c.x)<c.w/2+.15&&Math.abs(p.z-c.z)<c.d/2+.15&&oldY>=c.top-.01&&p.y<=c.top&&this.velocityY<0)this.ground=Math.max(this.ground,c.top);
      if(p.y<this.ground){p.y=this.ground;this.velocityY=0;}
      const blocked=(xx,zz)=>this.colliders.some(c=>p.y<c.top-.03&&p.y+height>c.y&&Math.abs(xx-c.x)<c.w/2+.20&&Math.abs(zz-c.z)<c.d/2+.20);
      if(!blocked(p.x+dx,p.z))p.x=clamp(p.x+dx,-3.75,3.75);if(!blocked(p.x,p.z+dz))p.z=clamp(p.z+dz,-3.75,3.75);
      this.eyeHeight=(this.eyeHeight??1.72)+(height-(this.eyeHeight??1.72))*Math.min(1,dt*12);
      this.probeLean=(this.probeLean||0)+((this.interaction.probe?.10:0)-(this.probeLean||0))*Math.min(1,dt*12);
      const lean=.14+Math.max(0,-p.pitch-.4)*.20+this.probeLean;
      this.camera.position.set(clamp(p.x-Math.sin(p.yaw)*lean,-3.88,3.88),p.y+this.eyeHeight,clamp(p.z-Math.cos(p.yaw)*lean,-3.88,3.88));this.camera.rotation.set(p.pitch,p.yaw,0,'YXZ');this.body.position.set(p.x,p.y,p.z);this.body.rotation.y=p.yaw;this.body.scale.y=(this.eyeHeight-.15)/1.57;for(const [i,leg] of this.legs.entries())leg.rotation.x=this.presentation.preferences.motion?Math.sin(this.clock*8+i*Math.PI)*Math.min(.18,Math.hypot(this.walkX||0,this.walkZ||0)*.12):0;
    }
    grip(e){return root.RealGrips.profile(e,this.meshes.get(e.id)?.height);}
    gripPoint(profile,point){return new T.Vector3(...point).sub(new T.Vector3(...profile.grip)).applyEuler(new T.Euler(...profile.rotation));}
    heldPose(e,mesh){
      const tool=this.heldEntity(),profile=this.grip(e);mesh.scale.setScalar(1);
      if(e.kind==='glove'){mesh.visible=false;return;}
      if(tool?.payload===e.id&&tool.kind!=='glove'){
        const grip=this.grip(tool);mesh.position.copy(this.gripPoint(grip,grip.tip));
        // Gather the existing slivers onto the spoon without shrinking the food.
        const onions=this.meshes.get(e.id)?.view?.onionInst;
        if(tool.kind==='spoon'&&onions){const matrix=new T.Matrix4();for(let i=0;i<onions.count;i++){onions.getMatrixAt(i,matrix);matrix.elements[12]*=.24;matrix.elements[14]*=.24;matrix.elements[13]+=Math.floor(i/10)*.0015;onions.setMatrixAt(i,matrix);}onions.instanceMatrix.needsUpdate=true;}
        if(!e.food)mesh.rotation.set(0,0,0);return;
      }
      const foodX=e.food&&e.kind!=='pan'?mesh.rotation.x:0;
      mesh.rotation.set(profile.rotation[0]+foodX,profile.rotation[1],profile.rotation[2]);
      mesh.position.copy(new T.Vector3(...profile.grip).applyEuler(new T.Euler(...profile.rotation)).negate());
    }
    renderEntities(dt){
      this.renderPending=true;
      for(const e of this.world.entities){
        if(['pan','lid'].includes(e.kind)&&e.station){const r=this.meshes.get(e.id);if(r)r.mesh.visible=false;continue;}
        let rec=this.meshes.get(e.id);
        if(e.discarded){if(rec){rec.oilView?.oilTexture.dispose();if(rec.view){rec.mesh.parent?.remove(rec.mesh);rec.view.dispose();}else this.dispose(rec.mesh);this.meshes.delete(e.id);}continue;}
        if(e.food&&e.station){if(rec){rec.mesh.visible=false;}continue;}
        if(rec&&rec.food!==e.food){rec.oilView?.oilTexture.dispose();if(rec.view){rec.mesh.parent?.remove(rec.mesh);rec.view.dispose();}else this.dispose(rec.mesh);this.meshes.delete(e.id);rec=null;}
        if(!rec){let mesh,view;
          if(e.food&&e.kind!=='pan'){view=e.kind==='patty'?new root.BurgerRender.PattyView(this.looseView,e.food):new root.BurgerRender.ItemView(this.looseView,e.food);mesh=view.group;}
          else if(e.kind==='pan'){const pan=this.panTemplates.get(e.panType).clone(true);mesh=new T.Group();mesh.add(pan);mesh.traverse(o=>{if(o.geometry)o.geometry=o.geometry.clone();if(o.material)o.material=o.material.clone();});this.scene.add(mesh);}
        else{mesh=e.stackRoot&&['mayo','ketchup','mustard'].includes(e.kind)?root.BurgerRender.coldLayer(e.kind,.048):this.prop(e.kind);this.scene.add(mesh);}
          const bounds=new T.Box3().setFromObject(mesh);rec={mesh,view,food:e.food,height:bounds.max.y-bounds.min.y,footprint:{minX:bounds.min.x-mesh.position.x,maxX:bounds.max.x-mesh.position.x,minZ:bounds.min.z-mesh.position.z,maxZ:bounds.max.z-mesh.position.z}};this.meshes.set(e.id,rec);mesh.traverse(o=>{if(o.isMesh)this.target(o,{type:'entity',entity:e.id,name:LABELS[e.kind]||e.label});});
        }
        if(e.kind==='pan'){
          if(!rec.oilView){rec.oilView={panGroup:rec.mesh,panFloorY:.004,stoveType:'gas'};root.BurgerRender.Viewport.prototype._buildOil.call(rec.oilView);}
          root.BurgerRender.Viewport.prototype._updateOil.call(rec.oilView,{pan:e.pan,t:this.world.time});
        }
        const m=rec.mesh;m.visible=true;
        if(!e.stackRoot&&!this.world.layers(e).length){rec.stackOwner=null;rec.stackLift=null;}
        if(e.fall&&!e.held){if(e.slide){e.pos[0]+=e.slide[0]*dt*.9;e.pos[2]+=e.slide[1]*dt*.9;}e.fall+=9.8*dt;e.pos[1]-=e.fall*dt;m.rotation.z=Math.min(.7,m.rotation.z+dt*2);if(e.pos[1]<.035){e.pos[1]=.035;e.fall=0;e.slide=null;}}
        if(rec.view){const where=e.panCarrier?'pan':'rest';if(e.kind==='patty'){if(rec.view.cutaway!==!!e.cut)rec.view.setCutaway(!!e.cut,0);rec.view.update(this.world.owner(e),dt,where,{x:e.pos[0],y:e.pos[1],z:e.pos[2],lift:e.panCarrier?e.pos[1]-this.looseView.panFloorY:0},'stove');}else rec.view.update(this.world.owner(e),dt,where,{x:e.pos[0],y:e.pos[1],z:e.pos[2]},'stove');}
        rec.lift=rec.view?m.position.y-e.pos[1]:0;
        if(e.kind==='cheese'){
          if(!rec.cheeseGeometry)m.traverse(o=>{if(o.geometry?.userData.sheet)rec.cheeseGeometry=o.geometry;});
          const ch=e.sliceState||{mass:(e.massG||20)/1000,melt:0},key=ch.mass+'/'+ch.melt.toFixed(3),geo=rec.cheeseGeometry;
          if(rec.cheeseKey!==key){rec.cheeseKey=key;root.CheeseMesh.update(geo,ch,{fried:true});geo.computeBoundingBox();rec.height=geo.boundingBox.max.y-geo.boundingBox.min.y;}
          m.children[0].position.y=0;rec.lift=-geo.boundingBox.min.y;
        }
        if(e.panCarrier){const panMesh=this.meshes.get(e.panCarrier)?.mesh;if(panMesh){panMesh.add(m);if(e.kind==='lid')m.position.set(0,.035,0);else m.position.set(e.food.pos.x,.004+rec.lift,e.food.pos.y);}continue;}
        if(e.trayCarrier&&!e.station){const tray=this.world.get(e.trayCarrier),trayMesh=this.meshes.get(tray.id)?.mesh;if(trayMesh){const n=tray.cargo.indexOf(e.id),at=e.carrierPos||{x:tray.kind==='plate'?0:n%2?.06:-.06,y:tray.kind==='plate'?0:n<2?-.075:.075};trayMesh.add(m);m.position.set(at.x,(tray.kind==='plate'?.008:.0152)+rec.lift,at.y);}continue;}
        if(e.held){if(m.parent!==this.heldAnchor)this.heldAnchor.add(m);this.heldPose(e,m);m.position.y+=rec.lift;}
        else {if(m.parent!==this.scene)this.scene.add(m);m.position.set(e.pos[0],e.pos[1]+rec.lift,e.pos[2]);m.scale.setScalar(1);if(!rec.view&&!e.fall)m.rotation.set(0,0,0);}
        if(!e.held)m.rotation.y=e.kind==='tray'&&e.station==='oven'?root.RealKitchen.fixtures.oven.yaw:e.yaw||0;
        if(e.cutFraction!=null)m.scale[e.kind==='pickles'?'z':e.kind==='cheeseBlock'?'y':'x']=Math.max(.02,e.cutFraction);
        if(e.sliceMm&&['tomatoSlice','pickleSlice'].includes(e.kind))m.scale.y*=e.sliceMm/({tomatoSlice:6,pickleSlice:4}[e.kind]);
      }
      for(const st of this.world.stations){const vp=this.stations.get(st.id);
        if(st.panId&&vp.panSpec.id!==st.state.pan.id)vp.setPan(st.state.pan.id);
        if(vp.lid)vp.lid.traverse(o=>{if(o.isMesh&&!o.userData.realTarget)this.target(o,{type:'panLid',id:st.id,name:'pan lid'});});
        vp.update(st.state,dt,0);if(st.id==='oven')vp.stove.visible=false;
        if(st.id!=='charcoal')vp.panGroup.visible=!!st.panId;
        for(const e of this.world.entities.filter(e=>e.station===st.id&&e.food&&e.kind!=='pan')){
          const v=e.kind==='patty'?vp.views.get(e.food):vp.itemViews.get(e.food);if(v){if(st.id==='oven'){const tray=this.world.get(e.trayCarrier),n=e.ovenSlot??st.state.patties.indexOf(e.food),at=tray?(e.carrierPos||{x:n%2?.06:-.06,y:n<2?-.075:.075}):{x:n%2?.12:-.12,y:n<2?-.15:.15};const pos=root.RealKitchen.fixturePoint('oven',[at.x,tray?.565:.544,at.y-.02]);v.group.position.set(pos[0]-vp.scene.position.x,pos[1]-vp.scene.position.y,pos[2]-vp.scene.position.z);}v.group.rotation.y=e.yaw||0;v.group.traverse(o=>{if(o.isMesh&&!o.userData.realTarget)this.target(o,{type:'entity',entity:e.id,name:e.label});});const w=v.group.getWorldPosition(new T.Vector3());e.pos=[w.x,w.y,w.z];}
        }
      }
      root.RealStackView.render(this,dt);
      for(const e of this.world.entities)if((e.panCarrier||e.trayCarrier||e.stackRoot)&&!e.station&&(e.stackRoot||!this.world.layers(e).length)){const rec=this.meshes.get(e.id);if(rec){const at=rec.mesh.getWorldPosition(new T.Vector3());e.pos=[at.x,at.y-(e.stackRoot?rec.stackLift||0:rec.lift||0),at.z];}}
      this.world.entities=this.world.entities.filter(e=>!e.discarded);
      this.targets=this.targets.filter(o=>{let parent=o;while(parent.parent)parent=parent.parent;return parent===this.scene;});
      this.fridgeDoor.rotation.y+=((this.world.doors.fridge?1.7:0)-this.fridgeDoor.rotation.y)*Math.min(1,dt*7);
      this.ovenDoor.rotation.x+=((this.world.doors.oven?-1.45:0)-this.ovenDoor.rotation.x)*Math.min(1,dt*7);
      for(const hinge of this.windowHinges)hinge.rotation.y+=((this.world.doors.window?hinge.userData.side*.8:0)-hinge.rotation.y)*Math.min(1,dt*5);this.waterStream.visible=this.world.doors.tap;if(this.binLid)this.binLid.rotation.x+=((this.world.doors.bin?1.18:0)-this.binLid.rotation.x)*Math.min(1,dt*8);
      for(const q of this.ovenKnobs||[])q.mesh.rotation.z=q.angle-(q.control==='power'?(this.world.station('oven').state.oven.target>0?1.2:0):(this.world.settings.ovenSetpoint-40)/210*Math.PI*1.4);if(this.ovenLamp)this.ovenLamp.material.emissiveIntensity=this.world.station('oven').state.oven.target>0?.75:0;
      this.mince.visible=this.world.bowl.mass>0;this.mince.scale.y=.1+Math.min(.5,this.world.bowl.mass/2000);if(this.activity?.kind==='mix')this.mince.rotation.y+=dt*1.2;
      if(this.airView){const rooms=this.world.stations.map(s=>P.roomAir(s.state));root.BurgerRender.Viewport.prototype._updateRoomAir.call(this.airView,{t:this.world.time,room:{upper:rooms.reduce((v,r)=>v+r.upper,0),lower:rooms.reduce((v,r)=>v+r.lower,0),opening:rooms[0].opening}});}
      this.interaction?.render();
    }
    animateHands(dt){
      const portion=this.world.portion.mass>0;
      this.portionMesh.visible=portion;this.portionMesh.scale.setScalar(Math.cbrt(Math.max(1,this.world.portion.mass)/150));
      this.portionMesh.position.y=.037*this.portionMesh.scale.x;
      let reach=this.left?.85:0;if(this.action){this.action.time+=dt;const u=this.action.time/this.action.duration;reach=Math.sin(Math.PI*Math.min(1,u));if(u>=.55&&!this.action.done){this.action.done=true;const at=this.action.target,entity=at?.data.entity;if(at&&this.camera.position.distanceTo(at.point)>Math.max(2.25,this.action.startDistance+.3)||entity&&!this.world.get(entity)){this.toast('Move a little closer.');}else{this.action.fn();this.audio.effect(this.action.kind,at?.point);}}if(u>=1)this.action=null;}
      const held=this.heldEntity(),item=held?.kind==='glove'&&held.payload?this.world.get(held.payload):held;
      const profile=item?this.grip(item):portion?root.RealGrips.profile({kind:'portion'}):null;
      const target=this.action?.target||this.hover,action=this.action?.kind,d=target?.data,food=this.foodAt(target);
      if(profile&&item?.kind==='press'&&action==='smash'){profile.support=[-.02,.09,0];profile.supportPose='flat';}
      const freeHand=held&&(this.grabControl||action==='reach'||action==='press'&&held.kind!=='lighter');
      const seasoning=this.activity?.kind==='salt';
      const pouring=profile?.pour&&(action==='pour'||this.activity&&['salt','oil','water'].includes(this.activity.kind));
      this.pourBlend=(this.pourBlend||0)+((pouring?1:0)-(this.pourBlend||0))*Math.min(1,dt*10);
      const stroke=action?Math.sin(this.action.time/this.action.duration*Math.PI):0;
      if(portion&&action==='form'){const shape=this.interaction.shapeSize(),u=Math.min(1,this.action.time/this.action.duration/.55),s=this.portionMesh.scale.x;this.portionMesh.scale.set(P.lerp(s,shape.D/.09,u),P.lerp(s,shape.h/.09,u),P.lerp(s,shape.D/.09,u));this.portionMesh.position.y=.037*this.portionMesh.scale.y;}
      const tilt=action==='flip'?-stroke*1.3:action==='slice'?Math.sin(this.action.time*22)*.22:0;
      this.heldAnchor.rotation.set((profile?.level?-this.camera.rotation.x:0)+tilt-this.pourBlend*1.95,0,0);
      const anchor=new T.Vector3(profile?.support?.12:.20,-.29,-.48);
      const motion=this.presentation.preferences.motion&&!this.action&&!this.left?Math.min(1,Math.hypot(this.walkX||0,this.walkZ||0))*.004:0;anchor.x+=Math.sin(this.clock*7)*motion;anchor.y+=Math.cos(this.clock*14)*motion*.5;
      const probing=profile&&this.interaction.probePose(profile);if(probing){this.heldAnchor.quaternion.copy(probing.rotation);anchor.copy(probing.position);}
      if(action==='taste')anchor.set(.05,-.16,-.32);
      if(profile&&reach>0&&target&&!freeHand&&!probing&&action!=='taste'){
        const reachPoint=this.camera.worldToLocal(target.point.clone());if(reachPoint.length()>1.1)reachPoint.setLength(1.1);
        // Reach with the working end; the handle stays behind it.
        const working=this.gripPoint(profile,pouring&&profile.spout?profile.spout:profile.tip||[0,0,0]);
        reachPoint.sub(working.applyQuaternion(this.heldAnchor.quaternion));reachPoint.y+=pouring?.09:.012;
        anchor.lerp(reachPoint,reach);
      }
      if(action==='stir'||this.activity?.kind==='mix'){anchor.x+=Math.sin(this.clock*14)*.035;anchor.z+=Math.cos(this.clock*14)*.025;}
      if(action==='wipe')anchor.x+=Math.sin(this.action.time*16)*.08;
      if(seasoning&&pouring)anchor.y+=Math.sin(this.clock*24)*.008;
      // Resolve the gripping hand first, then attach the assisting hand to the same object.
      for(const a of [this.arms[1],this.arms[0]]){
        const right=a.side===1,support=!right&&profile?.support&&!freeHand;
        const assisting=!right&&(freeHand||this.action&&['crack','form','smash','slice'].includes(action));
        const pose=right?profile:support?root.RealGrips.poses[profile.supportPose||'cup']:null;
        let end=new T.Vector3(a.side*.24,-.41,-.31),rotation=new T.Quaternion();
        if(pose){
          rotation.copy(this.heldAnchor.quaternion).multiply(new T.Quaternion().setFromEuler(new T.Euler(...pose.wrist)));
          a.hand.quaternion.slerp(rotation,Math.min(1,dt*18));
          const contact=new T.Vector3(...pose.contact).applyQuaternion(a.hand.quaternion);
          end.copy(right?anchor:this.gripPoint(profile,profile.support).applyQuaternion(this.heldAnchor.quaternion).add(this.heldAnchor.position)).sub(contact);
        }else{
          const r=right?reach:assisting?reach*.8:0;
          if(r>0&&target){const reachPoint=this.camera.worldToLocal(target.point.clone());if(reachPoint.length()>1.1)reachPoint.setLength(1.1);reachPoint.y+=.035;reachPoint.z+=.08;reachPoint.x+=right?.025:-.07;end.lerp(reachPoint,r);}
          a.hand.quaternion.slerp(rotation,Math.min(1,dt*18));
        }
        const shoulder=new T.Vector3(a.side*.25,-.20,.015),wristOffset=new T.Vector3(0,0,.029).applyQuaternion(a.hand.quaternion);
        const extension=end.clone().add(wristOffset).sub(shoulder);if(extension.length()>.65)end.copy(shoulder).add(extension.setLength(.65)).sub(wristOffset);
        a.position.lerp(end,Math.min(1,dt*18));a.hand.position.copy(a.position);
        if(right)this.heldAnchor.position.copy(a.position).add(new T.Vector3(...(profile?.contact||[0,-.017,-.042])).applyQuaternion(a.hand.quaternion));
        root.ChefRig.pose(a.hand,pose||((!right&&freeHand||!held)&&this.grabControl?.6:reach*.3),!pose&&action==='press',right&&held?.kind==='glove');
        const wrist=wristOffset.add(a.position),axis=wrist.clone().sub(shoulder),length=axis.length();axis.normalize();
        const bend=new T.Vector3(a.side*.5,-1,.15);bend.addScaledVector(axis,-bend.dot(axis)).normalize();
        const elbow=shoulder.clone().addScaledVector(axis,length/2).addScaledVector(bend,Math.sqrt(Math.max(0,.33*.33-length*length/4)));
        for(const [mesh,start,finish] of [[a.upper,shoulder,elbow],[a.fore,elbow,wrist]]){mesh.position.copy(start).add(finish).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(new T.Vector3(0,0,1),finish.clone().sub(start).normalize());mesh.scale.z=start.distanceTo(finish)/.25;}
      }
    }

    hint(){
      const t=this.action?.target||this.hover,h=this.heldEntity(),payload=h?.payload?this.world.get(h.payload):null,e=this.foodAt(t),d=t?.data;
      const name=q=>q&&(q.kind==='bun'||this.world.layers(q).length)?this.world.name(q):LABELS[q?.kind]||q?.label||q?.kind||'';
      if(!this.focusRing){this.focusRing=new T.Mesh(new T.RingGeometry(1,1.06,64),new T.MeshBasicMaterial({color:0xf5ca77,transparent:true,opacity:.9,depthWrite:false,side:T.DoubleSide}));this.focusRing.rotation.x=-Math.PI/2;this.focusRing.renderOrder=2;this.scene.add(this.focusRing);}
      this.focusRing.visible=!!(e?.food&&e.kind!=='pan'&&!e.held&&h?.kind!=='glove'&&!this.blocked(e));
      if(this.focusRing.visible){const radius=(e.food.Dcov||e.food.D)/2+.012;this.focusRing.scale.set(radius,radius,1);this.focusRing.position.set(e.pos[0],e.pos[1]+.003,e.pos[2]);}
      let title=e&&d?.type==='entity'?name(e):d?.name||(e?name(e):'Counter'),detail='';
      const st=d?.type==='station'?this.world.station(d.id):null,pan=e?.kind==='pan'?e.pan:st?.panId?st.state.pan:null;
      if(d&&['knob','ovenKnob','vent'].includes(d.type)){
        const s=this.world.station(d.id||'oven').state;title+=' · '+(d.type==='ovenKnob'?(d.control==='power'?(s.oven.target?'On':'Off'):Math.round(this.world.settings.ovenSetpoint)+' °C'):d.type==='vent'?Math.round(s.grill.topVent*100)+'%':s.stove.knob.toFixed(1)+'/10');detail='Hold left click + drag to turn';
      }else if(d?.type==='bowl'){
        title='Mixing bowl · '+Math.round(this.world.bowl.mass)+' g · '+this.world.bowl.salt.toFixed(1)+' g salt';
        detail=payload?'Place the carried food first':!h?(this.world.bowl.mass?'Hold left click: take mince':'Add a mince pack')+(this.world.portion.mass?' · Right click: return 25 g':''):h.kind==='spoon'?'Hold left click: mix':h.kind==='salt'?'Hold left click: season':['meat','meatLean','meatRich'].includes(h.kind)?'Left click: add mince':'Put your tool down to take mince';
      }else if(d?.type==='bin')detail=h?((payload||h).home?'Return this to its rest.':'Right click: discard '+name(payload||h)):'Left click: open / close';
      else if(d?.type==='supply')detail=h?'Put down '+name(h)+' to take an ingredient':'Right click: take one';
      else if(d?.type==='rest')detail=(payload||h)?.id===d.entity?'Right click: return to its rest':'A rest for '+name(this.world.get(d.entity));
      else if(d&&['fridge','ovenDoor','window','tap','button','grillLid','exit'].includes(d.type))detail='Left click: '+({fridge:'open / close',ovenDoor:'open / close',window:'open / close',tap:'water on / off',button:'press',grillLid:'open / close',exit:'pause'}[d.type]);
      else {
        detail=this.interaction.hint(t);
        if(!detail&&t){
          if(h&&['surface','board','sink','station','ovenRack','bin'].includes(d.type))detail='Right click: '+(d.type==='bin'?'discard '+name(payload||h):'place '+name(payload||h))+(h.kind==='knife'?'':' · Scroll: rotate');
          else if(st?.panId&&!h)detail=(st.state.pan.Tcenter??st.state.pan.T)>55?'Use the glove to move this pan.':'Right click: pick up pan';
          else if(st&&!st.panId&&st.id!=='charcoal')detail='Place a pan on this hob.';
          else if(e)detail=h?'Left click: use · Right click: '+(payload?'place':'lift'):'Right click: pick up '+name(e);
        }
      }
      const labels={discard:'Discarding',slice:'Slicing',form:'Shaping',crack:'Cracking',taste:'Tasting',wipe:'Wiping',wash:'Washing',flip:'Flipping',smash:'Pressing',pour:'Pouring'};
      const progress=$('real-action');if(progress){progress.hidden=!labels[this.action?.kind];if(!progress.hidden){progress.textContent=labels[this.action.kind];progress.style.setProperty('--progress',Math.min(1,this.action.time/this.action.duration)*100+'%');}}
      this.presentation.context(t&&(detail||pan)?this.game.tempText(title):'',this.game.tempText(detail));
      $('real-crosshair').classList.toggle('focused',!!t);
      this.presentation.held(h,payload,h?name(h)+(payload?' · '+name(payload):''):'Hands free');this.presentation.update(t,e,h);
    }
    frame(now){
      // Catch ordinary slow frames up in stable steps; cap long stalls to avoid a spiral.
      const dt=Math.min(.25,Math.max(0,(now-this.last)/1000));this.last=now;
      if(this.active){if(!this.paused){this.clock+=dt;let movement=dt;while(movement>1e-8){const step=Math.min(.05,movement);this.move(step);movement-=step;}this.hover=this.focus();this.continuous(dt);this.acc+=dt;while(this.acc>=.05-1e-9){this.world.step(.05);this.acc=Math.max(0,this.acc-.05);}this.animateHands(dt);if(this.clock-this.savedAt>15){this.save();this.savedAt=this.clock;}
        const sources=this.world.stations.map(st=>({id:st.id,state:st.state,position:new T.Vector3(st.x,.95,st.z)}));
        for(const e of this.world.entities)if(e.parked){const mesh=this.meshes.get(e.id)?.mesh;sources.push({id:'pan-'+e.id,state:e.parked,position:mesh?mesh.getWorldPosition(new T.Vector3()):new T.Vector3(...e.pos)});}
        this.audio.update(sources,this.camera.position,this.camera.getWorldDirection(new T.Vector3()),dt);
      }
        if(!this.paused||this.renderPending){this.renderEntities(this.paused?0:dt);this.hint();this.renderer.render(this.scene,this.camera);this.renderPending=false;}if(now>this.toastUntil)$('real-toast').hidden=true;
      }requestAnimationFrame(t=>this.frame(t));
    }
  }
  root.RealMode=RealMode;
  root.addEventListener('DOMContentLoaded',()=>root.RealPresentation.mount());
})(window);
