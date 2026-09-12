/* Small, deterministic material library. Maps are shared for the viewport lifetime. */
(function(root){
  'use strict';
  const T=root.THREE, cache=new Map(), shared=new Set();
  function texture(kind){
    if(cache.has(kind))return cache.get(kind);
    let seed=9173;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    const cv=document.createElement('canvas');cv.width=cv.height=512;const c=cv.getContext('2d');
    c.fillStyle='#cccccc';c.fillRect(0,0,512,512);
    const im=c.getImageData(0,0,512,512);
    for(let y=0;y<512;y++)for(let x=0;x<512;x++){
      const n=rand(),grain=Math.sin(y*.8+Math.sin(x*.016)*4)+.4*Math.sin(y*2.4+x*.004);
      let v=kind==='wood'?208+grain*7+n*8:kind==='iron'?170+n*65:kind==='stone'?238+n*10:kind==='bread'?207+n*30:210+n*22;
      const k=(y*512+x)*4;im.data[k]=im.data[k+1]=im.data[k+2]=v;im.data[k+3]=255;
    }
    c.putImageData(im,0,0);
    if(kind==='bread'){
      for(let i=0;i<60;i++){const x=rand()*512,y=rand()*512,r=12+rand()*45,g=c.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,'rgba(90,63,33,.12)');g.addColorStop(1,'rgba(90,63,33,0)');c.fillStyle=g;c.fillRect(x-r,y-r,r*2,r*2);}
      for(let i=0;i<1700;i++){c.fillStyle='rgba(70,50,30,.2)';c.beginPath();c.ellipse(rand()*512,rand()*512,.3+rand()*.7,.3+rand()*.4,0,0,Math.PI*2);c.fill();}
    }
    if(kind==='pickle'){
      c.fillStyle='#bec475';c.fillRect(0,0,512,512);
      const g=c.createRadialGradient(256,256,20,256,256,256);g.addColorStop(0,'#d2d194');g.addColorStop(.75,'#a4b65e');g.addColorStop(.90,'#8ca045');g.addColorStop(.94,'#4c6a30');g.addColorStop(1,'#344d24');c.fillStyle=g;c.fillRect(0,0,512,512);
      for(let i=0;i<24;i++){const a=i*2.4,r=40+rand()*130,x=256+Math.cos(a)*r,y=256+Math.sin(a)*r;c.fillStyle='#e9dba0';c.beginPath();c.ellipse(x,y,5+rand()*4,2+rand()*2,a,0,Math.PI*2);c.fill();}
    }
    if(kind==='mince')for(let i=0;i<9000;i++){
      const x=rand()*512,y=rand()*512,a=rand()*6.28,len=2+rand()*9;
      c.lineCap='round';c.lineWidth=1.5+rand()*2;c.strokeStyle='rgba(65,46,40,.25)';c.beginPath();c.moveTo(x,y);c.quadraticCurveTo(x+Math.cos(a)*len,y+Math.sin(a)*len,x+Math.cos(a+.4)*len,y+Math.sin(a+.4)*len);c.stroke();
      c.lineWidth=.7;c.strokeStyle='rgba(255,245,226,.35)';c.stroke();
    }
    if(kind==='wood'){
      for(let y=0;y<512;y+=64){c.fillStyle='rgba(50,27,10,.16)';c.fillRect(0,y,512,1);}
      for(let i=0;i<65;i++){c.strokeStyle='rgba(58,32,12,.10)';c.lineWidth=.4+rand();const y=rand()*512;c.beginPath();c.moveTo(0,y);c.bezierCurveTo(170,y+rand()*10,330,y-5,512,y);c.stroke();}
    }
    if(kind==='steel'||kind==='carbon'){
      for(let i=0;i<230;i++){const r=8+i*1.1;c.strokeStyle=`rgba(255,255,255,${.03+rand()*.1})`;c.lineWidth=.3+rand()*.6;c.beginPath();c.arc(256,256,r,0,Math.PI*2);c.stroke();}
      for(let i=0;i<55;i++){const x=rand()*512,y=rand()*512;c.strokeStyle='rgba(60,60,60,.13)';c.lineWidth=.35;c.beginPath();c.moveTo(x,y);c.lineTo(x+rand()*90-45,y+rand()*60-30);c.stroke();}
    }
    if(kind==='stone')for(let i=0;i<2000;i++){c.fillStyle=i%3?'rgba(110,102,88,.1)':'rgba(255,255,255,.4)';c.beginPath();c.ellipse(rand()*512,rand()*512,.3+rand()*1.2,.4+rand(),0,0,Math.PI*2);c.fill();}
    const map=new T.CanvasTexture(cv);map.encoding=T.sRGBEncoding;map.wrapS=map.wrapT=T.RepeatWrapping;map.anisotropy=8;
    const relief=map.clone();relief.encoding=T.LinearEncoding;relief.needsUpdate=true;
    const result={map,relief};cache.set(kind,result);shared.add(map);shared.add(relief);return result;
  }
  function material(kind,color){
    const look={wood:[.58,0,.00022],stone:[.48,0,.00010],iron:[.72,.35,.00013],carbon:[.42,.82,.000035],steel:[.27,1,.000018],bread:[.56,0,.00012],paint:[.44,0,.000025],ceramic:[.20,0,.00002],rubber:[.86,0,.00008]}[kind]||[.55,0,0];
    const m=new T.MeshPhysicalMaterial({color,roughness:look[0],metalness:look[1],envMapIntensity:kind==='steel'?1:.65});m.color.convertSRGBToLinear();
    if(['wood','stone','iron','carbon','steel','bread'].includes(kind)){const t=texture(kind);m.map=t.map;m.bumpMap=t.relief;m.bumpScale=look[2];}
    if(kind==='paint'||kind==='ceramic'||kind==='bread'){m.clearcoat=kind==='bread'?.18:.28;m.clearcoatRoughness=.28;}
    return m;
  }
  // Filleted solid, retaining exact outside dimensions. UVs stay on the original box faces.
  function roundedBox(w,h,d,r=.003,segments=3){
    r=Math.min(r,w*.22,h*.22,d*.22);
    const count=segments*2+1,g=new T.BoxGeometry(w,h,d,count,count,count),p=g.attributes.position,n=g.attributes.normal,uv=g.attributes.uv;
    const edge=(v,size)=>{const j=Math.round((v/size+.5)*count);return j<=segments?-size/2+r*j/segments:size/2-r*(count-j)/segments;};
    for(let i=0;i<p.count;i++){
      const x=edge(p.getX(i),w),y=edge(p.getY(i),h),z=edge(p.getZ(i),d),cx=Math.max(-w/2+r,Math.min(w/2-r,x)),cy=Math.max(-h/2+r,Math.min(h/2-r,y)),cz=Math.max(-d/2+r,Math.min(d/2-r,z));
      uv.setXY(i,Math.abs(n.getX(i))>.5?z/d+.5:x/w+.5,Math.abs(n.getY(i))>.5?z/d+.5:y/h+.5);
      const v=new T.Vector3(x-cx,y-cy,z-cz).normalize();p.setXYZ(i,cx+v.x*r,cy+v.y*r,cz+v.z*r);n.setXYZ(i,v.x,v.y,v.z);
    }return g;
  }
  root.KitchenAssets={material,texture,roundedBox,shared};
})(window);
