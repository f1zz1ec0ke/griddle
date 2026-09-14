/* One startup path. Neither mode can start cooking while the shared renderer is preparing. */
(function(root){
  'use strict';
  const loading=root.GriddleLoading,paint=root.RenderPreparation?.yieldFrame;
  async function build(owner,start,end){
    const steps=owner.buildSteps();
    for(const [i,step] of steps.entries()){
      const report=(done,total)=>loading.update(0,start+(end-start)*(i+done/total)/steps.length,step.label);
      report(0,1);await paint();
      if(step.reflection)await root.RenderPreparation.reflections(owner,(done,total)=>report(done,total+1));
      step.run();report(1,1);await paint();
    }
  }
  async function start(){
    if(loading.failed)return;
    if(!paint||!root.Game||!root.RealMode||!root.BurgerRender||!root.RealPresentation){loading.fail({download:true});return;}
    await paint();loading.update(0,0,'Starting graphics');await paint();
    const vp=new root.BurgerRender.Viewport(document.getElementById('view'),null,true);
    await build(vp,0,.5);
    root.game=new root.Game(vp);root.RealPresentation.mount();
    root.realMode=new root.RealMode(root.game,true);await build(root.realMode,.5,1);
    const compile=(stage,label)=>{
      loading.update(stage,0,label);
      return (done,total)=>loading.update(stage,done/total,label,done+' / '+total+' shader batches');
    };
    // Legacy equipment can be swapped at any point. Prepare every stove and pan with Legacy's
    // own lighting, using the already-built Real station assets as a material catalogue.
    const extra=[...root.realMode.stations.values()].map(st=>st.scene);
    await root.RenderPreparation.prepare(vp,{adapter:vp,extra,progress:compile(1,'Compiling Original shaders')});
    await root.RealRender.prepare(root.realMode,{progress:compile(2,'Compiling Real shaders')});
    if(loading.failed)return;
    loading.update(2,1,'Ready to cook','Both kitchens are ready.');await paint();
    loading.ready=true;document.body.dataset.experience='choose';document.getElementById('view').setAttribute('aria-busy','false');
    document.getElementById('boot-screen').hidden=true;document.getElementById('mode-choice').hidden=false;
    document.getElementById('choose-legacy').focus();
  }
  root.griddleReady=start().catch(error=>loading.fail(error));
})(window);
