import crypto from 'node:crypto';

export const sha256 = input => crypto.createHash('sha256').update(input).digest('hex');
export function signatureValid(raw, received, secret) {
  if (typeof received !== 'string' || !/^[a-fA-F0-9]{128}$/.test(received)) return false;
  const expected = crypto.createHmac('sha512',secret).update(raw).digest();
  return crypto.timingSafeEqual(expected,Buffer.from(received,'hex'));
}
export function enforcePaystackMode(mode, secret, liveEnabled=false) {
  if (!['test','live'].includes(mode)) throw new Error('PAYSTACK_MODE must be test or live');
  if (!secret || !secret.startsWith(mode==='test'?'sk_test_':'sk_live_')) throw new Error('Paystack secret key does not match PAYSTACK_MODE');
  if (mode==='live' && liveEnabled!==true) throw new Error('Live checkout requires PAYMENTS_LIVE_ENABLED=true');
}
export function validateVerifiedCharge(order, charge) {
  const failures=[];
  if (charge?.status!=='success') failures.push('Payment not successful');
  if (charge?.reference!==order.provider_reference) failures.push('Reference mismatch');
  if (!Number.isSafeInteger(charge?.amount)||charge.amount!==Number(order.amount_cents)) failures.push('Amount mismatch');
  if (charge?.currency!==order.currency) failures.push('Currency mismatch');
  if (charge?.domain!==order.provider_mode) failures.push('Merchant mode mismatch');
  if (String(charge?.customer?.email||'').trim().toLowerCase()!==order.customer_email.toLowerCase()) failures.push('Customer mismatch');
  const meta=typeof charge?.metadata==='string'?(()=>{try{return JSON.parse(charge.metadata)}catch{return {}}})():charge?.metadata;
  if (meta?.partner_hub_order !== order.id || meta?.partner_hub_product !== order.product_id) failures.push('Order metadata mismatch');
  return failures;
}
export function paystackClient(secret,{fetchImpl=fetch,base='https://api.paystack.co'}={}) {
  async function api(path,options={}) {
    const response=await fetchImpl(base+path,{...options,headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(15000)});
    const json=await response.json().catch(()=>null);
    if(!response.ok||!json?.status)throw Object.assign(new Error(json?.message||`Paystack HTTP ${response.status}`),{status:502});
    return json.data;
  }
  return {
    initialize: ({email,amount,currency,reference,callback_url,metadata})=>api('/transaction/initialize',{method:'POST',body:JSON.stringify({email,amount:String(amount),currency,reference,callback_url,metadata:JSON.stringify(metadata)})}),
    verify: reference=>api(`/transaction/verify/${encodeURIComponent(reference)}`)
  };
}
