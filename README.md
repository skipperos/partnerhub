# PARTNER HUB

**Built for the hungry.** A branded affiliate-sales management web platform built with **Supabase + Vercel + Render**.

## What's included

- Free automatic partner registration and verified email sign-in
- Mobile-first partner dashboard, product catalogue, one-click product enrollment
- Unique per-partner **and** per-product affiliate links
- Click tracking and last-click referral metadata
- Individual sales, commission and payout history
- Admin product management, activation, per-product commissions and recurring durations
- Admin partner controls, audited policy changes, sales attribution and manual payout batches
- Authenticated server-to-server sale/refund API with idempotent processing
- Commission rule snapshot on referral click so changes don't retroactively reduce existing referrals
- Supabase PostgreSQL schema and RLS restrictions
- Integration adapters and deployment guide

**START HERE: [SETUP.md](SETUP.md)**

### Folder structure

```text
partner-hub/
  web/               React + Vite frontend (deploy to Vercel)
  server/            Hono Node backend (deploy to Render)
  supabase/          PostgreSQL migration (run in Supabase SQL Editor)
  integrations/      Existing product site integration examples
  tests/             Finance unit tests
  prepare-local.ps1  Windows environment + npm installation
  start-server-local.ps1
  SETUP.md           Full deployment and testing instructions
```

### Important limitations

This is an **initial release**, not a deployed service. Payment **attribution requires connecting each existing product's secure backend** via `integrations/README.md`. Do **not** use an affiliate's client-side claim or a success page as evidence that a purchase occurred. Manual bank payouts must be separately completed before being marked paid.

No product sites, payment provider secret keys or user accounts are included.
