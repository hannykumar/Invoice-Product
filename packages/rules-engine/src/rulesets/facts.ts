/** Issue #7 [E07] — the facts the shipped rule sets ask about, named for a business owner. */
import type { FactDefinition } from '../facts.ts';

const f = (
  id: string,
  type: FactDefinition['type'],
  en: string,
  hi: string,
  whyEn: string,
  whyHi: string,
  enumValues?: readonly string[],
): FactDefinition => ({
  id,
  type,
  label: { 'en-IN': en, 'hi-IN': hi },
  whyNeeded: { 'en-IN': whyEn, 'hi-IN': whyHi },
  ...(enumValues === undefined ? {} : { enumValues }),
});

export const SUPPLY_FACTS: readonly FactDefinition[] = [
  f('supply.type', 'enum', 'Goods or services', 'Saaman ya service',
    'Goods and services are treated differently.', 'Saaman aur service ka tareeka alag hai.', ['GOODS', 'SERVICES']),
  f('supply.supplierStateCode', 'stateCode', "Your state", 'Aapka rajya',
    'Your state decides which GST applies.', 'Aapke rajya se tay hota hai kaunsa GST lagega.'),
  f('supply.deliveryStateCode', 'stateCode', 'The state the goods are delivered to', 'Maal kis rajya mein ja raha hai',
    'Where the goods go decides which state the sale counts in.', 'Maal kahan ja raha hai, isse tay hota hai bikri kis rajya ki hai.'),
  f('supply.placeOfSupplyStateCode', 'stateCode', 'The state this sale counts in', 'Yeh bikri kis rajya ki maani jayegi',
    'It decides whether one combined GST applies or two separate ones.', 'Isse tay hota hai ek GST lagega ya do.'),
  f('supply.recipientRegistered', 'boolean', 'Is the customer registered for GST', 'Kya customer GST mein registered hai',
    'A registered and an unregistered customer are treated differently.', 'Registered aur unregistered customer ka tareeka alag hai.'),
];

export const SUPPLIER_REGISTRATION_FACT: FactDefinition = f(
  'supply.supplierRegistration', 'enum', 'How your business is registered for GST', 'Aapka business GST mein kaise registered hai',
  'A business on the composition scheme is billed differently.', 'Composition scheme wale business ka bill alag hota hai.',
  ['REGULAR', 'COMPOSITION', 'UNREGISTERED'],
);

export const TRANSPORT_FACTS: readonly FactDefinition[] = [
  f('consignment.value', 'money', 'Value of the goods being moved', 'Jo maal ja raha hai uski keemat',
    'The value decides whether a permit is needed.', 'Keemat se tay hota hai permit chahiye ya nahin.'),
  f('movement.type', 'enum', 'Within the state or to another state', 'Rajya ke andar ya doosre rajya',
    'The kind of movement changes the rule.', 'Movement ka prakaar niyam badal deta hai.', ['INTRA_STATE', 'INTER_STATE']),
  f('movement.mode', 'enum', 'How the goods travel', 'Maal kaise ja raha hai',
    'Some ways of moving goods are treated differently.', 'Kuch tareekon ka niyam alag hai.', ['ROAD', 'RAIL', 'AIR', 'SHIP']),
  f('movement.approxDistanceKm', 'number', 'Roughly how far', 'Lagbhag kitni doori',
    'Short distances can be treated differently.', 'Kam doori ka niyam alag ho sakta hai.'),
];

export const MONEY_POLICY_FACTS: readonly FactDefinition[] = [
  f('invoice.totalBeforeRounding', 'money', 'Bill total before rounding', 'Round karne se pehle ka total',
    'We need the exact total to work out the rounding.', 'Rounding nikaalne ke liye sahi total chahiye.'),
  f('party.creditLimit', 'money', "The most this customer may owe you", 'Is customer par zyada se zyada kitna baaki rakh sakte hain',
    'Without a limit there is nothing to compare against.', 'Seema ke bina tulna kis se karein.'),
  f('party.outstanding', 'money', 'What this customer already owes', 'Customer par pehle se kitna baaki hai',
    'Unpaid bills count towards the limit.', 'Bina chukaye bill seema mein jodte hain.'),
  f('party.pendingValue', 'money', 'Bills for this customer that are not finished', 'Is customer ke adhoore bill',
    'Unfinished bills count towards the limit too.', 'Adhoore bill bhi seema mein jodte hain.'),
  f('sale.value', 'money', 'Value of this bill', 'Is bill ki keemat',
    'The new bill is added before the limit is checked.', 'Seema jaanchne se pehle naya bill joda jaata hai.'),
];

export const STOCK_FACTS: readonly FactDefinition[] = [
  f('stock.availableScaled', 'number', 'How much you can sell right now', 'Abhi kitna bech sakte hain',
    'We compare what is free against what the bill needs.', 'Jo khaali hai use bill ki zaroorat se milaate hain.'),
  f('stock.requiredScaled', 'number', 'How much this bill needs', 'Is bill ko kitna chahiye',
    'We compare what the bill needs against what is free.', 'Bill ki zaroorat ko khaali maal se milaate hain.'),
  f('stock.unit', 'text', 'The unit', 'Ikai',
    'Numbers without a unit cannot be compared.', 'Bina ikai ke ginti ki tulna nahin ho sakti.'),
];

export const ALL_FACTS: readonly FactDefinition[] = [
  ...SUPPLY_FACTS,
  SUPPLIER_REGISTRATION_FACT,
  ...TRANSPORT_FACTS,
  ...MONEY_POLICY_FACTS,
  ...STOCK_FACTS,
];
