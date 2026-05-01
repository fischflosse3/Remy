const REMY_DEFAULTS = {
  omni_pages: [],
  omni_settings: {
    autoRemember: true,
    gentleNudges: true,
    hasSeenOnboarding: false,
    ignoredDomains: [],
    blockedCategories: {
      banking: true,
      payments: true,
      email: true,
      dating: true,
      adult: true,
      medical: true,
      logins: true
    }
  },
  omni_stats: { rememberedTotal: 0, lastNudgeAt: 0 }
};

const STOPWORDS = new Set(['der','die','das','und','oder','aber','ich','du','er','sie','es','wir','ihr','ein','eine','einer','eines','mit','von','für','zu','im','in','auf','an','ist','sind','war','waren','was','wie','wo','wer','wenn','dass','nicht','auch','als','bei','aus','dem','den','des','zur','zum','the','and','or','to','of','in','for','with','is','are','what','how','why','a','an']);

const CATEGORY_RULES = {
  banking: ['bank','sparkasse','volksbank','ing.de','dkb.de','comdirect','n26.com','revolut','wise.com','broker','depot','konto','finanzen'],
  payments: ['checkout','payment','paypal','stripe','klarna','billing','rechnung','bezahlen','zahlung','warenkorb','cart','kasse','creditcard','kreditkarte'],
  email: ['mail.google.com','gmail.com','outlook.live.com','outlook.office.com','webmail','mail.yahoo.com','proton.me','inbox','posteingang'],
  dating: ['tinder.com','bumble.com','hinge.co','lovoo','okcupid','parship','elitepartner','dating'],
  adult: ['porn','sex','adult','xxx','xvideos','pornhub','onlyfans','erotic','erotik'],
  medical: ['doctor','arzt','klinik','medical','medizin','gesundheit','symptom','patient','therapie','apotheke'],
  logins: ['login','signin','sign-in','password','passwort','auth','oauth','2fa','account','konto','anmelden','registrieren']
};
const CATEGORY_LABELS = { banking: 'Banking & Finanzen', payments: 'Zahlungen & Checkout', email: 'E-Mail & Nachrichten', dating: 'Dating', adult: 'Erwachsene Inhalte', medical: 'Medizin & Gesundheit', logins: 'Logins & Account-Seiten' };

chrome.runtime.onInstalled.addListener(async () => {
  const current = await storageGet(Object.keys(REMY_DEFAULTS));
  await storageSet({
    omni_pages: current.omni_pages || REMY_DEFAULTS.omni_pages,
    omni_settings: mergeSettings(current.omni_settings),
    omni_stats: current.omni_stats || REMY_DEFAULTS.omni_stats
  });
  await setupContextMenus();
  updateBadge();
});

chrome.runtime.onStartup.addListener(async () => { await setupContextMenus(); updateBadge(); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'remy-toggle') {
    const data = await storageGet(['omni_settings']);
    const settings = mergeSettings(data.omni_settings);
    await setAutoRemember(!settings.autoRemember);
  }
  if (info.menuItemId === 'remy-ignore-site' && tab?.url) {
    const domain = safeDomain(tab.url);
    if (domain) await addIgnoredDomain(domain);
  }
  if (info.menuItemId === 'remy-open') chrome.action.openPopup?.();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OMNI_AUTO_REMEMBER_PAGE') {
    rememberPage(message.page, sender.tab).then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'OMNI_GET_LIVE_PAGE') { getLivePage().then(sendResponse); return true; }
  if (message?.type === 'OMNI_GET_STATE') { getState().then(sendResponse); return true; }
  if (message?.type === 'OMNI_SET_AUTO') { setAutoRemember(Boolean(message.value)).then(sendResponse); return true; }
  if (message?.type === 'OMNI_SET_ONBOARDING_SEEN') { setOnboardingSeen(Boolean(message.value)).then(sendResponse); return true; }
  if (message?.type === 'OMNI_SET_CATEGORY') { setCategory(message.category, Boolean(message.value)).then(sendResponse); return true; }
  if (message?.type === 'OMNI_ADD_IGNORED_DOMAIN') { addIgnoredDomain(message.domain).then(sendResponse); return true; }
  if (message?.type === 'OMNI_REMOVE_IGNORED_DOMAIN') { removeIgnoredDomain(message.domain).then(sendResponse); return true; }
  if (message?.type === 'OMNI_BLOCK_CURRENT_SITE') { blockCurrentSite().then(sendResponse); return true; }
  if (message?.type === 'OMNI_DELETE_PAGE') { deletePage(message.id).then(sendResponse); return true; }
  if (message?.type === 'OMNI_CLEAR_ALL') {
    storageSet({ omni_pages: [], omni_stats: { rememberedTotal: 0, lastNudgeAt: 0 } }).then(async () => { await updateBadge(); sendResponse({ ok: true }); });
    return true;
  }
});

async function setupContextMenus() {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: 'remy-toggle', title: 'Remy ein-/ausschalten', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'remy-ignore-site', title: 'Diese Website nie merken', contexts: ['action', 'page'] });
    chrome.contextMenus.create({ id: 'remy-open', title: 'Remy öffnen', contexts: ['action'] });
  } catch {}
}

async function getLivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) return { ok: false, safe: false, reason: 'Diese Seite kann Remy nicht lesen.' };
  let response;
  try { response = await chrome.tabs.sendMessage(tab.id, { type: 'OMNI_EXTRACT_NOW' }); } catch (error) { return { ok: false, safe: false, reason: 'Diese Seite ist noch nicht bereit. Lade sie kurz neu oder warte ein paar Sekunden.' }; }
  if (!response?.ok || !response.page) return { ok: false, safe: false, reason: response?.error || 'Keine lesbaren Inhalte gefunden.' };
  const { omni_settings } = await storageGet(['omni_settings']);
  const settings = mergeSettings(omni_settings);
  const skipReason = shouldSkipPage(response.page, settings);
  if (skipReason) return { ok: true, safe: false, reason: humanSkipReason(skipReason), rawReason: skipReason, url: tab.url, domain: safeDomain(tab.url) };
  const page = cleanPage(response.page, tab);
  if (!page.text || page.text.length < 80) return { ok: true, safe: false, reason: 'Auf dieser Seite gibt es kaum lesbaren Text.' };
  await saveCleanPage(page, { allowRecentDuplicate: true });
  return { ok: true, safe: true, page };
}

async function blockCurrentSite() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); const domain = tab?.url ? safeDomain(tab.url) : ''; if (!domain) return { ok: false, error: 'Keine Website erkannt.' }; return addIgnoredDomain(domain); }
async function addIgnoredDomain(domain) { const clean = cleanDomain(domain); if (!clean) return { ok: false, error: 'Domain fehlt.' }; const data = await storageGet(['omni_settings']); const settings = mergeSettings(data.omni_settings); settings.ignoredDomains = [...new Set([...(settings.ignoredDomains || []), clean])].sort(); await storageSet({ omni_settings: settings }); return { ok: true, settings }; }
async function removeIgnoredDomain(domain) { const clean = cleanDomain(domain); const data = await storageGet(['omni_settings']); const settings = mergeSettings(data.omni_settings); settings.ignoredDomains = (settings.ignoredDomains || []).filter(d => d !== clean); await storageSet({ omni_settings: settings }); return { ok: true, settings }; }
async function setCategory(category, value) { if (!Object.prototype.hasOwnProperty.call(CATEGORY_RULES, category)) return { ok: false, error: 'Unbekannte Kategorie.' }; const data = await storageGet(['omni_settings']); const settings = mergeSettings(data.omni_settings); settings.blockedCategories[category] = value; await storageSet({ omni_settings: settings }); return { ok: true, settings }; }
async function setOnboardingSeen(value) { const data = await storageGet(['omni_settings']); const settings = mergeSettings(data.omni_settings); settings.hasSeenOnboarding = value; await storageSet({ omni_settings: settings }); return { ok: true, settings }; }
async function deletePage(id) { const data = await storageGet(['omni_pages']); const updated = (data.omni_pages || []).filter(page => page.id !== id); await storageSet({ omni_pages: updated }); await updateBadge(updated.length); return { ok: true, pages: updated }; }

async function rememberPage(rawPage, tab) {
  const { omni_settings } = await storageGet(['omni_settings']);
  const settings = mergeSettings(omni_settings);
  if (!settings.autoRemember) return { saved: false, reason: 'paused' };
  const skipReason = shouldSkipPage(rawPage, settings);
  if (!rawPage || skipReason) return { saved: false, reason: skipReason || 'skipped' };
  const page = cleanPage(rawPage, tab);
  if (!page.text || page.text.length < 120) return { saved: false, reason: 'too_short' };
  return saveCleanPage(page, { allowRecentDuplicate: false, nudge: settings.gentleNudges });
}

async function saveCleanPage(page, options = {}) {
  const { omni_pages = [], omni_stats = REMY_DEFAULTS.omni_stats } = await storageGet(['omni_pages', 'omni_stats']);
  const existing = omni_pages.find(p => normalizeUrl(p.url) === normalizeUrl(page.url));
  if (existing && !options.allowRecentDuplicate && Date.now() - new Date(existing.savedAt).getTime() < 1000 * 60 * 20) return { saved: false, reason: 'recent_duplicate' };
  const withoutDuplicate = omni_pages.filter(p => normalizeUrl(p.url) !== normalizeUrl(page.url));
  const updated = [page, ...withoutDuplicate].slice(0, 600);
  const rememberedTotal = existing ? (omni_stats.rememberedTotal || 0) : (omni_stats.rememberedTotal || 0) + 1;
  const nextStats = { ...omni_stats, rememberedTotal };
  await storageSet({ omni_pages: updated, omni_stats: nextStats });
  await updateBadge(updated.length);
  if (!existing && options.nudge) maybeNudge(rememberedTotal, page, nextStats).catch(() => {});
  return { saved: true, count: updated.length, page };
}

function shouldSkipPage(page, settings) {
  const url = String(page?.url || '').toLowerCase();
  const title = String(page?.title || '').toLowerCase();
  const domain = cleanDomain(page?.domain || safeDomain(url));
  const haystack = `${url} ${title} ${domain}`.toLowerCase();
  if (!/^https?:\/\//.test(url)) return 'unsupported_url';
  if (page?.hasPasswordField && settings.blockedCategories.logins) return 'password_page';
  if ((settings.ignoredDomains || []).some(blocked => domain === blocked || domain.endsWith(`.${blocked}`))) return 'ignored_domain';
  for (const [category, enabled] of Object.entries(settings.blockedCategories || {})) {
    if (!enabled) continue;
    const hints = CATEGORY_RULES[category] || [];
    if (hints.some(hint => haystack.includes(hint))) return `blocked_${category}`;
  }
  return '';
}

function humanSkipReason(reason) {
  if (reason === 'password_page') return 'Diese Seite enthält ein Passwortfeld. Remy liest sie aus Datenschutzgründen nicht.';
  if (reason === 'ignored_domain') return 'Diese Website steht auf deiner Ignorierliste. Remy liest sie nicht.';
  if (reason.startsWith('blocked_')) return `Diese Seite fällt unter „${CATEGORY_LABELS[reason.replace('blocked_', '')] || 'geschützte Kategorie'}“. Remy liest sie nicht.`;
  return 'Diese Seite wird aus Datenschutzgründen nicht gelesen.';
}

function cleanPage(rawPage, tab) {
  const title = String(rawPage.title || tab?.title || 'Ohne Titel').trim().slice(0, 180);
  const url = String(rawPage.url || tab?.url || '').trim();
  const domain = String(rawPage.domain || safeDomain(url)).replace(/^www\./, '');
  const text = String(rawPage.text || '').replace(/\s+/g, ' ').trim().slice(0, 28000);
  const description = String(rawPage.description || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  const headings = String(rawPage.headings || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
  const platform = String(rawPage.platform || 'generic').slice(0, 60);
  const media = sanitizeMedia(rawPage.media || {});
  const language = sanitizeLanguage(rawPage.language || {});
  const summary = makeSummary({ description, headings, text, platform, media, language });
  const keywords = getKeywords(`${title} ${domain} ${platform} ${description} ${headings} ${summary} ${text}`).slice(0, 22);
  const searchQuery = media.searchQuery || extractSearchQuery(url);
  return { id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, title, url, domain, description, headings, text, summary, keywords, searchQuery, platform, media, language, savedAt: new Date().toISOString() };
}

function makeSummary(page) {
  const media = page.media || {};
  const languageNote = page.language?.detected && page.language.detected !== 'unknown' ? `Sprache: ${page.language.detected}.` : '';
  const platformIntro = page.platform && page.platform !== 'generic' ? [page.platform.includes('youtube') ? 'YouTube-Inhalt' : '', page.platform === 'twitch' ? 'Twitch-Inhalt' : '', page.platform === 'netflix' ? 'Netflix-Inhalt' : '', media.channel ? `von ${media.channel}` : '', media.game ? `Kategorie ${media.game}` : ''].filter(Boolean).join(' ') : '';
  const source = [page.description, page.headings, page.text].filter(Boolean).join(' ');
  const sentences = source.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 35 && s.length < 280);
  const base = sentences.slice(0, 2).join(' ') || source.slice(0, 420) || 'Keine lesbaren Inhalte gefunden.';
  return [languageNote, platformIntro, base].filter(Boolean).join(': ').slice(0, 760);
}
function sanitizeMedia(media) { const clean = {}; for (const [key, value] of Object.entries(media || {})) { if (typeof value === 'string') clean[key] = value.replace(/\s+/g, ' ').trim().slice(0, key === 'transcript' ? 10000 : 500); else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value; } return clean; }
function sanitizeLanguage(language) { return { htmlLang: String(language.htmlLang || '').slice(0, 20), detected: String(language.detected || 'unknown').slice(0, 20) }; }
function getKeywords(text) { return [...new Set(String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w)))].slice(0, 40); }
function extractSearchQuery(url) { try { const u = new URL(url); for (const key of ['q','query','search','p']) { const value = u.searchParams.get(key); if (value && value.length > 1) return value.slice(0, 160); } } catch {} return ''; }
async function maybeNudge(total, page, stats) { const now = Date.now(); const last = stats.lastNudgeAt || 0; if (now - last <= 1000 * 60 * 45 || !(total === 3 || total % 10 === 0)) return; await storageSet({ omni_stats: { ...stats, lastNudgeAt: now } }); chrome.notifications.create(`remy-nudge-${now}`, { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Remy merkt mit', message: `Schon ${total} Seiten lokal gemerkt. Frag mich später einfach danach.` }); }
async function getState() { const data = await storageGet(['omni_pages','omni_settings','omni_stats']); return { ok: true, pages: data.omni_pages || [], settings: mergeSettings(data.omni_settings), stats: data.omni_stats || REMY_DEFAULTS.omni_stats }; }
async function setAutoRemember(value) { const data = await storageGet(['omni_settings']); const settings = mergeSettings(data.omni_settings); settings.autoRemember = value; await storageSet({ omni_settings: settings }); await updateBadge(); return { ok: true, settings }; }
async function updateBadge(count) { if (typeof count !== 'number') { const data = await storageGet(['omni_pages','omni_settings']); count = (data.omni_pages || []).length; if (data.omni_settings && mergeSettings(data.omni_settings).autoRemember === false) { chrome.action.setBadgeText({ text: 'OFF' }); chrome.action.setBadgeBackgroundColor({ color: '#8aa0b5' }); return; } } chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : '' }); chrome.action.setBadgeBackgroundColor({ color: '#3E78D6' }); }
function mergeSettings(settings) { return { ...REMY_DEFAULTS.omni_settings, ...(settings || {}), blockedCategories: { ...REMY_DEFAULTS.omni_settings.blockedCategories, ...((settings || {}).blockedCategories || {}) }, ignoredDomains: Array.isArray(settings?.ignoredDomains) ? settings.ignoredDomains.map(cleanDomain).filter(Boolean) : [] }; }
function normalizeUrl(url) { try { const u = new URL(url); u.hash = ''; ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid'].forEach(k => u.searchParams.delete(k)); return u.toString(); } catch { return String(url || ''); } }
function safeDomain(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function cleanDomain(domain) { return String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim(); }
function storageGet(keys) { return new Promise(resolve => chrome.storage.local.get(keys, resolve)); }
function storageSet(obj) { return new Promise(resolve => chrome.storage.local.set(obj, resolve)); }
