const $ = (id) => document.getElementById(id);
const DEFAULT_BACKEND_URL = 'https://remy-backend-uqrf.onrender.com';
const stopwords = new Set(['der','die','das','und','oder','aber','ich','du','er','sie','es','wir','ihr','ein','eine','einer','eines','mit','von','für','zu','im','in','auf','an','ist','sind','war','waren','was','wie','wo','wer','wenn','dass','nicht','auch','als','bei','aus','dem','den','des','zur','zum','the','and','or','to','of','in','for','with','is','are','what','how','why','a','an']);
let state = { pages: [], settings: { autoRemember: true, hasSeenOnboarding: false }, omni_ai: { backendUrl: DEFAULT_BACKEND_URL, userId: null }, usage: null, auth: { token: null, user: null } };

function send(message) { return new Promise(resolve => chrome.runtime.sendMessage(message, resolve)); }
function storageGet(keys) { return new Promise(resolve => chrome.storage.local.get(keys, resolve)); }
function storageSet(obj) { return new Promise(resolve => chrome.storage.local.set(obj, resolve)); }
async function cacheUsage(usage) { if (usage) await storageSet({ remy_usage_cache: usage }); }
async function getCachedUsage() { const local = await storageGet(['remy_usage_cache']); return local.remy_usage_cache || null; }
async function loadAuth() { const local = await storageGet(['remy_auth']); state.auth = local.remy_auth || { token: null, user: null }; return state.auth; }
async function saveAuth(auth) { state.auth = auth || { token: null, user: null }; await storageSet({ remy_auth: state.auth }); }
function authHeaders(extra = {}) { const headers = { ...extra }; if (state.auth?.token) headers.Authorization = `Bearer ${state.auth.token}`; return headers; }
async function requestHeaders(extra = {}) { return authHeaders({ 'X-Omni-User-Id': await ensureUserId(), ...extra }); }
async function ensureUserId() {
  const local = await storageGet(['omni_ai']);
  const current = local.omni_ai || {};
  if (current.userId) { const backendUrl = (!current.backendUrl || current.backendUrl.includes('localhost') || current.backendUrl.includes('127.0.0.1')) ? DEFAULT_BACKEND_URL : current.backendUrl; state.omni_ai = { backendUrl, userId: current.userId }; if (backendUrl !== current.backendUrl) await storageSet({ omni_ai: state.omni_ai }); return current.userId; }
  const userId = crypto.randomUUID ? crypto.randomUUID() : `remy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const next = { backendUrl: current.backendUrl || DEFAULT_BACKEND_URL, userId };
  await storageSet({ omni_ai: next }); state.omni_ai = next; return userId;
}

function getKeywords(text) { return [...new Set(String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w)))].slice(0, 24); }
function scorePage(page, keywords, index) {
  const title = String(page.title || '').toLowerCase();
  const query = String(page.searchQuery || '').toLowerCase();
  const language = `${page.language?.detected || ''} ${page.language?.htmlLang || ''}`.toLowerCase();
  const haystack = `${page.title} ${page.domain} ${page.searchQuery} ${language} ${page.keywords?.join(' ')} ${page.summary} ${page.text}`.toLowerCase();
  let score = Math.max(0, 6 - index * 0.06);
  for (const kw of keywords) { const re = new RegExp(escapeRegExp(kw), 'g'); const hits = (haystack.match(re) || []).length; score += hits; if (title.includes(kw)) score += 7; if (query.includes(kw)) score += 8; }
  return score;
}
function rankPages(question, limit = 8, livePage = null) {
  const keywords = getKeywords(question);
  const base = livePage ? [livePage, ...(state.pages || []).filter(p => p.url !== livePage.url)] : (state.pages || []);
  return base.map((page, index) => ({ page, score: scorePage(page, keywords, index) + (livePage && page.url === livePage.url ? 12 : 0) })).sort((a,b)=>b.score-a.score).slice(0, limit).map(x => x.page);
}

function isCurrentPageQuestion(question) {
  const q = String(question || '').toLowerCase();
  return /(gerade|aktuell|diese seite|auf der seite|hier|sehe ich|liest du|sprache|language|current|this page|right now|what am i seeing)/i.test(q);
}

async function fetchLivePage(question) {
  const notice = $('liveNotice');
  notice.classList.add('hidden'); notice.textContent = '';
  const response = await send({ type: 'OMNI_GET_LIVE_PAGE' });
  if (response?.safe && response.page) {
    notice.classList.remove('hidden');
    const lang = response.page.language?.detected && response.page.language.detected !== 'unknown' ? ` · Sprache: ${response.page.language.detected.toUpperCase()}` : '';
    notice.textContent = `Aktuelle Seite live geprüft${lang}`;
    if (response.page) {
      state.pages = [response.page, ...(state.pages || []).filter(p => p.url !== response.page.url)];
      renderMemories(state.pages);
    }
    return { safe: true, page: response.page };
  }
  if (response?.safe === false) {
    notice.classList.remove('hidden'); notice.textContent = response.reason || 'Aktuelle Seite wird aus Datenschutzgründen nicht gelesen.';
    if (isCurrentPageQuestion(question)) return { safe: false, blockedCurrentQuestion: true, reason: response.reason };
  }
  return { safe: null, page: null };
}

async function askMemory(question) {
  const answer = $('answer');
  const pages = state.pages || [];
  if (!question.trim()) { answer.textContent = 'Schreib eine Frage rein — Remy sucht in deinen Erinnerungen.'; return; }
  answer.innerHTML = '<span class="ai-label">Remy prüft die aktuelle Seite…</span>';
  document.querySelector('.ask-card').classList.add('loading');
  const live = await fetchLivePage(question);
  if (live.blockedCurrentQuestion) {
    answer.innerHTML = `<span class="ai-label fallback-label">Privat geschützt</span>\n${escapeHtml(live.reason || 'Diese Seite wird aus Datenschutzgründen nicht gelesen. Remy antwortet hier nicht über aktuelle Eingaben oder private Inhalte.')}`;
    document.querySelector('.ask-card').classList.remove('loading');
    return;
  }
  const allPages = live.page ? [live.page, ...pages] : pages;
  if (!allPages.length) { answer.textContent = 'Ich habe noch nichts gemerkt. Öffne 2–3 normale Webseiten und warte kurz — dann sammle ich automatisch.'; document.querySelector('.ask-card').classList.remove('loading'); return; }
  const contextPages = rankPages(question, 10, live.page);
  answer.innerHTML = '<span class="ai-label">Remy sucht…</span>';
  try {
    const response = await fetch(`${getBackendUrl()}/api/ask`, {
      method: 'POST',
      headers: await requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question, memories: contextPages.map(compactMemory), language: 'de', liveUrl: live.page?.url || '' })
    });
    if (!response.ok) {
      const data = await safeJson(response);
      if (response.status === 402 && data?.usage) {
        state.usage = data.usage; await cacheUsage(data.usage); renderUsage();
        answer.innerHTML = `<span class="ai-label fallback-label">Free-Limit erreicht</span>\n${escapeHtml(data.error || 'Du hast deine kostenlosen Fragen verbraucht.')}\n<button class="inline-upgrade" id="answerUpgrade">Auf Plus upgraden</button>`;
        document.getElementById('answerUpgrade')?.addEventListener('click', openUpgrade); return;
      }
      throw new Error(data?.error || `Backend antwortet mit Status ${response.status}`);
    }
    const data = await response.json();
    if (data.usage) { state.usage = data.usage; await cacheUsage(data.usage); renderUsage(); }
    answer.innerHTML = `<span class="ai-label">Remy-Antwort</span>\n${linkify(escapeHtml(data.answer || 'Keine Antwort erhalten.'))}\n${renderSources(contextPages.slice(0, 5))}`;
    bindSourceLinks(answer); setAiStatus(true);
  } catch (error) {
    const fallback = buildLocalFallback(question, contextPages);
    answer.innerHTML = `<span class="ai-label fallback-label">Remy gerade offline</span>\n${escapeHtml(fallback.text)}\n${renderSources(fallback.sources)}`;
    bindSourceLinks(answer); setAiStatus(false, 'KI gerade nicht erreichbar');
  } finally { document.querySelector('.ask-card').classList.remove('loading'); }
}

function compactMemory(page) { return { title: String(page.title || '').slice(0,180), url: String(page.url || '').slice(0,500), domain: String(page.domain || '').slice(0,120), savedAt: page.savedAt, searchQuery: String(page.searchQuery || '').slice(0,160), summary: String(page.summary || '').slice(0,760), text: String(page.text || '').slice(0,2600), platform: String(page.platform || '').slice(0,80), media: page.media || {}, language: page.language || {}, keywords: Array.isArray(page.keywords) ? page.keywords.slice(0,22) : [] }; }
async function safeJson(response) { try { return await response.json(); } catch { return null; } }
function buildLocalFallback(question, pages) {
  const results = pages.slice(0,4); const top = results[0]; if (!top) return { text: 'Ich habe noch keine passende Erinnerung gefunden.', sources: [] };
  const lang = top.language?.detected && top.language.detected !== 'unknown' ? ` Die Seite wirkt aktuell wie ${languageName(top.language.detected)}.` : '';
  const queryMention = top.searchQuery ? ` Deine damalige Suche war ungefähr: „${top.searchQuery}“. ` : ' ';
  const other = results.slice(1).map(p => p.title || p.domain).filter(Boolean).slice(0,2); const extra = other.length ? `Ich habe außerdem ${other.map(x => `„${x}“`).join(' und ')} gefunden.` : '';
  return { text: `Ich glaube, du meinst „${top.title || top.domain}“.${lang}${queryMention}${top.summary || ''}\n\n${extra}`, sources: results };
}
function languageName(code) { return ({ de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch' }[code] || code); }

function renderSources(pages) {
  if (!pages.length) return '';
  return `<div class="sources-title">Passende Links</div>` + pages.map(page => `<div class="source"><strong>${escapeHtml(page.title || page.domain || 'Ohne Titel')}</strong><br><span>${escapeHtml(page.domain || '')} · ${formatDate(page.savedAt)}</span><br><small>${escapeHtml(page.summary || '').slice(0, 180)}</small><button class="open-source" data-url="${escapeHtml(page.url || '')}">Öffnen</button></div>`).join('');
}
function bindSourceLinks(root = document) { root.querySelectorAll('.open-source').forEach(btn => btn.addEventListener('click', () => { const url = btn.dataset.url; if (url) chrome.tabs.create({ url }); })); }
function linkify(html) { return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" class="answer-link" target="_blank" rel="noreferrer">$1</a>'); }
function getBackendUrl() { const saved = String(state.omni_ai?.backendUrl || DEFAULT_BACKEND_URL); return (saved.includes('localhost') || saved.includes('127.0.0.1') ? DEFAULT_BACKEND_URL : saved).replace(/\/$/, ''); }

function render() {
  const pages = state.pages || []; const autoOn = state.settings?.autoRemember !== false;
  $('onboarding').classList.toggle('hidden', Boolean(state.settings?.hasSeenOnboarding));
  $('toggleAuto').classList.toggle('off', !autoOn);
  $('autoStatus').textContent = autoOn ? 'Automatik aktiv' : 'Automatik pausiert';
  $('memoryCount').textContent = autoOn ? (pages.length ? `${pages.length} lokale Erinnerungen gespeichert. Kein Klick nötig.` : 'Öffne Webseiten — ich merke sie automatisch im Hintergrund.') : 'Remy ist pausiert. Deine alten Erinnerungen bleiben lokal.';
  renderPrivacySettings(); renderAuth(); renderMemories(pages); renderUsage();
}

function renderPrivacySettings() {
  const categories = state.settings?.blockedCategories || {};
  document.querySelectorAll('[data-category]').forEach(input => { input.checked = categories[input.dataset.category] !== false; });
  const list = $('ignoredDomains'); const domains = state.settings?.ignoredDomains || [];
  if (!domains.length) { list.innerHTML = '<p class="empty">Noch keine Websites blockiert.</p>'; return; }
  list.innerHTML = domains.map(domain => `<div class="ignored-domain"><span>${escapeHtml(domain)}</span><button data-domain="${escapeHtml(domain)}">Entfernen</button></div>`).join('');
  list.querySelectorAll('button[data-domain]').forEach(button => button.addEventListener('click', async () => { const response = await send({ type: 'OMNI_REMOVE_IGNORED_DOMAIN', domain: button.dataset.domain }); if (response?.ok) { state.settings = response.settings; render(); } }));
}

function renderMemories(pages) {
  const container = $('memories');
  if (!pages.length) { container.innerHTML = '<p class="empty">Noch leer. Öffne eine normale Webseite und warte kurz.</p>'; return; }
  container.innerHTML = pages.slice(0,8).map(page => `<article class="memory"><div class="favicon">${escapeHtml(initials(page.domain || page.title))}</div><div><div class="memory-title-row"><div class="memory-title">${escapeHtml(page.title || 'Ohne Titel')}</div><button class="delete-memory" data-id="${escapeHtml(page.id || '')}" title="Diese Erinnerung löschen">×</button></div><div class="memory-meta">${escapeHtml(page.domain || '')} · ${formatDate(page.savedAt)}${page.language?.detected && page.language.detected !== 'unknown' ? ` · ${escapeHtml(page.language.detected.toUpperCase())}` : ''}</div><div class="memory-summary">${escapeHtml(page.searchQuery ? `Suche: ${page.searchQuery}. ${page.summary || ''}` : page.summary || '')}</div><button class="open-memory" data-url="${escapeHtml(page.url || '')}">Link öffnen</button></div></article>`).join('');
  container.querySelectorAll('.delete-memory').forEach(button => button.addEventListener('click', async () => { const id = button.dataset.id; if (!id) return; const response = await send({ type: 'OMNI_DELETE_PAGE', id }); if (response?.ok) { state.pages = response.pages || state.pages.filter(page => page.id !== id); render(); } }));
  container.querySelectorAll('.open-memory').forEach(button => button.addEventListener('click', () => { const url = button.dataset.url; if (url) chrome.tabs.create({ url }); }));
}

function renderAuth() {
  const user = state.auth?.user;
  const authForm = $('authForm');
  const accountBox = $('accountBox');
  if (!authForm || !accountBox) return;
  authForm.classList.toggle('hidden', Boolean(user));
  accountBox.classList.toggle('hidden', !user);
  $('accountStatus').textContent = user ? 'Du bist angemeldet. Remy kann Limits und Plus deinem Konto zuordnen.' : 'Melde dich an, damit Remy deine Fragen deinem Konto zuordnen kann.';
  if (user) {
    $('accountEmail').textContent = user.email || '';
    $('accountPlan').textContent = (user.plan === 'plus') ? 'Remy Plus' : 'Remy Free';
  }

  const footerLogin = $('footerLoginBtn');
  const footerLogout = $('footerLogoutBtn');
  const footerEmail = $('footerEmail');
  const footerPlan = $('footerPlan');
  const footerAccount = $('footerAccount');
  if (footerLogin && footerLogout && footerAccount) {
    footerLogin.classList.toggle('hidden', Boolean(user));
    footerLogout.classList.toggle('hidden', !user);
    footerAccount.classList.toggle('logged-in', Boolean(user));
    if (footerEmail) footerEmail.textContent = user ? user.email : 'Nicht angemeldet';
    if (footerPlan) footerPlan.textContent = user ? ((user.plan === 'plus') ? 'Remy Plus' : 'Remy Free') : 'Login für Plus & Limits';
  }
}
async function submitAuth(mode) {
  const email = $('authEmail')?.value?.trim();
  const password = $('authPassword')?.value || '';
  $('authHint').textContent = mode === 'register' ? 'Konto wird erstellt…' : 'Login läuft…';
  try {
    const res = await fetch(`${getBackendUrl()}/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data?.error || 'Login fehlgeschlagen.');
    await saveAuth({ token: data.token, user: data.user });
    $('authPassword').value = '';
    $('authHint').textContent = 'Angemeldet.';
    await refreshUsage();
    render();
  } catch (error) {
    $('authHint').textContent = error.message || 'Login fehlgeschlagen.';
  }
}
async function logout() {
  await saveAuth({ token: null, user: null });
  await refreshUsage();
  render();
}
async function refreshMe() {
  if (!state.auth?.token) return;
  try {
    const res = await fetch(`${getBackendUrl()}/api/auth/me`, { headers: authHeaders() });
    if (!res.ok) throw new Error('not logged in');
    const data = await res.json();
    await saveAuth({ token: state.auth.token, user: data.user });
  } catch {
    await saveAuth({ token: null, user: null });
  }
}

function renderUsage() {
  const usage = state.usage || { plan: 'free', used: 0, limit: 10, remaining: 10, plusPrice: '3,99 € / Monat' };
  const isPlus = usage.plan === 'plus'; $('planName').textContent = isPlus ? 'Remy Plus' : 'Remy Free';
  if (isPlus) { $('usageText').textContent = 'Plus aktiv · 100 Fragen pro Monat und mehr Komfort.'; $('usageBar').style.width = '100%'; $('upgradeBtn').textContent = 'Plus aktiv'; return; }
  const used = Number(usage.used || 0), limit = Number(usage.limit || 10), remaining = Math.max(0, Number(usage.remaining ?? (limit - used)));
  $('usageText').textContent = `${remaining} von ${limit} kostenlosen Fragen übrig · Plus ${usage.plusPrice || '3,99 € / Monat'}`;
  $('usageBar').style.width = `${Math.min(100, Math.round((used / limit) * 100))}%`; $('upgradeBtn').textContent = 'Upgrade';
}
async function openUpgrade() {
  if (!state.auth?.token) {
    openAccountTab();
    $('authHint').textContent = 'Bitte melde dich an oder erstelle ein Konto. Dann kann Remy Plus deiner E-Mail zugeordnet werden.';
    $('answer').innerHTML = '<span class="ai-label fallback-label">Login nötig</span>\nBitte melde dich zuerst an, damit Remy Plus deinem Konto zugeordnet werden kann.';
    return;
  }
  try {
    const res = await fetch(`${getBackendUrl()}/api/create-checkout-session`, {
      method: 'POST',
      headers: await requestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({})
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data?.error || 'Checkout gerade nicht verfügbar.');
    if (!data?.url) throw new Error('Checkout-Link fehlt.');
    chrome.tabs.create({ url: data.url });
  } catch (error) {
    const price = state.usage?.plusPrice || '3,99 € / Monat';
    $('answer').innerHTML = `<span class="ai-label fallback-label">Upgrade gerade nicht verfügbar</span>\n${escapeHtml(error.message || `Plus kostet ${price} für 100 Fragen pro Monat und mehr Komfort.`)}`;
  }
}
async function refreshState() { await loadAuth(); const [response, local] = await Promise.all([send({ type: 'OMNI_GET_STATE' }), storageGet(['omni_ai'])]); if (response?.ok) { const omniAi = local.omni_ai || { backendUrl: DEFAULT_BACKEND_URL }; state = { ...response, omni_ai: omniAi, usage: state.usage }; await ensureUserId(); render(); } }
async function refreshUsage() { try { const res = await fetch(`${getBackendUrl()}/api/usage`, { headers: await requestHeaders() }); if (!res.ok) throw new Error('usage unavailable'); const payload = await res.json(); state.usage = payload.usage; await cacheUsage(state.usage); } catch { state.usage = await getCachedUsage() || { plan: 'free', used: 0, limit: 10, remaining: 10, plusPrice: '3,99 € / Monat' }; } renderUsage(); }
async function checkBackend() { try { const res = await fetch(`${getBackendUrl()}/health`, { method: 'GET' }); if (!res.ok) throw new Error('not ok'); const data = await res.json(); setAiStatus(Boolean(data?.ok && data?.hasKey), data?.hasKey ? 'KI bereit' : 'KI später erneut'); } catch { setAiStatus(false, 'KI gerade nicht erreichbar'); } }
function setAiStatus(ok, text) { const el = $('aiStatus'); el.classList.toggle('ok', ok); el.classList.toggle('off', !ok); el.textContent = text || (ok ? 'KI bereit' : 'KI gerade nicht erreichbar'); }
function initials(text) { const clean = String(text || '?').replace(/^www\./, '').trim(); return clean ? clean[0].toUpperCase() : '?'; }
function formatDate(date) { try { return new Intl.DateTimeFormat('de-DE', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit' }).format(new Date(date)); } catch { return ''; } }
function escapeHtml(str) { return String(str || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function escapeRegExp(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function openSettingsPanel() { $('settingsPanel')?.classList.remove('hidden'); }
function openAccountTab() {
  openSettingsPanel();
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.add('hidden'));
  document.querySelector('[data-tab="accountTab"]')?.classList.add('active');
  $('accountTab')?.classList.remove('hidden');
  setTimeout(() => $('authEmail')?.focus(), 50);
}

async function init() {
  await refreshState(); await refreshMe(); await checkBackend(); await refreshUsage();
  $('startOnboarding').addEventListener('click', async () => { let response = await send({ type: 'OMNI_SET_AUTO', value: true }); if (response?.ok) state.settings = response.settings; response = await send({ type: 'OMNI_SET_ONBOARDING_SEEN', value: true }); if (response?.ok) state.settings = response.settings; render(); });
  $('pauseOnboarding').addEventListener('click', async () => { let response = await send({ type: 'OMNI_SET_AUTO', value: false }); if (response?.ok) state.settings = response.settings; response = await send({ type: 'OMNI_SET_ONBOARDING_SEEN', value: true }); if (response?.ok) state.settings = response.settings; render(); });
  $('toggleAuto').addEventListener('click', async () => { const next = !(state.settings?.autoRemember !== false); const response = await send({ type: 'OMNI_SET_AUTO', value: next }); if (response?.ok) { state.settings = response.settings; render(); } });
  $('ask').addEventListener('click', () => askMemory($('question').value));
  $('upgradeBtn').addEventListener('click', openUpgrade);
  $('onboardingLoginBtn')?.addEventListener('click', openAccountTab);
  $('footerLoginBtn')?.addEventListener('click', openAccountTab);
  $('loginBtn')?.addEventListener('click', () => submitAuth('login'));
  $('registerBtn')?.addEventListener('click', () => submitAuth('register'));
  $('logoutBtn')?.addEventListener('click', logout);
  $('footerLogoutBtn')?.addEventListener('click', logout);
  $('question').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askMemory($('question').value); } });
  document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => { $('question').value = chip.dataset.question || ''; askMemory($('question').value); }));
  $('toggleSettings').addEventListener('click', () => $('settingsPanel').classList.toggle('hidden'));
  document.querySelectorAll('.settings-tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.add('hidden')); $(tab.dataset.tab).classList.remove('hidden'); }));
  document.querySelectorAll('[data-category]').forEach(input => input.addEventListener('change', async () => { const response = await send({ type: 'OMNI_SET_CATEGORY', category: input.dataset.category, value: input.checked }); if (response?.ok) { state.settings = response.settings; render(); } }));
  $('blockCurrentSite').addEventListener('click', async () => { const response = await send({ type: 'OMNI_BLOCK_CURRENT_SITE' }); if (response?.ok) { state.settings = response.settings; render(); $('liveNotice').classList.remove('hidden'); $('liveNotice').textContent = 'Diese Website wird ab jetzt nicht mehr gemerkt.'; } else { $('answer').textContent = response?.error || 'Diese Website konnte nicht blockiert werden.'; } });
  $('clearAll').addEventListener('click', async () => { if (!confirm('Alle lokalen Erinnerungen löschen?')) return; await send({ type: 'OMNI_CLEAR_ALL' }); state.pages = []; render(); $('answer').textContent = ''; });
}
init().catch(error => { $('answer').textContent = `Remy konnte gerade nicht starten: ${error.message}`; });
