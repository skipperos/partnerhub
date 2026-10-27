/**
 * COPY this source into the product site's client code / script.
 * Called during a visit to the product website. One last-click referral per product.
 * This code does NOT report a paid sale and contains NO secret credentials.
 * At checkout: your trusted backend receives getPartnerHubReferral() data,
 * verifies the actual payment, and forwards a signed/trusted event to Partner Hub.
 * Only send the referral if user consent/your applicable privacy policy permits it.
 */
export function capturePartnerHubReferral() {
  const params=new URLSearchParams(window.location.search);
  const ref=params.get('ph_ref'),click=params.get('ph_click');
  if(!ref||!click||!/^[A-Za-z0-9_-]{10,80}$/.test(ref)||!/^[0-9a-f-]{36}$/i.test(click))return;
  localStorage.setItem('partnerhub_referral',JSON.stringify({referral_code:ref,click_id:click,saved_at:Date.now()}));
}
export function getPartnerHubReferral(maxAgeDays=30) {
  try{
    const r=JSON.parse(localStorage.getItem('partnerhub_referral')||'null');
    if(!r||Date.now()-r.saved_at>maxAgeDays*86400000){localStorage.removeItem('partnerhub_referral');return null;}
    return {referral_code:r.referral_code,click_id:r.click_id};
  }catch{return null;}
}
