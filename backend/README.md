# Remy Backend

## Start

```bash
npm install
npm start
```

Lege vorher eine `.env` Datei an:

```env
OPENAI_API_KEY=dein_api_key_hier
OPENAI_MODEL=gpt-4.1-mini
PORT=8787
FREE_MONTHLY_QUESTIONS=10
PLUS_PRICE=3,99 € / Monat
```

## Free-Limit

Das Backend zählt aktuell pro anonymer Extension-ID 10 kostenlose KI-Fragen pro Monat. Die Nutzung wird lokal in `usage.json` gespeichert.

Für ein echtes öffentliches Produkt ersetzt du das später durch Login + Datenbank + Stripe/Paddle/Lemon Squeezy. Diese Version zeigt schon die korrekte Produktlogik, aber noch keine echte Zahlungsabwicklung.


Nutzungslimits werden dauerhaft in `backend/data/usage.json` gespeichert. Browser- oder Laptop-Neustarts setzen die 10 Free-Fragen nicht zurück; nur der neue Monat startet wieder mit 10 Fragen.
