/** Issue #25 [E25] — Sharma Fruit Traders, wired to the calculator. Same business as issue #1. */
import { isoDate, quantityFromString, rupees, type IsoDate, type Money, type Quantity } from '@invoice/kernel';
import { RulesEngine, shippedRegistry, type EngineMode } from '@invoice/rules-engine';
import { GstCalculator } from '../src/compute.ts';
import { FIXTURE_RATE_TABLE, RateTable } from '../src/rate-table.ts';
import { InMemoryMasterData, type ItemTaxClassification, type Registration } from '../src/master-data-port.ts';

export const SHARMA = 'company-sharma';

export const makeCalculator = (
  options: { mode?: EngineMode; registration?: Registration; rates?: RateTable; companyState?: string } = {},
): { calculator: GstCalculator; masterData: InMemoryMasterData } => {
  const mode: EngineMode = options.mode ?? 'development';
  const masterData = new InMemoryMasterData();

  masterData.putCompany({
    companyId: SHARMA,
    gstin: `${options.companyState ?? '07'}AAAAA0000A1Z4`,
    stateCode: options.companyState ?? '07',
    registration: options.registration ?? 'REGULAR',
  });

  masterData
    .putParty(SHARMA, { partyId: 'abc-traders', gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' })
    .putParty(SHARMA, { partyId: 'gurugram-fresh', gstin: '06BBBBB1111B1ZR', stateCode: '06', registration: 'REGULAR' })
    .putParty(SHARMA, { partyId: 'chandigarh-mart', gstin: '04EEEEE4444E1Z0', stateCode: '04', registration: 'REGULAR' })
    .putParty(SHARMA, { partyId: 'walk-in', gstin: null, stateCode: null, registration: 'UNKNOWN' });

  const items: ItemTaxClassification[] = [
    { itemId: 'APL-BOX-10', name: 'Apple box, 10 kg', kind: 'GOODS', hsnOrSac: '0808', treatment: 'NIL_RATED', reverseCharge: false, baseUnit: 'BOX' },
    { itemId: 'CRATE-P', name: 'Plastic crate', kind: 'GOODS', hsnOrSac: '3923', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' },
    { itemId: 'JUICE-1L', name: 'Packaged apple juice, 1 litre', kind: 'GOODS', hsnOrSac: '2009', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' },
    { itemId: 'COLA-300', name: 'Aerated drink, 300 ml', kind: 'GOODS', hsnOrSac: '2202', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' },
    { itemId: 'FREIGHT-GTA', name: 'Goods transport by road', kind: 'SERVICES', hsnOrSac: '9965', treatment: 'TAXABLE', reverseCharge: true, baseUnit: 'JOB' },
    { itemId: 'REPAIR', name: 'Crate repair work', kind: 'SERVICES', hsnOrSac: '9987', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'JOB' },
    { itemId: 'BOOKS', name: 'Printed order books', kind: 'GOODS', hsnOrSac: '4901', treatment: 'EXEMPT', reverseCharge: false, baseUnit: 'PCS' },
    { itemId: 'LIQUOR', name: 'Country liquor', kind: 'GOODS', hsnOrSac: '2208', treatment: 'NON_GST', reverseCharge: false, baseUnit: 'PCS' },
    { itemId: 'MYSTERY', name: 'Uncategorised item', kind: 'GOODS', hsnOrSac: null, treatment: 'UNKNOWN', reverseCharge: false, baseUnit: 'PCS' },
    { itemId: 'NO-CODE', name: 'Item with no government code', kind: 'GOODS', hsnOrSac: null, treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' },
    { itemId: 'NO-RATE', name: 'Item whose code we have no rate for', kind: 'GOODS', hsnOrSac: '9999', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' },
  ];
  for (const item of items) masterData.putItem(SHARMA, item);

  const calculator = new GstCalculator({
    masterData,
    rates: options.rates ?? FIXTURE_RATE_TABLE,
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode }),
    mode,
  });
  return { calculator, masterData };
};

export const qty = (value: string, unit: string): Quantity => quantityFromString(value, unit);
export const on = (date: string): IsoDate => isoDate(date);
export const inr = (whole: number, paise = 0): Money => rupees(whole, paise);
export const SOURCE = { kind: 'sales_invoice', id: 'si-test' };
