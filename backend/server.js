import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, 'data');
const storeFile = path.join(dataDir, 'store.json');

const app = express();
const port = Number(process.env.PORT || 8787);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const freeLimit = Number(process.env.FREE_WEEKLY_REQUESTS || 7);
const plusLimit = Number(process.env.UNLIMITED_MONTHLY_REQUESTS || 500);
const lifetimeLimit = Number(process.env.LIFETIME_MONTHLY_REQUESTS || 200);
const plusPrice = process.env.UNLIMITED_PRICE || '3,99 € / Monat';
const paidPlanName = process.env.PAID_PLAN_NAME || 'Remy Unlimited';
const authSecret = process.env.AUTH_SECRET || 'dev-change-me';
const hasKey = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dein_api_key_hier');
const openai = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const stripePriceId = process.env.STRIPE_PRICE_ID || '';
const stripePaymentLink = process.env.STRIPE_PAYMENT_LINK || '';
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL.replace(/\/$/, ''), process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const pendingDevices = new Map();
const rateBuckets = new Map();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimitMiddleware);

app.get('/health', (_req, res) => res.json({ ok: true, service: 'remy-backend', hasKey, model, supabase: Boolean(supabase), auth: true }));
app.get('/api/config', (_req, res) => res.json({ ok: true, plusPrice, paymentLink: stripePaymentLink, publicBaseUrl, hasCheckout: Boolean(stripe && stripePriceId) }));

function sendAuthPage(req, res) {
  const deviceId = safeId(req.query.deviceId || `web-${Date.now()}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(renderAuthPage(deviceId));
}

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remy</title><style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#111827;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:white;border-radius:24px;padding:28px;box-shadow:0 20px 60px #0001;max-width:460px}a{display:inline-block;margin-top:14px;background:#4f46e5;color:white;padding:12px 16px;border-radius:14px;text-decoration:none;font-weight:800}</style></head><body><main class="card"><h1>Remy Backend läuft</h1><p>Diese Seite ist nur der Server hinter Remy. Für Login öffne die Remy-Erweiterung oder nutze die Login-Seite.</p><a href="/auth">Zum Login</a></main></body></html>');
});
app.get('/auth', sendAuthPage);
app.get('/login', sendAuthPage);
app.get('/signin', sendAuthPage);
app.get('/out', sendAuthPage);

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const deviceId = safeId(req.body?.deviceId || '');
    if (!email || password.length < 6) return res.status(400).json({ error: 'E-Mail oder Passwort fehlt. Das Passwort braucht mindestens 6 Zeichen.' });
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Dieses Konto existiert bereits. Bitte einloggen.' });
    const user = await createUser(email, await bcrypt.hash(password, 10));
    const token = signToken(user);
    if (deviceId) pendingDevices.set(deviceId, { token, email, userId: user.id, at: Date.now() });
    res.json({ ok: true, token, user: publicUser(user) });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Registrierung konnte nicht abgeschlossen werden.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const deviceId = safeId(req.body?.deviceId || '');
    const user = email ? await findUserByEmail(email) : null;
    if (!user || !(await bcrypt.compare(password, user.password_hash || ''))) return res.status(401).json({ error: 'E-Mail oder Passwort ist falsch.' });
    const token = signToken(user);
    if (deviceId) pendingDevices.set(deviceId, { token, email, userId: user.id, at: Date.now() });
    res.json({ ok: true, token, user: publicUser(user) });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Login konnte nicht abgeschlossen werden.' }); }
});

app.get('/api/auth/device/:deviceId', (req, res) => {
  const session = pendingDevices.get(safeId(req.params.deviceId));
  if (!session) return res.status(202).json({ ok: false, pending: true });
  pendingDevices.delete(safeId(req.params.deviceId));
  res.json({ ok: true, token: session.token, user: { id: session.userId, email: session.email } });
});


app.post('/api/auth/request-password-reset', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Bitte gib deine E-Mail ein.' });
  // Sicherer MVP: Wir verraten nicht, ob die E-Mail existiert. Echte Reset-Mails werden später mit einem Mail-Dienst verbunden.
  res.json({ ok: true, message: 'Wenn diese E-Mail bei Remy registriert ist, bekommst du später eine Passwort-E-Mail. Der E-Mail-Versand muss noch verbunden werden.' });
});

app.get('/api/auth/me', requireUser, async (req, res) => res.json({ ok: true, user: publicUser(req.user), usage: publicUsage(await getUsage(req.user.id, req.user.plan), req.user.plan, await hasFreeTrialAvailable(req.user.id, req.user.plan)) }));
app.post('/api/auth/delete', requireUser, async (req, res) => {
  if (req.user.plan === 'plus' || req.user.plan === 'lifetime') return res.status(400).json({ error: 'Du hast einen aktiven Plan. Bitte verwalte oder kündige ihn zuerst über Stripe.' });
  await deleteUser(req.user.id);
  res.json({ ok: true });
});

app.get('/api/usage', requireUser, async (req, res) => res.json({ ok: true, usage: publicUsage(await getUsage(req.user.id, req.user.plan), req.user.plan, await hasFreeTrialAvailable(req.user.id, req.user.plan)) }));

app.post('/api/ask', requireUser, async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ error: 'Remy kann gerade nicht antworten. Der API-Key ist im Backend noch nicht eingerichtet.' });
    const usage = await getUsage(req.user.id, req.user.plan);
    const limit = planLimit(req.user.plan);
    const trialAvailableBefore = await hasFreeTrialAvailable(req.user.id, req.user.plan);
    if (usage.used >= limit && !trialAvailableBefore) return res.status(402).json({ error: `Du hast deine ${limit} Anfragen für diesen Zeitraum verbraucht.`, usage: publicUsage(usage, req.user.plan, false) });

    const question = clip(req.body?.question, 900);
    const mode = req.body?.mode === 'public' ? 'public' : 'local';
    const memories = Array.isArray(req.body?.memories) ? req.body.memories.slice(0, 10) : [];
    if (!question) return res.status(400).json({ error: 'Anfrage fehlt.' });
    if (mode === 'local' && !memories.length) return res.status(400).json({ error: 'Keine Erinnerungen übergeben.' });

    const systemText = mode === 'public'
      ? 'Du bist Remy im Modus Allgemein fragen. Antworte hilfreich, klar und kurz auf Deutsch. Nutze allgemeines Wissen. Nutze keine Browser-Erinnerungen und frage nicht nach privaten Browserdaten.'
      : 'Du bist Remy im Modus Browser-Suche. Antworte auf Deutsch, klar und knapp. Nutze ausschließlich die übergebenen Browser-Erinnerungen und die sichere aktuelle Seite. Verwende kein allgemeines Wissen, wenn es nicht aus den Quellen hervorgeht. Wenn die Antwort nicht in den Erinnerungen steht, sage ehrlich, dass du es in den gespeicherten Seiten nicht findest. Erfinde keine Quellen. Nenne passende Quellen mit Titel, Domain und URL.';
    const context = mode === 'local' ? memories.map((m, i) => [
      `Quelle ${i + 1}:`, `Titel: ${clip(m.title, 180)}`, `Domain: ${clip(m.domain, 120)}`, `URL: ${clip(m.url, 400)}`,
      `Gespeichert: ${clip(m.savedAt, 80)}`, m.platform ? `Plattform: ${clip(m.platform, 80)}` : '', m.searchQuery ? `Suchanfrage: ${clip(m.searchQuery, 160)}` : '',
      `Kurzfassung: ${clip(m.summary, 700)}`, `Textauszug: ${clip(m.text, 2500)}`
    ].filter(Boolean).join('\n')).join('\n\n---\n\n') : 'Keine lokalen Erinnerungen: öffentliche allgemeine Anfrage.';

    const response = await openai.responses.create({ model, input: [
      { role: 'system', content: [{ type: 'input_text', text: systemText }] },
      { role: 'user', content: [{ type: 'input_text', text: `Modus: ${mode}\nAnfrage:\n${question}\n\nKontext:\n${context}` }] }
    ]});
    let nextUsage;
    const trialAvailable = trialAvailableBefore;
    if (trialAvailable) {
      await markFreeTrialUsed(req.user.id);
      nextUsage = await getUsage(req.user.id, req.user.plan);
    } else {
      nextUsage = await incrementUsage(req.user.id, req.user.plan);
    }
    res.json({ ok: true, answer: response.output_text || 'Ich konnte keine Antwort erzeugen.', usage: publicUsage(nextUsage, req.user.plan, await hasFreeTrialAvailable(req.user.id, req.user.plan)) });
  } catch (error) { console.error(error); res.status(500).json({ error: 'Remy konnte gerade keine KI-Antwort erzeugen.' }); }
});

app.post('/api/create-checkout-session', requireUser, async (req, res) => {
  if (!stripe || !stripePriceId) {
    if (stripePaymentLink) return res.json({ ok: true, url: stripePaymentLink });
    return res.status(400).json({ error: 'Stripe ist noch nicht vollständig eingerichtet.' });
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription', line_items: [{ price: stripePriceId, quantity: 1 }], customer_email: req.user.email,
    success_url: `${publicBaseUrl}/auth?success=plus`, cancel_url: `${publicBaseUrl}/auth?cancel=1`, metadata: { remy_user_id: req.user.id }
  });
  res.json({ ok: true, url: session.url });
});

app.post('/api/create-customer-portal-session', requireUser, async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ error: 'Stripe ist noch nicht eingerichtet.' });
    let customerId = req.user.stripe_customer_id || '';

    // Falls der Nutzer bezahlt hat, aber die Customer-ID nicht gespeichert wurde,
    // versuchen wir sie sicher über die E-Mail im Stripe-Test/Live-Konto zu finden.
    if (!customerId && req.user.email) {
      const customers = await stripe.customers.list({ email: req.user.email, limit: 1 });
      customerId = customers.data?.[0]?.id || '';
      if (customerId) await updateUserFields(req.user.id, { stripe_customer_id: customerId });
    }

    if (!customerId) return res.status(400).json({ error: 'Für dieses Konto wurde noch kein Stripe-Abo gefunden.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${publicBaseUrl}/auth?portal=return`
    });
    res.json({ ok: true, url: session.url });
  } catch (error) {
    console.error('Customer portal error:', error);
    res.status(500).json({ error: 'Abo-Verwaltung konnte nicht geöffnet werden.' });
  }
});

app.listen(port, () => console.log(`Remy backend läuft auf Port ${port}`));

function signToken(user) { return jwt.sign({ sub: user.id, email: user.email }, authSecret, { expiresIn: '90d' }); }
async function requireUser(req, res, next) {
  try {
    const auth = req.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Bitte einloggen.' });
    const payload = jwt.verify(token, authSecret);
    const user = await findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Konto nicht gefunden.' });
    req.user = user; next();
  } catch { res.status(401).json({ error: 'Login abgelaufen. Bitte erneut einloggen.' }); }
}

function currentMonth() { return new Date().toISOString().slice(0, 7); }
function currentWeek() {
  const d = new Date();
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function usagePeriod(plan = 'free') { return plan === 'free' ? currentWeek() : currentMonth(); }
function resetLabel(plan = 'free') { return plan === 'free' ? 'Woche' : 'Monat'; }
function planLimit(plan) { return plan === 'lifetime' ? lifetimeLimit : plan === 'plus' ? plusLimit : freeLimit; }
function displayPlan(plan = 'free') { return plan === 'lifetime' ? 'Remy Lifetime' : plan === 'plus' ? paidPlanName : 'Remy Free'; }
function publicUsage(usage, plan = usage.plan, trialAvailable = false) { const limit = planLimit(plan); const used = Number(usage.used || 0); return { plan: plan || 'free', planName: displayPlan(plan), used, limit, remaining: Math.max(0, limit - used), period: usage.month || usagePeriod(plan), resetLabel: resetLabel(plan), plusPrice, trialAvailable: Boolean(trialAvailable) }; }
function publicUser(user) { return { id: user.id, email: user.email, plan: user.plan || 'free' }; }
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function safeId(v) { return String(v || '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 160); }
function clip(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function rateLimitMiddleware(req, res, next) { const now = Date.now(); const key = `${req.ip || 'ip'}:${req.path}`; const b = rateBuckets.get(key) || { start: now, count: 0 }; if (now - b.start > 60000) { b.start = now; b.count = 0; } b.count++; rateBuckets.set(key, b); if (b.count > Number(process.env.RATE_LIMIT_PER_MINUTE || 80)) return res.status(429).json({ error: 'Zu viele Anfragen. Bitte kurz warten.' }); next(); }

async function readStore() { try { return JSON.parse(await fs.readFile(storeFile, 'utf8')); } catch { return { users: {}, usage: {} }; } }
async function writeStore(store) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(storeFile, JSON.stringify(store, null, 2)); }
async function findUserByEmail(email) {
  if (supabase) {
    const { data, error } = await supabase.from('remy_users').select('*').eq('email', email).maybeSingle();
    if (error) throw new Error(`Supabase Nutzerabfrage fehlgeschlagen: ${error.message}`);
    return data || null;
  }
  const s = await readStore(); return Object.values(s.users).find(u => u.email === email) || null;
}
async function findUserById(id) {
  if (supabase) {
    const { data, error } = await supabase.from('remy_users').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`Supabase Nutzerabfrage fehlgeschlagen: ${error.message}`);
    return data || null;
  }
  const s = await readStore(); return s.users[id] || null;
}
async function createUser(email, password_hash) {
  const user = { id: crypto.randomUUID(), email, password_hash, plan: 'free', created_at: new Date().toISOString() };
  if (supabase) {
    const { data, error } = await supabase.from('remy_users').insert(user).select('*').single();
    if (error) throw new Error(`Supabase Registrierung fehlgeschlagen: ${error.message}`);
    return data;
  }
  const s = await readStore(); s.users[user.id] = user; await writeStore(s); return user;
}

async function updateUserFields(id, fields) {
  const safeFields = { ...fields };
  delete safeFields.id;
  delete safeFields.email;
  if (supabase) {
    const { data, error } = await supabase.from('remy_users').update(safeFields).eq('id', id).select('*').single();
    if (error) throw new Error(`Supabase Nutzer aktualisieren fehlgeschlagen: ${error.message}`);
    return data;
  }
  const store = await readStore();
  if (!store.users[id]) return null;
  store.users[id] = { ...store.users[id], ...safeFields };
  await writeStore(store);
  return store.users[id];
}

async function deleteUser(id) {
  if (supabase) {
    let { error } = await supabase.from('remy_usage').delete().eq('user_id', id);
    if (error) throw new Error(`Supabase Nutzung löschen fehlgeschlagen: ${error.message}`);
    ({ error } = await supabase.from('remy_users').delete().eq('id', id));
    if (error) throw new Error(`Supabase Konto löschen fehlgeschlagen: ${error.message}`);
    return;
  }
  const s = await readStore(); delete s.users[id]; delete s.usage[id]; await writeStore(s);
}

async function hasFreeTrialAvailable(userId, plan = 'free') {
  if (plan !== 'free') return false;
  if (supabase) {
    const { data, error } = await supabase.from('remy_free_trials').select('used').eq('user_id', userId).maybeSingle();
    if (error) throw new Error(`Supabase Test-Anfrage laden fehlgeschlagen: ${error.message}`);
    return !data?.used;
  }
  const s = await readStore();
  s.freeTrials ||= {};
  return !s.freeTrials[userId]?.used;
}
async function markFreeTrialUsed(userId) {
  if (supabase) {
    const { error } = await supabase.from('remy_free_trials').upsert({ user_id: userId, used: true, used_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw new Error(`Supabase Test-Anfrage speichern fehlgeschlagen: ${error.message}`);
    return;
  }
  const s = await readStore();
  s.freeTrials ||= {};
  s.freeTrials[userId] = { used: true, used_at: new Date().toISOString() };
  await writeStore(s);
}

async function getUsage(userId, plan = 'free') {
  const month = usagePeriod(plan);
  if (supabase) {
    const { data, error } = await supabase.from('remy_usage').select('*').eq('user_id', userId).eq('month', month).maybeSingle();
    if (error) throw new Error(`Supabase Nutzung laden fehlgeschlagen: ${error.message}`);
    if (data) return { ...data, plan };
    const row = { user_id: userId, month, used: 0 };
    const { data: created, error: insertError } = await supabase.from('remy_usage').insert(row).select('*').single();
    if (insertError) {
      // Falls zwei Fenster gleichzeitig anlegen, nochmal laden statt zurückzusetzen.
      const { data: retry, error: retryError } = await supabase.from('remy_usage').select('*').eq('user_id', userId).eq('month', month).maybeSingle();
      if (retryError || !retry) throw new Error(`Supabase Nutzung erstellen fehlgeschlagen: ${insertError.message}`);
      return { ...retry, plan };
    }
    return { ...(created || row), plan };
  }
  const s = await readStore(); const key = `${userId}:${month}`; s.usage[key] ||= { user_id: userId, month, used: 0 }; await writeStore(s); return { ...s.usage[key], plan };
}
async function incrementUsage(userId, plan = 'free') {
  const usage = await getUsage(userId, plan);
  const nextUsed = Number(usage.used || 0) + 1;
  if (supabase) {
    const { data, error } = await supabase
      .from('remy_usage')
      .upsert({ user_id: userId, month: usage.month, used: nextUsed }, { onConflict: 'user_id,month' })
      .select('*')
      .single();
    if (error) throw new Error(`Supabase Nutzung speichern fehlgeschlagen: ${error.message}`);
    return { ...(data || { ...usage, used: nextUsed }), plan };
  }
  const s = await readStore(); s.usage[`${userId}:${usage.month}`] = { ...usage, used: nextUsed }; await writeStore(s); return { ...s.usage[`${userId}:${usage.month}`], plan };
}

function renderAuthPage(deviceId) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remy Login</title><style>
  body{font-family:Inter,system-ui,sans-serif;background:linear-gradient(135deg,#fff7ed,#eef2ff);margin:0;min-height:100vh;display:grid;place-items:center;color:#1f2937}.card{width:min(440px,92vw);background:white;border-radius:28px;padding:28px;box-shadow:0 24px 70px #312e8133}.brand{display:flex;gap:12px;align-items:center}.logo-dot{width:54px;height:54px;border-radius:20px;background:#eef2ff;display:grid;place-items:center;overflow:hidden}.logo-dot img{width:48px;height:48px;object-fit:contain}h1{margin:18px 0 6px;font-size:28px}p{color:#6b7280;line-height:1.5}.tabs{display:flex;background:#f3f4f6;border-radius:16px;padding:4px;margin:20px 0}.tabs button{flex:1;border:0;border-radius:12px;padding:11px 8px;background:transparent;font-weight:800;cursor:pointer}.tabs button.active{background:white;box-shadow:0 6px 18px #0001}input{width:100%;box-sizing:border-box;border:1px solid #e5e7eb;border-radius:16px;padding:14px;margin:7px 0;font-size:15px}button.main{width:100%;border:0;border-radius:16px;background:#4f46e5;color:white;font-weight:900;padding:14px;margin-top:10px;cursor:pointer}.small-action{border:0;background:transparent;color:#4f46e5;font-weight:800;cursor:pointer;margin-top:12px}.msg{min-height:20px;margin-top:12px;font-size:14px;line-height:1.4}.ok{color:#059669}.err{color:#dc2626}.hidden{display:none!important}.hint{font-size:12px;color:#6b7280;margin-top:10px}
  </style></head><body><main class="card"><div class="brand"><div class="logo-dot"><img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CiAgPHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIHJ4PSIzMCIgZmlsbD0iI0VFRjdGRiIvPgogIDxwYXRoIGQ9Ik0zMSAyNmMwLTggNi0xNCAxNC0xNGg0MGM4IDAgMTQgNiAxNCAxNHY2MmMwIDYtNyAxMC0xMiA2TDcwIDgyYy0zLTItNy0yLTEwIDBMNDMgOTRjLTUgNC0xMiAwLTEyLTZWMjZ6IiBmaWxsPSIjM0U3OEQ2Ii8+CiAgPHBhdGggZD0iTTc2IDEyaDljOCAwIDE0IDYgMTQgMTR2OEg4NGMtNCAwLTgtNC04LThWMTJ6IiBmaWxsPSIjODJEOENEIi8+CiAgPGNpcmNsZSBjeD0iNTIiIGN5PSI1MyIgcj0iNyIgZmlsbD0iI0ZGRkZGRiIvPgogIDxjaXJjbGUgY3g9Ijc4IiBjeT0iNTMiIHI9IjciIGZpbGw9IiNGRkZGRkYiLz4KICA8Y2lyY2xlIGN4PSI1NCIgY3k9IjU0IiByPSIzIiBmaWxsPSIjMjAzQTU3Ii8+CiAgPGNpcmNsZSBjeD0iNzYiIGN5PSI1NCIgcj0iMyIgZmlsbD0iIzIwM0E1NyIvPgogIDxwYXRoIGQ9Ik01NSA3MGM2IDYgMTUgNiAyMSAwIiBzdHJva2U9IiMyMDNBNTciIHN0cm9rZS13aWR0aD0iNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPGNpcmNsZSBjeD0iNDAiIGN5PSI2NCIgcj0iNSIgZmlsbD0iI0Y3QjZBNiIgb3BhY2l0eT0iLjcyIi8+CiAgPGNpcmNsZSBjeD0iOTAiIGN5PSI2NCIgcj0iNSIgZmlsbD0iI0Y3QjZBNiIgb3BhY2l0eT0iLjcyIi8+Cjwvc3ZnPgo=" alt="Remy"></div><strong>Remy</strong></div><h1>Einloggen und Remy nutzen</h1><p>Deine Anfragen, dein Remy-Unlimited-Status und deine Remy-Daten bleiben deinem Konto zugeordnet.</p><div class="tabs"><button id="loginTab" class="active">Einloggen</button><button id="registerTab">Konto erstellen</button></div><input id="email" type="email" placeholder="E-Mail"><input id="password" type="password" placeholder="Passwort"><input id="password2" class="hidden" type="password" placeholder="Passwort wiederholen"><button id="submit" class="main">Einloggen</button><button id="forgot" class="small-action">Passwort vergessen?</button><div id="msg" class="msg"></div><div class="hint">Nach erfolgreichem Login kannst du dieses Fenster schließen und Remy öffnen.</div></main><script>
  let mode='login';const d=${JSON.stringify(deviceId)};function q(id){return document.getElementById(id)}
  function setMode(m){mode=m;q('loginTab').classList.toggle('active',m==='login');q('registerTab').classList.toggle('active',m==='register');q('password').classList.toggle('hidden',m==='reset');q('password2').classList.toggle('hidden',m!=='register');q('forgot').classList.toggle('hidden',m==='reset');q('submit').textContent=m==='login'?'Einloggen':m==='register'?'Konto erstellen':'Reset-Link anfordern';q('msg').textContent=''}
  q('loginTab').onclick=()=>setMode('login');q('registerTab').onclick=()=>setMode('register');q('forgot').onclick=()=>setMode('reset');
  q('submit').onclick=async()=>{q('msg').textContent='Bitte warten…';q('msg').className='msg';try{const email=q('email').value.trim();const password=q('password').value;let endpoint='/api/auth/login';let body={email,password,deviceId:d};if(mode==='register'){if(password!==q('password2').value)throw new Error('Die Passwörter stimmen nicht überein.');endpoint='/api/auth/register'}if(mode==='reset'){endpoint='/api/auth/request-password-reset';body={email}}const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Fehler');q('msg').className='msg ok';q('msg').textContent=mode==='reset'?(data.message||'Wenn ein Konto existiert, erhältst du eine E-Mail.'):'Fertig. Du kannst dieses Fenster schließen und Remy öffnen.'}catch(e){q('msg').className='msg err';q('msg').textContent=e.message||'Login kann nicht abgeschlossen werden.'}};
  </script></body></html>`;
}
