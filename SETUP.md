# Partner Hub — Deployment and operating guide

**Stack:** Vercel (React/Vite UI) + Render (Node/Hono API) + Supabase (Auth/Postgres).

This repository is a **working-code starter release**, not a deployed or payment-certified platform. The partner and admin applications, database migration, tracking redirect, commission ledger, refund handling, and manual payout management are implemented. **Your existing product checkouts are NOT automatically connected:** each product's secure backend must send verified transactions before affiliate commissions are recorded. Do sandbox testing before using real customer money.

## A. Supabase (first)

1. Create a new Supabase project. Keep its database password private.
2. Open **SQL Editor**, paste and run `supabase/001_schema.sql` **once**.
3. In **Authentication > Providers > Email**, keep email confirmation enabled. This keeps signups automatic **after** the user proves ownership of their email; nobody needs admin approval.
4. Set **Authentication > URL Configuration** Site URL to your eventual `https://your-partner-hub.vercel.app`. Add `http://localhost:5173` as an allowed development redirect URL and the Vercel production URL as an allowed redirect URL.
5. From project settings copy your Supabase URL and the **publishable / anon key** (not the service-role key).
6. From Supabase **Connect > Session pooler / URI**, copy the database URL. Use the session pooler on port 5432 for the Render Node server, or the direct URL if Render supports your project's connectivity. **Do not** expose it to Vercel/frontend.
7. You will be the first admin. The email address used to sign up **must equal** the address listed in Render's `ADMIN_EMAILS` environment variable. The backend checks verified Supabase identity, so nobody can make themselves admin merely by entering a display name.

If PostgreSQL reports a certificate validation error, use Supabase's documented CA certificate and the optional `DATABASE_CA_CERT` variable. **Do not disable TLS verification in production.**

## B. Render backend

Create a **Web Service**, connect the GitHub repository containing this project, and use:

| Setting | Value |
|---|---|
| Root directory | `server` |
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Node version | 20 or newer |

Configure the following **Render-only** environment variables:

```dotenv
DATABASE_URL=postgresql://... (Supabase direct or session pooler URI)
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=your_publishable_or_anon_key
ADMIN_EMAILS=your-real-verified-email@example.com
APP_ORIGINS=https://your-partner-hub.vercel.app,http://localhost:5173
PUBLIC_API_ORIGIN=https://your-api.onrender.com
NODE_ENV=production
CRON_SECRET=a-very-long-random-generated-value
```

Do **not** store production secrets in a file committed to Git. Do not give browser code `DATABASE_URL`, product API keys or payment gateway secret keys.

Verify your backend URL: `https://your-api.onrender.com/api/health` should return `{"ok":true,...}` **after** SQL migration and database connection succeed.

**Recommendation:** a paid always-on Render plan for live financial webhooks. Free services may sleep and delay requests.

## C. Vercel frontend

Create a Vercel project from the same GitHub repository:

| Setting | Value |
|---|---|
| Root directory | `web` |
| Framework | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |

Add three **Vercel environment variables**:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your_publishable_or_anon_key
VITE_API_URL=https://your-api.onrender.com
```

Deploy. The `web/vercel.json` handles SPA page refreshes. Update `APP_ORIGINS` in Render if your final Vercel domain differs, then redeploy/restart the backend. All API calls go to Render, not Vercel Functions.

## D. First login & admin

1. Open the Vercel site and choose **Create a free account**.
2. Register using the exact email in `ADMIN_EMAILS`.
3. Verify the confirmation link in your email inbox, then sign in.
4. The workspace switch shows **Partner** and **Admin**.
5. In Admin > **Manage products**, add the first product using its **real deployed URL**, real displayed price, and commission rules. The initial database contains **no fake products, website links, or prices**.
6. Keep the product **inactive** until its payment integration has passed testing. Then enable it.
7. In Admin > Products > **API key**, generate a key for that product. Store it in the existing product's secure backend environment.

To add Kingdom of Soft Life, OmniSight X-Ray, Covenant Vanguard, Sentinel or VentureFoundry, enter each product separately. Vanguard and Sentinel can be separate catalogue records with different URLs/rates, even if they share a branding family.

## E. Commission settings (admin only)

Each product independently configures:

- Commission rate in **basis points** internally (e.g. 30% = 3000), shown as a percentage in UI.
- One-time commission **per qualifying initial purchase** (no automatic renewal commission), or recurring commission. For a customer purchasing multiple separate orders, each qualifying order can earn a one-time commission; it does not mean first order per customer identity.
- Recurring duration: 3, 6, 12, 24 months, or lifetime (while a subscription continues and pays). The schema supports any 1–120 months, and the interface can be extended.
- Referral validity, default 30 days.
- Hold period before a commission becomes payable, default 14 days.
- Active/paused availability.

**Existing referral clicks retain the rules that existed when they were clicked. Existing acquired subscriptions retain their original recurring terms.** New clicks use the updated rules. Changes are auditable.

**Attribution rule in V1:** last eligible click, within the configured period, on the same product/browser journey. The product's first-party code overwrites its previously saved referral on a new affiliate visit. Cross-device attribution is NOT guaranteed.

## F. Connect each website — REQUIRED for live commissions

See `integrations/README.md`, `integrations/landing-capture.js`, and `integrations/verified-paystack-example.mjs`.

1. User shares the Render link `https://YOUR-API/r/PARTNER_CODE`.
2. Render records a click and redirects to the product site with `ph_ref` + `ph_click` query parameters.
3. Product landing page persists that information locally where permitted.
4. **Product checkout backend** stores referral pair with the order **before payment**, validates the actual charge with its payment provider, and sends a server-to-server event with its product integration key.
5. Partner Hub checks the matching click, product, expiry and policy snapshot; records the verified sale; creates the commission (or records as unattributed if no valid click).
6. The partner and admin dashboards show the event after refreshing.
7. A duplicate callback with the same transaction reference does **not** create a second commission.
8. A full refund/chargeback is reported from the product backend to reverse the commission.

**The integration adapter does not magically validate payments by itself.** For each product you must use its real backend/payment provider event, validate signature and order, and retry reporting after transient errors. There is no safe generic client-side shortcut for this.

This release includes an authenticated generic product event endpoint rather than a one-size-fits-all Paystack/PayPal webhook, because every product may use a different gateway, account, subscription configuration and metadata format. The adapter demonstrates how to connect a **verified** Paystack transaction. Other providers require their own verification adapter.

## G. Manual payouts

- Sale -> **pending commission** -> **approved after hold period** -> **draft payout batch** -> **paid after verified bank transfer**.
- Admin > Payouts shows approved balances. Click **Create batch**, confirm the actual external bank payment, enter a bank transfer reference, then **Mark paid**.
- Clicking **Mark paid** records your assertion of payment; it **does not send money**. Cancel a draft batch if needed.
- If a sale is refunded after a payout was already marked paid, a debit is recorded and offset against eligible future commissions.
- Refunds before a draft batch is marked paid automatically cancel the affected batch so the admin can recalculate it.
- **Full refunds only** are automated in this version. Partial refunds require a future feature; do not connect gateways that send partial refund events as full refunds without adapting the logic.
- Bank details and bank transfers are handled outside the portal in V1. Do not paste bank account details into notes, messages or unencrypted database fields.

Commission eligibility is refreshed on authenticated dashboard reads; optionally schedule `POST /api/internal/settle` with `x-cron-secret` using a Render Cron Job or trusted scheduler. This is useful when no one opens the dashboard for a long time.

## H. Local Windows development

1. Extract this ZIP.
2. Open PowerShell in the `partner-hub` folder.
3. Run `./prepare-local.ps1` (creates `.env` templates if absent and runs `npm install`).
4. Edit `server/.env` and `web/.env` with **local** values. The backend reads environment variables; the `prepare-local.ps1` uses `node --env-file` for local start.
5. Open two PowerShell windows:

```powershell
# Terminal A, from project root
./start-server-local.ps1

# Terminal B, from project root
npm run dev:web
```

The included server script loads `server/.env` before running Node. Then visit `http://localhost:5173`.

## I. Production acceptance tests

- Email sign-up, email verification, login/logout, and password reset via Supabase recovery emails.
- Admin access restricted to your verified allowlisted address.
- Normal partner cannot access admin endpoints or another partner's data.
- Partner registers without admin approval, selects active product and receives stable unique link.
- Redirect records click, sends correct website query parameters.
- Product backend reports verified payment and commission appears both sides.
- Duplicate event is idempotent; invalid key is rejected; invalid/expired click gets no commission.
- Existing commission rate remains unchanged after admin edits the product.
- Recurring renewal only credits eligible original subscriptions within duration.
- Full refund reverses commission; refund after payout creates debit offset.
- Draft payout can be cancelled, payout paid requires bank reference.
- RLS on all financial tables, TLS, proper CORS and no server secrets in browser.
- POPIA-compliant privacy notice, retention, affiliate terms, payout policy and tax advice reviewed before production marketing.

## Known V1 boundaries

- Existing websites require backend integration; their payment processing is NOT altered by this project ZIP.
- No background durable event-retry queue is bundled: implement durable retries in **each product backend**; keep original verified payment reference to reconcile missed events.
- No automated EFT/bank payouts; bank payments are manual.
- No partial refund calculation, multi-touch attribution, cross-device tracking, fraud scoring, automated tax statements, or tiered partner commissions.
- Currency totals are displayed separately; no misleading multi-currency conversion.
- The initial install needs your actual credentials and live website URLs. None are prefilled.
- A comprehensive security and payment-processing audit should be done before processing high-value production sales.
