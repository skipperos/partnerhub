import test from 'node:test';
import assert from 'node:assert/strict';
import {commissionAmount, withinCommissionDuration} from '../server/src/math.js';

test('commission uses integer minor units and basis points',()=>{
 assert.equal(commissionAmount(50000,3000),15000);
 assert.equal(commissionAmount(30000,2500),7500);
 assert.equal(commissionAmount(101,5000),51);
 assert.equal(commissionAmount(0,3500),0);
});
test('time-bounded recurring commissions preserve month-end dates',()=>{
 assert.equal(withinCommissionDuration('2026-01-31T10:00:00.000Z','2026-02-27T10:00:00.000Z',1),true);
 assert.equal(withinCommissionDuration('2026-01-31T10:00:00.000Z','2026-02-28T10:00:00.000Z',1),false);
 assert.equal(withinCommissionDuration('2026-01-31T10:00:00.000Z','2029-01-01T00:00:00.000Z',null),true);
});
