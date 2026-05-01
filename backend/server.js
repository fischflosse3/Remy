import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, 'data');
const usageFile = path.join(dataDir, 'usage.json');
const usersFile = path.join(dataDir, 'users.json');

const app = express();
const port = Number(process.env.PORT || 8787);
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const freeLimit = Number(process.env.FREE_MONTHLY_QUESTIONS || 10);
const plusLimit = Number(process.env.PLUS_MONTHLY_QUESTIONS || 100);
const plusPrice = process.env.PLUS_PRICE || '3,99 € / Monat';
const paymentLink = process.env.STRIPE_PAYMENT_LINK || '';
const authSecret = process.env.AUTH_SECRET || 'dev-secret-change-me';
const maxQuestionChars = Number(process.env.MAX_QUESTION_CHARS || 800);
const maxMemoryChars = Number(process.env.MAX_MEMORY_CHARS || 2600);
const maxMemories = Number(process.env.MAX_MEMORIES_PER_ASK || 10);
const hasKey = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dein_api_key_hier');
const openai = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const rateBuckets = new Map();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimitMiddleware);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'remy-backend', hasKey, model, freeLimit, plusLimit, plusPrice, auth: true, paymentLinkConfigured: Boolean(paymentLink) });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email) return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
    if (password.length < 8) return res.status(400).json({ error: 'Das Passwort muss mindestens 8 Zeichen haben.' });
    const store = await readUsersStore();
    if (store.usersByEmail[email]) return res.status(409).json({ error: 'Für diese E-Mail gibt es schon ein Konto. Bitte melde dich an.' });
    const id = `user_${crypto.randomUUID()}`;
    const passwordRecord = hashPassword(password);
    const user = { id, email, plan: 'free', createdAt: new Date().toISOString(), ...passwordRecord };
    store.usersByEmail[email] = user;
    store.usersById[id] = email;
    await writeUsersStore(store);
    const token = signToken({ sub: id, email, plan: user.plan });
    res.json({ ok: true, token, user: publicUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Konto konnte gerade nicht erstellt werden.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const store = await readUsersStore();
    const user = email ? store.usersByEmail[email] : null;
    if (!user || !verifyPassword(password, user)) return res.status(401).json({ error: 'E-Mail oder Passwort stimmt nicht.' });
    const token = signToken({ sub: user.id, email: user.email, plan: user.plan || 'free' });
    res.json({ ok: true, token, user: publicUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login ist gerade nicht möglich.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const identity = await getIdentity(req);
  if (!identity.user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  res.json({ ok: true, user: publicUser(identity.user) });
});

app.get('/api/checkout-link', (_req, res) => {
  if (!paymentLink) return res.status(404).json({ error: 'Der Zahlungslink ist noch nicht konfiguriert.' });
  res.json({ ok: true, url: paymentLink });
});

app.get('/api/usage', async (req, res) => {
  const identity = await getIdentity(req);
  const usage = await getUsage(identity.userId, identity.plan);
  res.json({ ok: true, usage: publicUsage(usage) });
});

app.post('/api/ask', async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ error: 'Remy kann gerade nicht antworten. Der API-Key ist im Backend noch nicht eingerichtet.' });
    const identity = await getIdentity(req);
    const usage = await getUsage(identity.userId, identity.plan);
    const limit = usage.plan === 'plus' ? plusLimit : freeLimit;
    if (usage.used >= limit) {
      return res.status(402).json({ error: usage.plan === 'plus' ? `Du hast dein Plus-Limit von ${plusLimit} KI-Fragen für diesen Monat erreicht.` : `Du hast deine ${freeLimit} kostenlosen KI-Fragen für diesen Monat verbraucht. Upgrade auf Plus für ${plusPrice}.`, usage: publicUsage(usage) });
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

    const nextUsage = await incrementUsage(identity.userId, identity.plan);
    res.json({ ok: true, answer: response.output_text || 'Ich konnte keine Antwort erzeugen.', usage: publicUsage(nextUsage) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Remy konnte gerade keine KI-Antwort erzeugen. Bitte versuche es gleich nochmal.' });
  }
});

app.listen(port, () => {
  console.log(`Remy backend läuft auf Port ${port}`);
  console.log(hasKey ? `OpenAI Modell: ${model}` : 'OPENAI_API_KEY fehlt noch. Trage ihn in .env ein.');
  console.log(`Free: ${freeLimit} Fragen/Monat · Plus: ${plusLimit} Fragen/Monat · ${plusPrice}`);
  if (authSecret === 'dev-secret-change-me') console.log('Hinweis: Setze AUTH_SECRET in Render für echte Nutzung.');
});

function rateLimitMiddleware(req, res, next) {
  const now = Date.now();
  const key = `${req.ip || 'ip'}:${getRawUserId(req)}`;
  const windowMs = 60 * 1000;
  const maxPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE || 12);
  const bucket = rateBuckets.get(key) || { start: now, count: 0 };
  if (now - bucket.start > windowMs) { bucket.start = now; bucket.count = 0; }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > maxPerMinute) return res.status(429).json({ error: 'Zu viele Anfragen in kurzer Zeit. Bitte warte einen Moment.' });
  next();
}

async function getIdentity(req) {
  const tokenUser = await getUserFromAuthHeader(req);
  if (tokenUser) return { user: tokenUser, userId: tokenUser.id, plan: tokenUser.plan || 'free' };
  return { user: null, userId: getRawUserId(req), plan: 'free' };
}
function getRawUserId(req) { return String(req.get('X-Omni-User-Id') || req.body?.userId || 'local-user').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 120) || 'local-user'; }
async function getUserFromAuthHeader(req) {
  const header = String(req.get('Authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload?.sub) return null;
  const store = await readUsersStore();
  const email = store.usersById[payload.sub];
  return email ? store.usersByEmail[email] || null : null;
}
function signToken(payload) {
  const full = { ...payload, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 };
  const body = base64url(JSON.stringify(full));
  const sig = crypto.createHmac('sha256', authSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', authSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return payload.exp > Date.now() ? payload : null; } catch { return null; }
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('base64url');
  return { passwordSalt: salt, passwordHash: hash };
}
function verifyPassword(password, user) {
  if (!user?.passwordSalt || !user?.passwordHash) return false;
  const hash = crypto.pbkdf2Sync(String(password || ''), user.passwordSalt, 120000, 32, 'sha256').toString('base64url');
  const a = Buffer.from(hash);
  const b = Buffer.from(user.passwordHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normalizeEmail(email) { const clean = String(email || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : ''; }
async function readUsersStore() { try { const store = JSON.parse(await fs.readFile(usersFile, 'utf8')); return { usersByEmail: store.usersByEmail || {}, usersById: store.usersById || {} }; } catch { return { usersByEmail: {}, usersById: {} }; } }
async function writeUsersStore(store) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(usersFile, JSON.stringify(store, null, 2)); }
function publicUser(user) { return { id: user.id, email: user.email, plan: user.plan || 'free', createdAt: user.createdAt }; }
function currentMonth() { return new Date().toISOString().slice(0, 7); }
async function readUsageStore() { try { return JSON.parse(await fs.readFile(usageFile, 'utf8')); } catch { return { users: {} }; } }
async function writeUsageStore(store) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(usageFile, JSON.stringify(store, null, 2)); }
function normalizeUsage(store, userId, plan = 'free') { const month = currentMonth(); const existing = store.users[userId] || { plan, month, used: 0 }; if (existing.month !== month) { existing.month = month; existing.used = 0; } existing.plan = plan || existing.plan || 'free'; existing.used = Number(existing.used || 0); store.users[userId] = existing; return existing; }
async function getUsage(userId, plan = 'free') { const store = await readUsageStore(); const usage = normalizeUsage(store, userId, plan); await writeUsageStore(store); return usage; }
async function incrementUsage(userId, plan = 'free') { const store = await readUsageStore(); const usage = normalizeUsage(store, userId, plan); usage.used = Number(usage.used || 0) + 1; store.users[userId] = usage; await writeUsageStore(store); return usage; }
function publicUsage(usage) { const used = Number(usage.used || 0); const limit = usage.plan === 'plus' ? plusLimit : freeLimit; return { plan: usage.plan || 'free', used, limit, remaining: Math.max(0, limit - used), month: usage.month || currentMonth(), plusPrice, plusLimit, freeLimit }; }
function clip(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function base64url(input) { return Buffer.from(input).toString('base64url'); }
