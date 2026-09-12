'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../js/cheese-mesh');
function volume(g){
  const p=g.attributes.position.array,a=g.index.array;let v=0;
  for(let i=0;i<a.length;i+=3){const x=a[i]*3,y=a[i+1]*3,z=a[i+2]*3;
    v+=(p[x]*(p[y+1]*p[z+2]-p[y+2]*p[z+1])+p[x+1]*(p[y+2]*p[z]-p[y]*p[z+2])+p[x+2]*(p[y]*p[z+1]-p[y+1]*p[z]))/6;
  }return v;
}
test('cheese remains a closed outward-facing solid throughout melting',()=>{
  for(const fried of [false,true])for(const melt of [0,.5,1]){
    const g=C.create();C.update(g,{mass:.02,melt},{fried});
    const edges=new Map(),a=g.index.array;
    for(let i=0;i<a.length;i+=3)for(let j=0;j<3;j++){
      const x=a[i+j],y=a[i+(j+1)%3],key=[Math.min(x,y),Math.max(x,y)].join(':');
      const e=edges.get(key)||{count:0,winding:0};e.count++;e.winding+=x<y?1:-1;edges.set(key,e);
    }
    for(const e of edges.values()){assert.equal(e.count,2);assert.equal(e.winding,0);}
    assert.ok([...g.attributes.normal.array].every(Number.isFinite));
    assert.ok(Math.abs(volume(g)/(.02/C.density)-1)<.025,'sheet volume should follow cheese mass');
  }
});
test('fried cheese spreads and thins with melting and moisture loss',()=>{
  const g=C.create();C.update(g,{mass:.02,melt:0},{fried:true});g.computeBoundingBox();
  const width=g.boundingBox.max.x-g.boundingBox.min.x,thickness=g.userData.thickness;
  C.update(g,{mass:.0124,melt:1},{fried:true});g.computeBoundingBox();
  assert.ok(g.boundingBox.max.x-g.boundingBox.min.x>width*1.2);
  assert.ok(g.userData.thickness<thickness*.5);
  assert.ok(Math.abs(volume(g)/(.0124/C.density)-1)<.025);
});
