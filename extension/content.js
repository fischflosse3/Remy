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

// Small side assistant. It does not read sensitive content; it only lets the user choose a mode quickly.
(function initRemySideBubble(){
  if (window.__remySideBubble || !/^https?:/.test(location.href)) return;
  window.__remySideBubble = true;
  const host = document.createElement('div');
  host.id = 'remy-side-bubble-root';
  host.innerHTML = `
    <style>
      #remy-side-bubble-root{position:fixed;right:18px;top:42%;z-index:2147483647;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#203a57}
      .remy-bubble{width:46px;height:46px;border:0;border-radius:18px;background:linear-gradient(135deg,#3e78d6,#7dd6c9);box-shadow:0 14px 34px rgba(32,58,87,.24);color:white;font-weight:900;cursor:pointer}
      .remy-panel{position:absolute;right:0;top:54px;width:218px;background:rgba(255,255,255,.96);border:1px solid #dbeafe;border-radius:20px;box-shadow:0 22px 64px rgba(32,58,87,.20);padding:12px;display:none}
      .remy-panel.open{display:block}.remy-panel strong{font-size:13px}.remy-panel p{margin:5px 0 10px;font-size:11.5px;line-height:1.35;color:#52677d}.remy-panel button{width:100%;border:0;border-radius:14px;padding:10px;margin-top:7px;font-weight:850;cursor:pointer}.remy-local{background:#eef7ff;color:#203a57}.remy-public{background:linear-gradient(135deg,#3e78d6,#7dd6c9);color:white}.remy-note{font-size:10.5px;color:#6b7c8f;margin-top:7px;line-height:1.3}
    </style>
    <button class="remy-bubble" title="Remy öffnen">R</button>
    <div class="remy-panel"><strong>Remy fragen</strong><p>Wähle, ob Remy deine Erinnerungen nutzt oder allgemein antwortet.</p><button class="remy-local">Lokal fragen</button><button class="remy-public">Öffentlich fragen</button><div class="remy-note">Du kannst den Modus später jederzeit ändern.</div></div>`;
  document.documentElement.appendChild(host);
  const panel = host.querySelector('.remy-panel');
  host.querySelector('.remy-bubble').addEventListener('click', () => panel.classList.toggle('open'));
  async function choose(mode){
    try { await chrome.storage.local.set({ remy_mode: mode }); } catch {}
    try { chrome.runtime.sendMessage({ type:'OMNI_OPEN_POPUP' }, () => {}); } catch {}
    panel.classList.remove('open');
  }
  host.querySelector('.remy-local').addEventListener('click', () => choose('local'));
  host.querySelector('.remy-public').addEventListener('click', () => choose('public'));
})();
