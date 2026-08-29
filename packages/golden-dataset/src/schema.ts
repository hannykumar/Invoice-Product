/**
 * Issue #43 [E43] — what a golden fixture is, and what makes one valid.
 *
 * A fixture is **data, not code**: a business, a list of things that happened to it, and what every
 * module is expected to say afterwards. Keeping it as JSON is the point — the same file is replayed
 * by this lane's tests today and can be replayed by another agent's module tomorrow without
 * importing anything of ours.
 *
 * The validator below is hand-written rather than pulled from a schema library, because a golden
 * dataset that needs a dependency to be checked is one more thing that can stop the build for a
 * reason unrelated to correctness.
 */

export type BusinessKind = 'BAKERY' | 'WHOLESALER' | 'SERVICES' | 'TRANSPORT';

/**
 * Where an expected compliance figure comes from.
 *
 * "Changing expected outcomes requires documented rule/source review" is an acceptance criterion,
 * so an expectation that rests on a rule has to name it. A figure with no provenance can be edited
 * by anyone to make a failing test pass, which is precisely what a golden dataset exists to stop.
 */
export interface RuleProvenance {
  readonly ruleId: string;
  readonly ruleVersion: string;
  /** The notification, circular or policy the rule rests on. `policy:` for our own choices. */
  readonly sourceRef: string;
  readonly effectiveFrom: string;
  /** Why this figure is what it is, for a person reviewing a change to it. */
  readonly note: string;
}

export interface FixtureItem {
  readonly itemId: string;
  readonly name: string;
  readonly kind: 'GOODS' | 'SERVICES';
  readonly baseUnit: string;
  readonly hsnOrSac: string | null;
  readonly treatment: 'TAXABLE' | 'NIL_RATED' | 'EXEMPT' | 'NON_GST' | 'UNKNOWN';
  readonly ratePercent?: number;
}

export interface FixtureParty {
  readonly partyId: string;
  readonly name: string;
  readonly role: 'CUSTOMER' | 'SUPPLIER';
  /** Structurally valid but invented. Never a real business's number — see the rule in the brief. */
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly accountCode: string;
}

export interface FixtureCompany {
  readonly companyId: string;
  readonly name: string;
  readonly kind: BusinessKind;
  readonly stateCode: string;
  readonly gstin: string;
  readonly booksStartDate: string;
  readonly warehouseId: string;
  readonly warehouseName: string;
}

export type FixtureEvent =
  | { readonly kind: 'stock_in'; readonly ref: string; readonly on: string; readonly itemId: string; readonly quantity: string; readonly unit: string; readonly unitCost: string }
  | { readonly kind: 'sale'; readonly ref: string; readonly on: string; readonly partyId: string; readonly dueOn: string; readonly lines: readonly { readonly itemId: string; readonly quantity: string; readonly unit: string; readonly unitPrice: string }[] }
  | { readonly kind: 'sale_refused'; readonly ref: string; readonly on: string; readonly partyId: string; readonly dueOn: string; readonly lines: readonly { readonly itemId: string; readonly quantity: string; readonly unit: string; readonly unitPrice: string }[]; readonly expectedCode: string; readonly expectedMessageContains: string; readonly why: string }
  | { readonly kind: 'payment'; readonly ref: string; readonly on: string; readonly partyId: string; readonly amount: string; readonly againstRef: string | null }
  | { readonly kind: 'cancel_sale'; readonly ref: string; readonly on: string; readonly cancels: string; readonly reason: string };

export interface ExpectedAccount {
  readonly code: string;
  readonly name: string;
  /** Signed on the account's normal side, in rupees with two decimals. */
  readonly balance: string;
}

export interface ExpectedStock {
  readonly itemId: string;
  readonly physical: string;
  readonly unit: string;
}

export interface ExpectedTax {
  readonly taxableValue: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly igst: string;
  readonly total: string;
  readonly provenance: RuleProvenance;
}

export interface ExpectedOutputs {
  readonly trialBalanceBalanced: true;
  readonly totalDebits: string;
  readonly totalCredits: string;
  readonly accounts: readonly ExpectedAccount[];
  readonly stock: readonly ExpectedStock[];
  readonly tax: ExpectedTax;
  /** Refusals the run must have produced, by the code the module raises. */
  readonly refusals: readonly string[];
}

export interface GoldenFixture {
  readonly id: string;
  readonly version: string;
  /** What this example is for, in a sentence a reviewer reads before changing anything. */
  readonly describes: string;
  readonly company: FixtureCompany;
  readonly parties: readonly FixtureParty[];
  readonly items: readonly FixtureItem[];
  readonly events: readonly FixtureEvent[];
  readonly expected: ExpectedOutputs;
}

export interface SchemaProblem {
  readonly path: string;
  readonly detail: string;
}

const MONEY = /^-?\d+\.\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QUANTITY = /^\d+(\.\d+)?$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks one fixture's shape.
 *
 * Money is checked as a string with exactly two decimals rather than a number: a golden figure
 * written as `1234.5` in JSON is a float, and floats are the one thing the money rules forbid
 * anywhere near a financial figure.
 */
export const validateFixture = (raw: unknown): readonly SchemaProblem[] => {
  const problems: SchemaProblem[] = [];
  const fail = (path: string, detail: string) => problems.push({ path, detail });

  if (!isObject(raw)) return [{ path: '', detail: 'a fixture must be an object' }];
  for (const key of ['id', 'version', 'describes'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).trim() === '') fail(key, 'must be a non-empty string');
  }

  const company = raw.company;
  if (!isObject(company)) fail('company', 'missing');
  else {
    for (const key of ['companyId', 'name', 'stateCode', 'gstin', 'warehouseId', 'warehouseName'] as const) {
      if (typeof company[key] !== 'string' || (company[key] as string).trim() === '') fail(`company.${key}`, 'must be a non-empty string');
    }
    if (typeof company.booksStartDate !== 'string' || !DATE.test(company.booksStartDate)) {
      fail('company.booksStartDate', 'must be a date like 2026-04-01');
    }
    if (!['BAKERY', 'WHOLESALER', 'SERVICES', 'TRANSPORT'].includes(String(company.kind))) {
      fail('company.kind', 'must be one of BAKERY, WHOLESALER, SERVICES, TRANSPORT');
    }
  }

  const items = raw.items;
  if (!Array.isArray(items) || items.length === 0) fail('items', 'a business sells at least one thing');
  else {
    items.forEach((item, index) => {
      if (!isObject(item)) return fail(`items[${index}]`, 'must be an object');
      if (typeof item.itemId !== 'string') fail(`items[${index}].itemId`, 'missing');
      if (typeof item.baseUnit !== 'string') fail(`items[${index}].baseUnit`, 'missing');
      if (item.treatment === 'TAXABLE' && typeof item.ratePercent !== 'number') {
        fail(`items[${index}].ratePercent`, 'a taxable item must say the rate this business charges');
      }
    });
  }

  const events = raw.events;
  if (!Array.isArray(events) || events.length === 0) fail('events', 'a fixture with nothing happening proves nothing');
  else {
    events.forEach((event, index) => {
      if (!isObject(event)) return fail(`events[${index}]`, 'must be an object');
      const at = `events[${index}]`;
      if (typeof event.ref !== 'string' || event.ref.trim() === '') fail(`${at}.ref`, 'every event needs a stable reference');
      if (typeof event.on !== 'string' || !DATE.test(String(event.on))) fail(`${at}.on`, 'must be a date like 2026-04-01');
      const kinds = ['stock_in', 'sale', 'sale_refused', 'payment', 'cancel_sale'];
      if (!kinds.includes(String(event.kind))) fail(`${at}.kind`, `must be one of ${kinds.join(', ')}`);
      if (event.kind === 'stock_in') {
        if (!QUANTITY.test(String(event.quantity))) fail(`${at}.quantity`, 'must be a positive number as a string');
        if (!MONEY.test(String(event.unitCost))) fail(`${at}.unitCost`, 'money is a string with two decimals');
      }
      if (event.kind === 'payment' && !MONEY.test(String(event.amount))) {
        fail(`${at}.amount`, 'money is a string with two decimals');
      }
      if ((event.kind === 'sale' || event.kind === 'sale_refused') && !Array.isArray(event.lines)) {
        fail(`${at}.lines`, 'a sale needs lines');
      }
      if (event.kind === 'sale_refused') {
        if (typeof event.expectedCode !== 'string' || String(event.why).trim() === '') {
          fail(`${at}.expectedCode`, 'a refusal must name the code it expects and say why');
        }
        // The code alone is the lifecycle wrapper; the reason lives in the message. Pinning only
        // the code would let the module start refusing for a different reason and still pass.
        if (typeof event.expectedMessageContains !== 'string' || String(event.expectedMessageContains).trim() === '') {
          fail(`${at}.expectedMessageContains`, 'a refusal must pin the reason it gives, not just its code');
        }
      }
    });
  }

  const expected = raw.expected;
  if (!isObject(expected)) fail('expected', 'missing');
  else {
    if (expected.trialBalanceBalanced !== true) {
      fail('expected.trialBalanceBalanced', 'a golden business whose books do not balance is not golden');
    }
    for (const key of ['totalDebits', 'totalCredits'] as const) {
      if (!MONEY.test(String(expected[key]))) fail(`expected.${key}`, 'money is a string with two decimals');
    }
    if (String(expected.totalDebits) !== String(expected.totalCredits)) {
      fail('expected.totalCredits', 'the two sides of the expected books must be the same figure');
    }
    const tax = expected.tax;
    if (!isObject(tax)) fail('expected.tax', 'missing');
    else {
      for (const key of ['taxableValue', 'cgst', 'sgst', 'igst', 'total'] as const) {
        if (!MONEY.test(String(tax[key]))) fail(`expected.tax.${key}`, 'money is a string with two decimals');
      }
      const parts = ['cgst', 'sgst', 'igst'].map((k) => Number(tax[k as 'cgst']));
      if (Math.abs(parts.reduce((a, b) => a + b, 0) - Number(tax.total)) > 0.005) {
        fail('expected.tax.total', 'the parts of the tax must add up to the total');
      }
      const provenance = tax.provenance;
      if (!isObject(provenance)) fail('expected.tax.provenance', 'a tax figure must say which rule produced it');
      else {
        for (const key of ['ruleId', 'ruleVersion', 'sourceRef', 'effectiveFrom', 'note'] as const) {
          if (typeof provenance[key] !== 'string' || (provenance[key] as string).trim() === '') {
            fail(`expected.tax.provenance.${key}`, 'required, so changing this figure needs a documented review');
          }
        }
      }
    }
    if (!Array.isArray(expected.accounts)) fail('expected.accounts', 'missing');
    else {
      expected.accounts.forEach((account, index) => {
        if (!isObject(account)) return fail(`expected.accounts[${index}]`, 'must be an object');
        if (!MONEY.test(String(account.balance))) fail(`expected.accounts[${index}].balance`, 'money is a string with two decimals');
      });
    }
    if (!Array.isArray(expected.stock)) fail('expected.stock', 'missing');
    if (!Array.isArray(expected.refusals)) fail('expected.refusals', 'missing, use [] when nothing was refused');
  }

  return problems;
};

export const assertValidFixture = (raw: unknown, name: string): GoldenFixture => {
  const problems = validateFixture(raw);
  if (problems.length > 0) {
    const lines = problems.map((p) => `  ${p.path || '(root)'}: ${p.detail}`).join('\n');
    throw new Error(`The golden fixture "${name}" is not valid:\n${lines}`);
  }
  return raw as GoldenFixture;
};
