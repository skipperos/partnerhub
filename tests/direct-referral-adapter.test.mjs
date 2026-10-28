import test from 'node:test';
import assert from 'node:assert/strict';
import {captureReferralOnLanding,getReferralForCheckout} from '../integrations/v3/direct-referrals.js';
const id='94b1877f-5910-432f-a495-737e464bb04e';
const click='d905df93-07c8-470b-8f3b-97126f903cad';
const code='9vlM3Q1IRPScHJ5ZZX0';
function setup(url){
 const original={window:globalThis.window,localStorage:globalThis.localStorage,sessionStorage:globalThis.sessionStorage,fetch:globalThis.fetch};
 function makeStore(){const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)}}
 globalThis.window={location:{href:url}};
 globalThis.localStorage=makeStore();globalThis.sessionStorage=makeStore();
 return ()=>{for(const [k,v] of Object.entries(original)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}};
}
test('direct product ref registers once and persists referral for checkout',async()=>{
 const restore=setup(`https://unpackmychat.com/?ph_ref=${code}`);let calls=0;
 globalThis.fetch=async(url,config)=>{calls++;assert.equal(url,'https://hub.test/api/v2/referrals/visit');assert.equal(JSON.parse(config.body).product_id,id);return {ok:true,status:201,json:async()=>({referral_code:code,click_id:click})}};
 try{
  const ref=await captureReferralOnLanding({apiBase:'https://hub.test',productId:id});
  assert.deepEqual(ref,{referral_code:code,click_id:click});
  assert.deepEqual(await getReferralForCheckout({apiBase:'https://hub.test',productId:id}),ref);
  assert.equal(calls,1);
 }finally{restore()}
});
test('legacy redirect ph_click persists without registering a duplicate',async()=>{
 const restore=setup(`https://unpackmychat.com/?ph_ref=${code}&ph_click=${click}`);
 globalThis.fetch=()=>{throw new Error('must not call server')};
 try{
  const ref=await captureReferralOnLanding({apiBase:'https://hub.test',productId:id});
  assert.deepEqual(ref,{referral_code:code,click_id:click});
 }finally{restore()}
});
