/**
 * Issues #146 and #147, driven through the HTTP edge the browser actually calls.
 *
 *  - "A logo can be uploaded ... and changed later" and "Until one is uploaded, the header lays out
 *     correctly without a gap."
 *  - "The file is checked for type and size."
 *  - "It is frozen onto each bill when the bill is raised."
 *  - #147's picture search and the faint mark, reachable from a screen.
 *
 * The preview is checked as a *rendered bill* rather than as a payload, because the whole point of
 * it is that the screen and the printer cannot disagree.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(response.body) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', {
    companyId: COMPANY_A,
    email: 'owner@sampoorna.example.invalid',
    password: 'karobar-demo',
  });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

/** A one-pixel PNG. Small enough to sit in a test, real enough to be a picture. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a business starts with no logo, no mark and no colour of its own', async () => {
  const session = await signIn();
  const { status, body } = await request('GET', '/api/branding', {}, session);
  assert.equal(status, 200);
  assert.deepEqual(body.branding, { logoDataUri: null, tradeMark: null, accent: null });
  assert.ok(body.templates.length > 0, 'the screen must be able to offer the shipped designs');
});

test('the sample bill is a complete bill before anything is branded, with no gap where a logo would go', async () => {
  const session = await signIn();
  const { status, body } = await request('POST', '/api/branding/preview', {}, session);
  assert.equal(status, 200);
  assert.ok(body.html.includes('SAMPLE/0001'));
  assert.ok(body.html.includes('29AAAAA0000A1Z5'), 'the seller’s GST number is on every tax invoice');
  assert.ok(!body.html.includes('class="logo"'), 'no empty logo box is drawn');
  assert.ok(!body.html.includes('class="watermark"'));
});

test('a logo is stored, and it reaches the printed bill', async () => {
  const session = await signIn();
  const saved = await request('POST', '/api/branding', { logoDataUri: PNG }, session);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.branding.logoDataUri, PNG);

  const preview = await request('POST', '/api/branding/preview', {}, session);
  assert.ok(preview.body.html.includes('class="logo"'));
  assert.ok(preview.body.html.includes(PNG), 'the picture itself travels onto the bill, not a link to it');
});

test('a picture that is not a picture, or one too large to sit on every bill, is refused', async () => {
  const session = await signIn();
  const notAPicture = await request('POST', '/api/branding', { logoDataUri: 'https://example.com/logo.png' }, session);
  assert.equal(notAPicture.status, 422);
  assert.equal(notAPicture.body.code, 'LOGO_NOT_A_PICTURE');

  const huge = await request('POST', '/api/branding', { logoDataUri: `data:image/png;base64,${'A'.repeat(400_001)}` }, session);
  assert.equal(huge.status, 422);
  assert.equal(huge.body.code, 'LOGO_TOO_LARGE');
});

test('a business’s own colour is used for headings, and only a real colour is accepted', async () => {
  const session = await signIn();
  const saved = await request('POST', '/api/branding', { accent: '#8a2f14' }, session);
  assert.equal(saved.body.branding.accent, '#8a2f14');

  const preview = await request('POST', '/api/branding/preview', {}, session);
  assert.ok(preview.body.html.includes('#8a2f14'), 'the design is drawn in the business’s colour');

  const nonsense = await request('POST', '/api/branding', { accent: 'red-ish' }, session);
  assert.equal(nonsense.status, 422);
  assert.equal(nonsense.body.code, 'ACCENT_NOT_A_COLOUR');
});

test('a business searches for the mark of its trade in its own words', async () => {
  const session = await signIn();
  const { status, body } = await request('POST', '/api/trade-marks/search', { query: 'mithai' }, session);
  assert.equal(status, 200);
  const ids = body.pictures.map((p: { pictureId: string }) => p.pictureId);
  assert.ok(ids.includes('cake') || ids.includes('candy'));
  // The drawing comes back with the result, so the screen has something to show without a second
  // round trip per picture.
  assert.ok(body.pictures[0].svg.startsWith('<svg'));
});

test('the chosen mark is kept, prints faintly, and can be taken off again', async () => {
  const session = await signIn();
  const chosen = await request('POST', '/api/branding', { pictureId: 'cake' }, session);
  assert.equal(chosen.body.branding.tradeMark.pictureId, 'cake');
  assert.equal(chosen.body.branding.tradeMark.opacityPercent, 6);

  const preview = await request('POST', '/api/branding/preview', {}, session);
  assert.ok(preview.body.html.includes('class="watermark"'));
  assert.ok(preview.body.html.includes('opacity:0.060'));

  const removed = await request('POST', '/api/branding', { clear: ['tradeMark'] }, session);
  assert.equal(removed.body.branding.tradeMark, null);
  const after = await request('POST', '/api/branding/preview', {}, session);
  assert.ok(!after.body.html.includes('class="watermark"'));
});

test('a mark darker than the cap cannot be set from a screen', async () => {
  const session = await signIn();
  const tooDark = await request('POST', '/api/branding', { pictureId: 'cake', opacityPercent: 40 }, session);
  assert.equal(tooDark.status, 422);
  assert.equal(tooDark.body.code, 'TRADE_MARK_TOO_DARK');
});

test('the faint mark is never printed on till roll, whatever the business chose', async () => {
  const session = await signIn();
  await request('POST', '/api/branding', { pictureId: 'cake' }, session);
  const thermal = await request('POST', '/api/branding/preview', { format: 'THERMAL_80MM' }, session);
  assert.ok(!thermal.body.html.includes('class="watermark"'));
  assert.ok(thermal.body.html.includes('SAMPLE/0001'), 'the bill itself is untouched');
});

test('the logo and the colour come off separately, without losing the other', async () => {
  const session = await signIn();
  await request('POST', '/api/branding', { logoDataUri: PNG, accent: '#8a2f14', pictureId: 'cake' }, session);

  const withoutLogo = await request('POST', '/api/branding', { clear: ['logo'] }, session);
  assert.equal(withoutLogo.body.branding.logoDataUri, null);
  assert.equal(withoutLogo.body.branding.accent, '#8a2f14');
  assert.equal(withoutLogo.body.branding.tradeMark.pictureId, 'cake');

  const withoutAccent = await request('POST', '/api/branding', { clear: ['accent'] }, session);
  assert.equal(withoutAccent.body.branding.accent, null);
  assert.equal(withoutAccent.body.branding.tradeMark.pictureId, 'cake');
});

test('branding needs a signed-in session, like everything else about a company', async () => {
  assert.equal((await request('GET', '/api/branding')).status, 401);
  assert.equal((await request('POST', '/api/branding', { accent: '#8a2f14' })).status, 401);
  assert.equal((await request('POST', '/api/branding/preview')).status, 401);
});
