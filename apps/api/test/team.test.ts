/**
 * Issue #343 — the team: invite, accept, change a role, remove (their sessions end at once), hand
 * the business over, and leave; the last owner cannot leave; an invitation is for its address only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { DEMO_SIGN_IN_CODE } from '../../../packages/platform/src/seed.ts';
import { signIn, tokenFrom } from './sign-in-helper.ts';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
const call = async (method: string, path: string, body: unknown, token?: string) => {
  const reply = await handleApi(method, path, body, token === undefined ? undefined : `Bearer ${token}`);
  return { status: reply.status, headers: reply.headers, body: JSON.parse(String(reply.body)) as Record<string, any> };
};
const team = async (token: string) => (await call('GET', '/api/team', {}, token)).body.members as { userId: string; name: string; role: string; you: boolean }[];
const joinWith = (address: string, invitation: string) => call('POST', '/api/auth/sign-in', { address, code: DEMO_SIGN_IN_CODE, invitation });

test('#343: an owner invites a cashier by phone; the cashier joins by signing in with the link, as staff', async () => {
  const owner = await signIn('owner@sampoorna.example.invalid', SAMPOORNA);
  const invited = await call('POST', '/api/team/invite', { address: '98765 01234', role: 'staff' }, owner);
  assert.equal(invited.status, 200, invited.body.message);
  assert.equal(invited.body.invitation.address, '+919876501234');
  assert.match(invited.body.link, /^\/#join=/);
  const days = (Date.parse(invited.body.invitation.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 6.99 && days <= 7, `an invitation lasts 7 days, not ${days}`);
  const token = decodeURIComponent(invited.body.link.slice('/#join='.length));

  // Someone else who has the link cannot take it up: it is for the number it was sent to.
  const stranger = await joinWith('+919876509999', token);
  assert.equal(stranger.status, 400);
  assert.match(stranger.body.message, /sent to a different number or email/);

  const joined = await joinWith('9876501234', token);
  assert.equal(joined.status, 200, joined.body.message);
  assert.equal(joined.body.company.id, SAMPOORNA);
  const cashier = tokenFrom(joined.headers)!;
  const session = (await call('GET', '/api/session', {}, cashier)).body;
  assert.ok(session.permissions.includes('sales.draft.write'));
  assert.ok(!session.permissions.includes('bank.balance.read'), 'a cashier cannot see bank balances (handbook #3)');
  assert.ok(!session.permissions.includes('gst_returns.submit'), 'nor file GST');
  assert.ok(!session.permissions.includes('inventory.adjust'), 'nor override stock');
  assert.ok((await team(owner)).some((member) => member.name === '+919876501234' && member.role === 'staff'));

  // Used once: the same link does nothing a second time.
  assert.equal((await joinWith('9876501234', token)).status, 400);
});

test('#343: nobody is made an owner by an invitation or a role change, and only an owner touches admins', async () => {
  const owner = await signIn('owner@sampoorna.example.invalid', SAMPOORNA);
  const admin = await signIn('admin@sampoorna.example.invalid', SAMPOORNA);
  assert.match((await call('POST', '/api/team/invite', { address: 'new@example.invalid', role: 'owner' }, owner)).body.message, /hands the business over/);
  assert.equal((await call('POST', '/api/team/invite', { address: 'another-admin@example.invalid', role: 'admin' }, admin)).status, 403, 'an admin cannot make admins');
  assert.equal((await call('POST', '/api/team/invite', { address: 'counter@example.invalid', role: 'staff' }, admin)).status, 200, 'an admin can invite staff');
  const members = await team(owner);
  const ownerId = members.find((member) => member.role === 'owner')!.userId;
  const viewerId = members.find((member) => member.name === 'viewer@sampoorna.example.invalid')!.userId;
  assert.equal((await call('POST', '/api/team/role', { userId: ownerId, role: 'viewer' }, admin)).status, 403, 'an admin cannot demote the owner');
  assert.equal((await call('POST', '/api/team/remove', { userId: ownerId }, admin)).status, 403, 'nor remove them');
  assert.match((await call('POST', '/api/team/role', { userId: viewerId, role: 'owner' }, owner)).body.message, /hands the business over/);
  assert.match((await call('POST', '/api/team/role', { userId: ownerId, role: 'admin' }, owner)).body.message, /cannot change or remove yourself/);
  assert.equal((await call('POST', '/api/team/remove', { userId: '00000000-0000-4000-8000-000000000013' }, owner)).status, 404, "Konkan's owner is not in Sampoorna");
});

test('#343: a role change takes effect on the next request; a removed member is signed out at once', async () => {
  const owner = await signIn('owner@sampoorna.example.invalid', SAMPOORNA);
  const staff = await signIn('counter@sampoorna.example.invalid', SAMPOORNA);
  const staffId = (await team(owner)).find((member) => member.name === 'counter@sampoorna.example.invalid')!.userId;
  assert.equal((await call('GET', '/api/catalogue', {}, staff)).status, 200);
  const changed = await call('POST', '/api/team/role', { userId: staffId, role: 'viewer' }, owner);
  assert.equal(changed.status, 200, changed.body.message);
  assert.equal((await call('GET', '/api/catalogue', {}, staff)).status, 403, 'now a viewer: no customer list');
  assert.equal((await call('POST', '/api/team/role', { userId: staffId, role: 'staff' }, owner)).status, 200);
  assert.equal((await call('GET', '/api/catalogue', {}, staff)).status, 200);

  const removed = await call('POST', '/api/team/remove', { userId: staffId }, owner);
  assert.equal(removed.status, 200, removed.body.message);
  assert.equal((await call('GET', '/api/session', {}, staff)).status, 401, 'their session ended at once');
  assert.equal((await call('POST', '/api/auth/sign-in', { address: 'counter@sampoorna.example.invalid', code: DEMO_SIGN_IN_CODE }, undefined)).status, 403, 'and they belong to no business now');
});

test('#343: the only owner cannot leave until they hand the business over; then they stay on as an admin', async () => {
  const owner = await signIn('owner@konkan.example.invalid', KONKAN);
  const left = await call('POST', '/api/team/leave', {}, owner);
  assert.equal(left.status, 400);
  assert.match(left.body.message, /only owner/);
  assert.equal((await call('GET', '/api/session', {}, owner)).status, 200, 'refused, and still signed in');

  const accountantId = (await team(owner)).find((member) => member.name === 'accounts@konkan.example.invalid')!.userId;
  const viewer = await signIn('viewer@konkan.example.invalid', KONKAN);
  assert.equal((await call('POST', '/api/team/transfer', { userId: accountantId }, viewer)).status, 403, 'a viewer cannot hand anything over');
  const handed = await call('POST', '/api/team/transfer', { userId: accountantId }, owner);
  assert.equal(handed.status, 200, handed.body.message);
  const roles = Object.fromEntries((handed.body.members as { name: string; role: string }[]).map((member) => [member.name, member.role]));
  assert.equal(roles['accounts@konkan.example.invalid'], 'owner');
  assert.equal(roles['owner@konkan.example.invalid'], 'admin');
  assert.equal((await call('POST', '/api/team/transfer', { userId: accountantId }, owner)).status, 403, 'no longer the owner, so no longer able to hand over');

  const leaving = await call('POST', '/api/team/leave', {}, owner);
  assert.equal(leaving.status, 200, leaving.body.message);
  assert.match(leaving.headers['set-cookie']!, /Max-Age=0/);
  assert.equal((await call('GET', '/api/session', {}, owner)).status, 401);
});

test('#343: a viewer calling the team routes directly, not through the screen, is refused (403)', async () => {
  const viewer = await signIn('viewer@sampoorna.example.invalid', SAMPOORNA);
  for (const [path, body] of [['/api/team/invite', { address: 'x@example.invalid', role: 'staff' }], ['/api/team/role', { userId: 'x', role: 'staff' }], ['/api/team/remove', { userId: 'x' }]] as const) {
    assert.equal((await call('POST', path, body, viewer)).status, 403, path);
  }
  assert.equal((await call('GET', '/api/team', {}, viewer)).status, 403);
});
