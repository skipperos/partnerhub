/**
 * EXAMPLE ONLY, not an installed automatic integration.
 * In the EXISTING product's Paystack-verified backend handler, call this function
 * AFTER checking the authentic Paystack webhook HMAC SHA-512 signature AND
 * verifying the transaction matches the expected amount, currency and order.
 * The key must only live on the product BACKEND, never in the browser.
 * Do not pass referral details from an unauthenticated webhook callback directly.
 */
export async function reportPaystackSale({
  partnerHubApiUrl,
  partnerHubProductKey,
  verifiedTransaction,
  validatedOrder,
}) {
  // validatedOrder must have been loaded from your server database, not blindly
  // trusted from a webhook metadata field or a client-supplied order payload.
  const event = {
    type: 'payment.succeeded',
    provider: 'paystack',
    external_transaction_id: verifiedTransaction.reference,
    kind: validatedOrder.isRenewal ? 'renewal' : 'initial',
    external_subscription_id: validatedOrder.subscriptionId || null,
    gross_cents: verifiedTransaction.amount,
    eligible_cents: validatedOrder.eligibleAmountCents,
    currency: verifiedTransaction.currency,
    referral_code: validatedOrder.referralCode || null,
    click_id: validatedOrder.clickId || null,
    occurred_at: new Date(verifiedTransaction.paid_at).toISOString(),
  };
  const response=await fetch(`${partnerHubApiUrl.replace(/\/$/,'')}/api/integrations/events`,{
    method:'POST',
    headers:{'Content-Type':'application/json','x-product-key':partnerHubProductKey},
    body:JSON.stringify(event),
  });
  const result=await response.json();
  if(!response.ok)throw new Error(`Partner Hub integration failed: ${JSON.stringify(result)}`);
  return result;
}
