import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAffiliateLinks,registerDirectVisit} from '../server/src/referral-links.js';

const product={website_url:'https://unpackmychat.com/start?mode=preview',direct_links_enabled:true};
const code='9vlM3Q1IRPScHJ5ZZX0';
const api='https://partnerhub-backend-hurg.onrender.com';
test('direct product link uses real domain, keeps original query, and adds partner code',()=>{
 const p=buildAffiliateLinks(product,code,api);
 assert.equal(p.url,`https://unpackmychat.com/start?mode=preview&ph_ref=${code}`);
 assert.equal(p.legacy_url,`${api}/r/${code}`);
 assert.equal(new URL(p.url).host,'unpackmychat.com');
});
test('legacy redirect is default until product integration explicitly enabled',()=>{
 const p=buildAffiliateLinks({...product,direct_links_enabled:false},code,api);
 assert.equal(p.url,`${api}/r/${code}`);
});
test('direct link removes stale ph_click from website_url',()=>{
 const p=buildAffiliateLinks({website_url:'https://site.example/?ph_click=old',direct_links_enabled:true},code,api);
 assert.equal(new URL(p.url).searchParams.has('ph_click'),false);
});
const row={affiliate_link_id:'a',partner_id:'b',product_id:'c',website_url:'https://unpackmychat.com/',active:true,partner_status:'active',commission_bps:3000,commission_mode:'one_time',recurring_months:null,hold_days:14,referral_days:30};
function fakePool(record=row){
 const seen=[];
 return {seen,async query(sql,values){seen.push({sql,values});
   return sql.includes('select al.id')?{rows:record?[record]:[]}:{rows:[{id:values[0],expires_at:'2026-11-28T00:00:00Z'}]};
 }};
}
test('trusted product can create a click with rate snapshot',async()=>{
 const db=fakePool();const v=await registerDirectVisit(db,{product_id:'c',referral_code:code,origin:'https://unpackmychat.com',allowedOrigins:new Set(['https://unpackmychat.com'])});
 assert.equal(v.referral_code,code);assert.match(v.click_id,/^[0-9a-f-]{36}$/);
 assert.equal(db.seen.length,2);assert.equal(db.seen[1].values[4],3000);
});
test('wrong origin cannot create a click',async()=>{
 const db=fakePool();await assert.rejects(registerDirectVisit(db,{product_id:'c',referral_code:code,origin:'https://attacker.example',allowedOrigins:new Set(['https://unpackmychat.com'])}),{status:403});
 assert.equal(db.seen.length,1);
});
test('inactive affiliate cannot create a click',async()=>{
 const db=fakePool({...row,partner_status:'suspended'});
 await assert.rejects(registerDirectVisit(db,{product_id:'c',referral_code:code,origin:'https://unpackmychat.com',allowedOrigins:new Set(['https://unpackmychat.com'])}),{status:404});
 assert.equal(db.seen.length,1);
});
