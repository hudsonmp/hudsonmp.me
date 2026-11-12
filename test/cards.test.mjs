// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createCards, seal, unseal, passwordVar } from '../server/cards.mjs';

const SLUG = 'mom-birthday-2026';
const key = randomBytes(32);
const env = { CARD_KEY: key.toString('base64'), [passwordVar(SLUG)]: 'test-password' };
const meta = {
  spread: { id: 'spread', width: 400, height: 200, split: 0.5, v: 'abc', hotspot: { x: 0.6, y: 0.8, w: 0.1, h: 0.05 } },
  photos: [{ id: 'p1', thumb: 'p1t', width: 300, height: 400, v: 'def' }],
  alt: 'a private caption',
};
const spread = randomBytes(5000);
const photo = randomBytes(3000);
const files = {
  [`${SLUG}/meta`]: seal(SLUG, 'meta', Buffer.from(JSON.stringify(meta)), key),
  [`${SLUG}/spread`]: seal(SLUG, 'spread', spread, key),
  [`${SLUG}/p1`]: seal(SLUG, 'p1', photo, key),
};

function setup(over = {}, readFile = async (slug, id) => files[`${slug}/${id}`] ?? null) {
  let t = 1_800_000_000_000;
  const handle = createCards({ env: { ...env, ...over }, readFile, now: () => t });
  return { handle, advance: (ms) => (t += ms) };
}
const unlock = (handle, password, slug = SLUG) => handle({ method: 'POST', action: 'unlock', body: { slug, password } });
const cookieFrom = (out) => Object.fromEntries([out.cookie.split(';')[0].split('=')]);
const get = (handle, action, cookies, query = {}) => handle({ method: 'GET', action, query: { slug: SLUG, ...query }, cookies });

test('sealed files round-trip and are bound to their card, their id and the key', () => {
  const sealed = files[`${SLUG}/spread`];
  assert.ok(unseal(SLUG, 'spread', sealed, key).equals(spread));
  assert.throws(() => unseal('someone-else', 'spread', sealed, key));
  assert.throws(() => unseal(SLUG, 'p1', sealed, key), 'a file cannot be served under another id');
  assert.throws(() => unseal(SLUG, 'spread', sealed, randomBytes(32)));
  assert.equal(files[`${SLUG}/meta`].includes(Buffer.from('a private caption')), false, 'metadata is not readable');
  assert.equal(sealed.includes(spread.subarray(0, 64)), false, 'image bytes are not readable');
});

test('wrong password is refused and counted; right one sets a scoped HttpOnly cookie', async () => {
  const { handle } = setup();
  const bad = await unlock(handle, 'test-passwor');
  assert.equal(bad.status, 401);
  assert.equal(bad.miss, true);
  assert.equal(bad.cookie, undefined);
  assert.equal((await unlock(handle, 'Test-Password')).status, 401, 'case matters');
  const ok = await unlock(handle, ' test-password ');
  assert.equal(ok.status, 200);
  assert.match(ok.cookie, /^card_mom_birthday_2026=\d+\.[\w-]{43}; Path=\/__card; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure$/);
});

test('meta and images need a valid cookie', async () => {
  const { handle, advance } = setup();
  assert.equal((await get(handle, 'meta', {})).status, 401);
  assert.equal((await get(handle, 'image', { card_mom_birthday_2026: '9999999999.' + 'A'.repeat(43) }, { id: 'spread' })).status, 401);
  const c = cookieFrom(await unlock(handle, 'test-password'));
  const m = await get(handle, 'meta', c);
  assert.equal(m.status, 200);
  assert.deepEqual(m.json, meta);
  const img = await get(handle, 'image', c, { id: 'spread' });
  assert.equal(img.type, 'image/webp');
  assert.ok(img.bytes.equals(spread));
  assert.match(img.cache, /^private/);
  assert.ok((await get(handle, 'image', c, { id: 'p1' })).bytes.equals(photo));
  advance(31 * 86400 * 1000);
  assert.equal((await get(handle, 'meta', c)).status, 401, 'cookie expires');
});

test('image ids are validated: no metadata, traversal or missing files through the image endpoint', async () => {
  const { handle } = setup();
  const c = cookieFrom(await unlock(handle, 'test-password'));
  for (const id of ['meta', '../meta', 'P1', '', 'p2']) assert.equal((await get(handle, 'image', c, { id })).status, 404, id);
});

test('changing the password signs readers out', async () => {
  const c = cookieFrom(await unlock(setup().handle, 'test-password'));
  const { handle } = setup({ [passwordVar(SLUG)]: 'something-else' });
  assert.equal((await get(handle, 'meta', c)).status, 401);
});

test('unknown or unconfigured cards look the same as missing ones', async () => {
  const { handle } = setup();
  assert.equal((await unlock(handle, 'test-password', 'dad-birthday')).status, 404);
  assert.equal((await unlock(handle, 'test-password', '../etc')).status, 404);
  assert.equal((await handle({ method: 'GET', action: 'meta', query: { slug: 'nope' }, cookies: {} })).status, 404);
});

test('a configured card without its files yet says so after unlocking', async () => {
  const { handle } = setup({}, async () => null);
  const c = cookieFrom(await unlock(handle, 'test-password'));
  assert.equal((await get(handle, 'meta', c)).status, 409);
});

test('missing or malformed CARD_KEY is a configuration error, not a crash', async () => {
  const { handle } = setup({ CARD_KEY: 'short' });
  await assert.rejects(unlock(handle, 'test-password'), /32 bytes/);
});
