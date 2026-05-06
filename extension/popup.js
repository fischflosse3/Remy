const $ = id => document.getElementById(id);
const DEFAULT_BACKEND_URL = 'https://remy-backend-uqrf.onrender.com';
let state = { pages: [], settings: {}, usage: null, mode: 'local', auth: null, loggedIn: false };
function send(message){ return new Promise(resolve => chrome.runtime.sendMessage(message, resolve)); }
function storageGet(keys){ return new Promise(resolve => chrome.storage.local.get(keys, resolve)); }
function getBackendUrl(){ return DEFAULT_BACKEND_URL; }
function authHeaders(){ return state.auth?.token ? { Authorization:`Bearer ${state.auth.token}`, 'Content-Type':'application/json' } : { 'Content-Type':'application/json' }; }
async function init(){
  await refreshAll();
  setInterval(async()=>{ if(!state.loggedIn){ await refreshAuth(); render(); }}, 2500);
  $('loginNow').onclick = () => send({ type:'REMY_START_LOGIN' });
  if($('dismissTutorial')) $('dismissTutorial').onclick = async()=>{ const r=await send({type:'OMNI_SET_ONBOARDING_SEEN',value:true}); if(r?.ok){state.settings=r.settings;render();}};
  $('toggleAuto').onclick = async()=>{ const next = !(state.settings?.autoRemember !== false); const r=await send({type:'OMNI_SET_AUTO',value:next}); if(r?.ok){state.settings=r.settings;render();}};
  $('modeLocal').onclick = ()=>setMode('local'); $('modePublic').onclick=()=>setMode('public');
  if($('clearChatMain')) $('clearChatMain').onclick=clearChatMain;
  $('ask').onclick=()=>ask($('question').value); $('question').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();ask($('question').value);} });
  $('upgradeBtn').onclick=openUpgrade; $('logoutBtn').onclick=async()=>{await send({type:'REMY_LOGOUT'}); await refreshAll();};
  $('deleteAccount').onclick=deleteAccount; $('manageSubscription').onclick=manageSubscription;
  $('toggleSettings').onclick=()=>$('settingsPanel').classList.toggle('hidden');
  document.querySelectorAll('.settings-tab').forEach(tab=>tab.onclick=()=>{document.querySelectorAll('.settings-tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');document.querySelectorAll('.settings-tab-content').forEach(c=>c.classList.add('hidden'));$(tab.dataset.tab).classList.remove('hidden');});
  document.querySelectorAll('[data-category]').forEach(input=>input.onchange=async()=>{const r=await send({type:'OMNI_SET_CATEGORY',category:input.dataset.category,value:input.checked}); if(r?.ok){state.settings=r.settings;render();}});
  $('blockCurrentSite').onclick=async()=>{const r=await send({type:'OMNI_BLOCK_CURRENT_SITE'}); if(r?.ok){state.settings=r.settings;render();$('liveNotice').classList.remove('hidden');$('liveNotice').textContent='Diese Website wird ab jetzt nicht mehr gemerkt.';}};
  $('clearAll').onclick=async()=>{ if(!confirm('Alle lokalen Erinnerungen löschen?'))return; await send({type:'OMNI_CLEAR_ALL'}); state.pages=[]; render(); };
}
async function refreshAll(){
  const st = await send({type:'OMNI_GET_STATE'});
  if(st?.ok){
    const preservedUsage = state.usage;
    state={...state,...st};
    if(preservedUsage && !st.usage) state.usage = preservedUsage;
  }
  await refreshAuth();
  render();
  await checkBackend();
  if(state.loggedIn) await refreshUsage();
}
async function refreshAuth(){ const r=await send({type:'REMY_GET_AUTH'}); state.loggedIn=Boolean(r?.loggedIn); state.auth=r?.auth||null; if(r?.usage) state.usage=r.usage; return r; }
async function refreshUsage(){ try{const res=await fetch(`${getBackendUrl()}/api/usage`,{headers:authHeaders()}); if(res.ok){const d=await res.json(); state.usage=d.usage; renderUsage();}}catch{} }
function schedulePostBillingRefresh(){
  // Stripe braucht manchmal ein paar Sekunden, bis die Subscription im API-Status sichtbar ist.
  [2000, 5000, 10000, 20000].forEach(delay=>setTimeout(()=>{ if(state.loggedIn) refreshAll(); }, delay));
}
async function checkBackend(){ try{const res=await fetch(`${getBackendUrl()}/health`); const d=await res.json(); setAiStatus(d.ok&&d.hasKey,d.hasKey?'KI bereit':'KI später erneut');}catch{setAiStatus(false,'KI nicht erreichbar');}}
function setMode(mode){ state.mode=mode==='public'?'public':'local'; send({type:'REMY_SET_MODE',mode:state.mode}); renderMode(); $('question').focus(); }
async function ask(question){
  question=String(question||'').trim();
  if(!question)return;
  $('answer').innerHTML='<span class="ai-label">Remy denkt…</span>';
  const r=await send({type:'REMY_SIDEBAR_ASK',question,mode:state.mode});
  if(!r?.ok){
    $('answer').textContent=r?.error||'Remy konnte nicht antworten.';
    if(r?.usage){state.usage=r.usage;renderUsage();}
    if(r?.loginRequired) send({type:'REMY_START_LOGIN'});
    return;
  }
  if(r.usage){state.usage=r.usage;renderUsage();}
  await refreshUsage();
  $('answer').innerHTML=`<span class="ai-label">Antwort</span>\n${escapeHtml(r.answer||'Keine Antwort.')}${renderSources(r.sources||[])}`;
  bindLinks();
  $('question').value='';
}
function render(){ const logged=state.loggedIn; $('loginGate').classList.toggle('hidden',logged); $('mainApp').classList.toggle('hidden',!logged); if(!logged)return; const autoOn=state.settings?.autoRemember!==false; $('toggleAuto').classList.toggle('off',!autoOn); $('autoStatus').textContent=autoOn?'Automatik aktiv':'Automatik pausiert'; $('memoryCount').textContent=`${(state.pages||[]).length} lokale Erinnerungen`; $('accountText').textContent=state.auth?.user?.email?`Angemeldet als ${state.auth.user.email}`:'Angemeldet'; if($('tutorialCard')) $('tutorialCard').classList.toggle('hidden', Boolean(state.settings?.hasSeenOnboarding)); renderMode(); renderUsage(); renderPrivacy(); renderMemories(); }
function renderMode(){ const pub=state.mode==='public'; $('modeLocal').classList.toggle('active',!pub); $('modePublic').classList.toggle('active',pub); $('modeHelp').textContent=pub?'Allgemein fragen nutzt KI-Wissen. Keine privaten Daten eingeben.':'Browser suchen nutzt nur deine gespeicherten Seiten.'; }
function renderUsage(){ const u=state.usage||{plan:'free',planName:'Remy Free',used:0,limit:7,remaining:7,plusPrice:'3,99 € / Monat',resetLabel:'Woche',trialAvailable:true}; const isPaid=u.plan==='plus'||u.plan==='lifetime'; $('planName').textContent=isPaid?(u.planName||(u.plan==='lifetime'?'Remy Lifetime':'Remy Unlimited')):'Remy Free'; const rem=u.remaining ?? Math.max(0,u.limit-u.used); const period=u.resetLabel|| (u.plan==='free'?'Woche':'Monat'); const trial=u.trialAvailable?' · erste Test-Anfrage kostenlos':''; $('usageText').textContent=isPaid?`${rem} von ${u.limit} Anfragen diesen ${period} übrig`:`${rem} von ${u.limit} Free-Anfragen diese ${period} übrig${trial} · Unlimited ${u.plusPrice||'3,99 € / Monat'}`; $('usageBar').style.width=`${Math.min(100,Math.round((u.used/u.limit)*100))}%`; $('upgradeBtn').textContent=isPaid?(u.plan==='lifetime'?'Lifetime aktiv':'Unlimited aktiv'):'Upgrade'; $('upgradeBtn').disabled=isPaid; $('manageSubscription').classList.toggle('hidden',!isPaid); }
function renderPrivacy(){ const cats=state.settings?.blockedCategories||{}; document.querySelectorAll('[data-category]').forEach(i=>i.checked=cats[i.dataset.category]!==false); const domains=state.settings?.ignoredDomains||[]; $('ignoredDomains').innerHTML=domains.length?domains.map(d=>`<div class="ignored-domain"><span>${escapeHtml(d)}</span><button data-domain="${escapeHtml(d)}">Entfernen</button></div>`).join(''):'<p class="empty">Keine Websites blockiert.</p>'; $('ignoredDomains').querySelectorAll('button').forEach(b=>b.onclick=async()=>{const r=await send({type:'OMNI_REMOVE_IGNORED_DOMAIN',domain:b.dataset.domain}); if(r?.ok){state.settings=r.settings;renderPrivacy();}}); }
function renderMemories(){ const pages=state.pages||[]; $('memories').innerHTML=pages.length?pages.slice(0,8).map(p=>`<article class="memory"><div class="favicon">${escapeHtml((p.domain||p.title||'?')[0].toUpperCase())}</div><div><div class="memory-title-row"><div class="memory-title">${escapeHtml(p.title||'Ohne Titel')}</div><button class="delete-memory" data-id="${escapeHtml(p.id||'')}">×</button></div><div class="memory-meta">${escapeHtml(p.domain||'')}</div><div class="memory-summary">${escapeHtml(p.summary||'')}</div><button class="open-memory" data-url="${escapeHtml(p.url||'')}">Öffnen</button></div></article>`).join(''):'<p class="empty">Noch leer. Öffne eine normale Webseite und warte kurz.</p>'; $('memories').querySelectorAll('.delete-memory').forEach(b=>b.onclick=async()=>{const r=await send({type:'OMNI_DELETE_PAGE',id:b.dataset.id}); if(r?.ok){state.pages=r.pages;renderMemories();}}); $('memories').querySelectorAll('.open-memory').forEach(b=>b.onclick=()=>chrome.tabs.create({url:b.dataset.url})); }

async function clearChatMain(){
  await send({type:'REMY_CLEAR_CHAT', mode:state.mode});
  if($('answer')) $('answer').innerHTML='<span class="ai-label">Chat gelöscht</span> Der Chatinhalt wurde gelöscht. Du kannst jetzt ein neues Thema starten.';
  if($('question')) $('question').value='';
}

async function openUpgrade(){
  if(!state.loggedIn){send({type:'REMY_START_LOGIN'});return;}
  const res=await fetch(`${getBackendUrl()}/api/create-checkout-session`,{method:'POST',headers:authHeaders(),body:'{}'});
  const d=await res.json().catch(()=>({}));
  if(d.url){
    $('answer').textContent='Stripe Checkout wird geöffnet… Nach dem Kauf aktualisiert Remy deinen Unlimited-Status automatisch.';
    chrome.tabs.create({url:d.url});
    schedulePostBillingRefresh();
  } else $('answer').textContent=d.error||'Upgrade ist noch nicht eingerichtet.';
}
async function manageSubscription(){
  try {
    if(!state.loggedIn){ send({type:'REMY_START_LOGIN'}); return; }
    $('answer').textContent='Stripe Abo-Verwaltung wird geöffnet…';
    const res = await fetch(`${getBackendUrl()}/api/create-customer-portal-session`, { method:'POST', headers:authHeaders(), body:'{}' });
    const d = await res.json().catch(()=>({}));
    if(!res.ok || !d.url){
      $('answer').textContent = d.error || 'Abo-Verwaltung konnte nicht geöffnet werden.';
      return;
    }
    chrome.tabs.create({ url:d.url });
    schedulePostBillingRefresh();
  } catch (error) {
    console.error(error);
    $('answer').textContent='Abo-Verwaltung konnte nicht geöffnet werden.';
  }
}
async function deleteAccount(){
  const confirmed = await showDeleteModal();
  if(!confirmed) return;
  const res=await fetch(`${getBackendUrl()}/api/auth/delete`,{method:'POST',headers:authHeaders(),body:'{}'});
  const d=await res.json().catch(()=>({}));
  if(!res.ok){ $('answer').textContent=d.error||'Konto konnte nicht gelöscht werden.'; return; }
  await send({type:'REMY_LOGOUT'});
  await refreshAll();
}
function showDeleteModal(){
  return new Promise(resolve=>{
    const modal=$('deleteModal'), cancel=$('cancelDelete'), confirm=$('confirmDelete');
    if(!modal||!cancel||!confirm){ resolve(window.confirm('Konto wirklich löschen?')); return; }
    const close=(value)=>{ modal.classList.add('hidden'); cancel.onclick=null; confirm.onclick=null; resolve(value); };
    cancel.onclick=()=>close(false);
    confirm.onclick=()=>close(true);
    modal.onclick=(e)=>{ if(e.target===modal) close(false); };
    modal.classList.remove('hidden');
  });
}
function setAiStatus(ok,text){const el=$('aiStatus');el.classList.toggle('ok',ok);el.classList.toggle('off',!ok);el.textContent=text;}
function renderSources(sources){ if(!sources.length)return''; return '<div class="sources-title">Passende Links</div>'+sources.map(s=>`<div class="source"><strong>${escapeHtml(s.title||s.domain||'Quelle')}</strong><br><span>${escapeHtml(s.domain||'')}</span><button class="open-source" data-url="${escapeHtml(s.url||'')}">Öffnen</button></div>`).join(''); }
function bindLinks(){ document.querySelectorAll('.open-source').forEach(b=>b.onclick=()=>chrome.tabs.create({url:b.dataset.url})); }
function escapeHtml(str){return String(str||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
init().catch(e=>{$('loginGate').classList.remove('hidden');$('loginGate').querySelector('p').textContent=e.message||'Remy konnte nicht starten.'});
