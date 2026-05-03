let lastPayloadHash = '';
let lastSentAt = 0;
let lastUrl = location.href;

const PLATFORM_WAIT_MS = { youtube: 6500, twitch: 5000, netflix: 5000, generic: 2200 };

async function extractReadablePage() {
  const platform = detectPlatform();
  const platformData = await extractPlatformData(platform);

  const selectorsToRemove = [
    'script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'video', 'audio',
    'nav', 'footer', 'header', 'aside', '[role="navigation"]', '[aria-hidden="true"]'
  ];

  const body = document.body || document.documentElement;
  const clone = body.cloneNode(true);
  selectorsToRemove.forEach(selector => clone.querySelectorAll(selector).forEach(el => el.remove()));

  const title = platformData.title || document.title || '';
  const metaDescription = platformData.description || getMeta('description') || getMeta('og:description') || '';
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map(h => visibleText(h)).filter(Boolean).slice(0, 18).join(' · ');

  const genericText = clone.innerText.replace(/\s+/g, ' ').trim().slice(0, 22000);
  const platformText = buildPlatformText(platformData);
  const text = [platformText, genericText].filter(Boolean).join('\n\n').replace(/\s+\n/g, '\n').trim().slice(0, 28000);
  const language = detectPageLanguage([title, metaDescription, headings, text].join(' '));

  return {
    title,
    url: location.href,
    domain: location.hostname,
    description: metaDescription,
    headings: platformData.headings || headings,
    text,
    platform: platformData.platform || platform,
    media: platformData.media || {},
    language,
    hasPasswordField: Boolean(document.querySelector('input[type="password"]')),
    extractedAt: new Date().toISOString()
  };
}

function detectPlatform() {
  const host = location.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'twitch';
  if (host === 'netflix.com' || host.endsWith('.netflix.com')) return 'netflix';
  return 'generic';
}

async function extractPlatformData(platform) {
  if (platform === 'youtube') return await extractYouTubeData();
  if (platform === 'twitch') return extractTwitchData();
  if (platform === 'netflix') return extractNetflixData();
  return { platform: 'generic', media: {} };
}

async function extractYouTubeData() {
  const isVideo = /\/watch\b|\/shorts\//.test(location.pathname);
  const videoId = getYouTubeVideoId();
  const title = cleanTitle(
    visibleText(document.querySelector('ytd-watch-metadata h1 yt-formatted-string')) ||
    visibleText(document.querySelector('h1.ytd-watch-metadata')) || getMeta('og:title') || document.title
  );
  const channel = visibleText(document.querySelector('ytd-watch-metadata ytd-channel-name #text a')) ||
    visibleText(document.querySelector('#owner #channel-name #text a')) ||
    visibleText(document.querySelector('ytd-video-owner-renderer #channel-name a')) || '';
  const description = visibleText(document.querySelector('ytd-watch-metadata #description-inline-expander')) ||
    visibleText(document.querySelector('#description')) || getMeta('description') || getMeta('og:description') || '';
  const viewsAndDate = visibleText(document.querySelector('ytd-watch-info-text')) || visibleText(document.querySelector('#info-strings')) || '';
  const chips = Array.from(document.querySelectorAll('yt-chip-cloud-chip-renderer, #chips yt-chip-cloud-chip-renderer')).map(visibleText).filter(Boolean).slice(0, 8).join(' · ');
  const searchQuery = location.pathname === '/results' ? new URLSearchParams(location.search).get('search_query') || '' : '';
  const transcript = isVideo ? await getYouTubeTranscript() : '';
  const playlistTitle = visibleText(document.querySelector('ytd-playlist-panel-renderer #title')) || '';
  return {
    platform: isVideo ? 'youtube-video' : (location.pathname === '/results' ? 'youtube-search' : 'youtube'),
    title: title || (searchQuery ? `YouTube-Suche: ${searchQuery}` : 'YouTube'),
    description,
    headings: [channel ? `Kanal: ${channel}` : '', viewsAndDate, playlistTitle ? `Playlist: ${playlistTitle}` : '', chips ? `Themen: ${chips}` : ''].filter(Boolean).join(' · '),
    media: { type: isVideo ? 'video' : 'page', videoId, channel, viewsAndDate, playlistTitle, searchQuery, transcript: transcript.slice(0, 10000) }
  };
}

function extractTwitchData() {
  const title = cleanTitle(visibleText(document.querySelector('[data-a-target="stream-title"]')) || getMeta('og:title') || document.title);
  const channel = visibleText(document.querySelector('[data-a-target="streamer-channel-name"]')) || visibleText(document.querySelector('h1')) || '';
  const game = visibleText(document.querySelector('[data-a-target="stream-game-link"]')) || visibleText(document.querySelector('a[href^="/directory/category/"]')) || '';
  const description = getMeta('description') || getMeta('og:description') || '';
  return { platform: 'twitch', title: title || 'Twitch', description, headings: [channel ? `Kanal: ${channel}` : '', game ? `Kategorie: ${game}` : ''].filter(Boolean).join(' · '), media: { type: 'stream', channel, game } };
}

function extractNetflixData() {
  const title = cleanTitle(visibleText(document.querySelector('[data-uia="video-title"]')) || visibleText(document.querySelector('.video-title')) || getMeta('og:title') || document.title);
  const description = visibleText(document.querySelector('[data-uia="title-info-synopsis"]')) || getMeta('description') || getMeta('og:description') || '';
  const maturity = visibleText(document.querySelector('[data-uia="maturity-rating"]')) || '';
  const year = visibleText(document.querySelector('[data-uia="item-year"]')) || '';
  return { platform: 'netflix', title: title || 'Netflix', description, headings: [year, maturity].filter(Boolean).join(' · '), media: { type: 'streaming-title', year, maturity } };
}

function buildPlatformText(data) {
  if (!data || data.platform === 'generic') return '';
  const media = data.media || {};
  return [
    `Plattform: ${data.platform}`,
    data.title ? `Titel: ${data.title}` : '',
    media.channel ? `Kanal/Creator: ${media.channel}` : '',
    media.game ? `Kategorie/Game: ${media.game}` : '',
    media.viewsAndDate ? `Aufrufe/Datum: ${media.viewsAndDate}` : '',
    media.playlistTitle ? `Playlist: ${media.playlistTitle}` : '',
    media.searchQuery ? `YouTube-Suche: ${media.searchQuery}` : '',
    data.description ? `Beschreibung: ${data.description}` : '',
    media.transcript ? `Transkript-Auszug: ${media.transcript}` : ''
  ].filter(Boolean).join('\n');
}

async function getYouTubeTranscript() {
  try {
    const captionTracks = findYouTubeCaptionTracks();
    if (!captionTracks.length) return '';
    const preferred = captionTracks.find(track => /^de\b/i.test(track.languageCode || '')) || captionTracks.find(track => /^en\b/i.test(track.languageCode || '')) || captionTracks[0];
    if (!preferred?.baseUrl) return '';
    const url = preferred.baseUrl.includes('fmt=') ? preferred.baseUrl : `${preferred.baseUrl}&fmt=json3`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return '';
    return parseCaptionResponse(await res.text());
  } catch { return ''; }
}

function findYouTubeCaptionTracks() {
  const scripts = Array.from(document.scripts).map(s => s.textContent || '').filter(t => t.includes('captionTracks'));
  for (const text of scripts) {
    const json = extractBalancedObjectAfter(text, 'ytInitialPlayerResponse');
    const fromJson = parseCaptionTracksFromJson(json);
    if (fromJson.length) return fromJson;
    const match = text.match(/"captionTracks"\s*:\s*(\[.*?\])\s*,\s*"audioTracks"/s);
    if (match?.[1]) { try { return JSON.parse(match[1].replace(/\\u0026/g, '&')); } catch {} }
  }
  return [];
}

function extractBalancedObjectAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return '';
  const start = text.indexOf('{', markerIndex);
  if (start < 0) return '';
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return '';
}

function parseCaptionTracksFromJson(jsonText) {
  if (!jsonText) return [];
  try { return JSON.parse(jsonText.replace(/\\u0026/g, '&'))?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []; } catch { return []; }
}

function parseCaptionResponse(raw) {
  try {
    const json = JSON.parse(raw);
    if (Array.isArray(json.events)) return json.events.flatMap(event => event.segs || []).map(seg => seg.utf8 || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
  } catch {}
  const div = document.createElement('div');
  div.innerHTML = raw;
  return Array.from(div.querySelectorAll('text')).map(node => node.textContent || '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
}

function getYouTubeVideoId() {
  try {
    const url = new URL(location.href);
    if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/').filter(Boolean)[1] || '';
    return url.searchParams.get('v') || '';
  } catch { return ''; }
}

function getMeta(name) { return document.querySelector(`meta[name="${cssEscape(name)}"]`)?.content || document.querySelector(`meta[property="${cssEscape(name)}"]`)?.content || ''; }
function cssEscape(value) { return String(value).replace(/"/g, '\\"'); }
function visibleText(el) { return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim(); }
function cleanTitle(title) { return String(title || '').replace(/\s+-\s+YouTube$/, '').replace(/\s+\|\s+Twitch$/, '').replace(/^Netflix\s*-\s*/i, '').trim(); }

function detectPageLanguage(text) {
  const htmlLang = String(document.documentElement?.lang || '').trim().slice(0, 20);
  const sample = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 12000)} `;
  const scores = {
    de: countMatches(sample, [' der ', ' die ', ' das ', ' und ', ' ist ', ' nicht ', ' ein ', ' eine ', ' mit ', ' für ', ' auf ', ' von ', ' zu ', ' wurde ', ' kaufen ', ' warenkorb ']),
    en: countMatches(sample, [' the ', ' and ', ' is ', ' are ', ' not ', ' with ', ' for ', ' this ', ' that ', ' you ', ' your ', ' from ', ' to ', ' buy ', ' cart ', ' checkout ']),
    fr: countMatches(sample, [' le ', ' la ', ' les ', ' et ', ' est ', ' pas ', ' pour ', ' avec ', ' vous ', ' votre ', ' panier ']),
    es: countMatches(sample, [' el ', ' la ', ' los ', ' las ', ' y ', ' es ', ' no ', ' para ', ' con ', ' usted ', ' carrito '])
  };
  const detected = Object.entries(scores).sort((a,b) => b[1] - a[1])[0];
  return { htmlLang, detected: detected && detected[1] > 1 ? detected[0] : (htmlLang ? htmlLang.split('-')[0].toLowerCase() : 'unknown') };
}
function countMatches(text, needles) { return needles.reduce((sum, needle) => sum + (text.includes(needle) ? 1 : 0), 0); }

function simpleHash(str) { let hash = 0; for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0; return String(hash); }

async function autoRemember(reason = 'idle') {
  if (!/^https?:\/\//.test(location.href)) return;
  const now = Date.now();
  if (now - lastSentAt < 10000) return;
  const page = await extractReadablePage();
  if (!page.text || page.text.length < 80) return;
  const payloadHash = simpleHash(`${page.url}|${page.title}|${page.language?.detected || ''}|${page.text.slice(0, 2500)}`);
  if (payloadHash === lastPayloadHash) return;
  lastPayloadHash = payloadHash;
  lastSentAt = now;
  chrome.runtime.sendMessage({ type: 'OMNI_AUTO_REMEMBER_PAGE', page, reason }, () => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'OMNI_EXTRACT_NOW') {
    extractReadablePage().then(page => sendResponse({ ok: true, page })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

function scheduleRemember(reason = 'scheduled') { const platform = detectPlatform(); const delay = PLATFORM_WAIT_MS[platform] || PLATFORM_WAIT_MS.generic; setTimeout(() => autoRemember(reason), delay); }
scheduleRemember('initial_idle');
setTimeout(() => autoRemember('late_dynamic_content'), 12000);

let mutationTimer;
const observer = new MutationObserver(() => { clearTimeout(mutationTimer); mutationTimer = setTimeout(() => autoRemember('content_changed'), 3500); });
if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href; lastPayloadHash = ''; lastSentAt = 0;
    scheduleRemember('spa_url_changed');
    setTimeout(() => autoRemember('spa_late_dynamic_content'), 12000);
  }
}, 1000);

// Remy Seiten-Popup mit radialem Schnellmenü und getrennten Chats
(function initRemySideChat() {
  if (window.__remySideChatInstalled) return;
  window.__remySideChatInstalled = true;
  if (!/^https?:\/\//.test(location.href)) return;

  const root = document.createElement('div');
  root.id = 'remy-side-root';
  root.innerHTML = `
    <button id="remy-float-button" title="Remy öffnen"><img src="${chrome.runtime.getURL('logo.svg')}" alt="Remy"></button>
    <div id="remy-radial-menu" class="remy-radial-menu hidden" aria-label="Remy Schnellaktionen">
      <button id="remy-radial-local" class="remy-radial-action local" title="Lokal fragen"><span>Lokal</span></button>
      <button id="remy-radial-public" class="remy-radial-action public" title="Öffentlich fragen"><span>Öffentlich</span></button>
      <button id="remy-radial-ignore" class="remy-radial-action ignore" title="Diese Seite nie merken"><span>Nie merken</span></button>
    </div>
    <section id="remy-side-panel" class="remy-side-panel hidden" aria-label="Remy Chat">
      <header class="remy-side-header">
        <div><img src="${chrome.runtime.getURL('logo.svg')}" alt=""><strong>Remy</strong><span id="remy-side-mode-label">Lokal</span></div>
        <button id="remy-side-close">×</button>
      </header>
      <p id="remy-mode-help" class="remy-mode-help">Lokal nutzt deine gespeicherten Erinnerungen und diese sichere Seite.</p>
      <div id="remy-side-usage" class="remy-side-usage">Fragen werden geladen…</div>
      <div id="remy-side-messages" class="remy-side-messages"></div>
      <form id="remy-side-form" class="remy-side-form">
        <textarea id="remy-side-input" rows="2" placeholder="Lokal fragen…"></textarea>
        <button type="submit">↵</button>
      </form>
    </section>`;
  document.documentElement.appendChild(root);

  const style = document.createElement('style');
  style.textContent = `
    #remy-side-root{position:fixed!important;z-index:2147483647!important;right:18px!important;bottom:18px!important;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;color:#1f2937!important}
    #remy-float-button{width:68px;height:68px;border:0;border-radius:24px;background:linear-gradient(135deg,#fff7ed,#eef2ff);box-shadow:0 18px 45px rgba(79,70,229,.25);display:grid;place-items:center;cursor:pointer;padding:8px;transition:.18s transform,.18s box-shadow;position:relative;z-index:2}
    #remy-float-button:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 22px 55px rgba(79,70,229,.33)}#remy-float-button img{width:54px;height:54px;object-fit:contain;display:block}
    .remy-radial-menu{position:absolute;right:7px;bottom:7px;width:178px;height:178px;pointer-events:none}.remy-radial-menu.hidden{display:none}.remy-radial-action{position:absolute;width:72px;height:72px;border:0;border-radius:24px;box-shadow:0 18px 44px rgba(31,41,55,.22);cursor:pointer;font-size:11px;font-weight:900;line-height:1.05;color:white;pointer-events:auto;display:grid;place-items:center;padding:9px;text-align:center;transition:.16s transform}.remy-radial-action:hover{transform:translateY(-2px) scale(1.04)}.remy-radial-action.local{right:0;bottom:96px;background:linear-gradient(135deg,#7c3aed,#4f46e5)}.remy-radial-action.public{right:76px;bottom:76px;background:linear-gradient(135deg,#0891b2,#0e7490)}.remy-radial-action.ignore{right:96px;bottom:0;background:linear-gradient(135deg,#f97316,#dc2626)}
    .remy-side-panel{position:absolute;right:0;bottom:82px;width:min(360px,calc(100vw - 34px));max-height:min(570px,calc(100vh - 112px));background:rgba(255,255,255,.98);backdrop-filter:blur(14px);border:1px solid rgba(124,58,237,.13);border-radius:28px;box-shadow:0 28px 90px rgba(31,41,55,.26);overflow:hidden;display:flex;flex-direction:column}.remy-side-panel.hidden{display:none}.remy-side-panel.public-mode{border-color:rgba(8,145,178,.22);box-shadow:0 28px 90px rgba(8,145,178,.22)}.remy-side-panel.local-mode{border-color:rgba(124,58,237,.20)}
    .remy-side-header{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 9px}.remy-side-header>div{display:flex;align-items:center;gap:9px}.remy-side-header img{width:34px;height:34px}.remy-side-header strong{font-size:16px}.remy-side-header span{font-size:11px;font-weight:900;border-radius:999px;background:#ede9fe;color:#6d28d9;padding:4px 8px}.public-mode .remy-side-header span{background:#cffafe;color:#0e7490}.remy-side-header button{border:0;background:#f3f4f6;border-radius:12px;width:30px;height:30px;cursor:pointer;font-size:18px;color:#4b5563}
    .remy-mode-help{font-size:12px;color:#6b7280;margin:0 16px 8px;line-height:1.35}.remy-side-usage{font-size:12px;font-weight:800;color:#4b5563;background:#f9fafb;border-top:1px solid #f3f4f6;border-bottom:1px solid #f3f4f6;padding:9px 16px}.public-mode .remy-side-usage{background:#ecfeff;color:#0e7490}.local-mode .remy-side-usage{background:#f5f3ff;color:#6d28d9}
    .remy-side-messages{padding:14px;overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:150px;max-height:34vh}.remy-bubble{border-radius:18px;padding:11px 12px;line-height:1.42;font-size:13px;white-space:pre-wrap}.remy-bot{background:#f3f4f6}.remy-user{background:#4f46e5;color:white;align-self:flex-end;max-width:84%}.remy-bot.public{background:#ecfeff}.remy-bot.local{background:#f5f3ff}.remy-source{font-size:12px;border:1px solid #e5e7eb;border-radius:14px;padding:8px;margin-top:7px;background:white}.remy-source a{color:#4f46e5;font-weight:800;text-decoration:none}
    .remy-side-form{display:flex;gap:8px;padding:12px;background:#fff;border-top:1px solid #f3f4f6}.remy-side-form textarea{flex:1;border:1px solid #e5e7eb;border-radius:18px;padding:11px;resize:none;font:inherit;font-size:13px;outline:none;max-height:90px}.remy-side-form textarea:focus{border-color:#a78bfa;box-shadow:0 0 0 4px #ede9fe}.public-mode .remy-side-form textarea:focus{border-color:#67e8f9;box-shadow:0 0 0 4px #ecfeff}.remy-side-form button{width:44px;border:0;border-radius:17px;background:#111827;color:white;font-weight:900;cursor:pointer}`;
  document.documentElement.appendChild(style);

  const $r = (id) => root.querySelector(`#${id}`);
  let mode = 'local';
  const histories = {
    local: [{ who: 'bot', text: 'Lokaler Chat. Ich nutze nur deine gespeicherten Erinnerungen und sichere Seiten.' }],
    public: [{ who: 'bot', text: 'Öffentlicher Chat. Ich nutze allgemeines KI-Wissen. Gib hier keine privaten Daten ein.' }]
  };

  $r('remy-float-button').addEventListener('click', () => $r('remy-radial-menu').classList.toggle('hidden'));
  $r('remy-radial-local').addEventListener('click', () => openChat('local'));
  $r('remy-radial-public').addEventListener('click', () => openChat('public'));
  $r('remy-radial-ignore').addEventListener('click', ignoreCurrentSite);
  $r('remy-side-close').addEventListener('click', () => $r('remy-side-panel').classList.add('hidden'));
  $r('remy-side-form').addEventListener('submit', async (event) => { event.preventDefault(); await ask(); });
  $r('remy-side-input').addEventListener('keydown', async (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); await ask(); } });

  function openChat(next) {
    $r('remy-radial-menu').classList.add('hidden');
    setMode(next, true);
    $r('remy-side-panel').classList.remove('hidden');
  }

  function setMode(next, focus = false) {
    mode = next === 'public' ? 'public' : 'local';
    chrome.runtime.sendMessage({ type: 'REMY_SET_MODE', mode }, () => {});
    $r('remy-side-mode-label').textContent = mode === 'public' ? 'Öffentlich' : 'Lokal';
    $r('remy-side-panel').classList.toggle('public-mode', mode === 'public');
    $r('remy-side-panel').classList.toggle('local-mode', mode === 'local');
    $r('remy-mode-help').textContent = mode === 'public' ? 'Öffentlich nutzt allgemeines KI-Wissen. Stelle hier keine privaten Daten rein.' : 'Lokal nutzt deine gespeicherten Erinnerungen und diese sichere Seite.';
    $r('remy-side-input').placeholder = mode === 'public' ? 'Öffentlich fragen…' : 'Lokal fragen…';
    renderHistory();
    refreshUsage();
    if (focus) $r('remy-side-input').focus();
  }

  function renderHistory() {
    const box = $r('remy-side-messages');
    box.innerHTML = '';
    histories[mode].forEach(item => {
      const div = document.createElement('div');
      div.className = `remy-bubble ${item.who === 'user' ? 'remy-user' : `remy-bot ${mode}`}`;
      div.textContent = item.text;
      if (item.sources?.length) item.sources.slice(0, 3).forEach(source => {
        const s = document.createElement('div');
        s.className = 'remy-source';
        s.innerHTML = `<strong>${escapeHtml(source.title || source.domain || 'Quelle')}</strong><br><a href="${escapeAttr(source.url || '#')}" target="_blank" rel="noreferrer">Öffnen</a>`;
        div.appendChild(s);
      });
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  }

  function pushMessage(who, text, sources = null) {
    histories[mode].push({ who, text, sources });
    renderHistory();
    return histories[mode].length - 1;
  }
  function replaceBot(index, text, sources = null) { histories[mode][index] = { who: 'bot', text, sources }; renderHistory(); }

  function updateUsage(usage) {
    if (!usage) return;
    const remaining = usage.remaining === null || usage.remaining === undefined ? usage.limit - usage.used : usage.remaining;
    $r('remy-side-usage').textContent = `${Math.max(0, remaining)} von ${usage.limit} Fragen übrig · ${usage.plan === 'free' ? 'Free' : usage.plan}`;
  }
  function refreshUsage() { chrome.runtime.sendMessage({ type: 'REMY_GET_AUTH' }, r => updateUsage(r?.usage)); }

  async function ignoreCurrentSite() {
    $r('remy-radial-menu').classList.add('hidden');
    chrome.runtime.sendMessage({ type: 'REMY_IGNORE_CURRENT_SITE_AND_DELETE' }, (response) => {
      const msg = response?.ok ? `Diese Website wird nicht mehr gemerkt. ${response.deleted || 0} alte Erinnerungen wurden gelöscht.` : (response?.error || 'Website konnte nicht blockiert werden.');
      openChat('local');
      pushMessage('bot', msg);
    });
  }

  async function ask() {
    const input = $r('remy-side-input');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    const activeMode = mode;
    pushMessage('user', question);
    const loadingIndex = pushMessage('bot', 'Remy denkt kurz…');
    chrome.runtime.sendMessage({ type: 'REMY_SIDEBAR_ASK', question, mode: activeMode }, (response) => {
      if (mode !== activeMode) mode = activeMode;
      if (!response?.ok || response.loginRequired) {
        replaceBot(loadingIndex, response?.error || 'Bitte melde dich zuerst an.');
        return;
      }
      replaceBot(loadingIndex, response.answer || 'Keine Antwort erhalten.', response.sources || null);
      updateUsage(response.usage);
    });
  }

  chrome.storage.local.get(['remy_mode', 'remy_usage_cache'], ({ remy_mode, remy_usage_cache }) => { setMode(remy_mode || 'local'); updateUsage(remy_usage_cache); });
  function escapeHtml(v) { return String(v || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
  function escapeAttr(v) { return escapeHtml(v).replaceAll('"','&quot;'); }
})();
