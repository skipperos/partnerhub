# Partner Hub V2 — Central Paystack Payment Engine

**Deployment status:** Source implementation delivered. Not deployed to your account. **PAYSTACK_MODE=test** and **PAYMENTS_LIVE_ENABLED=false** by default. This package does not change any existing Paystack webhook, checkout, DNS or merchant configuration. Do not start live transactions before the test checklist and refund/subscription work are complete.

## What actually works in this version

- Central **fixed-price, one-time** Paystack hosted checkout initialization from Partner Hub's Render API, not from the product site.
- Each product can have multiple checkout offers and its own affiliate link; the backend controls the amount and commission-eligible amount.
- Server-side Paystack transaction verification by reference, checking **status, amount, currency, mode, customer email, product ID and order ID** against the saved order.
- Signed `x-paystack-signature` HMAC-SHA512 webhook receipt using the exact raw payload, with durable webhook inbox, automatic 60-second sweep, and manual/scheduled reconciliation.
- Duplicate sale/commission protection through V1's `recordVerifiedPayment` and order idempotency.
- Separate **test orders**, including test attribution estimates, that never enter the live sales or payable commission ledger.
- Product-scoped fulfillment polling + idempotent acknowledgement endpoint (each website must implement its own actual delivery logic).
- An Admin → Payment engine screen for offers, recent orders, environment and events requiring review.
- Central Paystack API key **only on Render**. Sites do **not** need to store Paystack keys.

## Not yet safe/implemented for live rollout

- **Automatic recurring subscriptions and renewals** on this new checkout API. V1 still supports recurring *trusted integration events*; V2's central checkout deliberately rejects products whose commission mode is `recurring` until a validated subscription linkage is added.
- **Automatic full/partial refund and chargeback reconciliation.** Unrecognized/refund events enter admin review. Do not pay commissions from the new flow until refund/dispute handling has been completed and tested.
- Real product fulfillment code for Kingdom of Soft Life, OmniSight X-Ray, Sentinel, etc. The supplied examples are adapters and require an integration in each target codebase. **A static website cannot securely grant paid-only assets through frontend JavaScript alone.**
- A complete deployed integration test against Supabase/Paystack. No real Paystack credentials are in this ZIP.
- Existing live checkout migrations. Your working product checkouts remain unchanged.

## Safe deployment — upgrade existing repo, do not create another

1. **Back up your current live repository and Supabase database.** Download and save the current `main` revision separately; verify your existing V1 backend and frontend remain operational.
2. **Merge** the V2 files into the current `skipperos/partnerhub` repository; do not replace GitHub with an unrelated history. The ZIP retains your V1 files, plus V2 additions. Review git diff first.
3. In **your existing Supabase project**, open SQL Editor, run **`supabase/002_payment_engine.sql` once**. It adds new payment tables and two product fields without dropping or truncating any existing data. This migration is intended for your PostgreSQL backend using the session pooler and certificate you already configured. Do NOT rerun `001_schema.sql` as a replacement.
4. On **Render → Environment**, keep your existing `DATABASE_URL`, `DATABASE_CA_CERT`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_ORIGINS`, `PUBLIC_API_ORIGIN`, `ADMIN_EMAILS`, `CRON_SECRET`. Add:

   ```dotenv
   PAYSTACK_MODE=test
   PAYMENTS_LIVE_ENABLED=false
   PAYSTACK_SECRET_KEY=sk_test_YOUR_OWN_TEST_SECRET
   PRODUCT_ORIGINS=https://YOUR-REAL-PRODUCT-SITE.example
   ```

   Use the *test secret key* copied privately from Paystack's test environment. Do not expose it in Vercel or frontend files. `PRODUCT_ORIGINS` is comma-separated exact origins (no trailing `/`). The origin must match the product's configured `website_url` origin. For dynamic server-side site adapters, the existing per-product `x-product-key` is used instead.
5. Deploy **Render** first. `GET https://YOUR-RENDER-URL/api/health` should still return `ok`. New endpoint `GET /api/v2/payments/health` should report `{configured:true,mode:'test',live_enabled:false}`. Recheck logs.
6. Deploy the existing Vercel frontend from `web` (same `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL` settings). Sign in as admin and find **Payment engine** in navigation.
7. In Admin → Manage products, create/verify one product (e.g. Kingdom). Set product URL and optional `payment_return_url` on the **same HTTPS origin**. Initially leave **Enable Partner Hub checkout** OFF. Create a **test offer** in Payment engine and activate that offer. Only after connecting the test website, enable Partner Hub checkout for that product.
8. Add the static-site adapter from `integrations/v2/static-site-example.js` or a backend adapter for the product. Replace `PRODUCT_ID`, `OFFER_CODE`, and `HUB_API` placeholders. Customer email is sent to Render; prices are NEVER supplied by the browser.
9. Use the **Paystack test environment's webhook URL** `https://YOUR-RENDER-URL/api/v2/paystack/webhook` and leave the existing **live** webhook untouched. Paystack typically provides separate test/live webhook configuration in its dashboard. Do not configure the live URL until you have inventoried all existing live website fulfillment integrations.
10. Run the tests below, inspect events, and connect the product's trusted fulfillment worker. For products without backends, add a secure delivery backend before selling access-controlled digital products.

### Test checklist

- [ ] The normal existing V1 signup, partner portal, admin portal and commission management still work.
- [ ] Product with `payment_enabled=false` rejects checkout.
- [ ] Active fixed-price offer begins a Paystack **test** transaction and redirects to `checkout.paystack.com`.
- [ ] Unauthorized Origin, invalid product key, arbitrary amount, wrong product, malformed email, altered order tokens and unsupported offers do not authorize purchases.
- [ ] Failed/abandoned Paystack transactions do not mark orders paid.
- [ ] Paystack test success recorded in Payment engine as `paid` and marked `test`; **it is absent from partner's payable commission balance**.
- [ ] Same webhook delivered twice does not result in duplicate sales or fulfillment.
- [ ] Tampered webhook signature is rejected.
- [ ] Wrong amount, currency, email, reference or metadata is rejected and flagged for review.
- [ ] A browser returning to the product without the order token cannot bypass server-side authorization.
- [ ] Product backend polls and fulfills **once**; acknowledges after delivery.
- [ ] Reconciliation handles delayed webhook, temporarily unavailable Paystack, and Render restart.
- [ ] Real refund/chargeback/subscription paths are fully designed and tested **before going live**.

## API contract

### Checkout — browser or trusted product backend

`POST /api/v2/checkout/start`

```json
{
  "product_id":"PRODUCT_UUID",
  "offer_code":"starter-pack",
  "email":"customer@example.com",
  "referral_code":"OPTIONAL_PH_REF",
  "click_id":"OPTIONAL_PH_CLICK_UUID"
}
```

The public browser call must come from the exact product website origin and that origin must be in `PRODUCT_ORIGINS`. Alternatively an authorized product backend may supply `x-product-key`. The browser must never receive this key. Amount, currency, offer, status and callbacks are derived server-side. Returns HTTP 201, `order_id`, `order_token`, `authorization_url`, amount and currency. Store token temporarily in session storage indexed by `order_id` to resume status checks after returning from Paystack. In live production, review consent/privacy handling of referral persistence.

`GET /api/v2/checkout/:id/status` and `POST /api/v2/checkout/:id/verify`

Header `x-order-token: <opaque-token>` (or `x-product-key` from a trusted backend). `verify` checks directly against Paystack, and paid status is **never trusted from the browser callback**.

### Paystack → Partner Hub

`POST /api/v2/paystack/webhook`

Header `x-paystack-signature`. Signed events are durably recorded, then processed from Paystack's Verify Transaction API. Only **original Partner Hub-initiated orders** are automatically matched; unknown references go to admin review instead of being assigned to a random product. Paystack test and live events must be configured separately.

### Product fulfillment — trusted product backend only

- `GET /api/v2/integrations/orders` with `x-product-key` returns up to 100 paid, unfulfilled orders for that product (including offer, email, reference and amount).
- `POST /api/v2/integrations/orders/:id/fulfilled` with `x-product-key` and `{"fulfillment_reference":"your-unique-delivery-id"}` marks an order fulfilled. Idempotently reuse the same delivery reference if retried. **Fulfillment logic runs in your product backend**; the hub only records its status.

### Admin

- `GET/POST /api/admin/payment-offers`
- `PATCH /api/admin/payment-offers/:id`
- `GET /api/admin/payment-orders`
- `POST /api/admin/payment-reconcile`
- `GET /api/v2/payments/health`
- `POST /api/v2/cron/payments` with `x-cron-secret` (Render scheduled task; recommended every few minutes as a backup to in-process sweeps).

## Financial data and safety rules

- Test payments can be used to verify the order and estimated affiliate association, but **never post to V1 live sales, commissions, earnings or payouts**.
- In live mode (not enabled by default), verified orders use the existing V1 financial ledger and original affiliate click's commission snapshot. V1's hold period and payout approval apply.
- Subscriptions and refunds are deliberately *not* auto-credited or auto-reversed in V2. This is a live-rollout blocker, not permission to treat a refund as a successful unreversed sale.
- If you ever activate live credentials, first make backups, perform a fresh npm dependency audit and professional payment/financial testing; configure `PAYSTACK_MODE=live`, a proper `sk_live_...` key and explicitly set `PAYMENTS_LIVE_ENABLED=true`. This is **not recommended until the blockers above have been resolved**.
- `x-product-key` is an existing Partner Hub product integration key, NOT a Paystack API key. Product-site source must not contain private credentials.
- Don't use `NODE_TLS_REJECT_UNAUTHORIZED=0` or bypass database SSL certificate validation.

### Rollback

If V2 deployment causes trouble, redeploy the saved V1 GitHub commit and keep your existing Paystack live webhook unchanged. The additive V2 tables do not affect V1 functionality. Do not drop V2 tables if they contain transactions. If the first product's checkout integration has been tested and later reversed, restore that site's prior checkout independently.

## Reference docs

- https://paystack.com/docs/api/transaction/
- https://paystack.com/docs/payments/webhooks/
- https://paystack.com/docs/payments/verify-payments/
