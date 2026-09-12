/* First-person hand geometry. Metres; joints curl from the knuckles, not the mesh centres. */
(function(root){
  'use strict';
  const T=root.THREE,A=root.KitchenAssets;
  function loft(sections,segments=24){
    const pos=[],uv=[],index=[];
    for(let j=0;j<sections.length;j++){
      const [z,w,h,cy=0]=sections[j];
      for(let i=0;i<=segments;i++){
        const a=i/segments*Math.PI*2,c=Math.cos(a),s=Math.sin(a);
        pos.push(w*Math.sign(c)*Math.pow(Math.abs(c),.72),cy+h*Math.sign(s)*Math.pow(Math.abs(s),.85),z);uv.push(i/segments,j/(sections.length-1));
        if(j&&i){const k=j*(segments+1)+i;index.push(k,k-segments-1,k-1,k-1,k-segments-1,k-segments-2);}
      }
    }
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(index);g.computeVertexNormals();return g;
  }
  function hand(side){
    const group=new T.Group();group.name=side<0?'Left chef hand':'Right chef hand';
    const skin=new T.MeshStandardMaterial({color:0xbe8d73,roughness:.76});skin.color.convertSRGBToLinear();
    const nailMat=new T.MeshStandardMaterial({color:0xd3ae99,roughness:.48});nailMat.color.convertSRGBToLinear();
    const mesh=(g,parent=group)=>{const m=new T.Mesh(g,skin);m.userData.skin=true;m.castShadow=m.receiveShadow=true;parent.add(m);return m;};
    mesh(loft([[.037,0,0],[.035,.020,.012],[.018,.023,.013],[0,.034,.014],[-.018,.037,.013],[-.037,.034,.010],[-.042,0,0]]));
    const fingers=[];
    function digit(x,z,length,width,thumb=false){
      const base=new T.Group();base.position.set(x,-.001,z);group.add(base);const joints=[];let parent=base;
      for(let j=0;j<3;j++){
        const l=length*[.43,.33,.24][j],w=width*(1-j*.12),joint=new T.Group();parent.add(joint);joints.push(joint);
        mesh(loft([[.002,w*.83,w*.74],[0,w,w*.8],[-l*.35,w*.96,w*.78],[-l*.78,w*.88,w*.73],[-l,w*.72,w*.66],[-l-.001,j===2?0:w*.65,j===2?0:w*.6]]),joint);
        if(j===2){const nail=new T.Mesh(A.roundedBox(w*1.3,.0008,l*.64,.0015,3),nailMat);nail.userData.nail=true;nail.position.set(0,w*.73,-l*.50);nail.rotation.x=.08;joint.add(nail);}
        parent=new T.Group();parent.position.z=-l;joint.add(parent);
      }
      const digit={base,joints,thumb};fingers.push(digit);return digit;
    }
    const lengths=[.062,.070,.065,.052];
    for(let i=0;i<4;i++){const d=digit((i-1.5)*.018*side,-.035+Math.abs(i-1.1)*.002,lengths[i],i===3?.007:.008);d.base.rotation.y=(1.5-i)*side*.05;}
    const thumb=digit(-side*.031,.007,.050,.009,true);thumb.base.rotation.y=side*.75;thumb.base.rotation.z=side*.45;
    const glove=A.material('paint',0xb96043);glove.roughness=.95;glove.clearcoat=0;
    group.userData.rig={fingers,skin,glove,side};pose(group,0,false);return group;
  }
  function pose(group,grip,point,gloved=false){
    const rig=group.userData.rig;if(rig.gloved!==gloved){group.traverse(o=>{if(o.userData.skin)o.material=gloved?rig.glove:rig.skin;if(o.userData.nail)o.visible=!gloved;});rig.gloved=gloved;}
    group.userData.rig.fingers.forEach((d,i)=>{
      const curl=point&&i===0?.02:typeof grip==='number'?grip:d.thumb?grip.thumb:grip.curl[i];
      if(d.thumb){d.base.rotation.y=rig.side*(.45-curl*1.75);d.base.rotation.z=rig.side*(.35-curl*.22);}
      d.joints.forEach((j,k)=>j.rotation.x=-(d.thumb?[.18,.28,.15][k]+curl*[.28,.5,.35][k]:[.10,.18,.12][k]+curl*[.80,1.02,.65][k]));
    });
  }
  function apron(){
    const pos=[],uv=[],idx=[],cols=24,rows=30;
    for(let j=0;j<=rows;j++){
      const t=j/rows,y=.63+t*.67,width=.215-.072*Math.pow(t,4);
      for(let i=0;i<=cols;i++){
        const u=i/cols,x=(u*2-1)*width;
        let z=-.13-.12*Math.exp(-(((y-.94)/.19)**2));
        for(const [cy,cz,rx,ry,rz] of [[1.12,.035,.2184,.294,.1484],[.94,-.08,.24,.216,.204]]){
          const q=(x/rx)**2+((y-cy)/ry)**2;if(q<1)z=Math.min(z,cz-rz*Math.sqrt(1-q)-.007);
        }
        z-=.003*Math.sin(u*Math.PI*8)*Math.sin(t*Math.PI);
        pos.push(x,y,z);uv.push(u,t);
        if(j&&i){const k=j*(cols+1)+i;idx.push(k,k-cols-1,k-1,k-1,k-cols-1,k-cols-2);}
      }
    }
    const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(pos,3));geometry.setAttribute('uv',new T.Float32BufferAttribute(uv,2));geometry.setIndex(idx);geometry.computeVertexNormals();
    const material=A.material('paint',0x547b67);material.side=T.DoubleSide;material.roughness=.94;material.clearcoat=0;return new T.Mesh(geometry,material);
  }
  root.ChefRig={hand,pose,loft,apron};
})(window);
