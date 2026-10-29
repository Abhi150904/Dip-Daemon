import test from 'node:test';
import assert from 'node:assert/strict';
import {money, number, escapeHtml, time, riskStatus} from '../web/format.js';

test('dashboard money distinguishes unavailable marks from zero and converts paise exactly once', () => {
  assert.equal(money(null), '—');
  assert.equal(money(undefined), '—');
  assert.equal(money(NaN), '—');
  assert.equal(money('100'), '—');
  assert.equal(money(0), '₹0.00');
  assert.equal(money(1000000), '₹10,000.00');
  assert.equal(money(-361, true), '-₹3.61');
  assert.equal(money(361, true), '+₹3.61');
  assert.equal(number(null), '—');
});

test('server-provided text cannot inject HTML into dashboard tables', () => {
  assert.equal(escapeHtml('<img src="x" onerror=\'alert(1)\'>&'), '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;');
  assert.equal(escapeHtml(null), '');
  assert.equal(time(null), '—');
  assert.match(time(Date.parse('2026-10-26T04:15:00Z')), /09:45:00/);
});

test('risk text never describes an absent account or stale valuation as within limits', () => {
  assert.equal(riskStatus(null), 'Paper account unavailable');
  assert.equal(riskStatus(undefined), 'Paper account unavailable');
  assert.equal(riskStatus({killed: false, halted: false, stalePrices: true}), 'Valuation stale');
  assert.equal(riskStatus({killed: true}), 'Emergency stop active');
  assert.equal(riskStatus({halted: true}), 'Daily loss halt');
  assert.equal(riskStatus({killed: false, halted: false, stalePrices: false}), 'Within limits');
});
