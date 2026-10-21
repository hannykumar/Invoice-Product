/**
 * Issue #289, part 2 — the reverse-charge table and its questions, on their own.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { citeReverseChargeEntry, reverseChargeDecisionFor } from '../src/reverse-charge-notified.ts';

const unregistered = { registered: false, agriculturist: false };
const registered = { registered: true, agriculturist: false };

test('metal scrap is reverse charge only from 10 October 2024 (Notification 06/2024-CT(R))', () => {
  assert.equal(reverseChargeDecisionFor({ hsnSac: '74040010', on: '2024-10-09', supplier: unregistered, recipientIsComposition: false }).kind, 'NONE');
  const after = reverseChargeDecisionFor({ hsnSac: '74040010', on: '2024-10-10', supplier: unregistered, recipientIsComposition: false });
  assert.equal(after.kind, 'REVERSE_CHARGE');
  assert.equal(reverseChargeDecisionFor({ hsnSac: '74040010', on: '2026-08-01', supplier: registered, recipientIsComposition: false }).kind, 'NONE', 'from a registered seller the seller charges it');
});

test('GTA: the forward-charge question is asked only of a transporter with a GST number', () => {
  const answers = { gta_consignment_note: true, gta_exempt: false };
  const fromUnregistered = reverseChargeDecisionFor({ hsnSac: '996791', on: '2026-08-01', supplier: unregistered, recipientIsComposition: false, answers });
  assert.equal(fromUnregistered.kind, 'REVERSE_CHARGE');
  const fromRegistered = reverseChargeDecisionFor({ hsnSac: '996791', on: '2026-08-01', supplier: registered, recipientIsComposition: false, answers });
  assert.equal(fromRegistered.kind, 'ASK');
  assert.equal(fromRegistered.kind === 'ASK' ? fromRegistered.ask.id : '', 'gta_forward_charge');
  if (fromUnregistered.kind === 'REVERSE_CHARGE') {
    assert.equal(fromUnregistered.entry.rate?.basisPoints, 500);
    assert.equal(citeReverseChargeEntry(fromUnregistered.entry).match(/S\.No\./g)?.length, 1, 'cited once');
  }
});

test('an exempt answer settles it with the exemption named', () => {
  const exempt = reverseChargeDecisionFor({ hsnSac: '996511', on: '2026-08-01', supplier: registered, recipientIsComposition: false, answers: { gta_consignment_note: true, gta_exempt: true } });
  assert.equal(exempt.kind, 'EXEMPT');
  assert.match(exempt.kind === 'EXEMPT' ? exempt.because : '', /12\/2017-CT\(R\), S\.No\. 21/);
});

test('rent of a shop from an unregistered landlord leaves out a composition recipient (5AB)', () => {
  assert.equal(reverseChargeDecisionFor({ hsnSac: '997212', on: '2026-08-01', supplier: unregistered, recipientIsComposition: false }).kind, 'REVERSE_CHARGE');
  assert.equal(reverseChargeDecisionFor({ hsnSac: '997212', on: '2026-08-01', supplier: unregistered, recipientIsComposition: true }).kind, 'NONE');
});
