import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, 'data');
const usageFile = path.join(dataDir, 'usage.json');

const app = express();
const port = Number(process.env.PORT || 8787);
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const freeLimit = Number(process.env.FREE_MONTHLY_QUESTIONS || 10);
const plusPrice = process.env.PLUS_PRICE || '3,99 € / Monat';
const maxQuestionChars = Number(process.env.MAX_QUESTION_CHARS || 800);
const maxMemoryChars = Number(process.env.MAX_MEMORY_CHARS || 2600);
const maxMemories = Number(process.env.MAX_MEMORIES_PER_ASK || 10);
const hasKey = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dein_api_key_hier');
const openai = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const rateBuckets = new Map();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimitMiddleware);

app.get('/health', (_req, res) => { res.json({ ok: true, service: 'remy-backend', hasKey, model, freeLimit, plusPrice }); });
app.get('/api/usage', async (req, res) => { const userId = getUserId(req); const usage = await getUsage(userId); res.json({ ok: true, usage: publicUsage(usage) }); });

app.post('/api/ask', async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ error: 'Remy kann gerade nicht antworten. Der API-Key ist im Backend noch nicht eingerichtet.' });
    const userId = getUserId(req);
    const usage = await getUsage(userId);
    if (usage.plan !== 'plus' && usage.used >= freeLimit) {
      return res.status(402).json({ error: `Du hast deine ${freeLimit} kostenlosen KI-Fragen für diesen Monat verbraucht. Upgrade auf Plus für ${plusPrice}.`, usage: publicUsage(usage) });
    }

    const question = clip(req.body?.question, maxQuestionChars);
    const memories = Array.isArray(req.body?.memories) ? req.body.memories.slice(0, maxMemories) : [];
    if (!question) return res.status(400).json({ error: 'Frage fehlt.' });
    if (!memories.length) return res.status(400).json({ error: 'Keine Erinnerungen übergeben.' });

    const context = memories.map((m, index) => [
      `Quelle ${index + 1}:`,
      `Titel: ${clip(m.title, 180)}`,
      `Domain: ${clip(m.domain, 120)}`,
      `URL: ${clip(m.url, 400)}`,
      `Gespeichert: ${clip(m.savedAt, 80)}`,
      m.platform ? `Plattform: ${clip(m.platform, 80)}` : '',
      m.language?.detected ? `Erkannte Sprache: ${clip(m.language.detected, 40)}` : '',
      m.language?.htmlLang ? `HTML-Sprache: ${clip(m.language.htmlLang, 40)}` : '',
      m.media?.channel ? `Kanal/Creator: ${clip(m.media.channel, 120)}` : '',
      m.media?.game ? `Kategorie: ${clip(m.media.game, 120)}` : '',
      m.searchQuery ? `Suchanfrage: ${clip(m.searchQuery, 160)}` : '',
      `Kurzfassung: ${clip(m.summary, 760)}`,
      `Textauszug: ${clip(m.text, maxMemoryChars)}`
    ].filter(Boolean).join('\n')).join('\n\n---\n\n');

    const response = await openai.responses.create({
      model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'Du bist Remy, ein hilfreiches Browser-Gedächtnis. Antworte auf Deutsch, klar und knapp. Nutze nur die übergebenen lokalen Erinnerungen und die aktuelle Seite als Grundlage. Wenn die Frage nach der aktuellen Sprache fragt, prüfe die erkannten Sprachfelder und den Textauszug. Wenn du unsicher bist, sag es. Erfinde keine Quellen. Nenne am Ende 1-3 passende Quellen mit Titel, Domain und URL. Erfinde keine Links und nutze nur die angegebenen URLs.' }] },
        { role: 'user', content: [{ type: 'input_text', text: `Frage des Nutzers:\n${question}\n\nLokale Browser-Erinnerungen und aktuelle sichere Seite:\n${context}` }] }
      ]
    });

    const nextUsage = await incrementUsage(userId);
    res.json({ ok: true, answer: response.output_text || 'Ich konnte keine Antwort erzeugen.', usage: publicUsage(nextUsage) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Remy konnte gerade keine KI-Antwort erzeugen. Bitte versuche es gleich nochmal.' });
  }
});

app.listen(port, () => {
  console.log(`Remy backend läuft auf http://localhost:${port}`);
  console.log(hasKey ? `OpenAI Modell: ${model}` : 'OPENAI_API_KEY fehlt noch. Trage ihn in .env ein.');
  console.log(`Free-Limit: ${freeLimit} Fragen/Monat · Plus: ${plusPrice}`);
});

function rateLimitMiddleware(req, res, next) {
  const now = Date.now();
  const key = `${req.ip || 'ip'}:${getUserId(req)}`;
  const windowMs = 60 * 1000;
  const maxPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE || 12);
  const bucket = rateBuckets.get(key) || { start: now, count: 0 };
  if (now - bucket.start > windowMs) { bucket.start = now; bucket.count = 0; }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > maxPerMinute) return res.status(429).json({ error: 'Zu viele Anfragen in kurzer Zeit. Bitte warte einen Moment.' });
  next();
}
function getUserId(req) { return String(req.get('X-Omni-User-Id') || req.body?.userId || 'local-user').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 120) || 'local-user'; }
function currentMonth() { return new Date().toISOString().slice(0, 7); }
async function readUsageStore() { try { return JSON.parse(await fs.readFile(usageFile, 'utf8')); } catch { return { users: {} }; } }
async function writeUsageStore(store) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(usageFile, JSON.stringify(store, null, 2)); }
function normalizeUsage(store, userId) { const month = currentMonth(); const existing = store.users[userId] || { plan: 'free', month, used: 0 }; if (existing.month !== month) { existing.month = month; existing.used = 0; } existing.plan = existing.plan || 'free'; existing.used = Number(existing.used || 0); store.users[userId] = existing; return existing; }
async function getUsage(userId) { const store = await readUsageStore(); const usage = normalizeUsage(store, userId); await writeUsageStore(store); return usage; }
async function incrementUsage(userId) { const store = await readUsageStore(); const usage = normalizeUsage(store, userId); usage.used = Number(usage.used || 0) + 1; store.users[userId] = usage; await writeUsageStore(store); return usage; }
function publicUsage(usage) { const used = Number(usage.used || 0); return { plan: usage.plan || 'free', used, limit: freeLimit, remaining: usage.plan === 'plus' ? null : Math.max(0, freeLimit - used), month: usage.month || currentMonth(), plusPrice }; }
function clip(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
