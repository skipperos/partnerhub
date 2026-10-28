import React,{useEffect,useState} from 'react';
import {CreditCard,RefreshCw,Plus,ShieldCheck,AlertTriangle} from 'lucide-react';

const zar=(c,currency='ZAR')=>new Intl.NumberFormat('en-ZA',{style:'currency',currency}).format(Number(c||0)/100);
export default function PaymentsAdmin({products,request,notify}) {
 const [data,setData]=useState({orders:[],review_events:[],paystack:null});
 const [offers,setOffers]=useState([]);
 const [error,setError]=useState(''),[loading,setLoading]=useState(false);
 const [offer,setOffer]=useState({product_id:'',code:'',title:'',amount_cents:0,eligible_cents:0,active:false});
 const load=async()=>{
   setLoading(true);try{const [payments,off]=await Promise.all([request('/api/admin/payment-orders'),request('/api/admin/payment-offers')]);setData(payments);setOffers(off.offers||[]);setError('');}
   catch(e){setError(e.message)}finally{setLoading(false)}
 };
 useEffect(()=>{load()},[]);
 const create=async e=>{e.preventDefault();try{
   await request('/api/admin/payment-offers',{method:'POST',body:JSON.stringify({...offer,amount_cents:Number(offer.amount_cents),eligible_cents:Number(offer.eligible_cents)})});
   notify('Offer created, disabled by default unless you activated it');setOffer({product_id:'',code:'',title:'',amount_cents:0,eligible_cents:0,active:false});await load();
 }catch(ex){setError(ex.message)}};
 const toggle=async o=>{try{await request(`/api/admin/payment-offers/${o.id}`,{method:'PATCH',body:JSON.stringify({active:!o.active})});await load()}catch(ex){setError(ex.message)}};
 const reconcile=async()=>{try{const r=await request('/api/admin/payment-reconcile',{method:'POST'});notify(`Reconciliation completed: ${r.processed} processed, ${r.review} flagged`);await load()}catch(ex){setError(ex.message)}};
 return <>
   <div className="page-heading"><div><div className="eyebrow">PAYMENT ENGINE V2</div><h1>Paystack payments</h1><p>Configure fixed-price offers, monitor payments and reconcile verified transactions.</p></div>
      <div className="heading-actions"><button className="small-action" onClick={load} disabled={loading}><RefreshCw size={16}/> Refresh</button><button className="small-action" onClick={reconcile} disabled={loading}>Reconcile</button></div></div>
   {error&&<div className="banner error">{error}</div>}
   <div className="panel" style={{padding:18,marginBottom:18}}><div className="panel-heading"><h2><ShieldCheck size={18}/> Paystack environment</h2></div>
     <p><strong>Configuration:</strong> {data.paystack?.configured?'API key loaded':'API key not configured'} · <strong>Mode:</strong> {data.paystack?.mode||'unknown'}</p>
     <p className="subtle">Credentials remain on Render. The engine does not change your existing Paystack webhook settings automatically. Test one website before switching your live webhook URL.</p>
     <p className="subtle">Automatic Paystack subscription renewals and partial refunds require separate integration and validation; do not activate recurring checkout offers here yet.</p>
   </div>
   <div className="panel" style={{padding:18,marginBottom:18}}><div className="panel-heading"><h2><Plus size={18}/> Create checkout offer</h2></div>
     <form className="editor-form" onSubmit={create}>
       <div className="form-grid">
         <label>Product<select value={offer.product_id} required onChange={e=>setOffer(s=>({...s,product_id:e.target.value}))}><option value="">Choose product</option>{products.map(p=><option key={p.id} value={p.id}>{p.name} ({p.currency})</option>)}</select></label>
         <label>Offer code<input required pattern="(?:[a-z0-9]|-)+" minLength={2} value={offer.code} placeholder="starter-pack" onChange={e=>setOffer(s=>({...s,code:e.target.value}))}/></label>
       </div>
       <label>Offer name<input required value={offer.title} onChange={e=>setOffer(s=>({...s,title:e.target.value}))} placeholder="Starter pack"/></label>
       <div className="form-grid">
         <label>Price (in cents)<input required min={1} type="number" step={1} value={offer.amount_cents} onChange={e=>setOffer(s=>({...s,amount_cents:e.target.value,eligible_cents:e.target.value}))}/></label>
         <label>Commission-eligible amount (cents)<input required min={0} type="number" step={1} value={offer.eligible_cents} onChange={e=>setOffer(s=>({...s,eligible_cents:e.target.value}))}/></label>
       </div>
       <label className="checkboxline"><input type="checkbox" checked={offer.active} onChange={e=>setOffer(s=>({...s,active:e.target.checked}))}/>Activate this offer for checkout</label>
       <p className="form-note">Example: R199.00 = 19900 cents. Product checkout must also be enabled separately. Prices are always enforced server-side.</p>
       <button className="small-action" type="submit">Create offer</button>
     </form>
   </div>
   <section className="panel table-panel" style={{marginBottom:18}}><div className="panel-heading"><h2>Offers</h2></div>
     <div className="table-wrap"><table><thead><tr><th>Product</th><th>Code</th><th>Amount</th><th>Eligible</th><th>Active</th><th>Action</th></tr></thead><tbody>{offers.map(o=><tr key={o.id}><td>{o.product_name}</td><td><code>{o.code}</code></td><td>{zar(o.amount_cents,o.currency)}</td><td>{zar(o.eligible_cents,o.currency)}</td><td>{o.active?'Yes':'No'}</td><td><button className="small-action" onClick={()=>toggle(o)}>{o.active?'Pause':'Activate'}</button></td></tr>)}</tbody></table></div>
   </section>
   <section className="panel table-panel" style={{marginBottom:18}}><div className="panel-heading"><h2><CreditCard size={18}/> Payment orders</h2></div>
     <div className="table-wrap"><table><thead><tr><th>Order</th><th>Product / offer</th><th>Amount</th><th>Mode</th><th>Payment</th><th>Fulfillment</th><th>Created</th></tr></thead><tbody>{data.orders.map(o=><tr key={o.id}><td><code title={o.provider_reference}>{o.id.slice(0,8)}</code></td><td>{o.product_name} / {o.offer_title}</td><td>{zar(o.amount_cents,o.currency)}</td><td>{o.provider_mode}</td><td>{o.status}</td><td>{o.fulfillment_status||'—'}</td><td>{new Date(o.created_at).toLocaleDateString('en-ZA')}</td></tr>)}</tbody></table></div>
     {!data.orders.length&&<p className="subtle" style={{padding:18}}>No checkout orders yet. Test transactions will appear here.</p>}
   </section>
   <section className="panel table-panel"><div className="panel-heading"><h2><AlertTriangle size={18}/> Events requiring review</h2></div>
     {!data.review_events.length?<p className="subtle" style={{padding:18}}>No flagged events.</p>:<div className="table-wrap"><table><thead><tr><th>Event</th><th>Reference</th><th>Reason</th></tr></thead><tbody>{data.review_events.map(e=><tr key={e.id}><td>{e.event_type}</td><td>{e.provider_reference||'—'}</td><td>{e.last_error||'Manual review required'}</td></tr>)}</tbody></table></div>}
   </section>
 </>;
}
