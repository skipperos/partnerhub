/**
 * Product-site browser adapter for Partner Hub direct product-domain affiliate links.
 * Copy this module into EACH actual product website; import & call captureReferralOnLanding
 * when the product page loads, then await getReferralForCheckout before starting payment.
 * No Paystack keys or product integration keys belong in this file.
 */
const STORE = 'partner_hub_ref'; // existing V2 static adapter uses this key
const LEGACY_STORE = 'partnerhub_referral'; // existing V1 adapter may use this key
const isCode = v => typeof v === 'string' && /^[A-Za-z0-9_-]{10,80}$/.test(v);
const isUUID = v => typeof v === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(v);
const cached = productId => `ph_direct_visit_${productId}`;
function save(productId,ref,click){
  const now=Date.now();
  localStorage.setItem(STORE,JSON.stringify({ref,click,saved_at:now,product_id:productId}));
  localStorage.setItem(LEGACY_STORE,JSON.stringify({referral_code:ref,click_id:click,saved_at:now,product_id:productId}));
}
function parseStored(productId,maxAgeDays){
  try {
    const x=JSON.parse(localStorage.getItem(STORE)||'null');
    if(!x || x.product_id!==productId || !isCode(x.ref) || !isUUID(x.click) ||
      !Number.isFinite(x.saved_at) || Date.now()-x.saved_at > maxAgeDays*86400000 || x.saved_at>Date.now()+60000) return null;
    return {referral_code:x.ref,click_id:x.click};
  }catch{return null;}
}
/**
 * Returns a referral or null. If ph_ref appears without ph_click, the product site
 * MUST register it with Partner Hub. That registration inserts a real click row.
 */
export async function captureReferralOnLanding({apiBase,productId}){
  if(!apiBase || !isUUID(productId))throw new Error('Set Partner Hub API base and valid product UUID');
  const u=new URL(window.location.href);
  const ref=u.searchParams.get('ph_ref');
  if(!isCode(ref))return null;
  const prior=u.searchParams.get('ph_click');
  if(isUUID(prior)){
    save(productId,ref,prior);return {referral_code:ref,click_id:prior};
  }
  // Deduplicate repeated calls on the same landing page/navigation (React effects).
  const sessionKey=cached(productId);
  try{
    const old=JSON.parse(sessionStorage.getItem(sessionKey)||'null');
    if(old?.ref===ref && isUUID(old?.click) && Date.now()-old.at<30*60*1000){
      save(productId,ref,old.click);return {referral_code:ref,click_id:old.click};
    }
  }catch{}
  const response=await fetch(`${apiBase.replace(/\/$/,'')}/api/v2/referrals/visit`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({product_id:productId,referral_code:ref})
  });
  let data=null;try{data=await response.json()}catch{}
  if(!response.ok || !isUUID(data?.click_id))throw new Error(data?.error||`Referral registration failed (${response.status})`);
  save(productId,ref,data.click_id);
  sessionStorage.setItem(sessionKey,JSON.stringify({ref,click:data.click_id,at:Date.now()}));
  return {referral_code:ref,click_id:data.click_id};
}
/**
 * Pass the result into the existing /api/v2/checkout/start request body.
 * Checkout MUST be protected by Partner Hub's verified payment logic.
 */
export async function getReferralForCheckout({apiBase,productId,maxAgeDays=30}){
  const ref=new URL(window.location.href).searchParams.get('ph_ref');
  if(isCode(ref))await captureReferralOnLanding({apiBase,productId});
  return parseStored(productId,maxAgeDays)||{};
}
