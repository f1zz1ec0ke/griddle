/* Grip points are in the existing model's metres, after its floor normalization. */
(function(root){
  'use strict';
  const pi=Math.PI;
  const poses={
    handle:{wrist:[0,pi/2,0],contact:[0,-.025,-.052],curl:[.72,.82,.86,.9],thumb:.85},
    cup:{wrist:[0,0,pi],contact:[0,-.017,-.042],curl:[.16,.19,.23,.28],thumb:.25},
    pinch:{wrist:[0,0,-pi/2],contact:[0,-.020,-.062],curl:[.40,.60,.76,.82],thumb:.9},
    bottle:{wrist:[0,0,-pi/2],contact:[0,-.026,-.046],curl:[.47,.56,.62,.66],thumb:.65},
    flat:{wrist:[0,0,0],contact:[0,-.015,-.045],curl:[.03,.05,.08,.12],thumb:.25}
  };
  function profile(e,height=.05){
    const p={pose:'cup',grip:[0,0,0],rotation:[0,0,0],level:true,support:null,tip:null};
    switch(e.kind){
      case 'spatula': Object.assign(p,{pose:'handle',grip:[0,.022,.115],tip:[0,.003,-.02]});break;
      case 'knife': case 'tongs': case 'spoon': Object.assign(p,{pose:'handle',grip:[0,.013,.085],tip:[0,.019,e.kind==='spoon'?-.09:-.065]});break;
      case 'probe': Object.assign(p,{pose:'handle',grip:[0,height/2,-.117],rotation:[0,pi,0],tip:[0,height/2,0]});break;
      case 'pan': {
        const radius=(e.pan?.diam||.30)/2,wall=e.panType==='castiron'?.041:e.panType==='carbonsteel'?.037:.043;
        const rim=radius*(e.panType==='carbonsteel'?1.14:1.075),depth=e.panType==='nonstick'?.013:.007;
        Object.assign(p,{pose:'handle',grip:[-rim+.012-.135*Math.cos(.15),wall-.004+.135*Math.sin(.15)-depth/2,0],rotation:[0,pi/2,0]});break;
      }
      case 'press': Object.assign(p,{pose:'handle',grip:[0,.067,0],wrist:[0,0,0]});break;
      case 'lid': Object.assign(p,{pose:'pinch',grip:[0,height-.009,0]});break;
      case 'tray': Object.assign(p,{pose:'pinch',grip:[.133,.0075,.08],support:(e.trayT||21)<=55?[-.15,0,.08]:null});break;
      case 'salt': case 'oil': case 'water': case 'ketchup': case 'mayo': case 'mustard': case 'lighter':
        Object.assign(p,{pose:'bottle',grip:[0,Math.min(height*.46,.055),0],spout:[0,height,0],pour:e.kind!=='lighter'});break;
      case 'cloth': Object.assign(p,{pose:'flat',grip:[0,height,0]});break;
      case 'glove': Object.assign(p,{pose:'handle',grip:[0,0,0]});break;
      case 'coal': case 'wood': Object.assign(p,{pose:'bottle',grip:[.045,height*.55,0],support:[-.045,.025,0],spout:[0,height,0],pour:true});break;
      case 'meat': Object.assign(p,{grip:[.055,0,0],support:[-.055,0,0],spout:[0,0,-.06],pour:true});break;
      case 'cheese': case 'tomatoSlice': case 'pickleSlice': case 'lettuce':
        Object.assign(p,{pose:'pinch',grip:[.035,height*.5,0]});break;
      case 'cheeseBlock': Object.assign(p,{grip:[.04,0,0],support:[-.045,0,0]});break;
      case 'bunWhole': Object.assign(p,{grip:[.018,0,0]});break;
      case 'patty': if(e.food?.assembly?.length)Object.assign(p,{grip:[.032,0,0],support:[-.04,0,0]});break;
      case 'egg': if(!e.food)Object.assign(p,{pose:'bottle',grip:[0,height*.45,0]});break;
      case 'pickles': Object.assign(p,{pose:'bottle',grip:[0,height*.5,0],rotation:[pi/2,0,0]});break;
      case 'bacon': Object.assign(p,{pose:'pinch',grip:[0,height*.5,.035]});break;
    }
    return Object.assign({},poses[p.pose],p);
  }
  const api={profile,poses};if(typeof module==='object'&&module.exports)module.exports=api;else root.RealGrips=api;
})(typeof window==='object'?window:globalThis);
