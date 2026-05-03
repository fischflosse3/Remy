import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
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
const lifetimeLimit = Number(process.env.LIFETIME_MONTHLY_QUESTIONS || 200);
const plusPrice = process.env.PLUS_PRICE || '3,99 € / Monat';
const lifetimePrice = process.env.LIFETIME_PRICE || '79 € einmalig';
const lifetimeEarlyBirdPrice = process.env.LIFETIME_EARLY_BIRD_PRICE || '49 € einmalig';
const stripeLifetimePriceId = process.env.STRIPE_LIFETIME_PRICE_ID || '';
const stripeLifetimeEarlyBirdPriceId = process.env.STRIPE_LIFETIME_EARLY_BIRD_PRICE_ID || '';
const earlyBirdLimit = Number(process.env.LIFETIME_EARLY_BIRD_LIMIT || 100);
const paymentLink = process.env.STRIPE_PAYMENT_LINK || '';
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripePriceId = process.env.STRIPE_PRICE_ID || '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const authSecret = process.env.AUTH_SECRET || 'dev-secret-change-me';
const maxQuestionChars = Number(process.env.MAX_QUESTION_CHARS || 800);
const maxMemoryChars = Number(process.env.MAX_MEMORY_CHARS || 2600);
const maxMemories = Number(process.env.MAX_MEMORIES_PER_ASK || 10);
const hasKey = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dein_api_key_hier');
const openai = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const rateBuckets = new Map();
const deviceLoginSessions = new Map();
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (supabaseUrl && supabaseServiceRoleKey) ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } }) : null;

app.use(cors({ origin: true }));

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) return res.status(400).send('Stripe ist noch nicht vollständig konfiguriert.');
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (error) {
    console.error('Stripe Webhook Signatur ungültig:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe Webhook Verarbeitung fehlgeschlagen:', error);
    res.status(500).send('Webhook konnte nicht verarbeitet werden.');
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(rateLimitMiddleware);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'remy-backend', hasKey, model, freeLimit, plusLimit, plusPrice, auth: true, database: supabase ? 'supabase' : 'local-json-fallback', paymentLinkConfigured: Boolean(paymentLink), stripeConfigured: Boolean(stripe), stripePriceConfigured: Boolean(stripePriceId), lifetimePriceConfigured: Boolean(stripeLifetimePriceId || stripeLifetimeEarlyBirdPriceId) });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email) return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
    if (password.length < 8) return res.status(400).json({ error: 'Das Passwort muss mindestens 8 Zeichen haben.' });
    if (await findUserByEmail(email)) return res.status(409).json({ error: 'Für diese E-Mail gibt es schon ein Konto. Bitte melde dich an.' });
    const id = `user_${crypto.randomUUID()}`;
    const passwordRecord = hashPassword(password);
    const user = { id, email, plan: 'free', createdAt: new Date().toISOString(), ...passwordRecord };
    await createUserRecord(user);
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
    const user = email ? await findUserByEmail(email) : null;
    if (!user || !verifyPassword(password, user)) return res.status(401).json({ error: 'E-Mail oder Passwort stimmt nicht.' });
    const token = signToken({ sub: user.id, email: user.email, plan: user.plan || 'free' });
    res.json({ ok: true, token, user: publicUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login ist gerade nicht möglich.' });
  }
});


app.post('/api/auth/device/start', async (_req, res) => {
  const code = crypto.randomUUID();
  const expiresAt = Date.now() + 1000 * 60 * 12;
  deviceLoginSessions.set(code, { code, expiresAt, token: '', user: null });
  res.json({ ok: true, code, url: `${publicBaseUrl()}/login?code=${encodeURIComponent(code)}` });
});

app.get('/api/auth/device/poll/:code', (req, res) => {
  const code = String(req.params.code || '');
  const session = deviceLoginSessions.get(code);
  if (!session || session.expiresAt < Date.now()) return res.status(404).json({ error: 'Login-Link ist abgelaufen. Bitte neu starten.' });
  if (!session.token) return res.json({ ok: true, pending: true });
  deviceLoginSessions.delete(code);
  res.json({ ok: true, pending: false, token: session.token, user: session.user });
});

app.post('/api/auth/device/complete', async (req, res) => {
  try {
    const code = String(req.body?.code || '');
    const mode = String(req.body?.mode || 'login');
    const session = deviceLoginSessions.get(code);
    if (!session || session.expiresAt < Date.now()) return res.status(404).json({ error: 'Login-Link ist abgelaufen. Bitte öffne Remy erneut.' });
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email) return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
    if (password.length < 8) return res.status(400).json({ error: 'Das Passwort muss mindestens 8 Zeichen haben.' });
    let user = await findUserByEmail(email);
    if (mode === 'register') {
      if (user) return res.status(409).json({ error: 'Für diese E-Mail gibt es schon ein Konto. Bitte melde dich an.' });
      const id = `user_${crypto.randomUUID()}`;
      const passwordRecord = hashPassword(password);
      user = await createUserRecord({ id, email, plan: 'free', createdAt: new Date().toISOString(), ...passwordRecord });
    } else {
      if (!user || !verifyPassword(password, user)) return res.status(401).json({ error: 'E-Mail oder Passwort stimmt nicht.' });
    }
    const token = signToken({ sub: user.id, email: user.email, plan: user.plan || 'free' });
    session.token = token;
    session.user = publicUser(user);
    deviceLoginSessions.set(code, session);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login konnte gerade nicht abgeschlossen werden.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const identity = await getIdentity(req);
  if (!identity.user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  res.json({ ok: true, user: publicUser(identity.user) });
});

app.delete('/api/auth/delete-account', async (req, res) => {
  try {
    const identity = await getIdentity(req);
    if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich zuerst an.' });
    if (identity.user.plan === 'plus') {
      return res.status(409).json({ error: 'Du hast noch Remy Plus aktiv. Bitte kündige dein Abo zuerst über „Abo verwalten“ und lösche danach dein Konto.' });
    }
    await deleteUserById(identity.user.id);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Konto konnte gerade nicht gelöscht werden.' });
  }
});

app.get('/api/checkout-link', (_req, res) => {
  if (!paymentLink) return res.status(404).json({ error: 'Der Zahlungslink ist noch nicht konfiguriert.' });
  res.json({ ok: true, url: paymentLink, mode: 'payment_link' });
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const identity = await getIdentity(req);
    if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich zuerst an, damit Remy Plus deinem Konto zugeordnet werden kann.' });

    if (!stripe || !stripePriceId) {
      if (!paymentLink) return res.status(404).json({ error: 'Stripe ist noch nicht konfiguriert.' });
      return res.json({ ok: true, url: paymentLink, mode: 'payment_link_fallback' });
    }

    let user = await findUserByEmail(identity.user.email);
    let customerId = user.stripeCustomerId || '';
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { remyUserId: user.id } });
      customerId = customer.id;
      user = await updateUserById(user.id, { stripeCustomerId: customerId, updatedAt: new Date().toISOString() });
    }

    const baseSuccess = process.env.STRIPE_SUCCESS_URL || 'https://remy-backend-uqrf.onrender.com/checkout/success';
    const baseCancel = process.env.STRIPE_CANCEL_URL || 'https://remy-backend-uqrf.onrender.com/checkout/cancel';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: `${baseSuccess}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: baseCancel,
      metadata: { remyUserId: user.id },
      subscription_data: { metadata: { remyUserId: user.id } }
    });
    res.json({ ok: true, url: session.url, mode: 'checkout_session' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Checkout konnte gerade nicht erstellt werden.' });
  }
});

app.get('/checkout/success', (_req, res) => {
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Remy Plus</title><body style="font-family:system-ui;padding:40px;background:#f5fbff;color:#203a57"><h1>Danke! Remy Plus wird aktiviert.</h1><p>Du kannst dieses Fenster schließen und Remy neu öffnen. Es kann ein paar Sekunden dauern, bis Stripe die Zahlung bestätigt hat.</p></body>');
});

app.get('/checkout/cancel', (_req, res) => {
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Remy Plus</title><body style="font-family:system-ui;padding:40px;background:#f5fbff;color:#203a57"><h1>Zahlung abgebrochen</h1><p>Du kannst jederzeit in Remy erneut auf Upgrade klicken.</p></body>');
});


app.get('/login', (req, res) => {
  const code = String(req.query.code || '');
  res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bei Remy anmelden</title><style>
  body{font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:linear-gradient(135deg,#f5fbff,#eef7ff);color:#203a57;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px} .card{width:min(430px,100%);background:white;border:1px solid #dbeafe;border-radius:28px;box-shadow:0 24px 70px rgba(32,58,87,.14);padding:28px} h1{margin:0 0 8px;font-size:30px;letter-spacing:-.04em} p{color:#52677d;line-height:1.5} input{box-sizing:border-box;width:100%;border:1px solid #dbe4ef;border-radius:16px;padding:13px 14px;margin:8px 0;font:inherit} .row{display:flex;gap:10px;margin-top:10px} button{flex:1;border:0;border-radius:16px;padding:13px 14px;font-weight:900;cursor:pointer} .primary{color:white;background:linear-gradient(135deg,#3e78d6,#7dd6c9)} .secondary{background:#eef7ff;color:#203a57}.hint{font-size:13px;margin-top:12px;min-height:20px}</style></head><body><main class="card"><h1>Bei Remy anmelden</h1><p>Melde dich an, damit Free-Fragen, Plus und gespeicherte Erinnerungen deinem Konto zugeordnet bleiben.</p><input id="email" type="email" autocomplete="email" placeholder="E-Mail"><input id="password" type="password" autocomplete="current-password" placeholder="Passwort, min. 8 Zeichen"><div class="row"><button class="primary" id="login">Einloggen</button><button class="secondary" id="register">Konto erstellen</button></div><p class="hint" id="hint"></p></main><script>
  const code=${JSON.stringify(code)}; const hint=document.getElementById('hint');
  async function submit(mode){ hint.textContent=mode==='register'?'Konto wird erstellt…':'Login läuft…'; try{ const res=await fetch('/api/auth/device/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,mode,email:email.value,password:password.value})}); const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.error||'Login fehlgeschlagen.'); hint.textContent='Fertig. Du kannst dieses Fenster schließen und Remy erneut öffnen.'; document.body.style.background='linear-gradient(135deg,#eefaf7,#eef7ff)'; }catch(e){ hint.textContent=e.message||'Login fehlgeschlagen.'; }}
  document.getElementById('login').onclick=()=>submit('login'); document.getElementById('register').onclick=()=>submit('register');
</script></body></html>`);
});


app.post('/api/create-lifetime-checkout-session', async (req, res) => {
  try {
    const identity = await getIdentity(req);
    if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich zuerst an, damit Lifetime deinem Konto zugeordnet werden kann.' });
    if (!stripe) return res.status(404).json({ error: 'Stripe ist noch nicht konfiguriert.' });
    const priceId = String(req.body?.earlyBird ? stripeLifetimeEarlyBirdPriceId : stripeLifetimePriceId) || stripeLifetimePriceId || stripeLifetimeEarlyBirdPriceId;
    if (!priceId) return res.status(404).json({ error: 'Lifetime-Preis ist noch nicht konfiguriert.' });
    let user = await findUserByEmail(identity.user.email);
    let customerId = user.stripeCustomerId || '';
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { remyUserId: user.id } });
      customerId = customer.id;
      user = await updateUserById(user.id, { stripeCustomerId: customerId, updatedAt: new Date().toISOString() });
    }
    const baseSuccess = process.env.STRIPE_SUCCESS_URL || `${publicBaseUrl()}/checkout/success`;
    const baseCancel = process.env.STRIPE_CANCEL_URL || `${publicBaseUrl()}/checkout/cancel`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseSuccess}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: baseCancel,
      metadata: { remyUserId: user.id, plan: 'lifetime' }
    });
    res.json({ ok: true, url: session.url, mode: 'lifetime_checkout' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Lifetime-Checkout konnte gerade nicht erstellt werden.' });
  }
});

app.post('/api/create-customer-portal-session', async (req, res) => {
  try {
    const identity = await getIdentity(req);
    if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich zuerst an, um dein Abo zu verwalten.' });
    if (!stripe) return res.status(404).json({ error: 'Stripe ist noch nicht konfiguriert.' });

    const user = await findUserByEmail(identity.user.email);
    if (!user?.stripeCustomerId) {
      return res.status(404).json({ error: 'Für dieses Konto wurde noch kein aktives Stripe-Abo gefunden.' });
    }

    const returnUrl = process.env.STRIPE_CUSTOMER_PORTAL_RETURN_URL || 'https://remy-backend-uqrf.onrender.com/checkout/success';
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl
    });
    res.json({ ok: true, url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Abo-Verwaltung konnte gerade nicht geöffnet werden. Prüfe, ob das Stripe Customer Portal aktiviert ist.' });
  }
});

app.get('/api/usage', async (req, res) => {
  const identity = await getIdentity(req);
  if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich an.' });
  const usage = await getUsage(identity.userId, identity.plan);
  res.json({ ok: true, usage: publicUsage(usage), user: publicUser(identity.user) });
});


app.get('/api/memories', async (req, res) => {
  try {
    const identity = await getIdentity(req);
    if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich an.' });
    const memories = await listMemories(identity.user.id);
    res.json({ ok: true, memories });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erinnerungen konnten gerade nicht geladen werden.' });
  }
});

app.post('/api/memories', async (req, res) => {
  try {
    const identity = await getIdentity(req);
    if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich an.' });
    const page = sanitizeMemory(req.body?.memory || req.body?.page || {});
    if (!page.url || !page.title) return res.status(400).json({ error: 'Erinnerung ist unvollständig.' });
    const saved = await upsertMemory(identity.user.id, page);
    res.json({ ok: true, memory: saved });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erinnerung konnte gerade nicht gespeichert werden.' });
  }
});

app.delete('/api/memories', async (req, res) => {
  try {
    const identity = await getIdentity(req);
    if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich an.' });
    const url = String(req.body?.url || req.query?.url || '');
    if (!url) return res.status(400).json({ error: 'URL fehlt.' });
    await deleteMemoryByUrl(identity.user.id, url);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erinnerung konnte gerade nicht gelöscht werden.' });
  }
});

app.post('/api/ask-public', async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ error: 'Remy kann gerade nicht antworten. Der API-Key ist im Backend noch nicht eingerichtet.' });
    const identity = await getIdentity(req);
    if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich an, um Remy zu nutzen.' });
    const usage = await getUsage(identity.userId, identity.plan);
    const limit = planLimit(identity.plan);
    if (usage.used >= limit) return res.status(402).json({ error: `Du hast dein Limit von ${limit} Fragen für diesen Monat erreicht.`, usage: publicUsage(usage) });
    const question = clip(req.body?.question, maxQuestionChars);
    if (!question) return res.status(400).json({ error: 'Frage fehlt.' });
    const response = await openai.responses.create({
      model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'Du bist Remy. Beantworte allgemeine Fragen hilfreich, knapp und klar auf Deutsch. Wenn etwas aktuell sein könnte, sag transparent, dass du ohne Browsing nicht live im Internet suchst.' }] },
        { role: 'user', content: [{ type: 'input_text', text: question }] }
      ]
    });
    const nextUsage = await incrementUsage(identity.userId, identity.plan);
    res.json({ ok: true, answer: response.output_text || 'Ich konnte keine Antwort erzeugen.', usage: publicUsage(nextUsage), mode: 'public' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Remy konnte gerade keine Antwort erzeugen.' });
  }
});

app.post('/api/ask', async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ error: 'Remy kann gerade nicht antworten. Der API-Key ist im Backend noch nicht eingerichtet.' });
    const identity = await getIdentity(req);
    if (!identity.user) return res.status(401).json({ error: 'Bitte melde dich an, um Remy zu nutzen.' });
    const usage = await getUsage(identity.userId, identity.plan);
    const limit = planLimit(identity.plan);
    if (usage.used >= limit) {
      return res.status(402).json({ error: `Du hast dein Limit von ${limit} Fragen für diesen Monat erreicht.`, usage: publicUsage(usage) });
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
  console.log(supabase ? 'Datenbank: Supabase aktiv' : 'Datenbank: lokaler JSON-Fallback aktiv');
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
  return await findUserById(payload.sub);
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

function fromDbUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    plan: row.plan || 'free',
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    stripeCustomerId: row.stripe_customer_id || '',
    stripeSubscriptionId: row.stripe_subscription_id || '',
    stripeSubscriptionStatus: row.stripe_subscription_status || '',
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
    lastStripeEvent: row.last_stripe_event || row.lastStripeEvent
  };
}
function toDbPatch(patch = {}) {
  const out = {};
  if ('email' in patch) out.email = patch.email;
  if ('plan' in patch) out.plan = patch.plan;
  if ('passwordSalt' in patch) out.password_salt = patch.passwordSalt;
  if ('passwordHash' in patch) out.password_hash = patch.passwordHash;
  if ('stripeCustomerId' in patch) out.stripe_customer_id = patch.stripeCustomerId;
  if ('stripeSubscriptionId' in patch) out.stripe_subscription_id = patch.stripeSubscriptionId;
  if ('stripeSubscriptionStatus' in patch) out.stripe_subscription_status = patch.stripeSubscriptionStatus;
  if ('lastStripeEvent' in patch) out.last_stripe_event = patch.lastStripeEvent;
  if ('updatedAt' in patch) out.updated_at = patch.updatedAt;
  if ('createdAt' in patch) out.created_at = patch.createdAt;
  return out;
}

async function findUserByEmail(email) {
  if (supabase) {
    const { data, error } = await supabase.from('remy_users').select('*').eq('email', email).maybeSingle();
    if (error) throw error;
    return fromDbUser(data);
  }
  const store = await readUsersStore();
  return store.usersByEmail[email] || null;
}
async function findUserById(id) {
  if (supabase) {
    const { data, error } = await supabase.from('remy_users').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return fromDbUser(data);
  }
  const store = await readUsersStore();
  const email = store.usersById[id];
  return email ? store.usersByEmail[email] || null : null;
}
async function createUserRecord(user) {
  if (supabase) {
    const { error } = await supabase.from('remy_users').insert({
      id: user.id,
      email: user.email,
      plan: user.plan || 'free',
      password_salt: user.passwordSalt,
      password_hash: user.passwordHash,
      created_at: user.createdAt || new Date().toISOString(),
      updated_at: user.updatedAt || new Date().toISOString()
    });
    if (error) throw error;
    return user;
  }
  const store = await readUsersStore();
  store.usersByEmail[user.email] = user;
  store.usersById[user.id] = user.email;
  await writeUsersStore(store);
  return user;
}
async function updateUserById(userId, patch = {}) {
  if (supabase) {
    const dbPatch = toDbPatch({ ...patch, updatedAt: patch.updatedAt || new Date().toISOString() });
    const { data, error } = await supabase.from('remy_users').update(dbPatch).eq('id', userId).select('*').single();
    if (error) throw error;
    return fromDbUser(data);
  }
  const store = await readUsersStore();
  const email = store.usersById[userId];
  if (!email || !store.usersByEmail[email]) return null;
  Object.assign(store.usersByEmail[email], patch, { updatedAt: patch.updatedAt || new Date().toISOString() });
  await writeUsersStore(store);
  return store.usersByEmail[email];
}
async function deleteUserById(userId) {
  if (supabase) {
    await supabase.from('remy_usage').delete().eq('user_id', userId);
    const { error } = await supabase.from('remy_users').delete().eq('id', userId);
    if (error) throw error;
    return;
  }
  const store = await readUsersStore();
  const email = store.usersById[userId];
  if (email) delete store.usersByEmail[email];
  delete store.usersById[userId];
  await writeUsersStore(store);
}

async function readUsersStore() { try { const store = JSON.parse(await fs.readFile(usersFile, 'utf8')); return { usersByEmail: store.usersByEmail || {}, usersById: store.usersById || {} }; } catch { return { usersByEmail: {}, usersById: {} }; } }
async function writeUsersStore(store) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(usersFile, JSON.stringify(store, null, 2)); }
async function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.client_reference_id || session.metadata?.remyUserId;
      if (!userId) return;
      await setUserPlanById(userId, session.metadata?.plan === 'lifetime' ? 'lifetime' : 'plus', {
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
        stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
        stripeSubscriptionStatus: session.metadata?.plan === 'lifetime' ? 'lifetime' : 'active',
        lastStripeEvent: event.type
      });
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const userId = subscription.metadata?.remyUserId || await findUserIdByStripeCustomer(subscription.customer);
      if (!userId) return;
      const activeStatuses = new Set(['active', 'trialing']);
      await setUserPlanById(userId, activeStatuses.has(subscription.status) ? 'plus' : 'free', {
        stripeCustomerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id,
        stripeSubscriptionId: subscription.id,
        stripeSubscriptionStatus: subscription.status,
        lastStripeEvent: event.type
      });
      break;
    }
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const userId = await findUserIdByStripeCustomer(invoice.customer);
      if (userId) await setUserPlanById(userId, 'plus', { lastStripeEvent: event.type });
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const userId = await findUserIdByStripeCustomer(invoice.customer);
      if (userId) { const u = await findUserById(userId); if (u?.plan !== 'lifetime') await setUserPlanById(userId, 'free', { lastStripeEvent: event.type }); }
      break;
    }
    default:
      break;
  }
}
async function findUserIdByStripeCustomer(customerId) {
  if (!customerId) return '';
  if (supabase) {
    const { data, error } = await supabase.from('remy_users').select('id').eq('stripe_customer_id', customerId).maybeSingle();
    if (error) throw error;
    return data?.id || '';
  }
  const store = await readUsersStore();
  for (const user of Object.values(store.usersByEmail)) {
    if (user.stripeCustomerId === customerId) return user.id;
  }
  return '';
}
async function setUserPlanById(userId, plan, extra = {}) {
  const user = await updateUserById(userId, { ...extra, plan, updatedAt: new Date().toISOString() });
  if (!user) return null;
  const usage = await getUsage(user.id, plan);
  usage.plan = plan;
  await writeUsageRecord(usage);
  return user;
}

function publicUser(user) { return { id: user.id, email: user.email, plan: user.plan || 'free', createdAt: user.createdAt, stripeSubscriptionStatus: user.stripeSubscriptionStatus || '' }; }
function currentMonth() { return new Date().toISOString().slice(0, 7); }
async function readUsageStore() { try { return JSON.parse(await fs.readFile(usageFile, 'utf8')); } catch { return { users: {} }; } }
async function writeUsageStore(store) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(usageFile, JSON.stringify(store, null, 2)); }
function normalizeUsage(store, userId, plan = 'free') { const month = currentMonth(); const existing = store.users[userId] || { userId, plan, month, used: 0 }; if (existing.month !== month) { existing.month = month; existing.used = 0; } existing.plan = plan || existing.plan || 'free'; existing.used = Number(existing.used || 0); store.users[userId] = existing; return existing; }
async function getUsage(userId, plan = 'free') {
  const month = currentMonth();
  if (supabase && !String(userId).startsWith('local-')) {
    const { data, error } = await supabase.from('remy_usage').select('*').eq('user_id', userId).eq('month', month).maybeSingle();
    if (error) throw error;
    if (!data) {
      const usage = { userId, month, plan, used: 0 };
      await writeUsageRecord(usage);
      return usage;
    }
    const usage = { userId: data.user_id, month: data.month, plan: plan || data.plan || 'free', used: Number(data.used || 0) };
    if (usage.plan !== data.plan) await writeUsageRecord(usage);
    return usage;
  }
  const store = await readUsageStore();
  const usage = normalizeUsage(store, userId, plan);
  await writeUsageStore(store);
  return usage;
}
async function writeUsageRecord(usage) {
  if (supabase && !String(usage.userId).startsWith('local-')) {
    const { error } = await supabase.from('remy_usage').upsert({
      user_id: usage.userId,
      month: usage.month || currentMonth(),
      plan: usage.plan || 'free',
      used: Number(usage.used || 0),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,month' });
    if (error) throw error;
    return;
  }
  const store = await readUsageStore();
  store.users[usage.userId] = usage;
  await writeUsageStore(store);
}
async function incrementUsage(userId, plan = 'free') {
  const usage = await getUsage(userId, plan);
  usage.used = Number(usage.used || 0) + 1;
  usage.plan = plan || usage.plan || 'free';
  await writeUsageRecord(usage);
  return usage;
}
function planLimit(plan) { return plan === 'lifetime' ? lifetimeLimit : (plan === 'plus' ? plusLimit : freeLimit); }
function publicUsage(usage) { const used = Number(usage.used || 0); const plan = usage.plan || 'free'; const limit = planLimit(plan); return { plan, used, limit, remaining: Math.max(0, limit - used), month: usage.month || currentMonth(), plusPrice, lifetimePrice, lifetimeEarlyBirdPrice, plusLimit, lifetimeLimit, freeLimit }; }

function publicBaseUrl() { return (process.env.PUBLIC_BASE_URL || 'https://remy-backend-uqrf.onrender.com').replace(/\/$/, ''); }
function sanitizeMemory(page = {}) {
  return {
    id: String(page.id || crypto.randomUUID()).slice(0, 120),
    title: clip(page.title, 180) || 'Ohne Titel',
    url: clip(page.url, 700),
    domain: clip(page.domain, 140),
    summary: clip(page.summary, 900),
    text: clip(page.text, 5000),
    searchQuery: clip(page.searchQuery, 180),
    platform: clip(page.platform, 80),
    media: page.media && typeof page.media === 'object' ? page.media : {},
    language: page.language && typeof page.language === 'object' ? page.language : {},
    keywords: Array.isArray(page.keywords) ? page.keywords.map(k => clip(k, 80)).filter(Boolean).slice(0, 30) : [],
    savedAt: page.savedAt || new Date().toISOString()
  };
}
function fromDbMemory(row) {
  return row ? { id: row.id, title: row.title, url: row.url, domain: row.domain, summary: row.summary || '', text: row.text || '', searchQuery: row.search_query || '', platform: row.platform || '', media: row.media || {}, language: row.language || {}, keywords: row.keywords || [], savedAt: row.saved_at || row.created_at } : null;
}
async function listMemories(userId) {
  if (supabase) {
    const { data, error } = await supabase.from('remy_memories').select('*').eq('user_id', userId).order('saved_at', { ascending: false }).limit(600);
    if (error) throw error;
    return (data || []).map(fromDbMemory).filter(Boolean);
  }
  const store = await readMemoriesStore();
  return Object.values(store[userId] || {}).sort((a,b)=>new Date(b.savedAt)-new Date(a.savedAt));
}
async function upsertMemory(userId, page) {
  if (supabase) {
    const { data, error } = await supabase.from('remy_memories').upsert({
      id: page.id,
      user_id: userId,
      title: page.title,
      url: page.url,
      domain: page.domain,
      summary: page.summary,
      text: page.text,
      search_query: page.searchQuery,
      platform: page.platform,
      media: page.media,
      language: page.language,
      keywords: page.keywords,
      saved_at: page.savedAt,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,url' }).select('*').single();
    if (error) throw error;
    return fromDbMemory(data);
  }
  const store = await readMemoriesStore();
  store[userId] ||= {};
  store[userId][page.url] = page;
  await writeMemoriesStore(store);
  return page;
}
async function deleteMemoryByUrl(userId, url) {
  if (supabase) {
    const { error } = await supabase.from('remy_memories').delete().eq('user_id', userId).eq('url', url);
    if (error) throw error;
    return;
  }
  const store = await readMemoriesStore();
  if (store[userId]) delete store[userId][url];
  await writeMemoriesStore(store);
}
async function readMemoriesStore() { try { return JSON.parse(await fs.readFile(path.join(dataDir, 'memories.json'), 'utf8')); } catch { return {}; } }
async function writeMemoriesStore(store) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(path.join(dataDir, 'memories.json'), JSON.stringify(store, null, 2)); }

function clip(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function base64url(input) { return Buffer.from(input).toString('base64url'); }
