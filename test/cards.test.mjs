// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createCards, sealCard, openCard, passwordVar } from '../server/cards.mjs';

const key = randomBytes(32);
const env = { CARD_KEY: key.toString('base64'), [passwordVar('mom-birthday-2026')]: 'test-password' };
const meta = { width: 400, height: 200, split: 0.5, v: 'abc', type: 'image/webp', alt: 'a private caption' };
const image = randomBytes(5000);
const sealed = sealCard('mom-birthday-2026', meta, image, key);
const files = { 'mom-birthday-2026': sealed };

function setup(over = {}) {
  let t = 1_800_000_000_000;
  const handle = createCards({ env: { ...env, ...over }, readCard: async (s) => files[s] ?? null, now: () => t });
  return { handle, advance: (ms) => (t += ms) };
}
const unlock = (handle, password, slug = 'mom-birthday-2026') => handle({ method: 'POST', action: 'unlock', body: { slug, password } });
const cookieFrom = (out) => Object.fromEntries([out.cookie.split(';')[0].split('=')]);
const get = (handle, action, cookies, slug = 'mom-birthday-2026') => handle({ method: 'GET', action, query: { slug }, cookies });

test('seal round-trips and is bound to its slug and key', () => {
  const back = openCard('mom-birthday-2026', sealed, key);
  assert.deepEqual(back.meta, meta);
  assert.ok(back.image.equals(image));
  assert.throws(() => openCard('someone-else', sealed, key));
  assert.throws(() => openCard('mom-birthday-2026', sealed, randomBytes(32)));
  assert.equal(sealed.includes(Buffer.from('a private caption')), false, 'metadata must not appear in the ciphertext');
  assert.equal(sealed.includes(image.subarray(0, 64)), false, 'image bytes must not appear in the ciphertext');
});

test('wrong password is refused and counted; right one sets a scoped HttpOnly cookie', async () => {
  const { handle } = setup();
  const bad = await unlock(handle, 'grounde');
  assert.equal(bad.status, 401);
  assert.equal(bad.miss, true);
  assert.equal(bad.cookie, undefined);
  assert.equal((await unlock(handle, 'Test-Password')).status, 401, 'case matters');
  const ok = await unlock(handle, ' test-password ');
  assert.equal(ok.status, 200);
  assert.match(ok.cookie, /^card_mom_birthday_2026=\d+\.[\w-]{43}; Path=\/__card; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure$/);
  assert.equal(JSON.stringify(ok.json).includes('test-password'), false);
});

test('meta and image need a valid cookie', async () => {
  const { handle, advance } = setup();
  assert.equal((await get(handle, 'meta', {})).status, 401);
  assert.equal((await get(handle, 'image', { card_mom_birthday_2026: '9999999999.' + 'A'.repeat(43) })).status, 401);
  const c = cookieFrom(await unlock(handle, 'test-password'));
  const m = await get(handle, 'meta', c);
  assert.equal(m.status, 200);
  assert.equal(m.json.split, 0.5);
  assert.equal(m.json.alt, 'a private caption');
  assert.equal(m.json.type, undefined);
  const img = await get(handle, 'image', c);
  assert.equal(img.type, 'image/webp');
  assert.ok(img.bytes.equals(image));
  assert.match(img.cache, /^private/);
  advance(31 * 86400 * 1000);
  assert.equal((await get(handle, 'meta', c)).status, 401, 'cookie expires');
});

test('changing the password signs readers out', async () => {
  const c = cookieFrom(await unlock(setup().handle, 'test-password'));
  const { handle } = setup({ [passwordVar('mom-birthday-2026')]: 'something-else' });
  assert.equal((await get(handle, 'meta', c)).status, 401);
});

test('unknown or unconfigured cards look the same as missing ones', async () => {
  const { handle } = setup();
  assert.equal((await unlock(handle, 'test-password', 'dad-birthday')).status, 404);
  assert.equal((await unlock(handle, 'test-password', '../etc')).status, 404);
  assert.equal((await get(handle, 'meta', {}, 'nope')).status, 404);
});

test('a configured card without its file yet says so after unlocking', async () => {
  const handle = createCards({ env, readCard: async () => null });
  const c = cookieFrom(await unlock(handle, 'test-password'));
  assert.equal((await get(handle, 'meta', c)).status, 409);
});

test('missing or malformed CARD_KEY is a configuration error, not a crash', async () => {
  const { handle } = setup({ CARD_KEY: 'short' });
  await assert.rejects(unlock(handle, 'test-password'), /32 bytes/);
});
