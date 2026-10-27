import { z } from 'zod';
import { commissionAmount, withinCommissionDuration } from './math.js';
export { commissionAmount, withinCommissionDuration } from './math.js';

export const paymentSchema = z.object({
  type: z.literal('payment.succeeded'),
  provider: z.string().min(2).max(40),
  external_transaction_id: z.string().min(2).max(180),
  kind: z.enum(['initial', 'renewal']).default('initial'),
  external_subscription_id: z.string().max(180).nullable().optional(),
  gross_cents: z.number().int().nonnegative().safe(),
  eligible_cents: z.number().int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  referral_code: z.string().max(100).nullable().optional(),
  click_id: z.string().uuid().nullable().optional(),
  occurred_at: z.string().datetime({offset:true}).optional()
}).refine(v => v.eligible_cents <= v.gross_cents, 'Eligible amount exceeds gross amount');

export const refundSchema = z.object({
  type: z.literal('payment.refunded'),
  provider: z.string().min(2).max(40),
  external_transaction_id: z.string().min(2).max(180)
});

export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

export async function writeEvent(client, actor, action, entityType, entityId, detail={}) {
  await client.query('insert into public.finance_events(actor,action,entity_type,entity_id,detail) values($1,$2,$3,$4,$5)', [actor,action,entityType,entityId,JSON.stringify(detail)]);
}

export async function approveMatured(pool) {
  await pool.query("update public.commissions set status='approved',approved_at=now() where status='pending' and hold_until<=now()");
}

// Called with a PostgreSQL transaction already in progress.
export async function cancelDraftPayout(client, payoutId, actor) {
  const result = await client.query("select * from public.payouts where id=$1 for update",[payoutId]);
  const payout=result.rows[0];
  if (!payout || payout.status!=='draft') return false;
  const allocations = await client.query('select * from public.payout_debit_allocations where payout_id=$1',[payoutId]);
  for(const a of allocations.rows) {
    await client.query('update public.partner_debits set applied_cents=applied_cents-$1 where id=$2',[a.amount_cents,a.debit_id]);
  }
  await client.query('delete from public.payout_debit_allocations where payout_id=$1',[payoutId]);
  await client.query("update public.commissions set payout_id=null where payout_id=$1 and status='approved'",[payoutId]);
  await client.query("update public.payouts set status='cancelled' where id=$1",[payoutId]);
  await writeEvent(client,actor,'payout.cancelled','payout',payoutId);
  return true;
}

export async function recordVerifiedPayment(pool, product, input, actor='integration') {
  const data = paymentSchema.parse(input);
  if(data.currency !== product.currency) throw Object.assign(new Error('Currency does not match product'), {status:422});
  const occurred = data.occurred_at ? new Date(data.occurred_at) : new Date();
  if (!Number.isFinite(occurred.valueOf())) throw Object.assign(new Error('Bad transaction timestamp'),{status:422});
  // Reject improbable dates from mistaken webhook adapters.
  if (occurred > new Date(Date.now()+5*60_000) || occurred < new Date('2020-01-01')) throw Object.assign(new Error('Transaction timestamp out of range'),{status:422});
  return withTx(pool, async c=>{
    const existing=await c.query('select id,gross_cents,eligible_cents,currency,kind from public.sales where product_id=$1 and provider=$2 and external_transaction_id=$3',[product.id,data.provider,data.external_transaction_id]);
    if(existing.rows.length) {
      const old=existing.rows[0];
      if(Number(old.gross_cents)!==data.gross_cents || Number(old.eligible_cents)!==data.eligible_cents || old.currency!==data.currency || old.kind!==data.kind) throw Object.assign(new Error('Transaction ID reused with differing values'),{status:409});
      return {ok:true,duplicate:true,sale_id:old.id};
    }
    if(data.kind==='initial' && data.external_subscription_id) {
      // Serialize first-charge events for the same subscription across concurrent requests.
      await c.query('select pg_advisory_xact_lock(hashtext($1))',[`${product.id}:${data.external_subscription_id}`]);
      const first=await c.query('select id from public.referred_subscriptions where product_id=$1 and external_subscription_id=$2',[product.id,data.external_subscription_id]);
      if(first.rows.length) throw Object.assign(new Error('Subscription already acquired; report subsequent charges as renewal'),{status:409});
    }
    let association=null;
    if(data.kind==='renewal' && data.external_subscription_id) {
      const sr=await c.query('select * from public.referred_subscriptions where product_id=$1 and external_subscription_id=$2',[product.id,data.external_subscription_id]);
      if(sr.rows[0] && product.currency===data.currency && withinCommissionDuration(sr.rows[0].started_at,occurred,sr.rows[0].recurring_months)) {
        association={...sr.rows[0],mode:'recurring'};
      }
    } else if (data.kind==='initial' && data.click_id && data.referral_code) {
      const r=await c.query(`select rc.*, al.code, pp.status as partner_status from public.referral_clicks rc
        join public.affiliate_links al on al.id=rc.affiliate_link_id
        join public.partner_profiles pp on pp.user_id=rc.partner_id
        where rc.id=$1 and rc.product_id=$2 and al.code=$3 and rc.clicked_at <= $4 and rc.expires_at >= $4`,
        [data.click_id,product.id,data.referral_code,occurred.toISOString()]);
      if(r.rows[0] && r.rows[0].partner_status==='active') {
        const click=r.rows[0];
        association={partner_id:click.partner_id,click_id:click.id,commission_bps:click.commission_bps,commission_mode:click.commission_mode,recurring_months:click.recurring_months,hold_days:click.hold_days,mode:click.commission_mode};
      }
    }
    const insert=await c.query(`insert into public.sales(product_id,provider,external_transaction_id,kind,external_subscription_id,gross_cents,eligible_cents,currency,partner_id,click_id,occurred_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(product_id,provider,external_transaction_id) do nothing returning id`,
      [product.id,data.provider,data.external_transaction_id,data.kind,data.external_subscription_id||null,data.gross_cents,data.eligible_cents,data.currency,association?.partner_id||null,association?.click_id||null,occurred.toISOString()]);
    if(!insert.rows[0]) return {ok:true,duplicate:true};
    const saleId=insert.rows[0].id;
    let commissionId=null;
    const allowed=association && (data.kind==='initial' || association.mode==='recurring');
    if(allowed && data.eligible_cents>0) {
      const amount=commissionAmount(data.eligible_cents,association.commission_bps);
      if(amount>0) {
        const cr=await c.query(`insert into public.commissions(sale_id,partner_id,product_id,amount_cents,rate_bps,currency,hold_until)
          values($1,$2,$3,$4,$5,$6,$7) returning id`,
          [saleId,association.partner_id,product.id,amount,association.commission_bps,data.currency,new Date(occurred.getTime()+association.hold_days*86400000).toISOString()]);
        commissionId=cr.rows[0].id;
        await writeEvent(c,actor,'commission.earned','commission',commissionId,{amount_cents:amount,rate_bps:association.commission_bps,sale_id:saleId});
      }
    }
    if(data.kind==='initial' && association?.mode==='recurring' && data.external_subscription_id) {
      await c.query(`insert into public.referred_subscriptions(product_id,external_subscription_id,partner_id,click_id,commission_bps,recurring_months,hold_days,started_at)
        values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(product_id,external_subscription_id) do nothing`,
        [product.id,data.external_subscription_id,association.partner_id,association.click_id,association.commission_bps,association.recurring_months,association.hold_days,occurred.toISOString()]);
    }
    await writeEvent(c,actor,'sale.recorded','sale',saleId,{gross_cents:data.gross_cents,eligible_cents:data.eligible_cents,attributed:!!association});
    return {ok:true,duplicate:false,sale_id:saleId,attributed:!!association,commission_id:commissionId};
  });
}

export async function recordVerifiedRefund(pool, product, input, actor='integration') {
  const data=refundSchema.parse(input);
  return withTx(pool,async c=>{
    const q=await c.query('select * from public.sales where product_id=$1 and provider=$2 and external_transaction_id=$3 for update',[product.id,data.provider,data.external_transaction_id]);
    const sale=q.rows[0];
    if(!sale) throw Object.assign(new Error('Original payment not found; retry once it is synced'),{status:404});
    if(sale.status==='refunded') return {ok:true,duplicate:true};
    const cm=await c.query('select * from public.commissions where sale_id=$1 for update',[sale.id]);
    const comm=cm.rows[0];
    if(comm?.payout_id) {
      const pq=await c.query('select status from public.payouts where id=$1',[comm.payout_id]);
      if(pq.rows[0]?.status==='draft') await cancelDraftPayout(c,comm.payout_id,actor);
      else if (pq.rows[0]?.status==='paid') {
        await c.query(`insert into public.partner_debits(commission_id,partner_id,currency,amount_cents) values($1,$2,$3,$4)
          on conflict(commission_id) do nothing`,[comm.id,comm.partner_id,comm.currency,comm.amount_cents]);
      }
    }
    await c.query("update public.sales set status='refunded',refunded_at=now() where id=$1",[sale.id]);
    if(comm) {
      await c.query("update public.commissions set status='reversed',reversed_at=now() where id=$1",[comm.id]);
      await writeEvent(c,actor,'commission.reversed','commission',comm.id,{sale_id:sale.id,amount_cents:comm.amount_cents});
    }
    await writeEvent(c,actor,'sale.refunded','sale',sale.id);
    return {ok:true,duplicate:false};
  });
}

export async function createPayout(pool,partnerId,currency,adminId) {
  return withTx(pool,async c=>{
    // Serializes concurrent payout creation for this partner.
    const pp=await c.query('select user_id,status from public.partner_profiles where user_id=$1 for update',[partnerId]);
    if(!pp.rows[0] || pp.rows[0].status!=='active') throw Object.assign(new Error('Partner is not active'),{status:422});
    const cr=await c.query("select id,amount_cents from public.commissions where partner_id=$1 and currency=$2 and status='approved' and payout_id is null order by created_at for update",[partnerId,currency]);
    if(!cr.rows.length) throw Object.assign(new Error('No approved commissions available'),{status:422});
    const gross=cr.rows.reduce((sum,r)=>sum+Number(r.amount_cents),0);
    const debts=await c.query('select * from public.partner_debits where partner_id=$1 and currency=$2 and applied_cents<amount_cents order by created_at for update',[partnerId,currency]);
    const outstanding=debts.rows.reduce((sum,d)=>sum+Number(d.amount_cents)-Number(d.applied_cents),0);
    const net=gross-outstanding;
    if(net<=0) throw Object.assign(new Error(`Outstanding refund adjustments (${currency} ${Math.round(outstanding/100)}) are at least as large as approved commissions; manual review needed`),{status:422});
    const r=await c.query("insert into public.payouts(partner_id,currency,amount_cents,created_by) values($1,$2,$3,$4) returning *",[partnerId,currency,net,adminId]);
    const payout=r.rows[0];
    await c.query('update public.commissions set payout_id=$1 where id=any($2::uuid[])',[payout.id,cr.rows.map(x=>x.id)]);
    let remaining=Math.min(outstanding,gross);
    for(const debit of debts.rows) {
      if(remaining<=0) break;
      const amount=Math.min(remaining,Number(debit.amount_cents)-Number(debit.applied_cents));
      await c.query('update public.partner_debits set applied_cents=applied_cents+$1 where id=$2',[amount,debit.id]);
      await c.query('insert into public.payout_debit_allocations(payout_id,debit_id,amount_cents) values($1,$2,$3)',[payout.id,debit.id,amount]);
      remaining-=amount;
    }
    await writeEvent(c,adminId,'payout.created','payout',payout.id,{gross_cents:gross,adjustment_cents:gross-net,net_cents:net});
    return payout;
  });
}
