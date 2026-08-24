export const STAGE_THEME_BOOTSTRAP = String.raw`(()=>{document.documentElement.classList.add('js');let choice=null;try{choice=localStorage.getItem('seer:theme')}catch(e){}const mode=choice==='light'||choice==='dark'?choice:'system';const dark=matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.themeMode=mode;document.documentElement.dataset.theme=mode==='system'?(dark?'dark':'light'):mode})();`;

export const STAGE_CLIENT = String.raw`(()=>{
  const root=document.documentElement;
  const dialog=document.querySelector('[data-focus-dialog]');
  const focusLayout=dialog?.querySelector('[data-focus-layout]');
  const repoDrawer=document.querySelector('[data-repo-rail]');
  const scrim=document.querySelector('[data-scrim]');
  const mq=matchMedia('(prefers-color-scheme: dark)');
  let opener=null;

  const theme=()=>{
    const mode=root.dataset.themeMode||'system';
    root.dataset.theme=mode==='system'?(mq.matches?'dark':'light'):mode;
    document.querySelectorAll('[data-theme-toggle]').forEach(button=>{
      button.setAttribute('aria-label','Theme: '+(mode==='system'?'System':mode==='dark'?'Dark mode':'Light mode'));
    });
  };
  mq.addEventListener('change',()=>{if((root.dataset.themeMode||'system')==='system')theme()});

  const pageChanges=()=>[...document.querySelectorAll('.walkthrough [data-change]')];
  const refreshProgress=()=>{
    const changes=pageChanges();
    const states=new Map(changes.map(item=>[item.dataset.change,item.dataset.read==='true']));
    const isRead=id=>states.get(id)===true;
    const read=changes.filter(item=>item.dataset.read==='true').length;
    document.querySelectorAll('[data-progress]').forEach(node=>node.textContent=read+' / '+changes.length+' read');
    document.querySelectorAll('[data-unread-summary]').forEach(node=>node.textContent=read===changes.length?'Read':(changes.length-read)+' unread');
    document.querySelectorAll('[data-tree-node]').forEach(node=>{
      const ids=(node.dataset.changeIds||'').split(',').filter(Boolean);
      const unread=ids.filter(id=>!isRead(id)).length;
      const summary=node.querySelector(':scope > summary [data-tree-summary]');
      if(summary)summary.textContent=node.dataset.files+' files · '+ids.length+' changes · '+unread+' unread';
    });
    document.querySelectorAll('[data-tree-file]').forEach(node=>{
      const ids=(node.dataset.changeIds||'').split(',').filter(Boolean);
      node.dataset.unread=String(ids.some(id=>!isRead(id)));
    });
    document.querySelectorAll('[data-group]').forEach(group=>{
      const ids=(group.dataset.changeIds||'').split(',').filter(Boolean);
      const target=group.querySelector('[data-group-progress]');
      if(target)target.textContent=ids.filter(isRead).length+' / '+ids.length+' read';
    });
  };

  const setRead=(id,read)=>{
    pageChanges().filter(item=>item.dataset.change===id).forEach(item=>{
      item.dataset.read=String(read);
      if(read)item.open=false;
      item.querySelectorAll('[data-read-input]').forEach(input=>input.value=read?'false':'true');
      item.querySelectorAll('[data-read-button]').forEach(button=>button.textContent=read?'Mark unread':'Mark as read');
      const state=item.querySelector('[data-read-state]');
      if(state)state.textContent=read?'read':'unread';
    });
    if(dialog?.open&&dialog.dataset.change===id){
      dialog.querySelectorAll('[data-read-input]').forEach(input=>input.value=read?'false':'true');
      dialog.querySelectorAll('[data-read-button]').forEach(button=>button.textContent=read?'Mark unread':'Mark as read');
      const state=dialog.querySelector('[data-read-state]');if(state)state.textContent=read?'read':'unread';
    }
    refreshProgress();
  };

  const observeDiffs=scope=>{
    if(!('ResizeObserver' in window))return;
    scope.querySelectorAll('[data-diff-frame]').forEach(frame=>{
      if(frame.__stageObserved)return;
      frame.__stageObserved=true;
      const observer=new ResizeObserver(entries=>{
        frame.dataset.layout=entries[0].contentRect.width>=1400?'split':'unified';
      });
      observer.observe(frame);
    });
  };

  const cleanFocusUrl=()=>{
    const url=new URL(location.href);
    url.searchParams.delete('focus');url.searchParams.delete('panel');
    url.searchParams.delete('tree');url.searchParams.delete('detail');
    url.hash='';return url;
  };

  const itemFor=id=>pageChanges().find(item=>item.dataset.change===id)||null;
  const fillFocus=id=>{
    const source=itemFor(id);if(!source||!dialog)return false;
    dialog.dataset.change=id;
    const title=dialog.querySelector('[data-focus-title]');if(title)title.textContent=source.dataset.path||'';
    const center=dialog.querySelector('[data-focus-center]');
    const detail=dialog.querySelector('[data-focus-detail-content]');
    if(center){center.replaceChildren();const inline=document.createElement('p');inline.className='focus-inline-description';inline.textContent=source.dataset.description||'';center.append(inline);const clone=source.querySelector('[data-review-core]')?.cloneNode(true);if(clone){const wrap=document.createElement('div');wrap.dataset.change=id;wrap.append(clone);center.append(wrap)}observeDiffs(center)}
    if(detail){detail.replaceChildren();const heading=document.createElement('h2');heading.textContent=source.dataset.groupTitle||'Change';const copy=document.createElement('p');copy.textContent=source.dataset.description||'';const signals=document.createElement('p');signals.className='item-meta';signals.textContent=source.dataset.signals||'';detail.append(heading,signals,copy)}
    return true;
  };

  const applyFocusPanels=url=>{
    if(!focusLayout)return;
    focusLayout.dataset.left=url.searchParams.get('tree')==='closed'?'closed':'open';
    focusLayout.dataset.right=url.searchParams.get('detail')==='closed'?'closed':'open';
    focusLayout.dataset.panel=url.searchParams.get('panel')||'';
  };

  const showFocus=(id,push)=>{
    if(!dialog)return;
    const sameChange=dialog.open&&dialog.dataset.change===id;
    if(!sameChange&&!fillFocus(id))return;
    if(!dialog.open)opener=document.activeElement;
    const current=new URL(location.href);const replacingFocus=current.searchParams.has('focus');
    const url=new URL(location.href);url.searchParams.set('focus',id);url.searchParams.delete('panel');url.hash=id;
    if(push){replacingFocus?history.replaceState(history.state,'',url):history.pushState({stageFocus:true},'',url)}
    applyFocusPanels(url);
    if(!dialog.open)dialog.showModal();
  };

  const hideFocus=fromHistory=>{
    if(!dialog?.open)return;
    dialog.close();dialog.dataset.change='';
    if(!fromHistory){
      if(history.state?.stageFocus)history.back();
      else history.replaceState(null,'',cleanFocusUrl());
    }
    if(opener instanceof HTMLElement)opener.focus();
  };

  const syncUrl=()=>{
    const url=new URL(location.href);
    const focus=url.searchParams.get('focus');
    if(focus){showFocus(focus,false);applyFocusPanels(url)}else if(dialog?.open)hideFocus(true);
    const repo=url.searchParams.get('panel')==='repository'&&!focus;
    if(repoDrawer)repoDrawer.dataset.open=String(repo);
    if(scrim){scrim.dataset.open=String(repo);scrim.hidden=!repo}
  };

  const setPanel=(name,value,push=true)=>{
    const url=new URL(location.href);
    if(value)url.searchParams.set(name,value);else url.searchParams.delete(name);
    (push?history.pushState:history.replaceState).call(history,push?{stagePanel:true}:history.state,'',url);
    syncUrl();
  };

  document.addEventListener('click',event=>{
    const target=event.target;
    if(!(target instanceof Element))return;
    const themeButton=target.closest('[data-theme-toggle]');
    if(themeButton){const modes=['light','dark','system'];const mode=modes[(modes.indexOf(root.dataset.themeMode||'system')+1)%3];root.dataset.themeMode=mode;try{mode==='system'?localStorage.removeItem('seer:theme'):localStorage.setItem('seer:theme',mode)}catch(e){}theme();return}
    document.querySelectorAll('details.wsmenu[open]').forEach(menu=>{if(!menu.contains(target))menu.open=false});
    const focus=target.closest('[data-focus-link]');if(focus){event.preventDefault();showFocus(focus.dataset.focus,true);return}
    if(target.closest('[data-focus-close]')){hideFocus(false);return}
    if(target.closest('[data-repo-open]')){setPanel('panel','repository');return}
    if(target.closest('[data-repo-close]')||target.closest('[data-scrim]')){if(history.state?.stagePanel)history.back();else setPanel('panel','',false);return}
    const pageTreeFile=target.closest('[data-tree-file]');if(pageTreeFile&&repoDrawer?.dataset.open==='true'){event.preventDefault();const url=new URL(pageTreeFile.href);url.searchParams.delete('panel');history.replaceState(null,'',url);syncUrl();document.getElementById(url.hash.slice(1))?.scrollIntoView();return}
    const toggle=target.closest('[data-focus-toggle]');
    if(toggle&&focusLayout){const side=toggle.dataset.focusToggle;const mobile=matchMedia('(max-width:760px)').matches;if(mobile){setPanel('panel',new URL(location.href).searchParams.get('panel')===side?'':side,false)}else{const key=side==='tree'?'tree':'detail';const current=new URL(location.href).searchParams.get(key);setPanel(key,current==='closed'?'':'closed',false)}return}
    const treeFocus=target.closest('[data-tree-focus]');if(treeFocus&&dialog?.open){event.preventDefault();showFocus(treeFocus.dataset.treeFocus,true)}
    const context=target.closest('[data-context-trigger]');if(context)loadContext(context);
  });

  document.addEventListener('submit',async event=>{
    const form=event.target;if(!(form instanceof HTMLFormElement)||!form.matches('.read-form'))return;
    event.preventDefault();const button=form.querySelector('[data-read-button]');if(button)button.disabled=true;
    try{const response=await fetch(form.action,{method:'POST',body:new FormData(form),headers:{accept:'application/json'}});if(!response.ok)throw new Error('Read state failed');const body=await response.json();setRead(body.changeId,body.read)}catch(error){const failure=form.querySelector('[data-read-failure]');if(failure)failure.textContent='Could not save'}finally{if(button)button.disabled=false}
  });

  const loadContext=async button=>{
    if(button.disabled)return;button.disabled=true;const host=button.closest('[data-context]');const output=host?.querySelector('[data-context-lines]');if(!output)return;
    output.textContent='Loading';
    try{const response=await fetch(button.dataset.contextUrl,{headers:{accept:'application/json'}});const body=await response.json();if(!response.ok)throw new Error(body.error||'Context unavailable');output.replaceChildren();for(const line of body.lines){const row=document.createElement('div');row.className='context-line';const number=document.createElement('span');number.textContent=String(line.number);const code=document.createElement('span');code.textContent=line.text;row.append(number,code);output.append(row)}button.remove()}catch(error){output.textContent=error.message||'Context unavailable';button.disabled=false}
  };

  dialog?.addEventListener('cancel',event=>{event.preventDefault();hideFocus(false)});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&dialog?.open){event.preventDefault();hideFocus(false)}});
  addEventListener('popstate',syncUrl);
  theme();observeDiffs(document);refreshProgress();syncUrl();
})();`;
