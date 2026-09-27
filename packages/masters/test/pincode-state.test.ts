/** Issue #224 — a PIN code from the wrong state is caught before it reaches a bill. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePincodeForState } from '../src/validation.ts';

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
