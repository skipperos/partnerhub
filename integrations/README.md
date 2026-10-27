# Connecting an existing product (without moving its website)

Every website stays where it is. Affiliate attribution only works once its **trusted checkout backend** reports verified sales to Partner Hub. Merely creating a product link is not enough.

## 1. Admin generates the product key

Admin > Products > API key > Generate / rotate. Copy `ph_live_...` once into the product **server** secrets. Never expose this in browser code, URL parameters, or a Git repository. Rotating disables the old key immediately.

## 2. Product landing page captures the referral

The redirect URL carries `ph_ref` and `ph_click` query parameters. The `landing-capture.js` helper shows a first-party localStorage approach; call `capturePartnerHubReferral()` on landing, and include `getPartnerHubReferral()` in your checkout request. The frontend is not allowed to submit sales to Partner Hub.

Your product's server should associate this referral pair with a server-side order record when checkout starts. Do not rely on browser data sent after payment. Respect your privacy notice, consent requirements, and retention policy. Cookies/localStorage can be blocked or deleted, so attribution is not perfect across devices.

## 3. Product server verifies the payment

For Paystack, verify its webhook signature from the **raw bytes** using HMAC SHA-512, reconcile the order and amount with your database, and/or independently verify the transaction reference through Paystack. For PayPal use the provider's documented webhook validation and capture/transaction verification procedures. These are **different integration paths**, not interchangeable snippets.

`verified-paystack-example.mjs` demonstrates the next step once a transaction is authenticated. The example is **not** a drop-in Paystack webhook endpoint: you must connect it to your existing secure order/checkout code, and ensure retries until confirmation.

## 4. Server submits a payment event

`POST https://YOUR-RENDER-URL/api/integrations/events`

Headers: `Content-Type: application/json`, `x-product-key: ph_live_...`

```json
{
  "type":"payment.succeeded",
  "provider":"paystack",
  "external_transaction_id":"provider-unique-reference",
  "kind":"initial",
  "external_subscription_id":null,
  "gross_cents":50000,
  "eligible_cents":47000,
  "currency":"ZAR",
  "referral_code":"code-from-order",
  "click_id":"uuid-from-order",
  "occurred_at":"2026-10-26T11:00:00.000Z"
}
```

- Both amounts must be **integer minor currency units**, e.g. R500.00 = 50000 cents.
- `eligible_cents` is the commissionable subtotal. The *product backend* decides excluded VAT, discounts, refunds etc consistently with its contractual policy.
- `external_transaction_id` must be unique per product + provider. Retries are safely deduplicated.
- `referral_code` AND `click_id` must match a valid active attributed referral click. Without these, the system records an **unattributed** sale, not a commission.
- A renewal must use `kind:"renewal"` and the same stable `external_subscription_id` as the initial sale. It pays only if that initial sale created a recurring affiliation and the configured duration is not exceeded.
- Store the initial `external_subscription_id` in your own server's order/subscription records. Some payment providers don't re-include initial custom metadata in renewals.
- If the payment reporting call fails, **retry from a durable product-backend queue or reconciliation process**. Do not fabricate a sale from the buyer's browser.

## 5. Refund / chargeback callback

After your product backend verifies a completed refund/chargeback, send:

```json
{
  "type":"payment.refunded",
  "provider":"paystack",
  "external_transaction_id":"provider-unique-reference"
}
```

Refund handling is currently **full-refund only**. Partial refunds must be handled by operations until pro-rata logic is added. If a payout was already completed, a debit adjustment is recorded and offset from future commissions.

## End-to-end test checklist

1. Sign up as a normal partner; verify email.
2. Create one active product in admin; generate integration key.
3. Partner chooses product and shares `https://YOUR-RENDER-URL/r/CODE`.
4. Click the link and verify `ph_ref` and `ph_click` arrive on destination.
5. Start checkout; save both on the **server-side** order.
6. Confirm a real sandbox payment through Paystack/PayPal; have product backend send `payment.succeeded`.
7. Verify partner shows 1 sale and a pending commission; admin shows same sale and company remainder.
8. Retry the exact event; confirm no duplicate commission.
9. Test an invalid product key; confirm 401 and no sale created.
10. Test expiry / invalid click; confirm no commission.
11. Test recurring subscription renewal with stable subscription ID; confirm correct rate/duration.
12. Process a full sandbox refund and verify reversal.
13. Confirm approved commissions move to a draft payout batch and are only marked paid after a real bank transfer.
