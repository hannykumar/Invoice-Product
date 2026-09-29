/** Issue #224 — a PIN code from the wrong state is caught before it reaches a bill. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { stateOfPincode, validatePincodeForState } from '../src/validation.ts';

test('a PIN code in its own state passes', () => {
  assert.equal(validatePincodeForState('500039', '36').ok, true); // Hyderabad, Telangana
  assert.equal(validatePincodeForState('110039', '07').ok, true); // Delhi
  assert.equal(validatePincodeForState('560058', '29').ok, true); // Bengaluru
  assert.equal(validatePincodeForState('403001', '30').ok, true); // Panaji, Goa
  assert.equal(validatePincodeForState('396210', '26').ok, true); // Daman
});

test('a PIN code from another state is refused, and says which digits that state uses', () => {
  const result = validatePincodeForState('110039', '36');
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.problems[0]?.code, 'PINCODE_STATE_MISMATCH');
  assert.match(result.ok ? '' : result.problems[0]?.message ?? '', /110039 is not in Telangana\. PIN codes in Telangana start with 50/);
  assert.equal(validatePincodeForState('560058', '27').ok, false);
});

test('where one postal region spans two states, both are allowed', () => {
  assert.equal(validatePincodeForState('500001', '37').ok, true); // Andhra Pradesh border area
  assert.equal(validatePincodeForState('248001', '05').ok, true); // Dehradun, Uttarakhand
  assert.equal(validatePincodeForState('248001', '09').ok, true); // the same block, Uttar Pradesh
});

test('a badly shaped PIN is still refused as badly shaped', () => {
  const result = validatePincodeForState('50003', '36');
  assert.equal(result.ok ? '' : result.problems[0]?.code, 'PINCODE_SHAPE');
});

test('#288: the state is read from the PIN code, for every state', () => {
  const expected: Record<string, string> = {
    '560001': '29', '411026': '27', '110001': '07', '403001': '30', '737101': '11', '744101': '35', '834001': '20',
    '800001': '10', '160017': '04', '141001': '03', '500001': '36', '520001': '37', '600001': '33', '682001': '32',
    '781001': '18', '791111': '12', '793001': '17', '795001': '14', '796001': '15', '797001': '13', '799001': '16',
    '190001': '01', '194101': '38', '171001': '02', '248001': '05', '226001': '09', '302001': '08', '380001': '24',
    '462001': '23', '492001': '22', '751001': '21', '700001': '19', '122001': '06',
  };
  for (const [pin, state] of Object.entries(expected)) assert.equal(stateOfPincode(pin), state, pin);
});

test('#288: a block two states share, or a PIN that is not six digits, is left for the person to choose', () => {
  for (const pin of ['262001', '396210', '605001', '56001', 'abcdef', '']) assert.equal(stateOfPincode(pin), null, pin);
});

test('#288: every state read from a PIN passes the PIN check for that state', () => {
  for (let block = 110; block <= 999; block += 1) {
    const pin = `${block}001`;
    const state = stateOfPincode(pin);
    if (state !== null) assert.equal(validatePincodeForState(pin, state).ok, true, `${pin} → ${state}`);
  }
});
