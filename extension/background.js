const DEFAULT_BACKEND_URL = 'https://remy-backend-uqrf.onrender.com';
const REMY_DEFAULTS = {
  omni_pages: [],
  omni_settings: {
    autoRemember: true,
    gentleNudges: true,
    hasSeenOnboarding: false,
    ignoredDomains: [],
    blockedCategories: { banking: true, payments: true, email: true, dating: true, adult: true, medical: true, logins: true }
  },
  omni_stats: { rememberedTotal: 0, lastNudgeAt: 0 },
  remy_auth: { token: null, user: null },
  remy_mode: 'local'
};
const CATEGORY_RULES = {
  banking: ['bank','sparkasse','volksbank','ing.de','dkb.de','comdirect','n26.com','revolut','wise.com','broker','depot','konto','finanzen'],
  payments: ['checkout','payment','paypal','stripe','klarna','billing','rechnung','bezahlen','zahlung','warenkorb','cart','kasse','creditcard','kreditkarte'],
  email: ['mail.google.com','gmail.com','outlook.live.com','outlook.office.com','webmail','mail.yahoo.com','proton.me','inbox','posteingang'],
  dating: ['tinder.com','bumble.com','hinge.co','lovoo','okcupid','parship','elitepartner','dating'],
  adult: ['porn','sex','adult','xxx','xvideos','pornhub','onlyfans','erotic','erotik'],
  medical: ['doctor','arzt','klinik','medical','medizin','gesundheit','symptom','patient','therapie','apotheke'],
  logins: ['login','signin','sign-in','password','passwort','auth','oauth','2fa','account','konto','anmelden','registrieren']
};
const STOPWORDS = new Set(['der','die','das','und','oder','aber','ich','du','er','sie','es','wir','ihr','ein','eine','einer','eines','mit','von','für','zu','im','in','auf','an','ist','sind','war','waren','was','wie','wo','wer','wenn','dass','nicht','auch','als','bei','aus','dem','den','des','zur','zum','the','and','or','to','of','in','for','with','is','are','what','how','why','a','an']);

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const current = await storageGet(Object.keys(REMY_DEFAULTS));
  await storageSet({
    omni_pages: current.omni_pages || REMY_DEFAULTS.omni_pages,
    omni_settings: mergeSettings(current.omni_settings),
    omni_stats: current.omni_stats || REMY_DEFAULTS.omni_stats,
    remy_auth: current.remy_auth || REMY_DEFAULTS.remy_auth,
    remy_mode: current.remy_mode || 'local'
  });
  await setupContextMenus();
  await updateBadge();
  if (reason === 'install') startExternalLogin();
});
chrome.runtime.onStartup.addListener(async () => { await setupContextMenus(); await updateBadge(); });
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'remy-toggle') { const { omni_settings } = await storageGet(['omni_settings']); const s = mergeSettings(omni_settings); await setAutoRemember(!s.autoRemember); }
  if (info.menuItemId === 'remy-ignore-site' && tab?.url) { const d = safeDomain(tab.url); if (d) await addIgnoredDomain(d); }
  if (info.menuItemId === 'remy-open') chrome.action.openPopup?.();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (message?.type === 'OMNI_AUTO_REMEMBER_PAGE') return await rememberPage(message.page, sender.tab);
    if (message?.type === 'OMNI_GET_LIVE_PAGE') return await getLivePage(sender.tab?.id);
    if (message?.type === 'OMNI_GET_STATE') return await getState();
    if (message?.type === 'OMNI_SET_AUTO') return await setAutoRemember(Boolean(message.value));
    if (message?.type === 'OMNI_SET_ONBOARDING_SEEN') return await setOnboardingSeen(Boolean(message.value));
    if (message?.type === 'OMNI_SET_CATEGORY') return await setCategory(message.category, Boolean(message.value));
    if (message?.type === 'OMNI_REMOVE_IGNORED_DOMAIN') return await removeIgnoredDomain(message.domain);
    if (message?.type === 'OMNI_BLOCK_CURRENT_SITE') return await blockCurrentSite(true);
    if (message?.type === 'REMY_IGNORE_CURRENT_SITE_AND_DELETE') return await blockCurrentSite(true);
    if (message?.type === 'REMY_TOGGLE_CURRENT_SITE_MEMORY') return await toggleCurrentSiteMemory();
    if (message?.type === 'REMY_GET_CURRENT_SITE_MEMORY_STATUS') return await getCurrentSiteMemoryStatus(sender.tab?.url);
    if (message?.type === 'OMNI_DELETE_PAGE') return await deletePage(message.id);
    if (message?.type === 'OMNI_CLEAR_ALL') { await storageSet({ omni_pages: [], omni_stats: { rememberedTotal: 0, lastNudgeAt: 0 } }); await updateBadge(0); return { ok: true }; }
    if (message?.type === 'REMY_START_LOGIN') return await startExternalLogin();
    if (message?.type === 'REMY_POLL_LOGIN') return await pollLogin(message.deviceId);
    if (message?.type === 'REMY_GET_AUTH') return await getAuthState();
    if (message?.type === 'REMY_LOGOUT') { await storageSet({ remy_auth: { token: null, user: null } }); return { ok: true }; }
    if (message?.type === 'REMY_SET_MODE') { await storageSet({ remy_mode: message.mode === 'public' ? 'public' : 'local' }); return { ok: true, mode: message.mode === 'public' ? 'public' : 'local' }; }
    if (message?.type === 'REMY_SIDEBAR_ASK') return await askFromExtension(message.question, message.mode, sender.tab?.id);
    return { ok: false, error: 'Unbekannte Anfrage.' };
  };
  run().then(r => sendResponse({ ok: true, ...r })).catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

async function setupContextMenus() { try { await chrome.contextMenus.removeAll(); chrome.contextMenus.create({ id: 'remy-toggle', title: 'Remy ein-/ausschalten', contexts: ['action'] }); chrome.contextMenus.create({ id: 'remy-ignore-site', title: 'Diese Website nie merken', contexts: ['action', 'page'] }); chrome.contextMenus.create({ id: 'remy-open', title: 'Remy öffnen', contexts: ['action'] }); } catch {} }
async function startExternalLogin() { const deviceId = crypto.randomUUID(); await storageSet({ remy_login_device: deviceId }); await chrome.tabs.create({ url: `${getBackendUrl()}/auth?deviceId=${encodeURIComponent(deviceId)}` }); return { ok: true, deviceId }; }
async function pollLogin(deviceId) { if (!deviceId) { const s = await storageGet(['remy_login_device']); deviceId = s.remy_login_device; } if (!deviceId) return { ok: false, pending: true }; const res = await fetch(`${getBackendUrl()}/api/auth/device/${encodeURIComponent(deviceId)}`); const data = await res.json().catch(() => ({})); if (data.ok && data.token) { await storageSet({ remy_auth: { token: data.token, user: data.user }, remy_login_device: null }); return { ok: true, auth: { token: data.token, user: data.user } }; } return { ok: false, pending: true }; }
async function getAuthState() {
  await pollLogin();
  const { remy_auth, remy_usage_cache } = await storageGet(['remy_auth','remy_usage_cache']);
  const auth = remy_auth || { token: null, user: null };
  if (!auth.token) return { loggedIn: false, auth, usage: remy_usage_cache || null };
  try {
    const res = await fetch(`${getBackendUrl()}/api/auth/me`, { headers: authHeaders(auth.token) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        await storageSet({ remy_auth: { token: null, user: null } });
        return { loggedIn: false, auth: { token: null, user: null }, usage: remy_usage_cache || null };
      }
      return { loggedIn: true, auth, usage: remy_usage_cache || null, warning: data.error || 'Nutzung konnte gerade nicht geladen werden.' };
    }
    await storageSet({ remy_auth: { token: auth.token, user: data.user }, remy_usage_cache: data.usage });
    return { loggedIn: true, auth: { token: auth.token, user: data.user }, usage: data.usage };
  } catch {
    return { loggedIn: true, auth, usage: remy_usage_cache || null, warning: 'Remy ist kurz offline, dein Login bleibt gespeichert.' };
  }
}
function authHeaders(token) { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }; }
function getBackendUrl() { return DEFAULT_BACKEND_URL; }

async function askFromExtension(question, mode = 'local', tabId = null) {
  const authState = await getAuthState();
  if (!authState.loggedIn) return { ok: false, loginRequired: true, error: 'Bitte melde dich an, um Remy zu nutzen.' };
  const safeMode = mode === 'public' ? 'public' : 'local';
  let memories = [];
  if (safeMode === 'local') {
    const { omni_pages = [] } = await storageGet(['omni_pages']);
    const openTabs = await getOpenTabsForContext();
    const combined = [...openTabs, ...omni_pages];
    const ranked = rankPages(question, combined, 10);
    memories = ranked.map(compactMemory);
    if (!memories.length) return { ok: false, error: 'Ich finde gerade keine passenden gespeicherten Seiten oder offenen Tabs.' };
  }
  const res = await fetch(`${getBackendUrl()}/api/ask`, { method: 'POST', headers: authHeaders(authState.auth.token), body: JSON.stringify({ question, mode: safeMode, memories, language: 'de' }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || 'Remy konnte gerade nicht antworten.', usage: data.usage };
  if (data.usage) await storageSet({ remy_usage_cache: data.usage });
  return { ok: true, answer: data.answer, usage: data.usage, sources: safeMode === 'local' ? memories.slice(0, 5) : [] };
}

async function getOpenTabsForContext() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const { omni_settings } = await storageGet(['omni_settings']);
  const settings = mergeSettings(omni_settings);
  return tabs
    .filter(tab => /^https?:\/\//.test(tab.url || ''))
    .map(tab => makeOpenTabMemory(tab))
    .filter(page => !shouldSkipPage(page, settings))
    .slice(0, 40);
}

function makeOpenTabMemory(tab) {
  const url = tab.url || '';
  const domain = safeDomain(url);
  const title = clip(tab.title || domain || 'Geöffneter Tab', 180);
  return {
    id: `open-tab-${tab.id || simpleHash(url)}`,
    sourceType: 'open_tab',
    title,
    url,
    domain,
    description: '',
    headings: '',
    text: '',
    summary: 'Aktuell geöffneter Tab. Es wurden nur Titel und URL verwendet; der Seiteninhalt wurde nicht ausgelesen.',
    keywords: getKeywords(`${title} ${domain} ${extractSearchQuery(url)}`),
    searchQuery: extractSearchQuery(url),
    platform: 'open-tab-metadata',
    media: {},
    language: {},
    savedAt: 'aktuell geöffnet'
  };
}
async function getLivePage(tabId = null) { let tab; if (tabId) tab = { id: tabId }; else [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id) return { safe: false, reason: 'Keine aktive Seite.' }; let response; try { response = await chrome.tabs.sendMessage(tab.id, { type: 'OMNI_EXTRACT_NOW' }); } catch { return { safe: false, reason: 'Diese Seite ist noch nicht bereit.' }; } if (!response?.ok || !response.page) return { safe: false, reason: response?.error || 'Keine lesbaren Inhalte.' }; const { omni_settings } = await storageGet(['omni_settings']); const settings = mergeSettings(omni_settings); const skip = shouldSkipPage(response.page, settings); if (skip) return { safe: false, reason: humanSkipReason(skip) }; const page = cleanPage(response.page, { url: response.page.url, title: response.page.title }); await saveCleanPage(page, { allowRecentDuplicate: true }); return { safe: true, page }; }
async function blockCurrentSite(deleteExisting = false) { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); const d = tab?.url ? safeDomain(tab.url) : ''; if (!d) return { ok: false, error: 'Keine Website erkannt.' }; return addIgnoredDomain(d, deleteExisting); }
async function getCurrentSiteMemoryStatus(url = '') {
  let targetUrl = url;
  if (!targetUrl) { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); targetUrl = tab?.url || ''; }
  const domain = safeDomain(targetUrl);
  const { omni_settings } = await storageGet(['omni_settings']);
  const s = mergeSettings(omni_settings);
  const ignored = isIgnoredDomain(domain, s);
  return { ok: true, domain, ignored };
}
async function toggleCurrentSiteMemory() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const domain = tab?.url ? safeDomain(tab.url) : '';
  if (!domain) return { ok: false, error: 'Keine Website erkannt.' };
  const { omni_settings } = await storageGet(['omni_settings']);
  const s = mergeSettings(omni_settings);
  if (isIgnoredDomain(domain, s)) {
    const r = await removeIgnoredDomain(domain);
    return { ok: true, action: 'allowed', domain, settings: r.settings, message: 'Diese Website wird wieder gemerkt.' };
  }
  const r = await addIgnoredDomain(domain, true);
  return { ok: true, action: 'ignored', domain, settings: r.settings, deleted: r.deleted || 0, message: `Diese Website wird nicht mehr gemerkt. ${r.deleted || 0} alte Erinnerungen wurden gelöscht.` };
}
function isIgnoredDomain(domain, settings) {
  const clean = cleanDomain(domain);
  return Boolean(clean && (settings.ignoredDomains || []).some(d => clean === d || clean.endsWith(`.${d}`)));
}
async function addIgnoredDomain(domain, deleteExisting = false) { const clean = cleanDomain(domain); const { omni_settings, omni_pages = [] } = await storageGet(['omni_settings','omni_pages']); const s = mergeSettings(omni_settings); s.ignoredDomains = [...new Set([...(s.ignoredDomains || []), clean])].filter(Boolean).sort(); let deleted = 0; let pages = omni_pages; if (deleteExisting && clean) { const before = omni_pages.length; pages = omni_pages.filter(p => { const d = cleanDomain(p.domain || safeDomain(p.url || '')); return !(d === clean || d.endsWith(`.${clean}`)); }); deleted = before - pages.length; } await storageSet({ omni_settings: s, omni_pages: pages }); await updateBadge(pages.length); return { ok: true, settings: s, pages, deleted }; }
async function removeIgnoredDomain(domain) { const clean = cleanDomain(domain); const { omni_settings } = await storageGet(['omni_settings']); const s = mergeSettings(omni_settings); s.ignoredDomains = (s.ignoredDomains || []).filter(d => d !== clean); await storageSet({ omni_settings: s }); return { ok: true, settings: s }; }
async function setCategory(category, value) { const { omni_settings } = await storageGet(['omni_settings']); const s = mergeSettings(omni_settings); if (!s.blockedCategories[category] && !(category in CATEGORY_RULES)) return { ok: false }; s.blockedCategories[category] = value; await storageSet({ omni_settings: s }); return { ok: true, settings: s }; }
async function setAutoRemember(value) { const { omni_settings } = await storageGet(['omni_settings']); const s = mergeSettings(omni_settings); s.autoRemember = value; await storageSet({ omni_settings: s }); await updateBadge(); return { ok: true, settings: s }; }
async function setOnboardingSeen(value) { const { omni_settings } = await storageGet(['omni_settings']); const s = mergeSettings(omni_settings); s.hasSeenOnboarding = value; await storageSet({ omni_settings: s }); return { ok: true, settings: s }; }
async function deletePage(id) { const { omni_pages = [] } = await storageGet(['omni_pages']); const pages = omni_pages.filter(p => p.id !== id); await storageSet({ omni_pages: pages }); await updateBadge(pages.length); return { ok: true, pages }; }
async function getState() { const data = await storageGet(['omni_pages','omni_settings','omni_stats','remy_mode','remy_usage_cache']); return { ok: true, pages: data.omni_pages || [], settings: mergeSettings(data.omni_settings), stats: data.omni_stats || {}, mode: data.remy_mode || 'local', usage: data.remy_usage_cache || null }; }
async function rememberPage(rawPage, tab) { const { omni_settings } = await storageGet(['omni_settings']); const s = mergeSettings(omni_settings); if (!s.autoRemember) return { saved: false, reason: 'paused' }; const skip = shouldSkipPage(rawPage, s); if (!rawPage || skip) return { saved: false, reason: skip || 'skipped' }; const page = cleanPage(rawPage, tab); if (!page.text || page.text.length < 120) return { saved: false, reason: 'too_short' }; return saveCleanPage(page, { allowRecentDuplicate: false }); }
async function saveCleanPage(page, opts = {}) { const { omni_pages = [], omni_stats = {} } = await storageGet(['omni_pages','omni_stats']); const existingIndex = omni_pages.findIndex(p => p.url === page.url); if (existingIndex >= 0) omni_pages.splice(existingIndex, 1); const pages = [page, ...omni_pages].slice(0, 220); await storageSet({ omni_pages: pages, omni_stats: { ...omni_stats, rememberedTotal: Number(omni_stats.rememberedTotal || 0) + 1 } }); await updateBadge(pages.length); return { saved: true, page, count: pages.length }; }
function cleanPage(raw, tab = {}) { const url = raw.url || tab.url || ''; return { id: simpleHash(`${url}|${Date.now()}`), title: clip(raw.title || tab.title || 'Ohne Titel', 180), url, domain: raw.domain || safeDomain(url), description: clip(raw.description, 500), headings: clip(raw.headings, 800), text: clip(raw.text, 18000), summary: summarize(raw), keywords: keywords(raw), searchQuery: extractSearchQuery(url), platform: raw.platform || 'generic', media: raw.media || {}, language: raw.language || {}, savedAt: new Date().toISOString() }; }
function shouldSkipPage(page, settings) { if (!page?.url) return 'no_url'; const url = page.url.toLowerCase(); const domain = cleanDomain(page.domain || safeDomain(page.url)); if ((settings.ignoredDomains || []).some(d => domain === d || domain.endsWith(`.${d}`))) return 'ignored_domain'; if (page.hasPasswordField && settings.blockedCategories.logins) return 'password_page'; for (const [cat, words] of Object.entries(CATEGORY_RULES)) { if (settings.blockedCategories?.[cat] === false) continue; if (words.some(w => url.includes(w) || domain.includes(w))) return cat; } return ''; }
function humanSkipReason(r) { return ({ banking:'Banking/Finanzen geschützt.', payments:'Zahlungsseite geschützt.', email:'E-Mail-Bereich geschützt.', dating:'Dating-Seite geschützt.', adult:'Erwachsene Inhalte geschützt.', medical:'Gesundheit/Medizin geschützt.', logins:'Login/Account geschützt.', password_page:'Passwortseite geschützt.', ignored_domain:'Website ist ignoriert.' }[r] || 'Diese Seite wird geschützt.'); }
function rankPages(q, pages, limit) { const kws = getKeywords(q); return pages.map((p,i)=>({p,score:scorePage(p,kws,i)})).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.p); }
function scorePage(p,kws,i){ const hay = `${p.title} ${p.domain} ${p.url} ${p.searchQuery} ${p.summary} ${p.text}`.toLowerCase(); const asksForOpenTabs = kws.some(k => ['tab','tabs','offen','offene','geöffnet','geoeffnet','link','links','seite','seiten'].includes(k)); let s = Math.max(0, 6 - i * .05); if(p.sourceType === 'open_tab' && asksForOpenTabs) s += 8; kws.forEach(k=>{ if(hay.includes(k)) s += 4; if(String(p.title||'').toLowerCase().includes(k)) s += 7; if(String(p.domain||'').toLowerCase().includes(k)) s += 5; }); return s; }
function getKeywords(t){ return [...new Set(String(t||'').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,' ').split(/\s+/).filter(w=>w.length>2&&!STOPWORDS.has(w)))].slice(0,24); }
function compactMemory(p){ return { sourceType:p.sourceType || 'saved_page', title:p.title, url:p.url, domain:p.domain, savedAt:p.savedAt, searchQuery:p.searchQuery, summary:p.summary, text:p.text, platform:p.platform, media:p.media, language:p.language, keywords:p.keywords }; }
function summarize(p){ const parts=[p.description,p.headings,p.text].filter(Boolean).join(' '); return clip(parts,260); }
function keywords(p){ return getKeywords(`${p.title} ${p.description} ${p.headings} ${p.text}`).slice(0,18); }
function extractSearchQuery(url){ try{ const u=new URL(url); return u.searchParams.get('q')||u.searchParams.get('query')||u.searchParams.get('search_query')||''; }catch{return ''} }
async function updateBadge(count){ const { omni_settings, omni_pages=[] } = await storageGet(['omni_settings','omni_pages']); const on = mergeSettings(omni_settings).autoRemember !== false; chrome.action.setBadgeText({ text: on ? String((count ?? omni_pages.length) || '') : 'OFF' }); chrome.action.setBadgeBackgroundColor({ color: on ? '#7c3aed' : '#9ca3af' }); }
function mergeSettings(s={}){ return { ...REMY_DEFAULTS.omni_settings, ...s, blockedCategories: { ...REMY_DEFAULTS.omni_settings.blockedCategories, ...(s.blockedCategories||{}) }, ignoredDomains: Array.isArray(s.ignoredDomains)?s.ignoredDomains:[] }; }
function storageGet(keys){ return new Promise(r=>chrome.storage.local.get(keys,r)); } function storageSet(o){ return new Promise(r=>chrome.storage.local.set(o,r)); }
function safeDomain(url){ try{return new URL(url).hostname.replace(/^www\./,'').toLowerCase()}catch{return ''} } function cleanDomain(d){ return String(d||'').replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].toLowerCase().trim(); }
function clip(v,m){ return String(v||'').replace(/\s+/g,' ').trim().slice(0,m); } function simpleHash(str){ let h=0; for(let i=0;i<str.length;i++)h=((h<<5)-h+str.charCodeAt(i))|0; return `${Date.now()}-${Math.abs(h)}`; }
