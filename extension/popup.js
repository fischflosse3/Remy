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
  if ($('startOnboarding')) $('startOnboarding').onclick = async()=>{ await send({type:'OMNI_SET_AUTO',value:true}); await chrome.storage.local.set({remyTutorialHidden:true}); const st=await send({type:'OMNI_GET_STATE'}); if(st?.ok){state={...state,...st};} render(); };
  if ($('pauseOnboarding')) $('pauseOnboarding').onclick = async()=>{ await chrome.storage.local.set({remyTutorialHidden:true}); render(); };
  $('toggleAuto').onclick = async()=>{ const next = !(state.settings?.autoRemember !== false); const r=await send({type:'OMNI_SET_AUTO',value:next}); if(r?.ok){state.settings=r.settings;render();}};
  $('modeLocal').onclick = ()=>setMode('local'); $('modePublic').onclick=()=>setMode('public');
  $('ask').onclick=()=>ask($('question').value); $('question').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();ask($('question').value);} }); $('clearChat').onclick=clearChat;
  $('upgradeBtn').onclick=openUpgrade; $('logoutBtn').onclick=async()=>{await send({type:'REMY_LOGOUT'}); await refreshAll();};
  $('deleteAccount').onclick=deleteAccount; $('manageSubscription').onclick=manageSubscription;
  $('toggleSettings').onclick=()=>$('settingsPanel').classList.toggle('hidden');
  document.querySelectorAll('.settings-tab').forEach(tab=>tab.onclick=()=>{document.querySelectorAll('.settings-tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');document.querySelectorAll('.settings-tab-content').forEach(c=>c.classList.add('hidden'));$(tab.dataset.tab).classList.remove('hidden');});
  document.querySelectorAll('[data-category]').forEach(input=>input.onchange=async()=>{const r=await send({type:'OMNI_SET_CATEGORY',category:input.dataset.category,value:input.checked}); if(r?.ok){state.settings=r.settings;render();}});
  $('blockCurrentSite').onclick=async()=>{const r=await send({type:'OMNI_BLOCK_CURRENT_SITE'}); if(r?.ok){state.settings=r.settings;render();$('liveNotice').classList.remove('hidden');$('liveNotice').textContent='Diese Website wird ab jetzt nicht mehr gemerkt.';}};
  $('clearAll').onclick=async()=>{ if(!confirm('Alle lokalen Erinnerungen löschen?'))return; await send({type:'OMNI_CLEAR_ALL'}); state.pages=[]; render(); };
}
async function refreshAll(){ const [st, auth, local] = await Promise.all([send({type:'OMNI_GET_STATE'}), refreshAuth(), storageGet(['remyTutorialHidden'])]); if(st?.ok){state={...state,...st};} state.tutorialHidden=Boolean(local.remyTutorialHidden); render(); await checkBackend(); if(state.loggedIn) await refreshUsage(); }
async function refreshAuth(){ const r=await send({type:'REMY_GET_AUTH'}); state.loggedIn=Boolean(r?.loggedIn); state.auth=r?.auth||null; if(r?.usage) state.usage=r.usage; return r; }
async function refreshUsage(){ try{const res=await fetch(`${getBackendUrl()}/api/usage`,{headers:authHeaders()}); if(res.ok){const d=await res.json(); state.usage=d.usage; renderUsage();}}catch{} }
async function checkBackend(){ try{const res=await fetch(`${getBackendUrl()}/health`); const d=await res.json(); setAiStatus(d.ok&&d.hasKey,d.hasKey?'KI bereit':'KI später erneut');}catch{setAiStatus(false,'KI nicht erreichbar');}}
function setMode(mode){ state.mode=mode==='public'?'public':'local'; send({type:'REMY_SET_MODE',mode:state.mode}); renderMode(); $('question').focus(); }
async function ask(question){ question=String(question||'').trim(); if(!question)return; $('answer').innerHTML='<span class="ai-label">Remy denkt…</span>'; const r=await send({type:'REMY_SIDEBAR_ASK',question,mode:state.mode}); if(!r?.ok){$('answer').textContent=r?.error||'Remy konnte nicht antworten.'; if(r?.loginRequired) send({type:'REMY_START_LOGIN'}); return;} if(r.usage){state.usage=r.usage;renderUsage();} $('answer').innerHTML=`<span class="ai-label">Antwort</span>\n${escapeHtml(r.answer||'Keine Antwort.')}${renderSources(r.sources||[])}`; bindLinks(); $('question').value=''; }
function render(){ const logged=state.loggedIn; $('loginGate').classList.toggle('hidden',logged); $('mainApp').classList.toggle('hidden',!logged); if(!logged)return; if ($('tutorialCard')) $('tutorialCard').classList.toggle('hidden', Boolean(state.tutorialHidden)); const autoOn=state.settings?.autoRemember!==false; $('toggleAuto').classList.toggle('off',!autoOn); $('autoStatus').textContent=autoOn?'Automatik aktiv':'Automatik pausiert'; $('memoryCount').textContent=`${(state.pages||[]).length} lokale Erinnerungen`; $('accountText').textContent=state.auth?.user?.email?`Angemeldet als ${state.auth.user.email}`:'Angemeldet'; renderMode(); renderUsage(); renderPrivacy(); renderMemories(); }
function renderMode(){ const pub=state.mode==='public'; $('modeLocal').classList.toggle('active',!pub); $('modePublic').classList.toggle('active',pub); $('modeHelp').textContent=pub?'Allgemein nutzt normales KI-Wissen. Gib hier keine privaten Daten ein.':'Browser durchsucht deine gespeicherten Seiten, offenen Tabs und sicheren Erinnerungen.'; }
function renderUsage(){ const u=state.usage||{plan:'free',used:0,limit:7,remaining:7,plusPrice:'3,99 € / Monat',paidPlanName:'Remy Unlimited'}; const isPaid=u.plan==='plus'||u.plan==='lifetime'; const paidName=u.paidPlanName||'Remy Unlimited'; $('planName').textContent=isPaid?(u.plan==='lifetime'?'Remy Lifetime':paidName):'Remy Free'; const rem=u.remaining ?? Math.max(0,u.limit-u.used); $('usageText').textContent=isPaid?`${rem} von ${u.limit} Anfragen diesen Monat übrig`:`${rem} von ${u.limit} Free-Anfragen übrig · ${paidName} ${u.plusPrice||'3,99 € / Monat'}`; $('usageBar').style.width=`${Math.min(100,Math.round((u.used/u.limit)*100))}%`; $('upgradeBtn').textContent=isPaid?'Unlimited aktiv':'Upgrade'; $('upgradeBtn').disabled=isPaid; $('manageSubscription').classList.toggle('hidden',!isPaid); }
function renderPrivacy(){ const cats=state.settings?.blockedCategories||{}; document.querySelectorAll('[data-category]').forEach(i=>i.checked=cats[i.dataset.category]!==false); const domains=state.settings?.ignoredDomains||[]; $('ignoredDomains').innerHTML=domains.length?domains.map(d=>`<div class="ignored-domain"><span>${escapeHtml(d)}</span><button data-domain="${escapeHtml(d)}">Entfernen</button></div>`).join(''):'<p class="empty">Keine Websites blockiert.</p>'; $('ignoredDomains').querySelectorAll('button').forEach(b=>b.onclick=async()=>{const r=await send({type:'OMNI_REMOVE_IGNORED_DOMAIN',domain:b.dataset.domain}); if(r?.ok){state.settings=r.settings;renderPrivacy();}}); }
function renderMemories(){ const pages=state.pages||[]; $('memories').innerHTML=pages.length?pages.slice(0,8).map(p=>`<article class="memory"><div class="favicon">${escapeHtml((p.domain||p.title||'?')[0].toUpperCase())}</div><div><div class="memory-title-row"><div class="memory-title">${escapeHtml(p.title||'Ohne Titel')}</div><button class="delete-memory" data-id="${escapeHtml(p.id||'')}">×</button></div><div class="memory-meta">${escapeHtml(p.domain||'')}</div><div class="memory-summary">${escapeHtml(p.summary||'')}</div><button class="open-memory" data-url="${escapeHtml(p.url||'')}">Öffnen</button></div></article>`).join(''):'<p class="empty">Noch leer. Öffne eine normale Webseite und warte kurz.</p>'; $('memories').querySelectorAll('.delete-memory').forEach(b=>b.onclick=async()=>{const r=await send({type:'OMNI_DELETE_PAGE',id:b.dataset.id}); if(r?.ok){state.pages=r.pages;renderMemories();}}); $('memories').querySelectorAll('.open-memory').forEach(b=>b.onclick=()=>chrome.tabs.create({url:b.dataset.url})); }
async function clearChat(){ await send({type:'REMY_CLEAR_CHAT', mode: state.mode}); $('answer').innerHTML='<span class="ai-label">Chat gelöscht</span>\nDu kannst jetzt ein neues Thema starten.'; $('question').focus(); }
async function openUpgrade(){ if(!state.loggedIn){send({type:'REMY_START_LOGIN'});return;} const res=await fetch(`${getBackendUrl()}/api/create-checkout-session`,{method:'POST',headers:authHeaders(),body:'{}'}); const d=await res.json().catch(()=>({})); if(d.url) chrome.tabs.create({url:d.url}); else $('answer').textContent=d.error||'Upgrade ist noch nicht eingerichtet.'; }
async function manageSubscription(){
  try{
    if(!state.loggedIn){ send({type:'REMY_START_LOGIN'}); return; }
    $('answer').textContent='Abo-Verwaltung wird geöffnet…';
    const res=await fetch(`${getBackendUrl()}/api/create-customer-portal-session`,{method:'POST',headers:authHeaders(),body:'{}'});
    const d=await res.json().catch(()=>({}));
    if(!res.ok || !d.url){ $('answer').textContent=d.error||'Abo-Verwaltung konnte nicht geöffnet werden.'; return; }
    chrome.tabs.create({url:d.url});
  }catch(e){
    console.error(e);
    $('answer').textContent='Abo-Verwaltung konnte nicht geöffnet werden.';
  }
}
async function deleteAccount(){ const msg='Du bist dabei, dein Remy-Konto zu löschen. Dadurch werden Konto und gespeicherte Remy-Daten dauerhaft entfernt. Wenn du Remy Plus nutzt, kündige bitte zuerst dein Abo. Wirklich fortfahren?'; if(!confirm(msg))return; const res=await fetch(`${getBackendUrl()}/api/auth/delete`,{method:'POST',headers:authHeaders(),body:'{}'}); const d=await res.json().catch(()=>({})); if(!res.ok){alert(d.error||'Konto konnte nicht gelöscht werden.');return;} await send({type:'REMY_LOGOUT'}); await refreshAll(); }
function setAiStatus(ok,text){const el=$('aiStatus');el.classList.toggle('ok',ok);el.classList.toggle('off',!ok);el.textContent=text;}
function renderSources(sources){ if(!sources.length)return''; return '<div class="sources-title">Passende Links</div>'+sources.map(s=>`<div class="source"><strong>${escapeHtml(s.title||s.domain||'Quelle')}</strong><br><a class="source-link" href="${escapeHtml(s.url||'#')}" data-url="${escapeHtml(s.url||'')}">${escapeHtml(s.url||s.domain||'Öffnen')}</a></div>`).join(''); }
function bindLinks(){ document.querySelectorAll('.source-link').forEach(a=>a.onclick=(e)=>{e.preventDefault(); if(a.dataset.url) chrome.tabs.create({url:a.dataset.url});}); }
function escapeHtml(str){return String(str||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
init().catch(e=>{$('loginGate').classList.remove('hidden');$('loginGate').querySelector('p').textContent=e.message||'Remy konnte nicht starten.'});
