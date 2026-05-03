# Remy Backend

## Setup

```bash
npm install
npm start
```

## Supabase

Führe `backend/supabase/schema.sql` im Supabase SQL Editor aus.

Danach in Render eintragen:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Stripe

Für Plus:

- `STRIPE_PRICE_ID`

Für Lifetime:

- `STRIPE_LIFETIME_EARLY_BIRD_PRICE_ID`
- `STRIPE_LIFETIME_PRICE_ID`

Für Webhooks:

- Endpoint: `/api/stripe/webhook`
- `STRIPE_WEBHOOK_SECRET`

Für Kund*innenportal:

- Stripe Customer Portal in Stripe aktivieren.

## Externer Login

Die Extension ruft `/api/auth/device/start` auf. Das Backend öffnet dann `/login?code=...` im Browser. Nach erfolgreichem Login holt die Extension Token und Nutzerprofil über `/api/auth/device/poll/:code` ab.
