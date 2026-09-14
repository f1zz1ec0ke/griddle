/* Bounded render work shared by the first-person stations. Three.js r128. */
(function(root){
  'use strict';
  const T=root.THREE;
  class TextureBudget{
    constructor(){this.pending=new Set();this.begin();}
    begin(){this.next=this.pending.values().next().value;this.pending.delete(this.next);this.available=true;}
    claim(view){if(this.available&&(!this.next||this.next===view)){this.available=false;this.pending.delete(view);return true;}this.pending.add(view);return false;}
    clear(){this.pending.clear();this.begin();}
  }
  class StaticShadows{
    constructor(renderer,scene,fixed){
      this.renderer=renderer;this.scene=scene;this.fixed=new Set(fixed);this.entries=new Map();this.enabled=renderer.capabilities.isWebGL2;this.phase=null;
      // Three recreates its shadow renderer on context recovery; retain its normal rendering path.
      renderer.domElement.addEventListener('webglcontextrestored',()=>{for(const entry of this.entries.values())entry.cached.dispose();this.entries.clear();this.enabled=false;});
      const shadows=renderer.shadowMap,render=shadows.render,clear=renderer.clear,draw=renderer.renderBufferDirect;
      shadows.render=(lights,world,camera)=>{
        if(!this.enabled||world!==scene||!shadows.enabled||!shadows.autoUpdate&&!shadows.needsUpdate||shadows.type!==T.PCFSoftShadowMap||lights.some(l=>l.shadow.isPointLightShadow))return render.call(shadows,lights,world,camera);
        const stale=[];
        for(const light of lights){
          const shadow=light.shadow,map=shadow.map;
          if(!map)return render.call(shadows,lights,world,camera); // let Three allocate the initial targets
          const key=[...light.matrixWorld.elements,...light.target.matrixWorld.elements,...shadow.camera.projectionMatrix.elements,camera.layers.mask,map.width,map.height].join('/');
          let entry=this.entries.get(light);
          if(!entry||entry.output!==map||entry.key!==key){entry?.cached.dispose();entry={output:map,cached:map.clone(),key,valid:false};this.entries.set(light,entry);stale.push(light);}
        }
        try{
          if(stale.length){
            this.phase='static';
            for(const light of stale){light.shadow.map=this.entries.get(light).cached;light.shadow.needsUpdate=true;}
            try{render.call(shadows,stale,world,camera);for(const light of stale)this.entries.get(light).valid=true;}
            finally{for(const light of stale)light.shadow.map=this.entries.get(light).output;}
          }
          this.phase='moving';render.call(shadows,lights,world,camera);
        }finally{this.phase=null;}
      };
      renderer.clear=(...args)=>{
        if(this.phase==='moving'){
          const target=renderer.getRenderTarget();let entry;for(const candidate of this.entries.values())if(candidate.output===target&&candidate.valid){entry=candidate;break;}
          if(entry){
            // Copy both packed shadow colour and its depth buffer. Moving objects then depth-test
            // against the fixed room exactly as they do in an uncached shadow render.
            const gl=renderer.getContext(),state=renderer.state,source=renderer.properties.get(entry.cached).__webglFramebuffer,destination=renderer.properties.get(target).__webglFramebuffer;
            state.bindFramebuffer(gl.READ_FRAMEBUFFER,source);state.bindFramebuffer(gl.DRAW_FRAMEBUFFER,destination);
            gl.blitFramebuffer(0,0,target.width,target.height,0,0,target.width,target.height,gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT,gl.NEAREST);
            state.bindFramebuffer(gl.READ_FRAMEBUFFER,destination);return;
          }
        }
        return clear.apply(renderer,args);
      };
      renderer.renderBufferDirect=(camera,world,geometry,material,object,group)=>{
        if(this.phase==='static'&&!this.fixed.has(object)||this.phase==='moving'&&this.fixed.has(object))return;
        return draw.call(renderer,camera,world,geometry,material,object,group);
      };
    }
  }
  root.RenderWork={TextureBudget,StaticShadows};
})(typeof window==='undefined'?globalThis:window);
