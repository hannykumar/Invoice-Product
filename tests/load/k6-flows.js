// Issue #361 — the five flows a shop runs all day, under load: sign in, record a purchase, make a
// bill, open reports, prepare the GST return. Each virtual user is the owner of one of the two
// synthetic companies, and every reply is checked for the other company's names, so a cross-company
// leak under load (#360) fails the run.
//
// k6 is an external binary, not an npm dependency (https://grafana.com/docs/k6/latest/set-up/install-k6/).
//
//   npm run web                                      # in another terminal
//   k6 run tests/load/k6-flows.js                    # local, ramps to 20 users over 2 minutes
//   k6 run -e VUS=200 -e RAMP=10m tests/load/k6-flows.js
//   k6 run -e BASE_URL=https://staging.example -e TARGET=staging tests/load/k6-flows.js
//
// Only a local server, or a host named with TARGET=staging. Never production.
import http from 'k6/http';
import { check, group } from 'k6';

const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const host = BASE_URL.replace(/^https?:\/\//, '').split(/[/:]/)[0];
if (!['127.0.0.1', 'localhost'].includes(host) && __ENV.TARGET !== 'staging') {
  throw new Error(`${BASE_URL} is not local. Name the environment with -e TARGET=staging; production is never a target.`);
}
if (/prod/i.test(host)) throw new Error(`${host} looks like production. Load tests never run there.`);

const VUS = Number(__ENV.VUS || 20);
const RAMP = __ENV.RAMP || '2m';
const PASSWORD = __ENV.DEMO_OWNER_PASSWORD || 'karobar-demo';

export const options = {
  scenarios: {
    shop_day: {
      executor: 'ramping-vus',
      stages: [{ duration: RAMP, target: VUS }, { duration: __ENV.HOLD || '1m', target: VUS }, { duration: '30s', target: 0 }],
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // A leak is never acceptable, not even one.
    'checks{check:own company only}': ['rate==1'],
    // Always true: these only make k6 print p95/p99 per flow, not just overall.
    'http_req_duration{flow:sign_in}': ['p(95)>=0'],
    'http_req_duration{flow:purchase}': ['p(95)>=0'],
    'http_req_duration{flow:bill}': ['p(95)>=0'],
    'http_req_duration{flow:reports}': ['p(95)>=0'],
    'http_req_duration{flow:gst_prepare}': ['p(95)>=0'],
  },
};

// The two synthetic companies the demo runtime seeds (apps/api/src/runtime.ts, packages/platform/src/seed.ts).
const COMPANIES = [
  { id: '00000000-0000-4000-8000-000000000001', email: 'owner@sampoorna.example.invalid', prefix: 'sampoorna', theirs: 'Mapusa Family Stores' },
  { id: '00000000-0000-4000-8000-000000000011', email: 'owner@konkan.example.invalid', prefix: 'konkan', theirs: 'ABC Traders' },
];

// India's date, which is what the books are kept in.
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

const post = (path, body, headers, flow) => http.post(`${BASE_URL}${path}`, JSON.stringify(body), { headers, tags: { flow } });
const ownOnly = (company, response) => check(response, {
  'status 200': (r) => r.status === 200,
  'own company only': (r) => !String(r.body).includes(company.theirs) && !String(r.body).includes(`${COMPANIES.find((c) => c !== company).prefix}:`),
});

export default function () {
  const company = COMPANIES[__VU % 2];
  const run = `lt-${__VU}-${__ITER}-${Date.now()}`;
  const date = today();
  const json = { 'content-type': 'application/json' };

  let headers;
  group('sign in', () => {
    const r = post('/api/auth/login', { companyId: company.id, email: company.email, password: PASSWORD }, json, 'sign_in');
    check(r, { 'signed in': (res) => res.status === 200 });
    headers = { ...json, authorization: `Bearer ${r.json('sessionId')}` };
  });

  const item = `${company.prefix}:item:SOAP`;
  group('record a purchase', () => {
    // 10 PCS × ₹40 = ₹400; 5% = ₹20; ₹420
    ownOnly(company, post('/api/purchases/record', {
      supplierId: `${company.prefix}:party:supplier`, reference: run, date, amount: '420',
      lines: JSON.stringify([{ itemId: item, quantity: '10', unit: 'PCS', rate: '40', gst: '500' }]),
    }, headers, 'purchase'));
  });

  group('make a bill', () => {
    ownOnly(company, post('/api/sales/record', {
      party: `${company.prefix}:party:customer`, date, terms: '30',
      lines: JSON.stringify([{ itemId: item, quantity: '1', unit: 'PCS', rate: '60' }]),
      freight: '', otherCharges: '', shipTo: 'same', requestId: run,
    }, headers, 'bill'));
  });

  group('open reports', () => {
    const r = http.get(`${BASE_URL}/api/reports`, { headers, tags: { flow: 'reports' } });
    ownOnly(company, r);
    check(r, { 'reports never cached': (res) => res.headers['Cache-Control'] === 'no-store' });
  });

  group('prepare the GST return', () => {
    ownOnly(company, post('/api/gst-returns/prepare', { period: date.slice(0, 7), reference: run }, headers, 'gst_prepare'));
  });
}
