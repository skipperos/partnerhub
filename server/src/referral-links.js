import crypto from 'node:crypto';

const invalid=(message,status=400)=>Object.assign(new Error(message),{status});

/** Existing links stay usable. Only opt-in products return website-domain links. */
export function buildAffiliateLinks(product,code,publicApiOrigin){
  if(!/^[A-Za-z0-9_-]{10,80}$/.test(code))throw invalid('Invalid affiliate code',422);
  const oldUrl=`${publicApiOrigin.replace(/\/$/,'')}/r/${code}`;
  const direct=new URL(product.website_url);
  if(direct.protocol!=='https:')throw invalid('Product link requires HTTPS',422);
  direct.hash='';
  direct.searchParams.set('ph_ref',code);
  direct.searchParams.delete('ph_click');
  return {
    url: product.direct_links_enabled?direct.toString():oldUrl,
    direct_url:direct.toString(),
    legacy_url:oldUrl,
    direct_links_enabled:!!product.direct_links_enabled
  };
}

/** Only records an eligible referral click; never records a financial event. */
export async function registerDirectVisit(pool,{product_id,referral_code,origin,allowedOrigins}){
  const q=await pool.query(`select al.id as affiliate_link_id,al.partner_id,al.product_id,
    p.website_url,p.active,p.commission_bps,p.commission_mode,p.recurring_months,p.hold_days,p.referral_days,
    pp.status as partner_status
    from public.affiliate_links al
    join public.products p on p.id=al.product_id
    join public.partner_profiles pp on pp.user_id=al.partner_id
    where al.code=$1 and al.product_id=$2`,[referral_code,product_id]);
  const r=q.rows[0];
  if(!r||!r.active||r.partner_status!=='active')throw invalid('Referral unavailable',404);
  // Browser Origin must equal the exact configured product origin and be allowlisted.
  // Unlike CORS alone, this check is enforced by the API itself.
  const productOrigin=new URL(r.website_url).origin;
  if(!origin||origin!==productOrigin||!allowedOrigins.has(origin))throw invalid('Untrusted product origin',403);
  const clickId=crypto.randomUUID();
  const created=await pool.query(`insert into public.referral_clicks(
     id,partner_id,product_id,affiliate_link_id,commission_bps,commission_mode,recurring_months,hold_days,expires_at
   ) values($1,$2,$3,$4,$5,$6,$7,$8,now()+($9::integer * interval '1 day'))
   returning id,expires_at`,[
    clickId,r.partner_id,r.product_id,r.affiliate_link_id,
    r.commission_bps,r.commission_mode,r.recurring_months,r.hold_days,r.referral_days
  ]);
  return {referral_code,click_id:created.rows[0].id,expires_at:created.rows[0].expires_at};
}
