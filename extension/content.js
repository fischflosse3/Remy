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

// Remy Seiten-Popup unten rechts mit radialen Aktionen und direktem Chat
(function initRemySideChat() {
  if (window.__remySideChatInstalled) return;
  window.__remySideChatInstalled = true;
  if (!/^https?:\/\//.test(location.href)) return;

  const root = document.createElement('div');
  root.id = 'remy-side-root';
  root.innerHTML = `
    <button id="remy-float-button" title="Remy öffnen"><img src="${chrome.runtime.getURL('logo.svg')}" alt="Remy"></button>
    <div id="remy-radial-actions" class="remy-radial-actions hidden" aria-label="Remy Aktionen">
      <button id="remy-action-local" class="remy-action bubble-local" type="button">Browser<br>suchen</button>
      <button id="remy-action-public" class="remy-action bubble-public" type="button">Allgemein<br>fragen</button>
      <button id="remy-action-ignore" class="remy-action bubble-ignore" type="button">Nie<br>merken</button>
    </div>
    <section id="remy-side-panel" class="remy-side-panel hidden" aria-label="Remy Chat">
      <header class="remy-side-header">
        <div><img src="${chrome.runtime.getURL('logo.svg')}" alt=""><strong>Remy</strong><span id="remy-side-mode-label">Browser suchen</span></div>
        <button id="remy-side-close" type="button">×</button>
      </header>
      <div class="remy-chat-tools"><button id="remy-chat-picker" type="button">Chat auswählen</button><button id="remy-new-chat" type="button">Neuer Chat</button></div>
      <div id="remy-chat-list" class="remy-chat-list hidden"></div>
      <p id="remy-mode-help" class="remy-mode-help">Browser suchen nutzt nur gespeicherte Seiten und diese sichere Seite.</p>
      <div id="remy-side-usage" class="remy-side-usage">Anfragen werden geladen…</div>
      <div id="remy-side-messages" class="remy-side-messages">
        <div class="remy-bubble remy-bot local">Frag Remy nach Seiten, Tabs oder Erinnerungen.</div>
      </div>
      <form id="remy-side-form" class="remy-side-form">
        <textarea id="remy-side-input" rows="2" placeholder="Was möchtest du wissen?"></textarea>
        <button type="submit">↵</button>
      </form>
    </section>`;
  document.documentElement.appendChild(root);

  const style = document.createElement('style');
  style.textContent = `
    #remy-side-root{position:fixed!important;z-index:2147483647!important;right:18px!important;bottom:18px!important;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;color:#1f2937!important}
    #remy-float-button{width:64px;height:64px;border:0;border-radius:25px;background:linear-gradient(135deg,#fff7ed,#eef2ff);box-shadow:0 18px 45px rgba(79,70,229,.25);display:grid;place-items:center;cursor:pointer;padding:8px;transition:.18s transform,.18s box-shadow;position:relative;z-index:4}
    #remy-float-button:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 22px 55px rgba(79,70,229,.33)}
    #remy-float-button img{width:48px;height:48px;object-fit:contain;display:block}
    .remy-radial-actions{position:absolute;right:0;bottom:0;width:190px;height:190px;pointer-events:none}.remy-radial-actions.hidden{display:none}.remy-action{position:absolute;width:72px;height:72px;border:0;border-radius:24px;color:white;font-size:12px;line-height:1.1;font-weight:950;box-shadow:0 18px 42px rgba(31,41,55,.25);cursor:pointer;pointer-events:auto;transition:.16s transform}.remy-action:hover{transform:translateY(-2px) scale(1.04)}.bubble-local{right:0;bottom:92px;background:#4f46e5}.bubble-public{right:78px;bottom:78px;background:#0891b2}.bubble-ignore{right:92px;bottom:0;background:#111827}
    .remy-side-panel{position:absolute;right:0;bottom:78px;width:348px;max-height:min(640px,calc(100vh - 118px));background:rgba(255,255,255,.98);backdrop-filter:blur(14px);border:1px solid rgba(124,58,237,.13);border-radius:28px;box-shadow:0 28px 90px rgba(31,41,55,.26);overflow:hidden;display:flex;flex-direction:column}.remy-side-panel.hidden{display:none}
    .remy-side-header{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 10px}.remy-side-header>div{display:flex;align-items:center;gap:9px}.remy-side-header img{width:34px;height:34px}.remy-side-header strong{font-size:16px}.remy-side-header span{font-size:11px;font-weight:900;border-radius:999px;background:#ede9fe;color:#6d28d9;padding:4px 8px}.remy-side-header span.public{background:#cffafe;color:#0e7490}.remy-side-header button{border:0;background:#f3f4f6;border-radius:12px;width:30px;height:30px;cursor:pointer;font-size:18px;color:#4b5563}
    .remy-chat-tools{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 14px 8px}.remy-chat-tools button{border:0;border-radius:14px;background:#f9fafb;color:#4b5563;font-size:12px;font-weight:900;padding:9px;cursor:pointer}.remy-chat-list{margin:0 14px 8px;background:white;border:1px solid #e5e7eb;border-radius:16px;padding:6px;box-shadow:0 12px 28px #0001;max-height:178px;overflow:auto}.remy-chat-list.hidden{display:none}.remy-chat-option{width:100%;border:0;background:transparent;text-align:left;padding:9px 10px;border-radius:12px;cursor:pointer;font-size:12px;color:#374151;font-weight:800}.remy-chat-option.active{background:#ede9fe;color:#5b21b6}.remy-chat-row{display:flex;align-items:center;gap:6px;border-radius:12px}.remy-chat-row.active{background:#ede9fe}.remy-chat-row .remy-chat-option{flex:1}.remy-chat-delete{border:0;background:#fee2e2;color:#b91c1c;border-radius:10px;width:28px;height:28px;font-weight:900;cursor:pointer}.remy-mode-help{font-size:12px;color:#6b7280;margin:4px 16px 8px;line-height:1.35}.remy-side-usage{font-size:12px;font-weight:800;color:#4b5563;background:#f9fafb;border-top:1px solid #f3f4f6;border-bottom:1px solid #f3f4f6;padding:9px 16px}
    .remy-side-messages{padding:14px;overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:170px}.remy-bubble{border-radius:18px;padding:11px 12px;line-height:1.42;font-size:13px;white-space:pre-wrap}.remy-bot{background:#f3f4f6}.remy-user{background:#4f46e5;color:white;align-self:flex-end;max-width:84%}.remy-bot.public{background:#ecfeff}.remy-bot.local{background:#f5f3ff}.remy-source-links{display:flex;flex-direction:column;gap:6px;margin-top:8px}.remy-source-link{color:#2563eb!important;font-size:12px;font-weight:950;text-decoration:underline!important;word-break:break-word}.remy-source-link:hover{color:#1d4ed8!important}
    .remy-side-form{display:flex;gap:8px;padding:12px;border-top:1px solid #f3f4f6;background:white}.remy-side-form textarea{flex:1;border:1px solid #e5e7eb;border-radius:18px;padding:11px;resize:none;font:inherit;font-size:13px;outline:none;max-height:92px}.remy-side-form textarea:focus{border-color:#a78bfa;box-shadow:0 0 0 4px #ede9fe}.remy-side-form button{width:44px;border:0;border-radius:17px;background:#111827;color:white;font-weight:900;cursor:pointer}`;
  document.documentElement.appendChild(style);

  const $r = (id) => root.querySelector(`#${id}`);
  let mode = 'local';
  let activeChatId = null;
  let chatState = { chats: [], activeChatId: null };

  $r('remy-float-button').addEventListener('click', async () => {
    if (!$r('remy-side-panel').classList.contains('hidden')) { closePanel(); return; }
    await refreshBlockButton();
    $r('remy-radial-actions').classList.toggle('hidden');
  });
  $r('remy-side-close').addEventListener('click', closePanel);
  $r('remy-action-local').addEventListener('click', () => openChat('local'));
  $r('remy-action-public').addEventListener('click', () => openChat('public'));
  $r('remy-action-ignore').addEventListener('click', toggleCurrentSiteMemory);
  $r('remy-chat-picker').addEventListener('click', async () => { await loadChats(); $r('remy-chat-list').classList.toggle('hidden'); });
  $r('remy-new-chat').addEventListener('click', async () => { chrome.runtime.sendMessage({ type: 'REMY_NEW_CHAT', mode }, (r) => { if (r?.ok) { chatState = r; activeChatId = r.activeChatId; renderChatList(); resetChatWindow(); } }); });
  $r('remy-side-form').addEventListener('submit', async (event) => { event.preventDefault(); await ask(); });
  $r('remy-side-input').addEventListener('keydown', async (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); await ask(); } });

  function closePanel() { $r('remy-side-panel').classList.add('hidden'); $r('remy-radial-actions').classList.add('hidden'); }
  function openChat(nextMode) { setMode(nextMode || 'local', true); $r('remy-radial-actions').classList.add('hidden'); $r('remy-side-panel').classList.remove('hidden'); $r('remy-side-input').focus(); }
  function setMode(next, focus = false) {
    mode = next === 'public' ? 'public' : 'local';
    chrome.runtime.sendMessage({ type: 'REMY_SET_MODE', mode }, () => {});
    const label = $r('remy-side-mode-label');
    label.textContent = mode === 'public' ? 'Allgemein fragen' : 'Browser suchen';
    label.classList.toggle('public', mode === 'public');
    $r('remy-mode-help').textContent = mode === 'public' ? 'Allgemein fragen nutzt allgemeines KI-Wissen. Keine privaten Daten eingeben.' : 'Browser suchen nutzt nur gespeicherte Seiten und diese sichere Seite.';
    loadChats();
    if (focus) $r('remy-side-input').focus();
  }

  async function toggleCurrentSiteMemory() {
    chrome.runtime.sendMessage({ type: 'REMY_TOGGLE_CURRENT_SITE_MEMORY' }, (r) => {
      $r('remy-radial-actions').classList.add('hidden');
      if (!r?.ok) return;
      const text = r.blocked ? 'Diese Website wird nicht mehr gemerkt. Alte Erinnerungen wurden entfernt.' : 'Diese Website wird wieder gemerkt.';
      openChat('local');
      addBubble(text, 'bot');
      refreshBlockButton();
    });
  }
  async function refreshBlockButton() {
    chrome.runtime.sendMessage({ type: 'REMY_GET_SITE_BLOCK_STATE' }, (r) => {
      if (!r?.ok) return;
      $r('remy-action-ignore').innerHTML = r.blocked ? 'Wieder<br>merken' : 'Nie<br>merken';
    });
  }

  function addBubble(text, who = 'bot') {
    const div = document.createElement('div');
    div.className = `remy-bubble ${who === 'user' ? 'remy-user' : `remy-bot ${mode}`}`;
    div.textContent = text;
    $r('remy-side-messages').appendChild(div);
    $r('remy-side-messages').scrollTop = $r('remy-side-messages').scrollHeight;
    return div;
  }
  function updateUsage(usage) {
    if (!usage) return;
    const remaining = usage.remaining === null || usage.remaining === undefined ? usage.limit - usage.used : usage.remaining;
    $r('remy-side-usage').textContent = `${Math.max(0, remaining)} von ${usage.limit} Anfragen übrig · ${usage.plan === 'free' ? 'Free' : (usage.plan === 'lifetime' ? 'Remy Lifetime' : 'Remy Unlimited')}`;
  }
  async function ask() {
    const input = $r('remy-side-input');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    addBubble(question, 'user');
    const loading = addBubble('Remy denkt kurz…', 'bot');
    chrome.runtime.sendMessage({ type: 'REMY_SIDEBAR_ASK', question, mode, chatId: activeChatId }, (response) => {
      if (!response?.ok || response.loginRequired) {
        loading.textContent = response?.error || 'Bitte melde dich zuerst an.';
        const a = document.createElement('button');
        a.textContent = 'Einloggen';
        a.style.cssText = 'margin-top:8px;border:0;border-radius:12px;padding:8px 12px;background:#4f46e5;color:white;font-weight:800;cursor:pointer';
        a.onclick = () => chrome.runtime.sendMessage({ type: 'REMY_START_LOGIN' });
        loading.appendChild(document.createElement('br'));
        loading.appendChild(a);
        return;
      }
      loading.textContent = response.answer || 'Keine Antwort erhalten.';
      updateUsage(response.usage);
      if (response.activeChatId) activeChatId = response.activeChatId;
      if (response.chats) { chatState = { chats: response.chats, activeChatId: response.activeChatId || activeChatId }; renderChatList(); }
      if (Array.isArray(response.sources) && response.sources.length) {
        const links = document.createElement('div');
        links.className = 'remy-source-links';
        response.sources.slice(0, 5).forEach(source => {
          const url = source.url || '';
          const a = document.createElement('a');
          a.className = 'remy-source-link';
          a.href = url || '#';
          a.textContent = source.sourceType === 'open-tab' ? `Offener Tab: ${source.title || source.domain || url}` : (source.title || source.domain || url || 'Quelle');
          a.dataset.url = url;
          a.dataset.tabId = source.media?.tabId || '';
          a.dataset.windowId = source.media?.windowId || '';
          a.onclick = (event) => {
            event.preventDefault();
            if (a.dataset.tabId) chrome.runtime.sendMessage({ type: 'REMY_OPEN_TAB_SOURCE', tabId: a.dataset.tabId, windowId: a.dataset.windowId, url });
            else if (url) window.open(url, '_blank', 'noopener,noreferrer');
          };
          links.appendChild(a);
        });
        loading.appendChild(links);
      }
    });
  }
  function resetChatWindow() {
    $r('remy-side-messages').innerHTML = `<div class="remy-bubble remy-bot ${mode}">Neuer Chat gestartet. Folgefragen bleiben jetzt in diesem Thema.</div>`;
    $r('remy-side-input').focus();
  }
  async function loadChats() {
    chrome.runtime.sendMessage({ type: 'REMY_GET_CHAT_STATE', mode }, (r) => {
      if (!r?.ok) return;
      chatState = r;
      activeChatId = r.activeChatId;
      renderChatList();
    });
  }
  function renderChatList() {
    const list = $r('remy-chat-list');
    const chats = chatState.chats || [];
    list.innerHTML = chats.length ? chats.slice(0, 6).map(c => `<div class="remy-chat-row ${c.id === activeChatId ? 'active' : ''}"><button type="button" class="remy-chat-option" data-id="${escapeAttr(c.id)}">${escapeHtml(c.title || (mode === 'public' ? 'Allgemeiner Chat' : 'Browser-Chat'))}</button><button type="button" class="remy-chat-delete" data-id="${escapeAttr(c.id)}" title="Chat löschen">×</button></div>`).join('') : '<div class="remy-chat-option">Noch kein Chat</div>';
    list.querySelectorAll('.remy-chat-option[data-id]').forEach(btn => btn.onclick = () => {
      const id = btn.dataset.id;
      chrome.runtime.sendMessage({ type: 'REMY_SELECT_CHAT', mode, chatId: id }, (r) => {
        if (r?.ok) { chatState = r; activeChatId = r.activeChatId; renderChatList(); $r('remy-chat-list').classList.add('hidden'); resetChatWindow(); }
      });
    });
    list.querySelectorAll('.remy-chat-delete[data-id]').forEach(btn => btn.onclick = (event) => {
      event.stopPropagation();
      if (!confirm('Diesen Chat löschen?')) return;
      chrome.runtime.sendMessage({ type: 'REMY_DELETE_CHAT', mode, chatId: btn.dataset.id }, (r) => {
        if (r?.ok) { chatState = r; activeChatId = r.activeChatId; renderChatList(); resetChatWindow(); }
      });
    });
  }

  chrome.storage.local.get(['remy_mode', 'remy_usage_cache'], ({ remy_mode, remy_usage_cache }) => { setMode(remy_mode || 'local'); updateUsage(remy_usage_cache); loadChats(); refreshBlockButton(); });
  function escapeHtml(v) { return String(v || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
  function escapeAttr(v) { return escapeHtml(v).replaceAll('"','&quot;'); }
})();
