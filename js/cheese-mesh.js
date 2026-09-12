/* A closed, rounded sheet with continuous bends and mass-dependent thickness. */
(function(root){
  'use strict';
  const T=typeof module!=='undefined'&&module.exports?require('./vendor/three.min.js'):root.THREE;
  const density=.02/(.095*.095*.0014),segments=96,rings=20;
  function create(){
    const count=1+segments*rings,indices=[];
    for(let i=0;i<segments;i++)indices.push(0,1+(i+1)%segments,1+i);
    for(let j=0;j<rings-1;j++)for(let i=0;i<segments;i++){
      const a=1+j*segments+i,b=1+j*segments+(i+1)%segments,c=a+segments,d=b+segments;indices.push(a,b,c,b,d,c);
    }
    const top=indices.slice();for(let i=0;i<top.length;i+=3)indices.push(top[i]+count,top[i+2]+count,top[i+1]+count);
    for(let i=0;i<segments;i++){const a=1+(rings-1)*segments+i,b=1+(rings-1)*segments+(i+1)%segments;indices.push(a,b,a+count,b,b+count,a+count);}
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(new Float32Array(count*6),3));g.setAttribute('color',new T.Float32BufferAttribute(new Float32Array(count*6).fill(1),3));g.setIndex(indices);
    g.userData.sheet={count,top,mid:new Float32Array(count*3),norm:new Float32Array(count*3)};return g;
  }
  function update(g,ch,{radius=.05,height=.02,dome=0,layer=0,fried=false}={}){
    const {count,top,mid,norm}=g.userData.sheet,melt=Math.max(0,Math.min(1,ch.melt||0)),mass=Math.max(.00001,ch.mass??.02);
    const exponent=8-5*melt,half=.0475*(1+(fried?.25:.045)*melt),floor=.0009+layer*.0011;
    for(let i=0;i<count;i++){
      const j=i?1+Math.floor((i-1)/segments):0,a=i?((i-1)%segments)/segments*Math.PI*2:0,t=j/rings,c=Math.cos(a),s=Math.sin(a);
      const edge=half/Math.pow(Math.pow(Math.abs(c),exponent)+Math.pow(Math.abs(s),exponent),1/exponent);
      const r=t*edge*(1+.022*melt*Math.sin(a*5+(ch.rot||0))*t*t);
      let rr=r,y=floor;
      if(!fried){
        const topY=height*(1+.28*dome)+layer*.0015+.0008;
        const over=Math.max(0,r-radius),bend=Math.min(.003,height*.18),arc=Math.PI*bend/2,drop=Math.max(0,topY-floor-2*bend);
        let dr=r,dy=topY;
        if(over>0){
          if(over<arc){const u=over/bend;dr=radius+bend*Math.sin(u);dy=topY-bend*(1-Math.cos(u));}
          else if(over<arc+drop){dr=radius+bend;dy=topY-bend-(over-arc);}
          else if(over<2*arc+drop){const u=(over-arc-drop)/bend;dr=radius+bend+bend*(1-Math.cos(u));dy=floor+bend*(1-Math.sin(u));}
          else {dr=radius+2*bend+over-2*arc-drop;dy=floor;}
        }else dy-=height*.28*dome*(r/radius)**2;
        rr=r+(dr-r)*melt;y=topY+(dy-topY)*melt;
      }else y+=.00012*melt*Math.sin(a*4)*t*t;
      mid[i*3]=rr*c;mid[i*3+1]=y;mid[i*3+2]=rr*s;
    }
    norm.fill(0);let area=0;
    for(let k=0;k<top.length;k+=3){
      const a=top[k]*3,b=top[k+1]*3,c=top[k+2]*3,ux=mid[b]-mid[a],uy=mid[b+1]-mid[a+1],uz=mid[b+2]-mid[a+2],vx=mid[c]-mid[a],vy=mid[c+1]-mid[a+1],vz=mid[c+2]-mid[a+2];
      const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;area+=Math.hypot(x,y,z)/2;
      for(const n of [a,b,c]){norm[n]+=x;norm[n+1]+=y;norm[n+2]+=z;}
    }
    const thickness=mass/(density*Math.max(area,1e-8)),p=g.attributes.position;
    for(let i=0;i<count;i++){
      const k=i*3,length=Math.hypot(norm[k],norm[k+1],norm[k+2])||1;
      for(let side=0;side<2;side++){const d=(side?-.5:.5)*thickness/length;p.setXYZ(i+side*count,mid[k]+norm[k]*d,mid[k+1]+norm[k+1]*d,mid[k+2]+norm[k+2]*d);}
    }
    p.needsUpdate=true;g.computeVertexNormals();g.computeBoundingSphere();g.userData.thickness=thickness;g.userData.surfaceArea=area;
  }
  const api={create,update,density};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CheeseMesh=api;
})(typeof window!=='undefined'?window:globalThis);
