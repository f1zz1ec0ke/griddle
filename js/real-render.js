/* Prepare both kitchens before mode selection, including equipment, smoke and sliced food. */
(function(root){
  'use strict';
  const T=root.THREE,P=root.BurgerPhysics;
  const yieldFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
  function checkPrograms(renderer){
    if(renderer.info.programs.some(program=>program.diagnostics?.runnable===false))throw new Error('A kitchen shader could not compile.');
  }
  function objectsIn(r,extra=[]){
    const objects=[];
    for(const group of [r.scene,...extra])group.traverse(o=>{if(o.material&&!o.userData.renderBatched)objects.push(o);});
    return objects;
  }
  async function compileRoom(r,fog,target,progress=()=>{},extra=[]){
    const renderer=r.renderer,preview=new T.Scene(),objects=[];preview.environment=r.scene.environment;preview.fog=fog;
    r.scene.traverseVisible(o=>{if(o.isLight)preview.add(o.clone());});
    objects.push(...objectsIn(r,extra));const total=Math.ceil(objects.length/16);
    // r128's compile is synchronous. Report completed batches and yield for the loading screen.
    for(let i=0;i<objects.length;i+=16){
      const batch=new T.Group();
      for(const object of objects.slice(i,i+16)){const copy=object.clone(false);batch.add(copy);}
      preview.add(batch);const previous=renderer.getRenderTarget();
      try{
        renderer.setRenderTarget(target);
        // compile() uses the current clipping state. Clear it before preparing ordinary room
        // surfaces, otherwise the last sliced food can create clipped variants of the whole room.
        renderer.render(new T.Scene(),r.camera);renderer.compile(preview,r.camera);checkPrograms(renderer);
      }finally{renderer.setRenderTarget(previous);preview.remove(batch);}
      progress(Math.floor(i/16)+1,total);await yieldFrame();
    }
  }
  function samples(r,source){
    if(r.shaderSamples)return r.shaderSamples;
    const group=new T.Group(),adapter=Object.create(source);adapter.scene=group;
    const meat=P.makePatty({massG:150,thicknessMm:20,fatFrac:.2,tempC:6,dimple:true,work:.4,salt:'surface'});meat.cheeses.push({mass:.02,melt:.5});
    const patty=new root.BurgerRender.PattyView(adapter,meat);patty.setCutaway(true,0);patty.updateCheese();
    for(const kind of ['bun','bacon','egg','onions'])new root.BurgerRender.ItemView(adapter,P.makeItem(kind,{half:'top'}));
    for(const kind of ['tomato','pickles','lettuce','ketchup','mayo','mustard'])group.add(root.BurgerRender.coldLayer(kind,.05));
    group.add(new T.Mesh(new T.BoxGeometry(.02,.02,.02),new T.MeshBasicMaterial({color:0x6ec7a0,transparent:true,opacity:.18,depthWrite:false,side:T.DoubleSide})));
    for(const coloured of [false,true]){const ghost=new T.InstancedMesh(new T.BoxGeometry(.01,.01,.01),new T.MeshBasicMaterial({color:0x6ec7a0,transparent:true,opacity:.18,depthWrite:false,side:T.DoubleSide}),1);if(coloured)ghost.setColorAt(0,new T.Color(1,1,1));group.add(ghost);}
    group.traverse(o=>{o.visible=true;if(o.isMesh)o.frustumCulled=false;});
    group.position.set(0,0,-.4);group.name='Prepared cooking shaders';r.scene.add(group);group.visible=false;
    // Keep these few sample materials alive: disposing the last material releases its cached
    // shader, which would bring the first-cook stall back. They are never simulation entities.
    r.shaderSamples=group;return group;
  }
  async function prepare(r,{adapter=r.looseView,extra=[],progress=()=>{}}={}){
    if(r.prepared)return;
    if(r.preparation)return r.preparation;
    r.preparing=true;
    r.preparation=(async()=>{
      await yieldFrame();
      const group=samples(r,adapter),renderer=r.renderer,target=new T.WebGLRenderTarget(8,8),fog=r.scene.fog;r.scene.add(group);
      target.texture.encoding=renderer.outputEncoding;
      const materials=new Set();group.traverse(o=>{if(o.material)materials.add(o.material);});
      const plane=new T.Plane(new T.Vector3(0,1,0),1000);
      const air=r.airView||r,atmospheres=[air.cleanFog,air.smokeFog],batches=Math.ceil(objectsIn(r,extra).length/16),total=(batches+2)*atmospheres.length;
      let completed=0;progress(0,total);
      try{
        for(const atmosphere of atmospheres){
          const before=completed;await compileRoom(r,atmosphere,target,done=>progress(before+done,total),extra);completed+=batches;
          for(const sliced of [false,true]){
            const previous=renderer.getRenderTarget();
            try{
              r.scene.fog=atmosphere;group.visible=true;renderer.setRenderTarget(target);
              for(const material of materials){material.clippingPlanes=sliced?[plane]:null;material.clipShadows=sliced;material.needsUpdate=true;}
              renderer.render(r.scene,r.camera);checkPrograms(renderer);
            }finally{group.visible=false;r.scene.fog=fog;renderer.setRenderTarget(previous);}
            progress(++completed,total);await yieldFrame();
          }
        }
        r.prepared=true;
      }finally{
        group.visible=false;group.parent?.remove(group);group.traverse(o=>o.geometry?.dispose());r.scene.fog=fog;target.dispose();r.renderPending=true;
      }
    })().finally(()=>{r.preparing=false;r.preparation=null;});
    return r.preparation;
  }
  async function reflections(r,progress){
    const target=new T.WebGLRenderTarget(8,8);
    try{await compileRoom(r,r.scene.fog,target,progress);}finally{target.dispose();}
  }
  root.RealRender={prepare};
  root.RenderPreparation={prepare,reflections,yieldFrame};
})(window);
