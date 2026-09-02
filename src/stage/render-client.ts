export const STAGE_THEME_BOOTSTRAP = String.raw`(()=>{document.documentElement.classList.add('js');let choice=null;try{choice=localStorage.getItem('seer:theme')}catch(e){}const mode=choice==='light'||choice==='dark'?choice:'system';const dark=matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.themeMode=mode;document.documentElement.dataset.theme=mode==='system'?(dark?'dark':'light'):mode})();`;

export const STAGE_CLIENT = String.raw`(()=>{
  const root=document.documentElement;
  const body=document.body;
  const dialog=document.querySelector('[data-focus-dialog]');
  const reviewNav=document.querySelector('[data-review-nav]');
  const pageDetails=document.querySelector('[data-page-details]');
  const pageScrim=document.querySelector('[data-page-scrim]');
  const background=document.querySelector('[data-stage-background]');
  const mq=matchMedia('(prefers-color-scheme: dark)');
  const changeIds=(body.dataset.stageChangeIds||'').split(',').filter(Boolean);
  const readIds=new Set((body.dataset.stageReadIds||'').split(',').filter(Boolean));
  const acknowledgementIds=(body.dataset.stageAcknowledgementIds||'').split(',').filter(Boolean);
  const acknowledgedIds=new Set((body.dataset.stageAcknowledgedIds||'').split(',').filter(Boolean));
  let opener=null;
  let reviewRequest=0;
  let activeObserver=null;
  let pendingPanelAction=null;
  let lineSelection=null;
  let draggingLines=false;
  let draggedLines=false;
  let dragStartLine=null;
  let suppressLineClick=false;
  let touchLine=false;

  const theme=()=>{
    const mode=root.dataset.themeMode||'system';
    root.dataset.theme=mode==='system'?(mq.matches?'dark':'light'):mode;
    document.querySelectorAll('[data-theme-toggle]').forEach(button=>button.setAttribute('aria-label','Theme: '+(mode==='system'?'System':mode==='dark'?'Dark mode':'Light mode')));
  };
  mq.addEventListener('change',()=>{if((root.dataset.themeMode||'system')==='system')theme()});

  const idsOf=node=>(node?.dataset.changeIds||'').split(',').filter(Boolean);
  const acknowledgementIdsOf=node=>(node?.dataset.acknowledgementIds||'').split(',').filter(Boolean);
  const readCount=ids=>ids.filter(id=>readIds.has(id)).length;
  const acknowledgementCount=ids=>ids.filter(id=>acknowledgedIds.has(id)).length;
  const handledCount=(ids,acknowledgements)=>readCount(ids)+acknowledgementCount(acknowledgements);
  const refreshJudgments=()=>{
    document.querySelectorAll('.judgment').forEach(section=>{
      const rows=[...section.querySelectorAll('[data-judgment-blocker]')];let blocked=0;
      for(const row of rows){const missing=!acknowledgedIds.has(row.dataset.judgmentBlocker);row.hidden=!missing;if(missing)blocked++}
      const list=section.querySelector('.judgment-blockers');if(list)list.hidden=blocked===0;
      section.querySelectorAll('.judgment-form button[type=submit]').forEach(button=>button.disabled=blocked>0);
    });
  };
  const updateTreeRead=(node,ids)=>{
    const read=readCount(ids);
    node.classList.toggle('is-read',ids.length>0&&read===ids.length);
    node.replaceChildren();const mark=document.createElement('i');mark.setAttribute('aria-hidden','true');node.append(mark,document.createTextNode(read+'/'+ids.length));
  };
  const refreshProgress=()=>{
    body.dataset.stageReadIds=[...readIds].join(',');body.dataset.stageAcknowledgedIds=[...acknowledgedIds].join(',');
    const handled=handledCount(changeIds,acknowledgementIds),total=changeIds.length+acknowledgementIds.length,label=handled+' / '+total+' handled';
    document.querySelectorAll('[data-progress]').forEach(node=>node.textContent=label);
    document.querySelectorAll('[data-progress-fill]').forEach(node=>node.style.width=(total?Math.round(handled/total*100):100)+'%');
    document.querySelectorAll('[data-unread-summary]').forEach(node=>node.textContent=label);
    document.querySelectorAll('[data-group]').forEach(group=>{
      const ids=idsOf(group),acks=acknowledgementIdsOf(group),count=handledCount(ids,acks),target=group.querySelector('[data-group-progress]');if(target)target.textContent=count+' / '+(ids.length+acks.length)+' handled';
    });
    document.querySelectorAll('[data-group-nav-progress]').forEach(node=>{const ids=idsOf(node),acks=acknowledgementIdsOf(node);node.textContent=handledCount(ids,acks)+'/'+(ids.length+acks.length)});
    document.querySelectorAll('[data-tree-node]').forEach(node=>{
      const ids=idsOf(node);const summary=node.querySelector(':scope > summary [data-tree-summary]');const state=summary?.querySelector('.tree-read');if(state)updateTreeRead(state,ids);
    });
    document.querySelectorAll('.tree-file,.focus-tree-file').forEach(node=>{
      const ids=idsOf(node.closest('.focus-tree-file')||node);const state=node.querySelector('.tree-read');if(state)updateTreeRead(state,ids);
    });
    document.querySelectorAll('[data-activate-change]').forEach(node=>node.dataset.read=String(readIds.has(node.dataset.activateChange)));
    document.querySelectorAll('[data-change]').forEach(node=>{
      const id=node.dataset.change;const read=readIds.has(id);node.dataset.read=String(read);node.classList.toggle('is-read',read);
      node.querySelectorAll('[data-read-input]').forEach(input=>input.value=read?'false':'true');
      node.querySelectorAll('[data-read-button]').forEach(button=>button.textContent=read?'Mark unread':'Mark read');
      node.querySelectorAll('[data-read-state]>span:last-child').forEach(state=>state.textContent=read?'Read':'Unread');
    });
    document.querySelectorAll('.file-review').forEach(file=>{
      const hunks=[...file.querySelectorAll('.hunk-review[data-change]')];const target=file.querySelector('[data-file-progress]');if(target)target.textContent=hunks.filter(hunk=>readIds.has(hunk.dataset.change)).length+' / '+hunks.length+' read';
    });
    refreshJudgments();applyUnreadFilter();
  };

  const setCollapsed=(hunk,collapsed)=>{
    if(!hunk)return;hunk.dataset.collapsed=String(collapsed);const button=hunk.querySelector('[data-toggle-change]');if(button){button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',(collapsed?'Expand ':'Collapse ')+(hunk.querySelector('.hunk-header code')?.textContent||'change'))}
  };
  const setRead=(id,read)=>{
    read?readIds.add(id):readIds.delete(id);
    if(read)document.querySelectorAll('.hunk-review[data-change]').forEach(hunk=>{if(hunk.dataset.change===id)setCollapsed(hunk,true)});
    refreshProgress();
  };
  const setAcknowledged=(id,acknowledged,view)=>{
    acknowledged?acknowledgedIds.add(id):acknowledgedIds.delete(id);
    const carried=acknowledged&&view?.provenance?.kind==='carried'?' · from rev '+view.provenance.sourceRevision:'';
    document.querySelectorAll('.acknowledgement-form').forEach(form=>{
      if(form.dataset.acknowledgementItem!==id)return;
      const input=form.elements.namedItem('acknowledged'),state=form.querySelector('.acknowledgement-state'),button=form.querySelector('button[type=submit]');
      if(input)input.value=acknowledged?'false':'true';if(state)state.textContent=acknowledged?'Acknowledged'+carried:'Needs acknowledgement';if(button){button.textContent=acknowledged?'Undo':'Acknowledge';button.disabled=false}
    });
    refreshProgress();
  };

  const observeDiffs=scope=>{
    if(!('ResizeObserver' in window))return;
    scope.querySelectorAll('[data-diff-frame]').forEach(frame=>{
      if(frame.__stageObserved)return;frame.__stageObserved=true;
      const observer=new ResizeObserver(entries=>{frame.dataset.layout=entries[0].contentRect.width>=1400?'split':'unified'});observer.observe(frame);
    });
  };

  const baseUrl=()=>{
    const url=new URL(location.href);for(const key of ['review','change','panel','tree','detail'])url.searchParams.delete(key);url.hash='';return url;
  };
  const urlForReview=(review,change=null)=>{
    const url=baseUrl();url.searchParams.delete('page');url.searchParams.set('review',review);if(change)url.searchParams.set('change',change);url.hash=change||'review-'+review;return url;
  };
  const findChange=(selector,id)=>[...document.querySelectorAll(selector)].find(node=>(node.dataset.change||node.dataset.ledgerChange||node.dataset.activateChange)===id)||null;
  const scrollInside=(container,node,block='nearest')=>{
    if(!container||!node)return;const outer=container.getBoundingClientRect(),inner=node.getBoundingClientRect();let delta=0;
    if(block==='center')delta=inner.top-outer.top-(outer.height-inner.height)/2;else if(block==='start')delta=inner.top-outer.top;else if(inner.top<outer.top)delta=inner.top-outer.top;else if(inner.bottom>outer.bottom)delta=inner.bottom-outer.bottom;
    if(!delta)return;if(typeof container.scrollBy==='function')container.scrollBy({top:delta,behavior:'smooth'});else container.scrollTop+=delta;
  };

  const activateChange=(id,{scrollCode=false,scrollLedger=false,writeUrl=false}={})=>{
    if(!id||!dialog?.open)return;
    const hunk=findChange('.hunk-review[data-change]',id);if(!hunk)return;
    dialog.dataset.activeChange=id;
    document.querySelectorAll('.hunk-review[data-change]').forEach(node=>node.classList.toggle('is-active',node.dataset.change===id));
    document.querySelectorAll('[data-ledger-change]').forEach(node=>node.classList.toggle('is-active',node.dataset.ledgerChange===id));
    document.querySelectorAll('[data-activate-change]').forEach(node=>node.classList.toggle('is-active',node.dataset.activateChange===id));
    if(scrollCode)scrollInside(dialog.querySelector('[data-focus-stream]'),hunk,'center');
    if(scrollLedger)scrollInside(dialog.querySelector('.focus-ledger'),findChange('[data-ledger-change]',id),'nearest');
    const all=[...dialog.querySelectorAll('.hunk-review[data-change]')];const position=all.findIndex(node=>node.dataset.change===id);dialog.querySelectorAll('[data-focus-change-position]').forEach(node=>node.textContent=(position+1)+' / '+all.length);
    if(writeUrl){const url=new URL(location.href);url.searchParams.set('change',id);url.hash=id;history.replaceState(history.state,'',url)}
  };

  const observeActiveChanges=()=>{
    activeObserver?.disconnect?.();activeObserver=null;if(!('IntersectionObserver' in window)||!dialog?.open)return;
    const stream=dialog.querySelector('[data-focus-stream]');if(!stream)return;
    const intersecting=new Set();activeObserver=new IntersectionObserver(entries=>{
      for(const entry of entries)entry.isIntersecting?intersecting.add(entry.target):intersecting.delete(entry.target);
      const bounds=stream.getBoundingClientRect();const focusY=bounds.top+bounds.height/2;
      const visible=[...intersecting].map(node=>({node,bounds:node.getBoundingClientRect()}));
      visible.sort((a,b)=>{const distance=item=>item.bounds.top<=focusY&&item.bounds.bottom>=focusY?0:Math.min(Math.abs(item.bounds.top-focusY),Math.abs(item.bounds.bottom-focusY));return distance(a)-distance(b)||a.bounds.top-b.bounds.top});
      const change=visible[0]?.node?.dataset.change;if(change&&change!==dialog.dataset.activeChange)activateChange(change,{scrollLedger:true,writeUrl:true});
    },{root:stream,threshold:[.25,.55,.85]});
    dialog.querySelectorAll('.hunk-review[data-change]').forEach(node=>activeObserver.observe(node));
  };

  const applyUnreadFilter=()=>{
    if(!dialog)return;const button=dialog.querySelector('[data-filter-unread]');const enabled=button?.getAttribute('aria-pressed')==='true';
    dialog.querySelectorAll('[data-ledger-change]').forEach(card=>card.classList.toggle('is-filtered',enabled&&readIds.has(card.dataset.ledgerChange)));
  };

  const isMobile=()=>matchMedia('(max-width:760px)').matches;
  const setReviewOpen=open=>{if(!background)return;background.toggleAttribute('inert',open);open?background.setAttribute('aria-hidden','true'):background.removeAttribute('aria-hidden')};
  const applyFocusPanels=url=>{
    const layout=dialog?.querySelector('[data-focus-layout]');if(!layout)return;
    layout.dataset.left=url.searchParams.get('tree')==='closed'?'closed':'open';layout.dataset.right=url.searchParams.get('detail')==='closed'?'closed':'open';
    const panel=url.searchParams.get('panel');layout.dataset.panel=panel==='tree'||panel==='detail'?panel:'';
    const scrim=layout.querySelector('[data-focus-panel-close]');if(scrim)scrim.hidden=!layout.dataset.panel;
  };

  const ensureModal=()=>{
    if(!dialog)return;setReviewOpen(true);let modal=false;try{modal=dialog.matches(':modal')}catch(e){}
    if(modal)return;if(dialog.open)dialog.removeAttribute('open');dialog.showModal();
  };

  const prepareDialog=()=>{
    if(!dialog?.dataset.review)return;observeDiffs(dialog);refreshProgress();applyFocusPanels(new URL(location.href));
    const wanted=new URL(location.href).searchParams.get('change')||dialog.dataset.activeChange||dialog.querySelector('.hunk-review[data-change]')?.dataset.change;
    if(wanted)activateChange(wanted);const layout=dialog.querySelector('[data-focus-layout]');if(layout)layout.scrollTop=0;const groups=dialog.querySelector('.focus-group-links');const activeGroup=groups?.querySelector('.focus-group-link.is-active');if(groups&&activeGroup)groups.scrollTop=Math.max(0,activeGroup.offsetTop-groups.offsetTop-6);observeActiveChanges();
  };

  const restoreAcknowledgements=()=>{
    if(!background||!dialog)return;const hosts=new Map([...background.querySelectorAll('[data-acknowledgement-host]')].map(node=>[node.dataset.acknowledgementHost,node]));for(const form of [...dialog.querySelectorAll('.acknowledgement-form')])hosts.get(form.dataset.acknowledgementItem)?.append(form)
  };
  const installDialog=next=>{
    restoreAcknowledgements();
    const fragment=document.createDocumentFragment();for(const node of [...next.childNodes])fragment.append(node.cloneNode(true));
    const held=document.querySelector('.judgment'),replacement=fragment.querySelector('.judgment');if(held&&replacement){held.remove();replacement.replaceWith(held)}
    const currentForms=new Map([...document.querySelectorAll('.acknowledgement-form')].map(form=>[form.dataset.acknowledgementItem,form]));for(const replacementForm of [...fragment.querySelectorAll('.acknowledgement-form')]){const current=currentForms.get(replacementForm.dataset.acknowledgementItem);if(current){current.remove();replacementForm.replaceWith(current)}}
    dialog.replaceChildren(fragment);
    dialog.dataset.review=next.dataset.review||'';dialog.dataset.layer=next.dataset.layer||'';dialog.dataset.page=next.dataset.page||'';dialog.dataset.activeChange=next.dataset.activeChange||'';dialog.setAttribute('aria-label',next.getAttribute('aria-label')||'Group review');
  };

  const openReview=async(review,change,{mode='push'}={})=>{
    if(!dialog||!review)return;
    const target=mode==='none'?new URL(location.href):urlForReview(review,change);if(mode==='replace'&&dialog.open){const current=new URL(location.href);for(const key of ['tree','detail'])if(current.searchParams.has(key))target.searchParams.set(key,current.searchParams.get(key))}const same=dialog.dataset.review===review&&(dialog.dataset.layer||'')===(target.searchParams.get('layer')||'')&&(dialog.dataset.page||'')===(target.searchParams.get('page')||'')&&dialog.querySelector('.hunk-review[data-change]');
    if(!same){
      const request=++reviewRequest;
      let response;try{response=await fetch(target,{headers:{accept:'text/html'}})}catch(error){location.assign(target);return}
      if(!response.ok){location.assign(target);return}
      const parsed=new DOMParser().parseFromString(await response.text(),'text/html');const next=parsed.querySelector('[data-focus-dialog][data-review]');
      if(request!==reviewRequest)return;if(!next){location.assign(target);return}installDialog(next);
    }
    if(!dialog.open)opener=document.activeElement;
    if(mode==='push')history.pushState({stageReview:true,directReview:false},'',target);else if(mode==='replace')history.replaceState({...history.state,stageReview:true,directReview:history.state?.directReview===true},'',target);
    ensureModal();prepareDialog();if(change)activateChange(change,{scrollCode:true,scrollLedger:true});
  };

  const closeInstalledDialog=()=>{restoreAcknowledgements();const host=document.querySelector('[data-judgment-host=overview]'),judgment=dialog?.querySelector('.judgment');if(host&&judgment)host.append(judgment);dialog?.close()};
  const closeFocus=(direct=false)=>{
    if(!dialog?.open)return;reviewRequest++;
    if(history.state?.stageFocusPanel){if(direct){pendingPanelAction=()=>closeFocus(true);history.back()}else closeFocusPanel();return}
    if(new URL(location.href).searchParams.has('layer')){if(direct&&history.state?.stageLayer){pendingPanelAction=()=>closeFocus(true);history.back()}else closeLayer();return}
    if(!background){if(history.state?.stageReview&&!history.state?.directReview)history.back();else location.replace(baseUrl());return}
    if(history.state?.directReview){history.replaceState(null,'',baseUrl());closeInstalledDialog();setReviewOpen(false);activeObserver?.disconnect?.();if(opener instanceof HTMLElement)opener.focus();return}
    if(history.state?.stageReview)history.back();else{history.replaceState(null,'',baseUrl());closeInstalledDialog();setReviewOpen(false);activeObserver?.disconnect?.();if(opener instanceof HTMLElement)opener.focus()}
  };

  const syncUrl=async()=>{
    const url=new URL(location.href);const review=url.searchParams.get('review');
    if(review){
      if(dialog?.dataset.review!==review||(dialog.dataset.layer||'')!==(url.searchParams.get('layer')||'')||(dialog.dataset.page||'')!==(url.searchParams.get('page')||''))await openReview(review,url.searchParams.get('change'),{mode:'none'});
      else{ensureModal();prepareDialog();const change=url.searchParams.get('change');if(change)activateChange(change)}
    }else if(dialog?.open){closeInstalledDialog();setReviewOpen(false);activeObserver?.disconnect?.();if(opener instanceof HTMLElement)opener.focus()}else if(!review)setReviewOpen(false);
    const pagePanel=!review&&url.searchParams.get('panel')==='review-navigation',detailPanel=!review&&url.searchParams.get('panel')==='details';if(reviewNav)reviewNav.dataset.open=String(pagePanel);if(pageDetails)pageDetails.dataset.open=String(detailPanel);if(pageScrim){pageScrim.dataset.open=String(pagePanel||detailPanel);pageScrim.hidden=!pagePanel&&!detailPanel}
  };

  const closePagePanel=()=>{
    if(history.state?.stagePagePanel)history.back();else{const url=new URL(location.href);url.searchParams.delete('panel');history.replaceState(history.state,'',url);syncUrl()}
  };
  const openFocusPanel=side=>{
    const url=new URL(location.href);const current=url.searchParams.get('panel');
    if(current===side){if(history.state?.stageFocusPanel)history.back();else{url.searchParams.delete('panel');history.replaceState(history.state,'',url);syncUrl()}return}
    url.searchParams.set('panel',side);const panelState={...history.state,stageFocusPanel:true,directReview:history.state?.directReview??!history.state?.stageReview};if(current)history.replaceState(panelState,'',url);else history.pushState(panelState,'',url);syncUrl();
  };
  const closeFocusPanel=()=>{
    if(history.state?.stageFocusPanel)history.back();else{const url=new URL(location.href);url.searchParams.delete('panel');history.replaceState(history.state,'',url);syncUrl()}
  };
  const afterFocusPanel=action=>{
    if(history.state?.stageFocusPanel){pendingPanelAction=action;history.back()}else action();
  };

  // The layer is a history rung between the panel and the review: Back and Escape drop it
  // before they close the review. Switching layer replaces the rung; leaving it pops it.
  const layerState=()=>({stageLayer:true,stageReview:true,directReview:history.state?.directReview===true});
  const closeLayer=()=>{
    if(history.state?.stageLayer){history.back();return}
    const url=new URL(location.href);url.searchParams.delete('layer');url.searchParams.delete('page');url.searchParams.delete('change');url.hash='review-'+(url.searchParams.get('review')||'');history.replaceState(history.state,'',url);syncUrl();
  };
  const openLayer=slug=>{
    if(!dialog?.open)return;if(!slug){closeLayer();return}
    const url=new URL(location.href);if(!url.searchParams.get('review'))return;
    url.searchParams.set('layer',slug);url.searchParams.delete('page');url.searchParams.delete('change');url.hash='review-'+url.searchParams.get('review');
    if(history.state?.stageLayer)history.replaceState(layerState(),'',url);else history.pushState(layerState(),'',url);syncUrl();
  };
  const stepLayer=direction=>{
    const options=[...(dialog?.querySelectorAll('[data-scope] option')||[])].map(option=>option.value).filter(Boolean);if(!options.length)return;
    const current=options.indexOf(new URL(location.href).searchParams.get('layer')||'');const next=direction>0?Math.min(current+1,options.length-1):current-1;
    if(next===current)return;openLayer(next<0?null:options[next]);
  };

  const loadContext=async button=>{
    if(button.disabled)return;button.disabled=true;const host=button.closest('[data-context]');const output=host?.querySelector('[data-context-lines]');if(!output)return;
    output.textContent='Loading';
    try{const response=await fetch(button.dataset.contextUrl,{headers:{accept:'application/json'}});const body=await response.json();if(!response.ok)throw new Error(body.error||'Context unavailable');output.replaceChildren();for(const line of body.lines){const row=document.createElement('div');row.className='context-line';const number=document.createElement('span');number.textContent=String(line.number);const code=document.createElement('span');code.textContent=line.text;row.append(number,code);output.append(row)}button.remove()}catch(error){output.textContent=error.message||'Context unavailable';button.disabled=false}
  };

  const threadSubmissionBody=form=>{const input=form.elements.namedItem('idempotencyKey');const fields=[...new FormData(form).entries()].filter(([name])=>name!=='idempotencyKey').map(([name,value])=>[name,String(value)]);const signature=JSON.stringify(fields);if(form.dataset.submissionSignature!==signature){if(input)input.value=crypto.randomUUID();form.dataset.submissionSignature=signature}return new FormData(form)};
  const refreshGithubReviewPreview=form=>{const preview=form.querySelector('[data-github-review-preview]');if(!preview)return;const body=form.elements.namedItem('body')?.value?.trim()||'',include=form.elements.namedItem('includeLocalComment')?.checked===true,local=include?(form.dataset.localComment||''):'';preview.textContent=body&&local?body+'\n\n'+local:body||local;preview.hidden=!preview.textContent};
  document.addEventListener('input',event=>{const form=event.target?.closest?.('.github-review-form');if(form)refreshGithubReviewPreview(form)});
  document.addEventListener('change',event=>{const form=event.target?.closest?.('.github-review-form');if(form)refreshGithubReviewPreview(form)});

  document.addEventListener('click',event=>{
    const target=event.target;if(!(target instanceof Element))return;
    const themeButton=target.closest('[data-theme-toggle]');if(themeButton){const modes=['light','dark','system'];const mode=modes[(modes.indexOf(root.dataset.themeMode||'system')+1)%3];root.dataset.themeMode=mode;try{mode==='system'?localStorage.removeItem('seer:theme'):localStorage.setItem('seer:theme',mode)}catch(e){}theme();return}
    document.querySelectorAll('details.wsmenu[open]').forEach(menu=>{if(!menu.contains(target))menu.open=false});
    const pageGroup=target.closest('.group-links a[href^="#"]');if(pageGroup&&reviewNav?.dataset.open==='true'){event.preventDefault();const url=new URL(location.href);url.searchParams.delete('panel');url.hash=pageGroup.hash;history.replaceState(null,'',url);syncUrl();document.getElementById(pageGroup.hash.slice(1))?.scrollIntoView?.({behavior:'smooth',block:'start'});return}
    const focus=target.closest('[data-focus-link]');if(focus){event.preventDefault();openReview(focus.dataset.review,focus.dataset.change||null,{mode:dialog?.open?'replace':'push'});return}
    const group=target.closest('[data-focus-group-link]');if(group){event.preventDefault();const review=group.dataset.review;afterFocusPanel(()=>{applyFocusPanels(new URL(location.href));openReview(review,null,{mode:'replace'})});return}
    if(target.closest('[data-focus-close]')){event.preventDefault();closeFocus(true);return}
    const pageLink=target.closest('[data-page-link]');if(pageLink&&dialog?.open){event.preventDefault();if(pageLink.getAttribute('aria-disabled')==='true')return;const url=new URL(pageLink.getAttribute('href'),location.href);history.replaceState({...history.state,stageReview:true,directReview:history.state?.directReview===true},'',url);syncUrl();return}
    if(target.closest('[data-review-nav-open]')){const url=new URL(location.href);url.searchParams.set('panel','review-navigation');history.pushState({stagePagePanel:true},'',url);syncUrl();return}
    if(target.closest('[data-page-details-open]')){const url=new URL(location.href);url.searchParams.set('panel','details');history.pushState({stagePagePanel:true},'',url);syncUrl();return}
    if(target.closest('[data-review-nav-close]')||target.closest('[data-page-details-close]')||target.closest('[data-page-scrim]')){closePagePanel();return}
    const toggle=target.closest('[data-focus-toggle]');if(toggle&&dialog?.open){const side=toggle.dataset.focusToggle;if(isMobile())openFocusPanel(side);else{const url=new URL(location.href);const key=side==='tree'?'tree':'detail';url.searchParams.get(key)==='closed'?url.searchParams.delete(key):url.searchParams.set(key,'closed');history.replaceState(history.state,'',url);applyFocusPanels(url)}return}
    if(target.closest('[data-focus-panel-close]')){closeFocusPanel();return}
    const activate=target.closest('[data-activate-change]');if(activate&&dialog?.open){event.preventDefault();const id=activate.dataset.activateChange;const scrollLedger=!activate.closest('[data-ledger-change]');afterFocusPanel(()=>{const url=new URL(location.href);url.searchParams.delete('panel');url.searchParams.set('change',id);url.hash=id;history.replaceState({...history.state,stageReview:true,directReview:history.state?.directReview===true},'',url);applyFocusPanels(url);activateChange(id,{scrollCode:true,scrollLedger})});return}
    const step=target.closest('[data-change-step]');if(step&&dialog?.open){const hunks=[...dialog.querySelectorAll('.hunk-review[data-change]')];if(hunks.length){const current=Math.max(0,hunks.findIndex(hunk=>hunk.dataset.change===dialog.dataset.activeChange));const direction=step.dataset.changeStep==='next'?1:-1;const next=hunks[(current+direction+hunks.length)%hunks.length];activateChange(next.dataset.change,{scrollCode:true,scrollLedger:true,writeUrl:true})}return}
    const file=target.closest('[data-scroll-file]');if(file&&dialog?.open){event.preventDefault();const anchor=file.dataset.scrollFile;afterFocusPanel(()=>{scrollInside(dialog.querySelector('[data-focus-stream]'),document.getElementById(anchor),'start');if(isMobile()){const url=new URL(location.href);url.searchParams.delete('panel');history.replaceState({...history.state,stageReview:true,directReview:history.state?.directReview===true},'',url);applyFocusPanels(url)}});return}
    const disclosure=target.closest('[data-toggle-change]');if(disclosure){const hunk=findChange('.hunk-review[data-change]',disclosure.dataset.toggleChange);setCollapsed(hunk,hunk?.dataset.collapsed!=='true');return}
    const filter=target.closest('[data-filter-unread]');if(filter){filter.setAttribute('aria-pressed',String(filter.getAttribute('aria-pressed')!=='true'));applyUnreadFilter();return}
    const context=target.closest('[data-context-trigger]');if(context){event.preventDefault();loadContext(context);return}
    const line=target.closest('[data-line-select]');if(line){event.preventDefault();if(suppressLineClick&&event.detail>0){suppressLineClick=false;touchLine=false;return}suppressLineClick=false;const hunk=line.closest('[data-change]');const side=line.dataset.lineSide;const number=Number(line.dataset.lineNumber);if(!hunk||!side||!number)return;const same=lineSelection&&lineSelection.change===hunk.dataset.change&&lineSelection.side===side;lineSelection=same&&(event.shiftKey||touchLine)?{...lineSelection,end:number}:{change:hunk.dataset.change,side,start:number,end:number};touchLine=false;if(lineSelection.end<lineSelection.start)[lineSelection.start,lineSelection.end]=[lineSelection.end,lineSelection.start];document.querySelectorAll('[data-line-select]').forEach(button=>button.setAttribute('aria-pressed',String(button.closest('[data-change]')?.dataset.change===lineSelection.change&&button.dataset.lineSide===lineSelection.side&&Number(button.dataset.lineNumber)>=lineSelection.start&&Number(button.dataset.lineNumber)<=lineSelection.end)));const form=findChange('[data-ledger-change]',lineSelection.change)?.querySelector('.range-thread form');if(form){form.elements.namedItem('side').value=lineSelection.side;form.elements.namedItem('startLine').value=String(lineSelection.start);form.elements.namedItem('endLine').value=String(lineSelection.end)}return}
  });

  document.addEventListener('submit',async event=>{
    const form=event.target;if(!(form instanceof HTMLFormElement))return;
    if(form.matches('.github-thread-publish,.github-thread-reply,.github-thread-resolution,.github-submission-retry,.github-viewed-control,.github-viewed-retry,.github-review-form')){event.preventDefault();const buttons=[...form.querySelectorAll('button[type=submit]')];buttons.forEach(button=>button.disabled=true);let status=form.querySelector('[role=status]');if(!status){status=document.createElement('span');status.setAttribute('role','status');status.setAttribute('aria-live','polite');form.append(status)}status.textContent='';const body=form.matches('.github-thread-reply,.github-thread-resolution')?threadSubmissionBody(form):new FormData(form);if(event.submitter?.name)body.set(event.submitter.name,event.submitter.value);try{const response=await fetch(form.action,{method:'POST',body,headers:{accept:'application/json'}});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'GitHub action failed');location.reload()}catch(error){status.textContent=error.message||'GitHub action failed';buttons.forEach(button=>button.disabled=false)}return}
    if(form.matches('.read-form')){event.preventDefault();const button=form.querySelector('[data-read-button]');if(button)button.disabled=true;try{const response=await fetch(form.action,{method:'POST',body:new FormData(form),headers:{accept:'application/json'}});if(!response.ok)throw new Error('Read state failed');const result=await response.json();setRead(result.changeId,result.read)}catch(error){const failure=form.querySelector('[data-read-failure]');if(failure)failure.textContent='Could not save'}finally{if(button)button.disabled=false}return}
    if(form.matches('.acknowledgement-form')){event.preventDefault();const button=form.querySelector('button[type=submit]'),status=form.querySelector('[role=status]'),itemId=form.dataset.acknowledgementItem;if(button)button.disabled=true;if(status)status.textContent='';try{const response=await fetch(form.action,{method:'POST',body:new FormData(form),headers:{accept:'application/json'}});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'Could not save');setAcknowledged(itemId,result.acknowledged,result.acknowledgement)}catch(error){if(status)status.textContent=error.message||'Could not save';if(button)button.disabled=false}return}
    if(form.matches('.judgment-form')){event.preventDefault();const buttons=[...form.querySelectorAll('button[type=submit]')],status=form.querySelector('[role=status]'),body=new FormData(form);if(event.submitter?.name)body.set(event.submitter.name,event.submitter.value);buttons.forEach(button=>button.disabled=true);if(status)status.textContent='';try{const response=await fetch(form.action,{method:'POST',body,headers:{accept:'application/json'}});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'Could not save');location.reload()}catch(error){if(status)status.textContent=error.message||'Could not save';buttons.forEach(button=>button.disabled=false)}return}
    if(!form.matches('.thread-new,.thread-reply,.thread-resolution'))return;
    event.preventDefault();const button=form.querySelector('button[type=submit]');if(button)button.disabled=true;const status=form.querySelector('[role=status]');if(status)status.textContent='';try{const response=await fetch(form.action,{method:'POST',body:threadSubmissionBody(form),headers:{accept:'application/json'}});const result=await response.json().catch(()=>({}));if(!response.ok&&result.rule==='anchor_mixed'&&Array.isArray(result.details?.ranges)&&status){status.replaceChildren(document.createTextNode(result.error||'Choose one range'));for(const range of result.details.ranges){const choice=document.createElement('button');choice.type='button';choice.textContent=(range.kind==='changed'?'Changed':'Unchanged')+' L'+range.startLine+'–'+range.endLine;choice.addEventListener('click',()=>{form.elements.namedItem('startLine').value=String(range.startLine);form.elements.namedItem('endLine').value=String(range.endLine);status.textContent=''});status.append(choice)}if(button)button.disabled=false;return}if(!response.ok)throw new Error(result.error||'Could not save');const url=new URL(location.href);url.hash=result.id||'';history.replaceState(history.state,'',url);location.reload()}catch(error){if(status)status.textContent=error.message||'Could not save';if(button)button.disabled=false}
  });

  dialog?.addEventListener('pointerdown',event=>{const line=event.target.closest?.('[data-line-select]');if(line){suppressLineClick=false;draggingLines=true;draggedLines=false;dragStartLine=line;touchLine=event.pointerType==='touch'}});
  dialog?.addEventListener('pointermove',event=>{if(!draggingLines)return;const line=event.target.closest?.('[data-line-select]');if(!line||!dragStartLine)return;if(!draggedLines){draggedLines=true;touchLine=false;dragStartLine.dispatchEvent(new MouseEvent('click',{bubbles:true}))}line.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}))});
  dialog?.addEventListener('pointerup',()=>{draggingLines=false;if(draggedLines)suppressLineClick=true;draggedLines=false;dragStartLine=null});
  dialog?.addEventListener('pointercancel',()=>{draggingLines=false;draggedLines=false;dragStartLine=null;suppressLineClick=false;touchLine=false});
  dialog?.addEventListener('pointerover',event=>{const linked=event.target.closest?.('.hunk-review[data-change],[data-ledger-change]');if(!linked)return;const id=linked.dataset.change||linked.dataset.ledgerChange;findChange('.hunk-review[data-change]',id)?.classList.add('is-linked-hover');findChange('[data-ledger-change]',id)?.classList.add('is-linked-hover')});
  dialog?.addEventListener('pointerout',event=>{const linked=event.target.closest?.('.hunk-review[data-change],[data-ledger-change]');if(!linked)return;const id=linked.dataset.change||linked.dataset.ledgerChange;findChange('.hunk-review[data-change]',id)?.classList.remove('is-linked-hover');findChange('[data-ledger-change]',id)?.classList.remove('is-linked-hover')});
  dialog?.addEventListener('cancel',event=>{event.preventDefault();closeFocus()});
  document.addEventListener('change',event=>{const select=event.target;if(select instanceof HTMLSelectElement&&select.matches('[data-scope]')&&dialog?.open){event.preventDefault();openLayer(select.value||null)}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&dialog?.open){event.preventDefault();closeFocus();return}if(event.key==='Escape'&&new URL(location.href).searchParams.has('panel')){event.preventDefault();closePagePanel();return}if((event.key==='['||event.key===']')&&dialog?.open&&!(event.target instanceof HTMLInputElement||event.target instanceof HTMLSelectElement||event.target instanceof HTMLTextAreaElement)){event.preventDefault();stepLayer(event.key===']'?1:-1)}});
  addEventListener('popstate',()=>{if(pendingPanelAction){const action=pendingPanelAction;pendingPanelAction=null;action()}else syncUrl()});
  const initialUrl=new URL(location.href);if(initialUrl.searchParams.has('review')&&!background)history.replaceState({directReview:true},'',initialUrl);else if(initialUrl.searchParams.has('review')&&!history.state?.stageReview&&!history.state?.directReview)history.replaceState({directReview:true},'',initialUrl);
  theme();refreshProgress();syncUrl();
})();`;
