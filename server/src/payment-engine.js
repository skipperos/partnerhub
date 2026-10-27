import crypto from 'node:crypto';
import {z} from 'zod';
import {paystackClient,sha256,signatureValid,validateVerifiedCharge,enforcePaystackMode} from './paystack.js';
import {recordVerifiedPayment} from './finance.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const safeRef=()=>`PH${crypto.randomBytes(19).toString('hex')}`;
const startSchema=z.object({product_id:z.string().uuid(),offer_code:z.string().regex(/^[a-z0-9-]{2,70}$/),email:z.string().trim().email().max(254),referral_code:z.string().max(100).optional(),click_id:z.string().uuid().optional()});
const offerSchema=z.object({code:z.string().regex(/^[a-z0-9-]{2,70}$/),title:z.string().trim().min(2).max(160),amount_cents:z.number().int().positive().max(100_000_000),eligible_cents:z.number().int().nonnegative().max(100_000_000),active:z.boolean().default(false)}).refine(x=>x.eligible_cents<=x.amount_cents,'Eligible amount exceeds price');
const ipHits=new Map();
function throttle(ip){
 const key=sha256(ip).slice(0,24),now=Date.now(),hit=ipHits.get(key)||{n:0,until:now+600_000};
 if(now>hit.until){hit.n=0;hit.until=now+600_000;}if(++hit.n>25)throw fail('Too many checkout requests. Try again later.',429);
 ipHits.set(key,hit);if(ipHits.size>20000)ipHits.clear();
}
function validReturnUrl(product){
 const root=new URL(product.website_url);
 const cb=product.payment_return_url?new URL(product.payment_return_url):new URL(product.website_url);
 if(cb.origin!==root.origin || cb.protocol!=='https:')throw fail('Payment return URL must be HTTPS on the product website origin',422);
 return cb;
}
const checkToken=(order,token)=>typeof token==='string'&&token.length>=32&&/^[A-Za-z0-9_-]+$/.test(token)&&sha256(token)===order.status_token_hash;
const errText=e=>String(e?.message||e).slice(0,250);

export function attachPaymentEngine(app,{pool,productIntegration,requireUser,requireAdmin}){
 const mode=process.env.PAYSTACK_MODE||'test';
 const key=process.env.PAYSTACK_SECRET_KEY||'';
 // Optional V2 deploy: no live charge initialization until explicitly configured.
 let paystack=null;
 if(key){enforcePaystackMode(mode,key,process.env.PAYMENTS_LIVE_ENABLED==='true');paystack=paystackClient(key);}
 const ready=()=>{if(!paystack)throw fail('Paystack not configured on Render',503);return paystack;};
 const originSet=new Set((process.env.PRODUCT_ORIGINS||'').split(',').map(x=>x.trim().replace(/\/$/,'')).filter(Boolean));
 const productAccess=(c,p)=>{
   const origin=c.req.header('origin');
   const secret=c.req.header('x-product-key')||'';
   if(secret && /^ph_live_[A-Za-z0-9_-]{30,100}$/.test(secret) && p.integration_key_hash && sha256(secret)===p.integration_key_hash)return;
   if(!origin || origin!==new URL(p.website_url).origin || !originSet.has(origin))throw fail('Checkout origin not authorized for this product',403);
 };
 async function requireMachine(c,next){await productIntegration(c,next);}
 async function getStatusOrder(c){
   const id=c.req.param('id');if(!z.string().uuid().safeParse(id).success)throw fail('Invalid order',404);
   const q=await pool.query('select * from public.payment_orders where id=$1',[id]);
   const order=q.rows[0];if(!order)throw fail('Order not found',404);
   const token=c.req.header('x-order-token')||'';
   if(!checkToken(order,token)){
     const secret=c.req.header('x-product-key')||'';
     if(!secret)throw fail('Order authorization required',401);
     const p=await pool.query('select integration_key_hash from public.products where id=$1',[order.product_id]);
     if(!p.rows[0]?.integration_key_hash || sha256(secret)!==p.rows[0].integration_key_hash)throw fail('Order authorization required',401);
   }
   return order;
 }
 async function settle(order){
   if(order.status==='paid')return {status:'paid',order_id:order.id,already_paid:true};
   const charge=await ready().verify(order.provider_reference);
   if(charge.status!=='success')return {status:'pending',order_id:order.id};
   const mismatch=validateVerifiedCharge(order,charge);
   if(mismatch.length){
     await pool.query("update public.payment_orders set status='review',failure_reason=$2,updated_at=now() where id=$1 and status<>'paid'",[order.id,mismatch.join('; ')]);
     throw fail('Payment needs manual verification. No sale recorded.',409);
   }
   if(order.provider_mode==='test'){
     // Test transactions NEVER enter the live sales/commission/payout ledger.
     let partnerId=null,rate=null,commission=null;
     if(order.click_id && order.referral_code){
       const r=await pool.query(`select rc.partner_id,rc.commission_bps from public.referral_clicks rc
         join public.affiliate_links al on al.id=rc.affiliate_link_id
         where rc.id=$1 and rc.product_id=$2 and al.code=$3 and rc.clicked_at <= $4 and rc.expires_at >= $4`,
         [order.click_id,order.product_id,order.referral_code,order.created_at]);
       if(r.rows[0]){partnerId=r.rows[0].partner_id;rate=r.rows[0].commission_bps;commission=Math.round(Number(order.eligible_cents)*rate/10000);}
     }
     await pool.query(`update public.payment_orders set status='paid',paid_at=$2,updated_at=now(),failure_reason=null,
       test_partner_id=$3,test_commission_cents=$4,test_rate_bps=$5 where id=$1 and status<>'paid'`,
       [order.id,charge.paid_at||new Date().toISOString(),partnerId,commission,rate]);
     await pool.query('insert into public.payment_fulfillments(order_id) values($1) on conflict(order_id) do nothing',[order.id]);
     return {status:'paid',order_id:order.id,test_mode:true};
   }
   const p=await pool.query('select * from public.products where id=$1',[order.product_id]);
   if(!p.rows[0])throw fail('Product unavailable for settlement',409);
   const result=await recordVerifiedPayment(pool,p.rows[0],{
      type:'payment.succeeded',provider:'paystack',external_transaction_id:order.provider_reference,
      kind:'initial',gross_cents:Number(order.amount_cents),eligible_cents:Number(order.eligible_cents),
      currency:order.currency,referral_code:order.referral_code||null,click_id:order.click_id||null,
      occurred_at:charge.paid_at||new Date().toISOString()
   },`paystack:${mode}`);
   // Idempotent recovery: a sale may have committed just before a worker crashed.
   let saleId=result.sale_id;
   if(!saleId){const q=await pool.query('select id from public.sales where product_id=$1 and provider=$2 and external_transaction_id=$3',[order.product_id,'paystack',order.provider_reference]);saleId=q.rows[0]?.id||null;}
   await pool.query(`update public.payment_orders set status='paid',sale_id=$2,paid_at=$3,updated_at=now(),failure_reason=null where id=$1 and status<>'paid'`,[order.id,saleId,charge.paid_at||new Date().toISOString()]);
   await pool.query('insert into public.payment_fulfillments(order_id) values($1) on conflict(order_id) do nothing',[order.id]);
   return {status:'paid',order_id:order.id,already_paid:!!result.duplicate};
 }
 async function reconcile(max=15){
   const statuses={processed:0,review:0,pending:0};
   const events=await pool.query("select * from public.payment_webhook_events where status='pending' order by received_at limit $1",[max]);
   for(const ev of events.rows){
     try{
       if(ev.event_type!=='charge.success' || !ev.provider_reference){
         await pool.query("update public.payment_webhook_events set status='review',processed_at=now(),last_error='Event requires manual review' where id=$1",[ev.id]);statuses.review++;continue;
       }
       const q=await pool.query('select * from public.payment_orders where provider_reference=$1 and provider_mode=$2',[ev.provider_reference,mode]);
       if(!q.rows[0]){
         await pool.query("update public.payment_webhook_events set status='review',processed_at=now(),last_error='Unknown reference: check pre-migration product webhooks' where id=$1",[ev.id]);statuses.review++;continue;
       }
       const outcome=await settle(q.rows[0]);
       if(outcome.status==='paid'){
         await pool.query("update public.payment_webhook_events set status='processed',processed_at=now(),last_error=null,attempts=attempts+1 where id=$1",[ev.id]);statuses.processed++;
       } else {
         await pool.query('update public.payment_webhook_events set attempts=attempts+1 where id=$1',[ev.id]);statuses.pending++;
       }
     }catch(e){
       const newStatus=e.status===409?'review':'pending';
       await pool.query('update public.payment_webhook_events set status=$2,last_error=$3,attempts=attempts+1 where id=$1',[ev.id,newStatus,errText(e)]);
       statuses[newStatus]++;
     }
   }
   const orders=await pool.query("select * from public.payment_orders where status='pending' and checkout_url is not null and created_at > now() - interval '7 days' order by created_at limit $1",[max]);
   for(const o of orders.rows){try{const x=await settle(o);if(x.status==='paid')statuses.processed++;}catch(e){console.error('[PAYMENT RECONCILE]',o.id,errText(e));}}
   return statuses;
 }

 let draining=false;
 async function drain(){if(draining||!paystack)return;draining=true;try{await reconcile(10);}finally{draining=false;}}
 // The durable inbox survives process restarts. For a sleeping service use a scheduled
 // authenticated call to /api/v2/cron/payments in addition to this background sweep.
 const sweep=setInterval(()=>drain().catch(e=>console.error('[PAYMENT SWEEP]',errText(e))),60_000);
 sweep.unref?.();
 app.get('/api/v2/payments/health',async c=>c.json({configured:!!paystack,mode,live_enabled:mode==='live'&&process.env.PAYMENTS_LIVE_ENABLED==='true'}));
 app.post('/api/v2/checkout/start',async c=>{
   ready();const input=startSchema.parse(await c.req.json());
   throttle((c.req.header('cf-connecting-ip')||c.req.header('x-forwarded-for')||'unknown').split(',')[0]);
   const pq=await pool.query(`select p.*,o.id as offer_id,o.amount_cents,o.eligible_cents,o.currency as offer_currency
     from public.products p join public.payment_offers o on o.product_id=p.id
     where p.id=$1 and o.code=$2 and p.active=true and p.payment_enabled=true and o.active=true`,[input.product_id,input.offer_code]);
   const product=pq.rows[0];if(!product)throw fail('Offer unavailable',404);
   productAccess(c,product);
   if(product.currency!==product.offer_currency)throw fail('Offer currency mismatch',422);
   if(product.commission_mode==='recurring')throw fail('Recurring products require the separate Paystack subscription integration; checkout is disabled for this product',422);
   const callback=validReturnUrl(product);
   let clickId=null,refCode=null;
   if(input.click_id && input.referral_code){
     const ref=await pool.query(`select rc.id from public.referral_clicks rc join public.affiliate_links al on al.id=rc.affiliate_link_id
       join public.partner_profiles pp on pp.user_id=rc.partner_id
       where rc.id=$1 and rc.product_id=$2 and al.code=$3 and rc.expires_at>=now() and pp.status='active'`,[input.click_id,product.id,input.referral_code]);
     if(ref.rows[0]){clickId=ref.rows[0].id;refCode=input.referral_code;}
   }
   const id=crypto.randomUUID(),reference=safeRef(),token=crypto.randomBytes(32).toString('base64url');
   callback.searchParams.set('ph_order',id);
   const customerEmail=input.email.toLowerCase();
   await pool.query(`insert into public.payment_orders(id,product_id,offer_id,customer_email,amount_cents,eligible_cents,currency,provider_mode,provider_reference,status_token_hash,referral_code,click_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,product.id,product.offer_id,customerEmail,product.amount_cents,product.eligible_cents,product.offer_currency,mode,reference,sha256(token),refCode,clickId]);
   let init;
   try{
     init=await ready().initialize({email:customerEmail,amount:Number(product.amount_cents),currency:product.offer_currency,reference,callback_url:callback.toString(),metadata:{partner_hub_order:id,partner_hub_product:product.id}});
     if(init.reference!==reference || !/^https:\/\/checkout\.paystack\.com\//.test(init.authorization_url||''))throw fail('Invalid Paystack checkout response',502);
   }catch(e){await pool.query("update public.payment_orders set status='cancelled',failure_reason=$2,updated_at=now() where id=$1",[id,errText(e)]);throw e;}
   await pool.query('update public.payment_orders set checkout_url=$2,updated_at=now() where id=$1',[id,init.authorization_url]);
   return c.json({order_id:id,order_token:token,authorization_url:init.authorization_url,amount_cents:Number(product.amount_cents),currency:product.offer_currency,status:'pending'},201);
 });
 app.get('/api/v2/checkout/:id/status',async c=>{
   const o=await getStatusOrder(c);
   c.header('Cache-Control','no-store');return c.json({order_id:o.id,status:o.status,paid:o.status==='paid',fulfillment_status:o.status==='paid'?(await pool.query('select status from public.payment_fulfillments where order_id=$1',[o.id])).rows[0]?.status||'pending':null});
 });
 app.post('/api/v2/checkout/:id/verify',async c=>{
   throttle((c.req.header('cf-connecting-ip')||c.req.header('x-forwarded-for')||'unknown').split(',')[0]);
   const o=await getStatusOrder(c);
   if(o.status==='cancelled'||o.status==='review')throw fail('Order unavailable for automatic verification',409);
   const status=await settle(o);
   return c.json(status);
 });
 app.post('/api/v2/paystack/webhook',async c=>{
   ready();const raw=await c.req.text();if(raw.length>100_000)throw fail('Webhook too large',413);
   if(!signatureValid(raw,c.req.header('x-paystack-signature'),key))throw fail('Invalid Paystack signature',401);
   let payload;try{payload=JSON.parse(raw);}catch{throw fail('Invalid JSON',400);}
   const type=String(payload.event||'').slice(0,80);
   const ref=payload?.data?.reference||payload?.data?.transaction?.reference||null;
   await pool.query(`insert into public.payment_webhook_events(event_hash,event_type,provider_reference,status)
     values($1,$2,$3,'pending') on conflict(event_hash) do nothing`,[sha256(raw),type,ref]);
   // Persist before acknowledging. Fast background drain; durable polling backs up failed/restarted workers.
   queueMicrotask(()=>drain().catch(e=>console.error('[WEBHOOK DRAIN]',errText(e))));
   c.header('Cache-Control','no-store');return c.json({received:true});
 });
 app.post('/api/v2/cron/payments',async c=>{
   const got=c.req.header('x-cron-secret');if(!got || !process.env.CRON_SECRET || got!==process.env.CRON_SECRET)throw fail('Forbidden',403);
   ready();return c.json({ok:true,...await reconcile(25)});
 });
 app.get('/api/v2/integrations/orders',productIntegration,async c=>{
   const product=c.get('product');const rows=await pool.query(`select po.id,po.provider_reference,po.customer_email,po.amount_cents,po.currency,po.paid_at,po.created_at,
     pf.status as fulfillment_status,o.code as offer_code
     from public.payment_orders po join public.payment_offers o on o.id=po.offer_id
     join public.payment_fulfillments pf on pf.order_id=po.id
     where po.product_id=$1 and po.status='paid' and pf.status='pending' order by po.paid_at limit 100`,[product.id]);
   return c.json({orders:rows.rows});
 });
 app.post('/api/v2/integrations/orders/:id/fulfilled',productIntegration,async c=>{
   const product=c.get('product');const id=c.req.param('id');
   const body=z.object({fulfillment_reference:z.string().min(2).max(180)}).parse(await c.req.json());
   const q=await pool.query(`update public.payment_fulfillments pf set status='fulfilled',fulfillment_reference=$3,fulfilled_at=now(),updated_at=now()
    from public.payment_orders po where pf.order_id=po.id and po.id=$1 and po.product_id=$2 and po.status='paid'
    and (pf.status='pending' or (pf.status='fulfilled' and pf.fulfillment_reference=$3)) returning pf.status`,[id,product.id,body.fulfillment_reference]);
   if(!q.rows[0])throw fail('Order unavailable or fulfilled with different reference',409);
   return c.json({ok:true,status:'fulfilled'});
 });
 // New offers are NOT automatically turned on. Admin intentionally activates them after testing.
 app.get('/api/admin/payment-offers',requireUser,requireAdmin,async c=>{
   const q=await pool.query(`select o.*,p.name as product_name from public.payment_offers o join public.products p on p.id=o.product_id order by o.created_at desc limit 400`);
   return c.json({offers:q.rows});
 });
 app.post('/api/admin/payment-offers',requireUser,requireAdmin,async c=>{
   const data=offerSchema.extend({product_id:z.string().uuid()}).parse(await c.req.json());
   const p=await pool.query('select id,currency from public.products where id=$1',[data.product_id]);if(!p.rows[0])throw fail('Unknown product',404);
   const q=await pool.query(`insert into public.payment_offers(product_id,code,title,amount_cents,eligible_cents,currency,active)
    values($1,$2,$3,$4,$5,$6,$7) returning *`,[data.product_id,data.code,data.title,data.amount_cents,data.eligible_cents,p.rows[0].currency,data.active]);
   return c.json({offer:q.rows[0]},201);
 });
 app.patch('/api/admin/payment-offers/:id',requireUser,requireAdmin,async c=>{
   const id=c.req.param('id');const row=(await pool.query('select * from public.payment_offers where id=$1',[id])).rows[0];if(!row)throw fail('Offer not found',404);
   const body=await c.req.json();if(!Object.keys(body).length||Object.keys(body).some(k=>!['title','amount_cents','eligible_cents','active'].includes(k)))throw fail('Invalid offer fields',422);
   const d=offerSchema.parse({...row,...body});
   const q=await pool.query(`update public.payment_offers set title=$2,amount_cents=$3,eligible_cents=$4,active=$5,updated_at=now() where id=$1 returning *`,[id,d.title,d.amount_cents,d.eligible_cents,d.active]);
   return c.json({offer:q.rows[0]});
 });
 app.get('/api/admin/payment-orders',requireUser,requireAdmin,async c=>{
   const [orders,events]=await Promise.all([
    pool.query(`select po.id,po.provider_reference,po.provider_mode,po.amount_cents,po.currency,po.status,po.created_at,po.paid_at,po.failure_reason,po.test_commission_cents,po.test_rate_bps,p.name as product_name,o.title as offer_title,pf.status as fulfillment_status
      from public.payment_orders po join public.products p on p.id=po.product_id join public.payment_offers o on o.id=po.offer_id
      left join public.payment_fulfillments pf on pf.order_id=po.id order by po.created_at desc limit 150`),
    pool.query("select id,event_type,provider_reference,status,last_error,received_at from public.payment_webhook_events where status='review' order by received_at desc limit 50")]);
   return c.json({orders:orders.rows,review_events:events.rows,paystack:{configured:!!paystack,mode}});
 });
 app.post('/api/admin/payment-reconcile',requireUser,requireAdmin,async c=>{ready();return c.json({ok:true,...await reconcile(25)});});
}
