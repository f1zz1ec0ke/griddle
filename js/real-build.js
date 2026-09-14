/* Real assembly can begin on bread; the first patty becomes the cooking-state owner. */
(function(root){
  'use strict';
  const P=typeof module==='object'?require('./physics'):root.BurgerPhysics,A=typeof module==='object'?require('./assembly'):root.BurgerAssembly;
  const coldKinds={tomatoSlice:'tomato',pickleSlice:'pickles',lettuce:'lettuce',ketchup:'ketchup',mayo:'mayo',mustard:'mustard'};
  const methods={
    labels:{meatLean:'90/10 mince pack',meatRich:'70/30 mince pack',bunWhole:'whole bun',meat:'mince pack',pickles:'whole pickle',onion:'whole onion',cheeseBlock:'cheese block',tomatoSlice:'tomato slice',pickleSlice:'pickle slice',coal:'charcoal bag',press:'smash plate',glove:'oven glove',butter:'butter dish',brush:'grill brush',rake:'coal rake',timer:'kitchen timer',ashpan:'ash catcher'},
    rootOf(e){return e?.stackRoot?this.get(e.stackRoot):e;},
    layers(e){e=this.rootOf(e);return e?.prep||e?.food?.assembly||[];},
    stackState(e){return e.prep?{...e.food,assembly:e.prep}:e.food;},
    name(e){if(!e)return '';if(this.layers(e).length)return this.rootOf(e).kind==='patty'?'burger':A.closed(this.stackState(this.rootOf(e)))?'sandwich':'dressed bottom bun';return e.kind==='bun'?(e.food.half==='top'?'top bun':'bottom bun'):this.labels[e.kind]||e.label;},
    cheeseCount(e){const base=this.rootOf(e),stack=this.layers(base);return stack.length?stack.reduce((n,l)=>n+(l.cheese?1:l.patty?(l.meat||base.food).cheeses.length+(l.meat||base.food).cheeseUnder.length:0),0):base?.kind==='patty'?base.food.cheeses.length+base.food.cheeseUnder.length:0;},
    topPart(base){base=this.rootOf(base);const stack=this.layers(base),l=stack.at(-1),meat=!l&&base?.kind==='patty'?base:l?.patty?(l.meat?this.entities.find(e=>e.food===l.meat):base):null;
      if(meat){const ch=meat.food.cheeses.at(-1),slice=this.entities.find(e=>!e.discarded&&e.cheeseCarrier===meat.id&&e.sliceState===ch);return slice||meat;}
      return !l?null:l.item?this.entities.find(e=>e.food===l.item):this.entities.find(e=>e.stackRoot===base.id&&e.layer===stack.length-1);
    },
    peel(base){
      base=this.rootOf(base);const stack=this.layers(base);if(!base||base.held||this.accessProblem(base))return null;
      const slice=this.topPart(base);if(slice?.cheeseCarrier){const meat=this.get(slice.cheeseCarrier);meat.food.cheeses=meat.food.cheeses.filter(ch=>ch!==slice.sliceState);slice.cheeseCarrier=null;slice.pos=meat.pos.slice();return slice;}
      if(!stack.length||base.station||base.panCarrier)return null;
      const l=stack.at(-1),part=this.topPart(base);if(!part||part===base&&base.prep)return null;
      if(part===base){
        // Leave every layer beneath the meat on its original bun, in its original order.
        const below=stack.slice(0,-1),bottom=this.entities.find(e=>e.food===below[0]?.item),plate=this.get(base.trayCarrier),pos=base.pos.slice();
        A.unpack(base.food);base.food.manualAssembly=false;if(plate)this.detach(base);
        for(const e of this.entities.filter(q=>q.stackRoot===base.id)){e.stackRoot=null;e.layer=null;if(e.food){e.food.assembledTo=null;e.food.burger=null;}}
        if(bottom){bottom.pos=pos;bottom.prep=below.length>1?below:undefined;bottom.food.prepAssembly=bottom.prep;for(const [i,layer] of below.entries()){const e=i===0?bottom:layer.item?this.entities.find(q=>q.food===layer.item):this.entities.find(q=>q.id===layer.entityId);if(!e)continue;if(i){e.stackRoot=bottom.id;e.layer=i;}if(e.food)e.food.assembledTo=bottom.prep?bottom.id:null;}if(plate)this.putOnTray(bottom,plate);}
      }else{
        stack.pop();if(l.meat)l.meat.assembledTo=null;if(l.item){l.item.assembledTo=null;l.item.burger=null;}part.stackRoot=null;part.layer=null;if(l.cold)part.coldState=l;
        if(base.prep?.length===1){delete base.prep;delete base.food.prepAssembly;base.food.assembledTo=null;}
      }
      return part;
    },
    assemblyProblem(held,target){
      const base=this.rootOf(target);if(!base||!held||held===base||held.discarded||base.discarded||held.stackRoot)return 'Choose another ingredient.';
      if(base.station||base.panCarrier||held.station||held.panCarrier)return 'Take the food off the heat before building.';
      if(this.layers(held).length)return 'Lift the layers with E before combining these.';
      const stack=this.layers(base),onBun=base.kind==='bun'&&base.food.half==='bottom';
      if(base.food&&A.closed(this.stackState(base)))return 'Lift the top bun with E first.';
      if(held.kind==='bun'&&held.food.half==='bottom'&&base.kind==='patty'&&!stack.length)return null;
      if(this.attachedProbe(base))return 'Remove the probe before adding another layer.';
      if(!onBun&&!stack.length)return 'Start on a bottom bun. Add the patty whenever you like.';
      if(held.kind==='patty'){const plate=this.get(base.trayCarrier);if(plate&&(plate.kind!=='plate'||held.food.D>.22))return 'That burger will not fit on this plate.';return stack.filter(l=>l.patty).length>=2?'Two patties is plenty.':null;}
      if(held.kind==='bun')return held.food.half!=='top'?'The bottom bun is already in place.':null;
      if(held.kind==='cheese')return this.cheeseCount(base)>=4?'Four cheese slices is plenty.':null;
      const cold=coldKinds[held.kind];if(cold)return stack.filter(l=>l.cold===cold).length>=(A.cold[cold].sauce?1:4)?'There is enough '+held.label+' on this burger.':null;
      return held.food&&held.kind!=='pan'?null:'Prepare that ingredient first.';
    },
    assemble(held,target){
      const base=this.rootOf(target);if(this.assemblyProblem(held,base))return false;
      if(held.kind==='bun'&&held.food.half==='bottom'&&base.kind==='patty'&&!this.layers(base).length){const plate=this.get(base.trayCarrier),pos=base.pos.slice();if(!this.assemble(base,held))return false;base.pos=pos;if(plate)this.putOnTray(base,plate);return true;}
      if(base.kind==='bun'){
        if(held.kind==='patty'){
          const plate=this.get(base.trayCarrier),stack=base.prep||[{item:base.food}],pos=base.pos.slice();this.detach(held);this.detach(base);delete base.prep;delete base.food.prepAssembly;
          held.food.assembly=stack;held.food.manualAssembly=true;stack.push({patty:true});held.pos=pos;held.held=false;
          for(const [i,l] of stack.entries()){if(l.patty)continue;const q=l.item?this.entities.find(e=>e.food===l.item):this.get(l.entityId);q.held=false;q.stackRoot=held.id;q.layer=i;if(q.food){q.food.assembledTo=held.id;q.food.burger=held.id;}}
          if(plate)this.putOnTray(held,plate);return true;
        }
        base.prep ||= [{item:base.food}];base.food.prepAssembly=base.prep;base.food.assembledTo=base.id;
      }
      const stack=this.layers(base),cold=coldKinds[held.kind];let layer,part=held;
      if(cold){layer=held.coldState||{cold,T:6,age:0};if(held.massG)layer.mass=held.massG/1000;if(held.sliceMm)layer.height=held.sliceMm/1000;layer.single=cold==='pickles';if(A.cold[cold].sauce)part=this.entity(cold,cold,base.pos);}
      else if(held.kind==='cheese'){held.sliceState ||= {T:held.temperature??6,mass:(held.massG||20)/1000,melt:0,rot:0,overhang:0,contact:0};layer={cheese:held.sliceState};}
      else if(held.kind==='patty'){layer={patty:true,meat:held.food};}
      else layer={item:held.food};
      if(held.food)this.detach(held);layer.entityId=part.id;part.stackRoot=base.id;part.layer=stack.length;part.held=false;stack.push(layer);
      if(part.food){part.food.assembledTo=base.id;part.food.burger=base.id;}
      return true;
    }
  };
  if(typeof module==='object')module.exports=methods;else root.RealBuildMethods=methods;
})(typeof window!=='undefined'?window:globalThis);
