'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),T=require('../js/vendor/three.min.js');
globalThis.THREE=T;require('../js/render-batching');require('../js/render-work');
const {batchStatic}=globalThis.RenderBatching,{TextureBudget}=globalThis.RenderWork;
const mesh=(color=0xffffff)=>new T.Mesh(new T.BoxGeometry(.2,.2,.2),new T.MeshStandardMaterial({color}));
test('static batching preserves transformed vertices, normals, UVs, colours and mirrored winding',()=>{
 const scene=new T.Scene();scene.position.set(3,0,2);scene.rotation.y=.2;
 const group=new T.Group();group.position.set(.6,.3,.6);group.rotation.y=.3;scene.add(group);
 const a=mesh(0x775522),b=mesh(0x224466);b.position.x=.2;b.scale.set(-1.2,.8,1);group.add(a,b);
 a.castShadow=b.castShadow=true;a.receiveShadow=b.receiveShadow=true;scene.updateMatrixWorld(true);
 const assetBounds=new T.Box3().setFromObject(group);
 const expected=[a,b].map(o=>({p:o.geometry.clone().applyMatrix4(o.matrixWorld).attributes.position.array.slice(),uv:o.geometry.attributes.uv.array.slice(),color:o.material.color.clone()}));
 const report=batchStatic(scene);assert.equal(report.sourceMeshes,2);assert.equal(report.batches,1);assert.equal(report.triangles,24);
 const batch=scene.children.find(o=>o.name==='Fixed kitchen surfaces');scene.updateMatrixWorld(true);
 const actual=batch.geometry.clone().applyMatrix4(batch.matrixWorld),pos=actual.attributes.position.array,uv=actual.attributes.uv.array,col=actual.attributes.color.array;
 let offset=0;for(const part of expected){part.p.forEach((v,i)=>assert.ok(Math.abs(v-pos[offset*3+i])<1e-6));part.uv.forEach((v,i)=>assert.equal(v,uv[offset*2+i]));for(let i=0;i<part.p.length/3;i++)for(const [j,k] of ['r','g','b'].entries())assert.ok(Math.abs(col[(offset+i)*3+j]-part.color[k])<1e-6);offset+=part.p.length/3;}
 const p=actual.attributes.position,n=actual.attributes.normal,index=actual.index;
 for(let i=0;i<index.count;i+=3){const ids=[index.getX(i),index.getX(i+1),index.getX(i+2)],v=ids.map(id=>new T.Vector3().fromBufferAttribute(p,id));const face=v[1].sub(v[0]).cross(v[2].sub(v[0])).normalize();assert.ok(face.dot(new T.Vector3().fromBufferAttribute(n,ids[0]))>.999);}
 assert.ok(batch.castShadow&&batch.receiveShadow);
 const afterBounds=new T.Box3().setFromObject(group);assert.ok(afterBounds.min.distanceTo(assetBounds.min)<1e-6&&afterBounds.max.distanceTo(assetBounds.max)<1e-6,'named assets retain their bounds after batching');
});
test('moving groups, targets, invisible surfaces and transparent materials retain their original meshes',()=>{
 const scene=new T.Scene(),moving=new T.Group();scene.add(moving);
 const originals=[mesh(),mesh(),mesh(),mesh()];moving.add(originals[0]);originals[1].userData.realTarget={type:'knob'};originals[2].visible=false;originals[3].material.transparent=true;scene.add(...originals.slice(1));
 const a=mesh(),b=mesh();scene.add(a,b);const report=batchStatic(scene,[moving]);assert.equal(report.sourceMeshes,2);
 for(const o of originals)assert.ok(o.parent);moving.position.x=2;scene.updateMatrixWorld(true);assert.equal(originals[0].getWorldPosition(new T.Vector3()).x,2);
});
test('batching keeps textures and shadow settings separate and does not dispose geometry used by a target',()=>{
 const scene=new T.Scene(),a=mesh(),b=mesh(),target=mesh(),different=mesh();target.geometry=a.geometry;target.userData.realTarget={type:'surface'};
 let disposed=false;a.geometry.addEventListener('dispose',()=>disposed=true);different.material.roughness=.2;scene.add(a,b,target,different);
 assert.equal(batchStatic(scene).batches,1);assert.equal(disposed,false);assert.ok(target.parent&&different.parent);
});
test('one shared texture slot serves every dirty patty fairly across stations',()=>{
 const budget=new TextureBudget(),views=[{},{},{},{}],counts=new Map(views.map(v=>[v,0]));
 for(let frame=0;frame<16;frame++){budget.begin();let granted=0;for(const view of views)if(budget.claim(view)){granted++;counts.set(view,counts.get(view)+1);}assert.equal(granted,1);}
 assert.deepEqual([...counts.values()],[4,4,4,4]);
 budget.clear();assert.equal(budget.pending.size,0);assert.ok(budget.claim({}));
});
