import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentSchema} from '../server/src/finance.js';

test('payment events reject invalid currency and impossible eligible totals',()=>{
 const sample={type:'payment.succeeded',provider:'paystack',external_transaction_id:'demo123',gross_cents:1000,eligible_cents:2000,currency:'ZAR'};
 assert.equal(paymentSchema.safeParse(sample).success,false);
 assert.equal(paymentSchema.safeParse({...sample,eligible_cents:900,currency:'INVALID'}).success,false);
 assert.equal(paymentSchema.safeParse({...sample,eligible_cents:900}).success,true);
});
