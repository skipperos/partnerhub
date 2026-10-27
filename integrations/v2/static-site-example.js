// Example for a static product site. Add this as a module to YOUR product's checkout page.
// Replace the constants. Never put a Paystack secret or product integration key in browser code.
const HUB_API = 'https://YOUR-PARTNER-HUB-BACKEND.onrender.com';
const PRODUCT_ID = 'YOUR-PARTNER-HUB-PRODUCT-UUID';
const OFFER_CODE = 'starter-pack';

// Capture redirect parameters immediately on landing, before navigating elsewhere.
export function capturePartnerReferral(){
  const url=new URL(window.location.href);
  const ref=url.searchParams.get('ph_ref'),click=url.searchParams.get('ph_click');
  if(ref&&click)localStorage.setItem('partner_hub_ref',JSON.stringify({ref,click,saved_at:Date.now()}));
}
export async function beginCheckout(customerEmail){
  const referral=JSON.parse(localStorage.getItem('partner_hub_ref')||'{}');
  if(!referral.saved_at || Date.now()-referral.saved_at>30*86400_000){referral.ref=null;referral.click=null;} // Actual attribution expiry also enforced by Partner Hub.
  const response=await fetch(`${HUB_API}/api/v2/checkout/start`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({product_id:PRODUCT_ID,offer_code:OFFER_CODE,email:customerEmail,
      referral_code:referral.ref||undefined,click_id:referral.click||undefined})
  });
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Unable to create checkout');
  sessionStorage.setItem(`partner_hub_order_${data.order_id}`,data.order_token);
  window.location.assign(data.authorization_url);
}
export async function checkReturnedOrder(){
  const id=new URLSearchParams(window.location.search).get('ph_order');
  if(!id)return {status:'none'};
  const token=sessionStorage.getItem(`partner_hub_order_${id}`);
  if(!token)return {status:'unavailable',message:'This browser does not have the original checkout token. Contact support with your order ID.'};
  const verify=await fetch(`${HUB_API}/api/v2/checkout/${id}/verify`,{method:'POST',headers:{'x-order-token':token}});
  const result=await verify.json();if(!verify.ok)throw new Error(result.error||'Unable to verify payment');
  // IMPORTANT: This is only for showing the user a receipt/status. Do not grant
  // sensitive digital entitlements based on browser-only checks. Your product
  // backend should poll the authenticated fulfillment API and deliver idempotently.
  return result;
}
