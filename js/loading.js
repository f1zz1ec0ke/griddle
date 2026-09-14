/* Loaded before the engine: progress reflects completed work, never elapsed-time guesses. */
(function(root){
  'use strict';
  const $=id=>document.getElementById(id),screen=$('boot-screen'),bar=$('boot-progress');
  const loading={ready:false,failed:false,progress:0,
    update(stage,fraction,label,detail=''){
      if(this.failed)return;
      this.progress=Math.max(this.progress,Math.min(1,(stage+fraction)/3));
      bar.value=this.progress;$('boot-percent').textContent=Math.floor(this.progress*100)+'%';
      if($('boot-label').textContent!==label)$('boot-label').textContent=label;$('boot-detail').textContent=detail;
      bar.setAttribute('aria-valuetext',Math.floor(this.progress*100)+'% · '+label);
      for(const [i,item] of [...screen.querySelectorAll('.boot-stages li')].entries())item.dataset.state=i<stage||fraction===1&&i===stage?'done':i===stage?'active':'waiting';
    },
    fail(error){
      if(this.ready||this.failed)return;
      this.failed=true;screen.dataset.error='true';$('view').setAttribute('aria-busy','false');
      $('boot-title').textContent="Couldn't get the kitchen ready.";
      $('boot-copy').textContent=error?.download?'Some kitchen files didn’t load. Check your connection, then reload.':'Please reload and try again. Your saved kitchens are safe.';
      $('boot-work').hidden=true;$('boot-retry').hidden=false;$('boot-retry').focus();
      console.error('Kitchen startup failed:',error);
    },
  };
  $('boot-retry').onclick=()=>location.reload();
  root.addEventListener('error',event=>{if(event.target?.tagName==='SCRIPT')loading.fail({download:true});else if(event.error)loading.fail(event.error);},true);
  root.GriddleLoading=loading;
})(window);
