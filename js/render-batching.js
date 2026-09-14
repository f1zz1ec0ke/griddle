/* Join fixed, opaque scenery without changing its surfaces, lighting or interaction targets. */
(function(root){
  'use strict';
  const T=root.THREE;
  const ignored=new Set(['uuid','name','color','vertexColors','version','userData']);
  function materialKey(material){
    return JSON.stringify(Object.keys(material).sort().filter(k=>!ignored.has(k)).map(k=>{
      const v=material[k];return [k,v?.isTexture?v.uuid:v?.toArray?v.toArray():v];
    }));
  }
  function batchStatic(scene,excluded=[]){
    const skip=new Set(excluded),groups=new Map(),geometryRefs=new Map(),materialRefs=new Map();
    const count=(map,key,n=1)=>map.set(key,(map.get(key)||0)+n);
    scene.updateMatrixWorld(true);
    const sceneInverse=new T.Matrix4().copy(scene.matrixWorld).invert();
    scene.traverse(o=>{if(o.geometry)count(geometryRefs,o.geometry);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])count(materialRefs,m);});
    function visit(o){
      if(skip.has(o)||!o.visible)return;
      const m=o.material,g=o.geometry;
      if(o.isMesh&&!o.isInstancedMesh&&!o.isSkinnedMesh&&!o.children.length&&!o.userData.realTarget&&g&&m&&!Array.isArray(m)
        &&(m.isMeshStandardMaterial||m.isMeshBasicMaterial)&&m.visible&&!m.transparent&&m.opacity===1&&!m.clippingPlanes&&!m.wireframe&&!m.transmission
        &&m.onBeforeCompile===T.Material.prototype.onBeforeCompile&&o.onBeforeRender===T.Object3D.prototype.onBeforeRender
        &&!Object.keys(g.morphAttributes).length&&g.drawRange.start===0&&g.drawRange.count===Infinity
        &&Object.entries(g.attributes).every(([name,a])=>['position','normal','uv','uv2','color'].includes(name)&&!a.isInterleavedBufferAttribute&&!a.normalized&&a.array instanceof Float32Array)){
        // Keep batches local so looking away still culls shelves and cabinets behind the chef.
        const p=new T.Vector3().setFromMatrixPosition(o.matrixWorld),cell=[Math.floor(p.x/2),Math.floor(p.z/2)];
        const attrs=Object.keys(g.attributes).filter(k=>k!=='color').sort().map(k=>[k,g.attributes[k].itemSize]);
        const key=JSON.stringify([cell,materialKey(m),attrs,o.castShadow,o.receiveShadow,o.renderOrder,o.layers.mask,o.frustumCulled]);
        if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o);
      }
      for(const child of o.children)visit(child);
    }
    visit(scene);
    const report={sourceMeshes:0,batches:0,triangles:0};
    for(const meshes of groups.values()){
      if(meshes.length<2)continue;
      const first=meshes[0],vertices=meshes.reduce((n,o)=>n+o.geometry.attributes.position.count,0),indices=meshes.reduce((n,o)=>n+(o.geometry.index?.count||o.geometry.attributes.position.count),0);
      const merged=new T.BufferGeometry(),names=Object.keys(first.geometry.attributes).filter(k=>k!=='color');
      for(const name of names){const size=first.geometry.attributes[name].itemSize;merged.setAttribute(name,new T.BufferAttribute(new Float32Array(vertices*size),size));}
      merged.setAttribute('color',new T.BufferAttribute(new Float32Array(vertices*3),3));
      const index=new (vertices>65535?Uint32Array:Uint16Array)(indices);let vertexOffset=0,indexOffset=0;
      for(const mesh of meshes){
        const matrix=new T.Matrix4().multiplyMatrices(sceneInverse,mesh.matrixWorld),geometry=mesh.geometry.clone().applyMatrix4(matrix),n=geometry.attributes.position.count,sourceColor=geometry.attributes.color,color=merged.attributes.color.array,tint=mesh.material.color;
        for(const name of names)merged.attributes[name].array.set(geometry.attributes[name].array,vertexOffset*geometry.attributes[name].itemSize);
        for(let i=0;i<n;i++){const at=(vertexOffset+i)*3;color[at]=tint.r;color[at+1]=tint.g;color[at+2]=tint.b;if(mesh.material.vertexColors&&sourceColor){color[at]*=sourceColor.getX(i);color[at+1]*=sourceColor.getY(i);color[at+2]*=sourceColor.getZ(i);}}
        const source=geometry.index,ni=source?.count||n,mirrored=matrix.determinant()<0;
        for(let i=0;i<ni;i+=3){const a=(source?source.getX(i):i)+vertexOffset,b=(source?source.getX(i+1):i+1)+vertexOffset,c=(source?source.getX(i+2):i+2)+vertexOffset;index[indexOffset++]=a;index[indexOffset++]=mirrored?c:b;index[indexOffset++]=mirrored?b:c;}
        vertexOffset+=n;geometry.dispose();
      }
      merged.setIndex(new T.BufferAttribute(index,1));merged.computeBoundingBox();merged.computeBoundingSphere();
      const material=first.material.clone();material.color.setRGB(1,1,1);material.vertexColors=true;
      const batch=new T.Mesh(merged,material);batch.name='Fixed kitchen surfaces';batch.castShadow=first.castShadow;batch.receiveShadow=first.receiveShadow;batch.renderOrder=first.renderOrder;batch.layers.mask=first.layers.mask;batch.frustumCulled=first.frustumCulled;batch.matrixAutoUpdate=false;scene.add(batch);
      // Keep the logical asset hierarchy for bounds queries. Its hidden source meshes no longer
      // draw or own GPU resources; movable and interactive meshes were excluded above.
      for(const mesh of meshes){mesh.visible=false;mesh.userData.renderBatched=true;mesh.matrixAutoUpdate=false;count(geometryRefs,mesh.geometry,-1);count(materialRefs,mesh.material,-1);}
      report.sourceMeshes+=meshes.length;report.batches++;report.triangles+=indices/3;
    }
    for(const [geometry,n] of geometryRefs)if(!n)geometry.dispose();
    for(const [material,n] of materialRefs)if(!n)material.dispose();
    return report;
  }
  root.RenderBatching={batchStatic};
})(typeof window==='undefined'?globalThis:window);
