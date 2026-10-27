// Example server-side integration; keep PH_PRODUCT_KEY in your backend's environment.
// Poll the central API and deliver products exactly once. NEVER implement this in browser code.
const API=process.env.PARTNER_HUB_API;
const PRODUCT_KEY=process.env.PH_PRODUCT_KEY;
if(!API||!PRODUCT_KEY)throw new Error('Set PARTNER_HUB_API and PH_PRODUCT_KEY');
async function hub(path,options={}){
 const res=await fetch(API+path,{...options,headers:{'x-product-key':PRODUCT_KEY,'Content-Type':'application/json'}});
 const data=await res.json();if(!res.ok)throw new Error(data.error||'Partner Hub API error');return data;
}
async function deliverOrderIdempotently(order){
 // YOUR product backend MUST store order.id as a UNIQUE fulfillment key.
 // Deliver the paid offer here only if your product has not delivered this ID before.
 // Include support for any retries/crashes; return a stable delivery reference.
 throw new Error('IMPLEMENT product-specific delivery using your own persistent database');
}
export async function processFulfillments(){
 const {orders}=await hub('/api/v2/integrations/orders');
 for(const order of orders){
   const deliveryReference=await deliverOrderIdempotently(order);
   await hub(`/api/v2/integrations/orders/${order.id}/fulfilled`,{method:'POST',body:JSON.stringify({fulfillment_reference:deliveryReference})});
 }
}
