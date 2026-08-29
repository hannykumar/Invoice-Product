/**
 * Issue #11 [E11] — the three acceptance criteria, and the cases that make them mean something.
 *
 *  1. The price source is visible.
 *  2. Credit counts what is outstanding **and** what is on unfinished bills.
 *  3. Overriding needs the right permission.
 *
 * The interesting tests are the ones about dates and about two people working at once, because
 * those are where a credit limit quietly stops working.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { DomainError } from '@invoice/kernel';
import { ABC, actorWith, inr, makeDesk, on } from './fixtures.ts';

const line = (over: Partial<{ lineId: string; itemId: string; itemName: string; unit: string; quantity: string; unitPrice: ReturnType<typeof inr> }> = {}) => ({
  lineId: 'l1',
  itemId: 'CRATE',
  itemName: 'Plastic crate',
  unit: 'PCS',
  quantity: '10',
  ...over,
});

test('the price this customer last agreed is suggested, and the bill it came from is named', async () => {
  const desk = makeDesk();
  desk.history.setAgreed([
    { partyId: ABC, itemId: 'CRATE', amount: inr(800), documentNumber: 'INV/2026-27/00007', on: on('2026-07-01') },
  ]);
  desk.parties.setLimit(inr(100000));

  const quote = await desk.service.quote(desk.actor, { partyId: ABC, documentDate: on('2026-08-29'), lines: [line()] });
  const price = quote.lines[0]?.price;

  assert.equal(price?.source, 'LAST_AGREED');
  assert.equal(price?.amount?.minor, inr(800).minor);
  assert.equal(price?.evidence.documentNumber, 'INV/2026-27/00007');
  assert.equal(price?.evidence.on, on('2026-07-01'));
  assert.match(price?.sentence['en-IN'] ?? '', /Last time you charged them ₹800\.00/);
  assert.match(price?.sentence['en-IN'] ?? '', /INV\/2026-27\/00007/);
});

test('a price agreed after the bill date is not evidence for that bill', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(100000));
  desk.history.setAgreed([
    { partyId: ABC, itemId: 'CRATE', amount: inr(800), documentNumber: 'INV-JUNE', on: on('2026-06-01') },
    { partyId: ABC, itemId: 'CRATE', amount: inr(950), documentNumber: 'INV-AUGUST', on: on('2026-08-20') },
  ]);

  // A bill written today sees the latest agreed price.
  const today = await desk.service.quote(desk.actor, { partyId: ABC, documentDate: on('2026-08-29'), lines: [line()] });
  assert.equal(today.lines[0]?.price.amount?.minor, inr(950).minor);
  assert.equal(today.lines[0]?.price.evidence.documentNumber, 'INV-AUGUST');

  // A bill back-dated to July must not be priced from an August agreement that had not happened.
  const backdated = await desk.service.quote(desk.actor, { partyId: ABC, documentDate: on('2026-07-15'), lines: [line()] });
  assert.equal(backdated.lines[0]?.price.amount?.minor, inr(800).minor);
  assert.equal(backdated.lines[0]?.price.evidence.documentNumber, 'INV-JUNE');
  assert.equal(backdated.lines[0]?.price.asOf, on('2026-07-15'));
});

test('with no history, the price list answers — and says which list and which slab', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(100000));
  desk.priceList.set([
    { itemId: 'CRATE', amount: inr(120), name: 'Shop rates' },
    { itemId: 'CRATE', amount: inr(100), name: 'Shop rates', fromQuantity: 10 },
  ]);

  const bulk = await desk.service.quote(desk.actor, { partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '10' })] });
  assert.equal(bulk.lines[0]?.price.source, 'PRICE_LIST');
  assert.equal(bulk.lines[0]?.price.amount?.minor, inr(100).minor);
  assert.equal(bulk.lines[0]?.price.evidence.priceListName, 'Shop rates');
  assert.equal(bulk.lines[0]?.price.evidence.appliesFromQuantity, '10');

  const single = await desk.service.quote(desk.actor, { partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '1' })] });
  assert.equal(single.lines[0]?.price.amount?.minor, inr(120).minor);
});

test('when nothing is on record the price stays empty and says so, rather than being guessed', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(100000));
  const quote = await desk.service.quote(desk.actor, { partyId: ABC, documentDate: on('2026-08-29'), lines: [line()] });

  assert.equal(quote.lines[0]?.price.source, 'NONE');
  assert.equal(quote.lines[0]?.price.amount, null);
  assert.match(quote.lines[0]?.price.sentence['en-IN'] ?? '', /please type what you agreed/);
  assert.equal(quote.outcome, 'ALLOW', 'not knowing a price does not stop a bill');
});

test('credit counts what is owed, what is on unfinished bills, and this bill', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(10000));
  desk.positions.set(inr(4000));
  desk.history.setPending([{ documentId: 'other-till', partyId: ABC, value: inr(3000) }]);
  desk.priceList.set([{ itemId: 'CRATE', amount: inr(200), name: 'Shop rates' }]);

  // 4,000 owed + 3,000 unfinished + 2,000 this bill = 9,000, inside a 10,000 limit.
  const inside = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), documentId: 'this-till',
    lines: [line({ quantity: '10', unitPrice: inr(200) })],
  });
  assert.equal(inside.credit.outstanding.minor, inr(4000).minor);
  assert.equal(inside.credit.pending.minor, inr(3000).minor);
  assert.equal(inside.credit.saleValue.minor, inr(2000).minor);
  assert.equal(inside.credit.exposure.minor, inr(9000).minor);
  assert.equal(inside.credit.outcome, 'ALLOW');

  // Landing exactly on the limit is not crossing it. A limit is the most they may owe.
  const exactly = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), documentId: 'this-till',
    lines: [line({ quantity: '15', unitPrice: inr(200) })],
  });
  assert.equal(exactly.credit.exposure.minor, inr(10000).minor);
  assert.equal(exactly.credit.excess.minor, 0n);
  assert.equal(exactly.credit.outcome, 'ALLOW');

  // One rupee more is over, and then it is a warning.
  const over = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), documentId: 'this-till',
    lines: [line({ quantity: '15', unitPrice: inr(200, 10) })],
  });
  assert.equal(over.credit.outcome, 'WARN');
  assert.equal(over.credit.excess.minor, inr(1, 50).minor);
});

test('going over the limit is warned about, with the excess and the rule that decided it', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(10000));
  desk.positions.set(inr(4000));
  desk.history.setPending([{ documentId: 'other-till', partyId: ABC, value: inr(3000) }]);

  const quote = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), documentId: 'this-till',
    lines: [line({ quantity: '20', unitPrice: inr(200) })],
  });

  assert.equal(quote.credit.exposure.minor, inr(11000).minor);
  assert.equal(quote.credit.excess.minor, inr(1000).minor);
  assert.equal(quote.credit.outcome, 'WARN');
  assert.equal(quote.credit.ruleId, 'sales.credit_limit', 'the approved rule decided this, not us');
  assert.notEqual(quote.credit.ruleVersion, null);
  assert.match(quote.credit.sentence['en-IN'], /takes them ₹1,000\.00 over/);
});

test('two tills writing bills for one customer cannot spend the same limit twice', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(10000));
  desk.positions.set(inr(0));

  // The first till starts a bill for 6,000. Nothing is issued yet, so nothing is outstanding.
  desk.history.setPending([{ documentId: 'till-1', partyId: ABC, value: inr(6000) }]);

  // The first till, looking at its own bill, excludes its own draft and is comfortably inside.
  const first = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), documentId: 'till-1',
    lines: [line({ quantity: '30', unitPrice: inr(200) })],
  });
  assert.equal(first.credit.pending.minor, 0n, 'a bill is not pending against itself');
  assert.equal(first.credit.outcome, 'ALLOW');

  // The second till writes another 6,000. It sees the first till's unfinished bill, so together
  // they are 12,000 against a 10,000 limit and this one is warned.
  const second = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), documentId: 'till-2',
    lines: [line({ quantity: '30', unitPrice: inr(200) })],
  });
  assert.equal(second.credit.pending.minor, inr(6000).minor, "the other till's bill counts");
  assert.equal(second.credit.exposure.minor, inr(12000).minor);
  assert.equal(second.credit.outcome, 'WARN');
});

test('a part payment lowers what is owed, and the next bill is judged on what is left', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(10000));

  desk.positions.set(inr(9500));
  const before = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '5', unitPrice: inr(200) })],
  });
  assert.equal(before.credit.outcome, 'WARN', '9,500 owed plus 1,000 crosses 10,000');

  // They pay 5,000. The very same bill now fits.
  desk.positions.set(inr(4500));
  const after = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '5', unitPrice: inr(200) })],
  });
  assert.equal(after.credit.outcome, 'ALLOW');
  assert.equal(after.credit.exposure.minor, inr(5500).minor);
});

test('no credit limit on file is unknown, not zero, and stops nobody', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(null);
  desk.positions.set(inr(50000));

  const quote = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '10', unitPrice: inr(200) })],
  });
  assert.equal(quote.credit.outcome, 'ALLOW');
  assert.equal(quote.credit.limit, null);
  assert.match(quote.credit.sentence['en-IN'], /No credit limit has been set/);
  assert.match(quote.credit.why['en-IN'], /We do not guess a limit/);
});

test('a business that wants over-limit bills stopped gets them stopped', async () => {
  const desk = makeDesk({ overLimit: 'BLOCK' });
  desk.parties.setLimit(inr(1000));
  desk.positions.set(inr(900));

  const quote = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '5', unitPrice: inr(200) })],
  });
  assert.equal(quote.credit.outcome, 'BLOCK');
  assert.equal(quote.outcome, 'BLOCK');
});

test('a customer whose oldest bill is far too late is stopped whatever their limit says', async () => {
  const desk = makeDesk({ blockWhenOverdueByDays: 60 });
  desk.parties.setLimit(inr(1000000));
  desk.positions.set(inr(500), 75);

  const quote = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '1', unitPrice: inr(200) })],
  });
  assert.equal(quote.credit.outcome, 'BLOCK', 'a limit means little when the last bill was never paid');
  assert.equal(quote.credit.oldestDaysOverdue, 75);
  assert.match(quote.credit.sentence['en-IN'], /75 days late/);
});

test('a discount inside the business threshold is allowed, and beyond it needs approval', async () => {
  const desk = makeDesk({ discountWithoutApprovalBasisPoints: 1000 });
  desk.parties.setLimit(inr(1000000));
  desk.priceList.set([{ itemId: 'CRATE', amount: inr(200), name: 'Shop rates' }]);

  const small = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '10', unitPrice: inr(190) })],
  });
  assert.equal(small.lines[0]?.discount?.outcome, 'ALLOW');
  assert.equal(small.lines[0]?.discount?.requestedBasisPoints, 500);
  assert.equal(small.lines[0]?.discount?.amountOff.minor, inr(100).minor, '₹10 off ten crates');
  assert.equal(small.outcome, 'ALLOW');

  const large = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '10', unitPrice: inr(150) })],
  });
  assert.equal(large.lines[0]?.discount?.outcome, 'NEEDS_APPROVAL');
  assert.equal(large.outcome, 'NEEDS_APPROVAL');
  assert.match(large.lines[0]?.discount?.sentence['en-IN'] ?? '', /more than the 10%/);
});

test('selling below cost is said out loud in money, and never blocks the bill', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(1000000));
  desk.cost.set({ CRATE: inr(120) });

  const quote = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '10', unitPrice: inr(100) })],
  });
  assert.equal(quote.lines[0]?.margin?.shortfallPerUnit.minor, inr(20).minor);
  assert.equal(quote.lines[0]?.margin?.shortfallOnLine.minor, inr(200).minor);
  assert.match(quote.lines[0]?.margin?.sentence['en-IN'] ?? '', /you lose ₹200\.00 on this line/);
  assert.equal(quote.outcome, 'ALLOW', 'selling at a loss is the owner’s decision to make');
});

test('when the cost is unknown no claim about margin is made at all', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(1000000));
  const quote = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '10', unitPrice: inr(1) })],
  });
  assert.equal(quote.lines[0]?.margin, null);
});

test('overriding needs the permission, a reason, and leaves an audit trail', async () => {
  const desk = makeDesk({ overLimit: 'BLOCK' });
  desk.parties.setLimit(inr(1000));
  desk.positions.set(inr(900));
  const request = {
    partyId: ABC, documentDate: on('2026-08-29'),
    lines: [line({ quantity: '5', unitPrice: inr(200) })],
  };

  // Without the permission, refusing names what is missing rather than just saying no.
  const till = actorWith(['sales.draft.write']);
  await assert.rejects(
    () => desk.service.quote(till, { ...request, override: { reason: 'The owner said yes on the phone.' } }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.kind === 'FORBIDDEN' &&
      error.code === 'TRADE_TERMS_OVERRIDE_NOT_ALLOWED' &&
      error.details.permission === 'sales.override_credit_limit',
  );

  // A reason is not optional, even with the permission.
  await assert.rejects(
    () => desk.service.quote(desk.actor, { ...request, override: { reason: '   ' } }),
    (error: unknown) => error instanceof DomainError && error.code === 'TRADE_TERMS_OVERRIDE_REASON_REQUIRED',
  );

  const before = desk.audit.events.length;
  const allowed = await desk.service.quote(desk.actor, {
    ...request,
    override: { reason: 'They are paying by cheque this afternoon.' },
  });
  assert.equal(allowed.outcome, 'ALLOW');
  assert.equal(allowed.override?.reason, 'They are paying by cheque this afternoon.');
  assert.match(allowed.reasons.at(-1)?.['en-IN'] ?? '', /Allowed anyway, because/);

  const events = desk.audit.events.slice(before);
  assert.equal(events.length, 1);
  const event = events[0] as { action: string; overrideReason?: string; details: Record<string, string> };
  assert.equal(event.action, 'trade_terms.overridden');
  assert.equal(event.overrideReason, 'They are paying by cheque this afternoon.');
  assert.equal(event.details.excess, String(inr(900).minor), 'the figure that was overridden is recorded');
});

test('approving a big discount is a different permission from allowing more credit', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(1000000));
  desk.priceList.set([{ itemId: 'CRATE', amount: inr(200), name: 'Shop rates' }]);
  const request = {
    partyId: ABC, documentDate: on('2026-08-29'),
    lines: [line({ quantity: '10', unitPrice: inr(100) })],
    override: { reason: 'Clearing last season’s crates.' },
  };

  const creditOnly = actorWith(['sales.override_credit_limit']);
  await assert.rejects(
    () => desk.service.quote(creditOnly, request),
    (error: unknown) => error instanceof DomainError && error.details.permission === 'sales.approve_discount',
  );

  const approver = actorWith(['sales.approve_discount']);
  const allowed = await desk.service.quote(approver, request);
  assert.equal(allowed.outcome, 'ALLOW');
});

test('an override is only applied when something actually needed one', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(1000000));
  const quote = await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'),
    lines: [line({ quantity: '1', unitPrice: inr(100) })],
    override: { reason: 'Not needed.' },
  });
  assert.equal(quote.outcome, 'ALLOW');
  assert.equal(quote.override, null, 'nothing was overridden, so nothing is recorded as overridden');
  assert.equal(desk.audit.events.length, 0);
});

test('a quantity of zero has no price, and says so plainly', async () => {
  const desk = makeDesk();
  desk.parties.setLimit(inr(1000));
  await assert.rejects(
    () => desk.service.quote(desk.actor, { partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '0' })] }),
    (error: unknown) => error instanceof DomainError && error.code === 'TRADE_TERMS_QUANTITY_INVALID',
  );
});

test('asking a quote changes nothing', async () => {
  const desk = makeDesk({ overLimit: 'BLOCK' });
  desk.parties.setLimit(inr(100));
  desk.positions.set(inr(90));
  await desk.service.quote(desk.actor, {
    partyId: ABC, documentDate: on('2026-08-29'), lines: [line({ quantity: '5', unitPrice: inr(200) })],
  });
  assert.equal(desk.audit.events.length, 0, 'a quote that was merely read writes nothing');
});
