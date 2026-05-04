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
const freeLimit = Number(process.env.FREE_WEEKLY_REQUESTS || process.env.FREE_MONTHLY_QUESTIONS || 7);
const plusLimit = Number(process.env.UNLIMITED_MONTHLY_REQUESTS || process.env.PLUS_MONTHLY_QUESTIONS || 500);
const lifetimeLimit = Number(process.env.LIFETIME_MONTHLY_QUESTIONS || 200);
const plusPrice = process.env.UNLIMITED_PRICE || process.env.PLUS_PRICE || '3,99 € / Monat';
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

app.get('/auth', (req, res) => {
  const deviceId = safeId(req.query.deviceId || `web-${Date.now()}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(renderAuthPage(deviceId));
});

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

app.get('/api/auth/me', requireUser, async (req, res) => res.json({ ok: true, user: publicUser(req.user), usage: publicUsage(await getUsage(req.user.id, req.user.plan)) }));
app.post('/api/auth/delete', requireUser, async (req, res) => {
  if (req.user.plan === 'plus' || req.user.plan === 'lifetime') return res.status(400).json({ error: 'Du hast einen aktiven Plan. Bitte verwalte oder kündige ihn zuerst über Stripe.' });
  await deleteUser(req.user.id);
  res.json({ ok: true });
});

app.get('/api/usage', requireUser, async (req, res) => res.json({ ok: true, usage: publicUsage(await getUsage(req.user.id, req.user.plan)) }));

app.post('/api/ask', requireUser, async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ error: 'Remy kann gerade nicht antworten. Der API-Key ist im Backend noch nicht eingerichtet.' });
    const usage = await getUsage(req.user.id, req.user.plan);
    const limit = planLimit(req.user.plan);
    if (usage.used >= limit) return res.status(402).json({ error: `Du hast deine ${limit} KI-Fragen für diesen Monat verbraucht.`, usage: publicUsage(usage, req.user.plan) });

    const question = clip(req.body?.question, 900);
    const mode = req.body?.mode === 'public' ? 'public' : 'local';
    const memories = Array.isArray(req.body?.memories) ? req.body.memories.slice(0, 10) : [];
    const history = normalizeHistory(req.body?.history).slice(-10);
    if (!question) return res.status(400).json({ error: 'Frage fehlt.' });
    if (mode === 'local' && !memories.length) return res.status(400).json({ error: 'Keine Erinnerungen übergeben.' });

    const systemText = mode === 'public'
      ? 'Du bist Remy. Antworte hilfreich, klar und kurz auf Deutsch. Diese Frage ist im öffentlichen Modus: Du darfst allgemeines Wissen nutzen. Frage nicht nach privaten Browserdaten.'
      : 'Du bist Remy, ein hilfreiches Browser-Gedächtnis. Antworte auf Deutsch, klar und knapp. Nutze nur die übergebenen Erinnerungen und aktuelle sichere Seite als Grundlage. Erfinde keine Quellen. Nenne passende Quellen mit Titel, Domain und URL.';
    const context = mode === 'local' ? memories.map((m, i) => [
      `Quelle ${i + 1}:`, `Titel: ${clip(m.title, 180)}`, `Domain: ${clip(m.domain, 120)}`, `URL: ${clip(m.url, 400)}`,
      `Gespeichert: ${clip(m.savedAt, 80)}`, m.platform ? `Plattform: ${clip(m.platform, 80)}` : '', m.searchQuery ? `Suchanfrage: ${clip(m.searchQuery, 160)}` : '',
      `Kurzfassung: ${clip(m.summary, 700)}`, `Textauszug: ${clip(m.text, 2500)}`
    ].filter(Boolean).join('\n')).join('\n\n---\n\n') : 'Keine lokalen Erinnerungen: öffentliche allgemeine Frage.';
    const historyText = history.length
      ? history.map((m, i) => `${i + 1}. ${m.role === 'assistant' ? 'Remy' : 'Nutzer'}: ${clip(m.text, 1200)}`).join('\n')
      : 'Noch kein vorheriger Verlauf in diesem Chat.';

    const response = await openai.responses.create({ model, input: [
      { role: 'system', content: [{ type: 'input_text', text: systemText + '\nBeachte den bisherigen Chat-Verlauf. Wenn die neue Frage eine Folgefrage ist, beziehe sie auf das zuletzt besprochene Thema. Wenn der Nutzer klar ein neues Thema beginnt, behandle es als neues Thema.' }] },
      { role: 'user', content: [{ type: 'input_text', text: `Modus: ${mode}\nBisheriger Chat-Verlauf:\n${historyText}\n\nAktuelle Frage:\n${question}\n\nKontext:\n${context}` }] }
    ]});
    const nextUsage = await incrementUsage(req.user.id, req.user.plan);
    res.json({ ok: true, answer: response.output_text || 'Ich konnte keine Antwort erzeugen.', usage: publicUsage(nextUsage, req.user.plan) });
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


app.get('/api/stripe/webhook', (_req, res) => res.json({ ok: true, message: 'Stripe webhook endpoint bereit. Stripe sendet hier per POST.' }));
app.post('/api/stripe/webhook', async (req, res) => {
  try {
    const event = req.body;
    const type = event?.type;
    const obj = event?.data?.object || {};
    if (type === 'checkout.session.completed') {
      const userId = obj.metadata?.remy_user_id || obj.client_reference_id || obj.subscription_details?.metadata?.remy_user_id;
      if (userId) await updateUserBilling(userId, { plan: 'plus', stripe_customer_id: obj.customer || null, stripe_subscription_id: obj.subscription || null });
    }
    if (type === 'invoice.payment_succeeded') {
      const subscriptionId = obj.subscription || obj.parent?.subscription_details?.subscription || null;
      if (subscriptionId) await confirmSubscriptionActive(subscriptionId);
    }
    if (type === 'customer.subscription.deleted') {
      const subscriptionId = obj.id;
      if (subscriptionId) await markSubscriptionFree(subscriptionId);
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error', error);
    res.status(500).json({ error: 'Webhook konnte nicht verarbeitet werden.' });
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

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({ role: item?.role === 'assistant' ? 'assistant' : 'user', text: clip(item?.text || '', 1600) }))
    .filter(item => item.text)
    .slice(-12);
}
function currentMonth() { return new Date().toISOString().slice(0, 7); }
function planLimit(plan) { return plan === 'lifetime' ? lifetimeLimit : plan === 'plus' ? plusLimit : freeLimit; }
function publicUsage(usage, plan = usage.plan) { const limit = planLimit(plan); const used = Number(usage.used || 0); return { plan: plan || 'free', used, limit, remaining: Math.max(0, limit - used), month: usage.month || currentMonth(), plusPrice, paidPlanName }; }
function publicUser(user) { return { id: user.id, email: user.email, plan: user.plan || 'free' }; }
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function safeId(v) { return String(v || '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 160); }
function clip(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function rateLimitMiddleware(req, res, next) { const now = Date.now(); const key = `${req.ip || 'ip'}:${req.path}`; const b = rateBuckets.get(key) || { start: now, count: 0 }; if (now - b.start > 60000) { b.start = now; b.count = 0; } b.count++; rateBuckets.set(key, b); if (b.count > Number(process.env.RATE_LIMIT_PER_MINUTE || 80)) return res.status(429).json({ error: 'Zu viele Anfragen. Bitte kurz warten.' }); next(); }

async function readStore() { try { return JSON.parse(await fs.readFile(storeFile, 'utf8')); } catch { return { users: {}, usage: {} }; } }
async function writeStore(store) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(storeFile, JSON.stringify(store, null, 2)); }
async function findUserByEmail(email) { if (supabase) { try { const { data } = await supabase.from('remy_users').select('*').eq('email', email).maybeSingle(); if (data) return data; } catch (e) { console.warn('Supabase user email failed', e.message); } } const s = await readStore(); return Object.values(s.users).find(u => u.email === email) || null; }
async function findUserById(id) { if (supabase) { try { const { data } = await supabase.from('remy_users').select('*').eq('id', id).maybeSingle(); if (data) return data; } catch (e) { console.warn('Supabase user id failed', e.message); } } const s = await readStore(); return s.users[id] || null; }
async function createUser(email, password_hash) { const user = { id: crypto.randomUUID(), email, password_hash, plan: 'free', created_at: new Date().toISOString() }; if (supabase) { try { const { data, error } = await supabase.from('remy_users').insert(user).select('*').single(); if (error) throw error; return data; } catch (e) { console.warn('Supabase create failed', e.message); } } const s = await readStore(); s.users[user.id] = user; await writeStore(s); return user; }
async function deleteUser(id) { if (supabase) { try { await supabase.from('remy_usage').delete().eq('user_id', id); await supabase.from('remy_users').delete().eq('id', id); return; } catch (e) { console.warn('Supabase delete failed', e.message); } } const s = await readStore(); delete s.users[id]; delete s.usage[id]; await writeStore(s); }
async function getUsage(userId, plan = 'free') { const month = currentMonth(); if (supabase) { try { const { data } = await supabase.from('remy_usage').select('*').eq('user_id', userId).eq('month', month).maybeSingle(); if (data) return { ...data, plan }; const row = { user_id: userId, month, used: 0 }; await supabase.from('remy_usage').insert(row); return { ...row, plan }; } catch (e) { console.warn('Supabase usage failed', e.message); } } const s = await readStore(); const key = `${userId}:${month}`; s.usage[key] ||= { user_id: userId, month, used: 0 }; await writeStore(s); return { ...s.usage[key], plan }; }
async function incrementUsage(userId, plan = 'free') { const usage = await getUsage(userId, plan); usage.used = Number(usage.used || 0) + 1; if (supabase) { try { await supabase.from('remy_usage').upsert({ user_id: userId, month: usage.month, used: usage.used }, { onConflict: 'user_id,month' }); return { ...usage, plan }; } catch (e) { console.warn('Supabase increment failed', e.message); } } const s = await readStore(); s.usage[`${userId}:${usage.month}`] = usage; await writeStore(s); return { ...usage, plan }; }


async function updateUserBilling(userId, patch) {
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (supabase) {
    try {
      const { error } = await supabase.from('remy_users').update(cleanPatch).eq('id', userId);
      if (error) throw error;
      return;
    } catch (e) { console.warn('Supabase billing update failed', e.message); }
  }
  const s = await readStore();
  if (s.users[userId]) { s.users[userId] = { ...s.users[userId], ...cleanPatch }; await writeStore(s); }
}
async function confirmSubscriptionActive(subscriptionId) {
  if (supabase) {
    try {
      const { data } = await supabase.from('remy_users').select('id').eq('stripe_subscription_id', subscriptionId).maybeSingle();
      if (data?.id) await updateUserBilling(data.id, { plan: 'plus' });
      return;
    } catch (e) { console.warn('Supabase subscription confirm failed', e.message); }
  }
  const s = await readStore();
  const user = Object.values(s.users).find(u => u.stripe_subscription_id === subscriptionId);
  if (user) { user.plan = 'plus'; await writeStore(s); }
}
async function markSubscriptionFree(subscriptionId) {
  if (supabase) {
    try {
      const { data } = await supabase.from('remy_users').select('id').eq('stripe_subscription_id', subscriptionId).maybeSingle();
      if (data?.id) await updateUserBilling(data.id, { plan: 'free', stripe_subscription_id: null });
      return;
    } catch (e) { console.warn('Supabase subscription cancel failed', e.message); }
  }
  const s = await readStore();
  const user = Object.values(s.users).find(u => u.stripe_subscription_id === subscriptionId);
  if (user) { user.plan = 'free'; user.stripe_subscription_id = null; await writeStore(s); }
}

function renderAuthPage(deviceId) { return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remy Login</title><style>body{font-family:Inter,system-ui,sans-serif;background:linear-gradient(135deg,#fff7ed,#eef2ff);margin:0;min-height:100vh;display:grid;place-items:center;color:#1f2937}.card{width:min(430px,92vw);background:white;border-radius:28px;padding:28px;box-shadow:0 24px 70px #312e8133}.brand{display:flex;gap:12px;align-items:center}.logo{width:54px;height:54px;border-radius:18px;background:#eef2ff;padding:8px}h1{margin:18px 0 6px;font-size:28px}p{color:#6b7280;line-height:1.5}.tabs{display:flex;background:#f3f4f6;border-radius:16px;padding:4px;margin:20px 0}.tabs button{flex:1;border:0;border-radius:12px;padding:11px;background:transparent;font-weight:800}.tabs button.active{background:white;box-shadow:0 6px 18px #0001}input{width:100%;box-sizing:border-box;border:1px solid #e5e7eb;border-radius:16px;padding:14px;margin:7px 0;font-size:15px}button.main{width:100%;border:0;border-radius:16px;background:#4f46e5;color:white;font-weight:900;padding:14px;margin-top:10px;cursor:pointer}.msg{min-height:20px;margin-top:12px;font-size:14px}.ok{color:#059669}.err{color:#dc2626}</style></head><body><main class="card"><div class="brand"><img class="logo" src="/logo-placeholder" onerror="this.style.display='none'"><strong>Remy</strong></div><h1>Einloggen und Remy nutzen</h1><p>Dein Free-Limit, Plus-Status und deine Remy-Daten bleiben so deinem Konto zugeordnet.</p><div class="tabs"><button id="loginTab" class="active">Einloggen</button><button id="registerTab">Konto erstellen</button></div><input id="email" type="email" placeholder="E-Mail"><input id="password" type="password" placeholder="Passwort"><button id="submit" class="main">Einloggen</button><div id="msg" class="msg"></div></main><script>let mode='login';const d=${JSON.stringify(deviceId)};function q(id){return document.getElementById(id)}function setMode(m){mode=m;q('loginTab').classList.toggle('active',m==='login');q('registerTab').classList.toggle('active',m==='register');q('submit').textContent=m==='login'?'Einloggen':'Konto erstellen'}q('loginTab').onclick=()=>setMode('login');q('registerTab').onclick=()=>setMode('register');q('submit').onclick=async()=>{q('msg').textContent='Bitte warten…';q('msg').className='msg';try{const r=await fetch('/api/auth/'+(mode==='login'?'login':'register'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:q('email').value,password:q('password').value,deviceId:d})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Fehler');q('msg').className='msg ok';q('msg').textContent='Fertig. Du kannst dieses Fenster schließen und Remy öffnen.'}catch(e){q('msg').className='msg err';q('msg').textContent=e.message||'Login kann nicht abgeschlossen werden.'}};</script></body></html>`; }
