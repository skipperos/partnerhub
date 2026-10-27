import 'node:process';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { z, ZodError } from 'zod';
import { approveMatured, cancelDraftPayout, createPayout, recordVerifiedPayment, recordVerifiedRefund, withTx, writeEvent } from './finance.js';

const { Pool } = pg;
const required=['DATABASE_URL','SUPABASE_URL','SUPABASE_ANON_KEY','ADMIN_EMAILS','APP_ORIGINS','PUBLIC_API_ORIGIN'];
for(const k of required) if(!process.env[k]) throw new Error(`Missing environment variable: ${k}`);
if(process.env.NODE_ENV==='production' && (!process.env.ADMIN_EMAILS.trim() || !process.env.APP_ORIGINS.includes('https://'))) throw new Error('Configure verified admin email and HTTPS app origin');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:12,ssl:/localhost|127\.0\.0\.1/.test(new URL(process.env.DATABASE_URL).hostname)?false:{rejectUnauthorized:true, ...(process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT.replace(/\\n/g,'\n')}: {})},idleTimeoutMillis:30000});
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const adminEmails=new Set(process.env.ADMIN_EMAILS.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
const allowedOrigins=new Set(process.env.APP_ORIGINS.split(',').map(x=>x.trim().replace(/\/$/,'')).filter(Boolean));
const app=new Hono();
app.use('*',secureHeaders());
app.use('/api/*',cors({origin: origin=>allowedOrigins.has(origin)?origin:null,allowHeaders:['Authorization','Content-Type','X-Product-Key','X-Cron-Secret'],allowMethods:['GET','POST','PATCH','OPTIONS'],maxAge:600}));

const err=(m,status=400)=>Object.assign(new Error(m),{status});
const clean=(v)=>String(v??'').trim();
const limit=(s,n)=>clean(s).slice(0,n);
const money=(cents)=>Number(cents||0);
const plainUrl=(url)=>{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))throw err('Product URL must be http or https',422);if(process.env.NODE_ENV==='production'&&u.protocol!=='https:')throw err('Production product URLs must use HTTPS',422);u.hash='';return u.toString();};
const slugify=s=>clean(s).toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70);
const createCode=()=>crypto.randomBytes(14).toString('base64url');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const productSchema=z.object({name:z.string().trim().min(2).max(140),slug:z.string().trim().regex(/^[a-z0-9-]{3,70}$/),description:z.string().max(1500).default(''),website_url:z.string().url(),display_price_cents:z.number().int().min(0).safe().default(0),currency:z.string().regex(/^[A-Z]{3}$/).default('ZAR'),active:z.boolean().default(false),commission_bps:z.number().int().min(0).max(10000).default(2500),commission_mode:z.enum(['one_time','recurring']).default('one_time'),recurring_months:z.number().int().min(1).max(120).nullable().default(null),referral_days:z.number().int().min(1).max(365).default(30),hold_days:z.number().int().min(0).max(180).default(14)});
const productFields=Object.keys(productSchema.shape);
const selectPublicProduct=`id,slug,name,description,website_url,display_price_cents,currency,active,commission_bps,commission_mode,recurring_months,referral_days,hold_days`;
const productRule=p=>({commission_bps:p.commission_bps,commission_mode:p.commission_mode,recurring_months:p.recurring_months,referral_days:p.referral_days,hold_days:p.hold_days});

app.get('/api/health',async c=>{
  await pool.query('select 1');
  return c.json({ok:true,service:'partner-hub-api'});
});

async function requireUser(c,next){
  const bearer=c.req.header('Authorization')||'';
  if(!bearer.startsWith('Bearer '))throw err('Sign in required',401);
  const token=bearer.slice(7);
  const {data,error}=await auth.auth.getUser(token);
  const u=data?.user;
  if(error||!u||!u.email_confirmed_at)throw err('Verify your email and sign in',401);
  const email=u.email?.toLowerCase();
  const displayName=limit(u.user_metadata?.full_name || email?.split('@')[0] || 'Partner',100);
  const isAdmin=adminEmails.has(email);
  const result=await pool.query(`insert into public.partner_profiles(user_id,email,display_name,role)
    values($1,$2,$3,$4) on conflict(user_id) do update set email=excluded.email,
    role=case when excluded.role='admin' then 'admin' else public.partner_profiles.role end,
    updated_at=now() returning *`,[u.id,email,displayName,isAdmin?'admin':'partner']);
  const profile=result.rows[0];
  if(profile.status!=='active')throw err('Account suspended. Contact the administrator.',403);
  c.set('me',profile);
  await next();
}
function requireAdmin(c,next){
  if(c.get('me')?.role!=='admin' || !adminEmails.has(c.get('me').email?.toLowerCase()))throw err('Administrator access required',403);
  return next();
}
app.use('/api/me',requireUser);
app.use('/api/catalog/*',requireUser);
app.use('/api/my/*',requireUser);
app.use('/api/admin/*',requireUser,requireAdmin);
app.get('/api/me',c=>c.json({profile:c.get('me')}));
app.get('/api/catalog/products',async c=>{
  const q=await pool.query(`select ${selectPublicProduct} from public.products where active=true order by created_at desc`);
  return c.json({products:q.rows});
});
app.post('/api/catalog/products/:id/enroll',async c=>{
  const me=c.get('me');const id=c.req.param('id');
  const p=await pool.query('select id from public.products where id=$1 and active=true',[id]);
  if(!p.rows[0])throw err('Product unavailable',404);
  const newCode=createCode();
  const q=await pool.query(`insert into public.affiliate_links(partner_id,product_id,code) values($1,$2,$3)
    on conflict(partner_id,product_id) do update set code=public.affiliate_links.code returning *`,[me.user_id,id,newCode]);
  return c.json({link:{...q.rows[0],url:`${process.env.PUBLIC_API_ORIGIN.replace(/\/$/,'')}/r/${q.rows[0].code}`}});
});
app.get('/api/my/links',async c=>{
  const q=await pool.query(`select al.id,al.code,al.created_at,al.product_id,p.name,p.slug,p.active,p.commission_bps,p.commission_mode,p.recurring_months
    from public.affiliate_links al join public.products p on p.id=al.product_id where al.partner_id=$1 order by al.created_at desc`,[c.get('me').user_id]);
  return c.json({links:q.rows.map(l=>({...l,url:`${process.env.PUBLIC_API_ORIGIN.replace(/\/$/,'')}/r/${l.code}`}))});
});
app.get('/api/my/stats',async c=>{
  await approveMatured(pool);
  const id=c.get('me').user_id;
  const [clicks,sales,comm,debits]=await Promise.all([
    pool.query('select count(*)::int as count from public.referral_clicks where partner_id=$1',[id]),
    pool.query("select count(*)::int as count,coalesce(sum(gross_cents) filter(where status='paid'),0) as revenue_cents from public.sales where partner_id=$1",[id]),
    pool.query('select status,currency,coalesce(sum(amount_cents),0) as amount_cents,count(*)::int as count from public.commissions where partner_id=$1 group by status,currency',[id]),
    pool.query('select currency,coalesce(sum(amount_cents-applied_cents),0) as outstanding_cents from public.partner_debits where partner_id=$1 group by currency',[id])
  ]);
  return c.json({clicks:clicks.rows[0].count,sales:sales.rows[0].count,revenue_cents:money(sales.rows[0].revenue_cents),commissions:comm.rows,refund_adjustments:debits.rows});
});
app.get('/api/my/commissions',async c=>{
  await approveMatured(pool);
  const q=await pool.query(`select cm.id,cm.amount_cents,cm.rate_bps,cm.currency,cm.status,cm.created_at,cm.hold_until,cm.payout_id,
    p.name as product_name,s.external_transaction_id,s.status as sale_status from public.commissions cm
    join public.products p on p.id=cm.product_id join public.sales s on s.id=cm.sale_id
    where cm.partner_id=$1 order by cm.created_at desc limit 150`,[c.get('me').user_id]);
  return c.json({commissions:q.rows});
});
app.get('/api/my/payouts',async c=>{
  const q=await pool.query('select id,currency,amount_cents,status,payment_reference,created_at,paid_at from public.payouts where partner_id=$1 order by created_at desc limit 100',[c.get('me').user_id]);
  return c.json({payouts:q.rows});
});

// Public redirect. Product gets ph_ref + ph_click; the product site must persist them into verified checkout metadata.
const redirectHits=new Map();
app.get('/r/:code',async c=>{
  const code=c.req.param('code');
  if(!/^[A-Za-z0-9_-]{10,80}$/.test(code))throw err('Invalid referral link',404);
  const ip=(c.req.header('cf-connecting-ip')||c.req.header('x-forwarded-for')||'unknown').split(',')[0];
  const key=hash(ip).slice(0,16), now=Date.now();
  const hit=redirectHits.get(key)||{n:0,until:now+60000};
  if(now>hit.until){hit.n=0;hit.until=now+60000;}
  if(++hit.n>120)throw err('Too many requests',429);
  redirectHits.set(key,hit);
  if(redirectHits.size>20000)redirectHits.clear();
  const q=await pool.query(`select al.*,p.website_url,p.active,p.commission_bps,p.commission_mode,p.recurring_months,p.hold_days,p.referral_days,pp.status as partner_status
    from public.affiliate_links al join public.products p on p.id=al.product_id join public.partner_profiles pp on pp.user_id=al.partner_id
    where al.code=$1`,[code]);
  const r=q.rows[0];if(!r||!r.active||r.partner_status!=='active')throw err('Referral link unavailable',404);
  const id=crypto.randomUUID();
  await pool.query(`insert into public.referral_clicks(id,partner_id,product_id,affiliate_link_id,commission_bps,commission_mode,recurring_months,hold_days,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,now()+($9::integer * interval '1 day'))`,[id,r.partner_id,r.product_id,r.id,r.commission_bps,r.commission_mode,r.recurring_months,r.hold_days,r.referral_days]);
  const destination=new URL(r.website_url);destination.searchParams.set('ph_ref',code);destination.searchParams.set('ph_click',id);
  c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');
  return c.redirect(destination.toString(),302);
});

// Authenticated machine-to-machine events. Product API key must remain ONLY on the product's backend.
async function productIntegration(c,next){
  const token=c.req.header('x-product-key')||'';
  if(!/^ph_live_[A-Za-z0-9_-]{30,100}$/.test(token))throw err('Invalid integration credentials',401);
  const q=await pool.query('select * from public.products where integration_key_hash=$1',[hash(token)]);
  if(!q.rows[0])throw err('Invalid integration credentials',401);
  c.set('product',q.rows[0]);await next();
}
app.post('/api/integrations/events',productIntegration,async c=>{
  const body=await c.req.json();
  const product=c.get('product');
  const result=body.type==='payment.succeeded'
    ?await recordVerifiedPayment(pool,product,body,`product:${product.id}`)
    :body.type==='payment.refunded'
      ?await recordVerifiedRefund(pool,product,body,`product:${product.id}`)
      :(()=>{throw err('Unsupported event type',422);})();
  return c.json(result);
});

app.get('/api/admin/overview',async c=>{
  await approveMatured(pool);
  const [partners,products,sales,comm]=await Promise.all([
    pool.query("select count(*)::int as count from public.partner_profiles where role='partner'"),
    pool.query('select count(*)::int as count from public.products'),
    pool.query("select currency,count(*)::int as count,coalesce(sum(gross_cents) filter(where status='paid'),0) as gross_cents from public.sales group by currency"),
    pool.query('select status,currency,coalesce(sum(amount_cents),0) as amount_cents from public.commissions group by status,currency')
  ]);
  return c.json({partners:partners.rows[0].count,products:products.rows[0].count,sales:sales.rows.reduce((a,x)=>a+x.count,0),gross_by_currency:sales.rows,commissions:comm.rows});
});
app.get('/api/admin/products',async c=>{
  const q=await pool.query(`select ${selectPublicProduct},created_at from public.products order by created_at desc`);
  return c.json({products:q.rows});
});
app.post('/api/admin/products',async c=>{
  const parsed=productSchema.parse(await c.req.json());parsed.website_url=plainUrl(parsed.website_url);
  const values=productFields.map(k=>parsed[k]);
  const cols=productFields.map(k=>`"${k}"`).join(',');const slots=productFields.map((_,i)=>`$${i+1}`).join(',');
  const result=await withTx(pool,async tx=>{
    const q=await tx.query(`insert into public.products(${cols}) values(${slots}) returning ${selectPublicProduct}`,[...values]);
    await tx.query('insert into public.product_rules_audit(product_id,changed_by,next_rule) values($1,$2,$3)',[q.rows[0].id,c.get('me').user_id,JSON.stringify(productRule(q.rows[0]))]);
    return q.rows[0];
  });
  return c.json({product:result},201);
});
app.patch('/api/admin/products/:id',async c=>{
  const body=await c.req.json();const keys=Object.keys(body);
  if(!keys.length || keys.some(k=>!productFields.includes(k)))throw err('Invalid product fields',422);
  const p=await pool.query('select * from public.products where id=$1',[c.req.param('id')]);if(!p.rows[0])throw err('Product not found',404);
  const validated=productSchema.parse({...p.rows[0],...body});validated.website_url=plainUrl(validated.website_url);
  const old=p.rows[0];
  const updated=await withTx(pool,async tx=>{
    const assignments=productFields.map((k,i)=>`"${k}"=$${i+1}`).join(',');
    const q=await tx.query(`update public.products set ${assignments},updated_at=now() where id=$${productFields.length+1} returning ${selectPublicProduct}`,[...productFields.map(k=>validated[k]),old.id]);
    await tx.query('insert into public.product_rules_audit(product_id,changed_by,previous_rule,next_rule) values($1,$2,$3,$4)',[old.id,c.get('me').user_id,JSON.stringify(productRule(old)),JSON.stringify(productRule(q.rows[0]))]);
    return q.rows[0];
  });
  return c.json({product:updated});
});
app.post('/api/admin/products/:id/rotate-key',async c=>{
  const id=c.req.param('id'); const token=`ph_live_${crypto.randomBytes(32).toString('base64url')}`;
  const result=await pool.query('update public.products set integration_key_hash=$1 where id=$2 returning id,name',[hash(token),id]);
  if(!result.rows[0])throw err('Product not found',404);
  await pool.query('insert into public.finance_events(actor,action,entity_type,entity_id) values($1,$2,$3,$4)',[c.get('me').user_id,'integration.key_rotated','product',id]);
  return c.json({product:result.rows[0],key:token,warning:'Copy this key now. It will not be shown again. Previous key immediately stops working.'});
});
app.get('/api/admin/partners',async c=>{
  const q=await pool.query(`select pp.user_id,pp.email,pp.display_name,pp.status,pp.role,pp.created_at,
    (select count(*)::int from public.affiliate_links al where al.partner_id=pp.user_id) as product_count,
    (select count(*)::int from public.sales s where s.partner_id=pp.user_id) as sales_count
    from public.partner_profiles pp order by pp.created_at desc limit 500`);
  return c.json({partners:q.rows});
});
app.post('/api/admin/partners/:id/status',async c=>{
  const {status}=z.object({status:z.enum(['active','suspended'])}).parse(await c.req.json());
  const id=c.req.param('id');if(id===c.get('me').user_id)throw err('Cannot suspend your own account',422);
  const q=await pool.query("update public.partner_profiles set status=$1,updated_at=now() where user_id=$2 and role='partner' returning user_id,email,status",[status,id]);
  if(!q.rows[0])throw err('Partner not found',404);
  await pool.query('insert into public.finance_events(actor,action,entity_type,entity_id,detail) values($1,$2,$3,$4,$5)',[c.get('me').user_id,'partner.status_changed','partner',id,JSON.stringify({status})]);
  return c.json({partner:q.rows[0]});
});
app.get('/api/admin/sales',async c=>{
  await approveMatured(pool);
  const q=await pool.query(`select s.id,s.provider,s.external_transaction_id,s.gross_cents,s.eligible_cents,s.currency,s.status,s.kind,s.occurred_at,p.name as product_name,
    pp.email as partner_email,cm.amount_cents as commission_cents,cm.status as commission_status,cm.rate_bps
    from public.sales s join public.products p on p.id=s.product_id
    left join public.partner_profiles pp on pp.user_id=s.partner_id
    left join public.commissions cm on cm.sale_id=s.id
    order by s.created_at desc limit 250`);
  return c.json({sales:q.rows});
});
app.get('/api/admin/payouts',async c=>{
  const [q,eligible]=await Promise.all([
    pool.query(`select po.*,pp.email as partner_email from public.payouts po join public.partner_profiles pp on pp.user_id=po.partner_id order by po.created_at desc limit 150`),
    pool.query(`select cm.partner_id,pp.email,cm.currency,sum(cm.amount_cents)::bigint as approved_cents,
      coalesce((select sum(amount_cents-applied_cents) from public.partner_debits d where d.partner_id=cm.partner_id and d.currency=cm.currency),0) as outstanding_debits_cents
      from public.commissions cm join public.partner_profiles pp on pp.user_id=cm.partner_id
      where cm.status='approved' and cm.payout_id is null and pp.status='active' group by cm.partner_id,pp.email,cm.currency`)
  ]);
  return c.json({payouts:q.rows,eligible:eligible.rows});
});
app.post('/api/admin/payouts',async c=>{
  await approveMatured(pool);
  const {partner_id,currency}=z.object({partner_id:z.string().uuid(),currency:z.string().regex(/^[A-Z]{3}$/)}).parse(await c.req.json());
  const payout=await createPayout(pool,partner_id,currency,c.get('me').user_id);
  return c.json({payout},201);
});
app.post('/api/admin/payouts/:id/paid',async c=>{
  const {payment_reference}=z.object({payment_reference:z.string().trim().min(3).max(160)}).parse(await c.req.json());
  const result=await withTx(pool,async tx=>{
    const r=await tx.query('select * from public.payouts where id=$1 for update',[c.req.param('id')]);
    const p=r.rows[0];if(!p||p.status!=='draft')throw err('Payout not available for marking paid',422);
    const bad=await tx.query("select count(*)::int as count from public.commissions where payout_id=$1 and status!='approved'",[p.id]);
    if(bad.rows[0].count>0)throw err('Payout includes non-approved commission; cancel payout first',422);
    await tx.query("update public.payouts set status='paid',paid_at=now(),payment_reference=$1 where id=$2",[payment_reference,p.id]);
    await tx.query("update public.commissions set status='paid' where payout_id=$1",[p.id]);
    await writeEvent(tx,c.get('me').user_id,'payout.paid','payout',p.id,{payment_reference});
    return p.id;
  });
  return c.json({ok:true,id:result});
});
app.post('/api/admin/payouts/:id/cancel',async c=>{
  const did=await withTx(pool,tx=>cancelDraftPayout(tx,c.req.param('id'),c.get('me').user_id));
  if(!did)throw err('Only draft payouts can be cancelled',422);
  return c.json({ok:true});
});
app.get('/api/admin/audit',async c=>{
  const q=await pool.query('select actor,action,entity_type,entity_id,detail,created_at from public.finance_events order by id desc limit 100');
  return c.json({events:q.rows});
});
// Optional secure call from a Render Cron Job. Normal dashboard loads also settle mature commissions.
app.post('/api/internal/settle',async c=>{
  const candidate=c.req.header('x-cron-secret')||'';const expected=process.env.CRON_SECRET||'';
  if(!expected || candidate.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(candidate),Buffer.from(expected)))throw err('Unauthorized',401);
  await approveMatured(pool);return c.json({ok:true});
});

app.onError((e,c)=>{
  const status=e.status||(e instanceof ZodError?422:500);
  if(status>=500)console.error('[API ERROR]',e);
  const message=e instanceof ZodError?e.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; '):status>=500?'Internal server error':e.message;
  return c.json({error:message},status);
});
app.notFound(c=>c.json({error:'Route not found'},404));
const port=Number(process.env.PORT||4000);
serve({fetch:app.fetch,port});
console.log(`Partner Hub API listening on port ${port}`);
