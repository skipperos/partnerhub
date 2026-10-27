import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {signatureValid,enforcePaystackMode,validateVerifiedCharge,paystackClient} from '../server/src/paystack.js';
const secret='sk_test_1234567890123456';
const order={id:'11111111-1111-4111-8111-111111111111',product_id:'22222222-2222-4222-8222-222222222222',provider_reference:'PHabc',amount_cents:20000,currency:'ZAR',provider_mode:'test',customer_email:'test@example.com'};
const charge={status:'success',reference:'PHabc',amount:20000,currency:'ZAR',domain:'test',customer:{email:'test@example.com'},metadata:{partner_hub_order:order.id,partner_hub_product:order.product_id}};
test('webhook signature validates raw bytes; forged and malformed values fail',()=>{
 const raw=JSON.stringify({event:'charge.success',data:{reference:'PHabc'}});
 const sign=crypto.createHmac('sha512',secret).update(raw).digest('hex');
 assert.equal(signatureValid(raw,sign,secret),true);
 assert.equal(signatureValid(raw+' ',sign,secret),false);
 assert.equal(signatureValid(raw,'deadbeef',secret),false);
});
test('test and live keys cannot be confused; live needs opt-in',()=>{
 assert.doesNotThrow(()=>enforcePaystackMode('test',secret));
 assert.throws(()=>enforcePaystackMode('live',secret,true));
 assert.throws(()=>enforcePaystackMode('live','sk_live_example',false));
 assert.doesNotThrow(()=>enforcePaystackMode('live','sk_live_example',true));
});
test('reject changed amount, currency, environment, email and metadata',()=>{
 assert.deepEqual(validateVerifiedCharge(order,charge),[]);
 for(const [key,value] of [['amount',15000],['currency','USD'],['domain','live'],['reference','notPHabc']])assert.ok(validateVerifiedCharge(order,{...charge,[key]:value}).length>0);
 assert.ok(validateVerifiedCharge(order,{...charge,customer:{email:'other@example.com'}}).length>0);
 assert.ok(validateVerifiedCharge(order,{...charge,metadata:{partner_hub_order:'random'}}).length>0);
});
test('Paystack client sends authorization and reads verified transaction',async()=>{
 const calls=[];
 const mock=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({status:true,data:{status:'success',reference:'PHabc'}})}};
 const api=paystackClient(secret,{fetchImpl:mock});
 const a=await api.verify('PHabc');assert.equal(a.status,'success');
 const b=await api.initialize({email:'test@example.com',amount:20000,currency:'ZAR',reference:'PHabc',callback_url:'https://example.com/return',metadata:{partner_hub_order:order.id}});
 assert.ok(b);assert.match(calls[0].url,/\/transaction\/verify\/PHabc$/);
 assert.equal(calls[1].options.headers.Authorization,`Bearer ${secret}`);
 assert.equal(JSON.parse(calls[1].options.body).amount,'20000');
});
