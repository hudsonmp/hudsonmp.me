/**
 * Password-gated cards (e.g. /mom-birthday-2026). The repo is public, so the card itself (the photo) is
 * committed only as ciphertext in cards/<slug>.card, encrypted with CARD_KEY (32 random bytes, never in the repo).
 * The reader's password is checked here on the server against CARD_PASSWORD_<SLUG>; it never reaches the client
 * and the ciphertext is useless without CARD_KEY, so a short password is not open to offline guessing.
 *
 * Vercel env vars (Settings > Environment Variables, marked Sensitive):
 *   CARD_KEY                       base64 of 32 random bytes; shared by every card
 *   CARD_PASSWORD_MOM_BIRTHDAY_2026  the reader password for /mom-birthday-2026 (slug upper-cased, - becomes _)
 *
 * Endpoints (vercel.json maps /__card/:action to api/cards.mjs; the dev server serves the same paths):
 *   POST /__card/unlock {slug, password}  sets an HttpOnly cookie (Path=/__card) for 30 days
 *   GET  /__card/meta?slug=               {width, height, split, v}  (cookie required)
 *   GET  /__card/image?slug=              the image bytes            (cookie required)
 * A card whose password variable is unset answers 404, the same as a card that does not exist.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { blocked, recordMiss, clearMisses } from './auth.mjs';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAGIC = Buffer.from('CARD1');
const COOKIE_DAYS = 30;

export const passwordVar = (slug) => 'CARD_PASSWORD_' + slug.toUpperCase().replace(/-/g, '_');
const cookieName = (slug) => 'card_' + slug.replace(/-/g, '_');
const fail = (status, message) => Object.assign(new Error(message), { status });
const sha = (s) => createHash('sha256').update(String(s ?? '')).digest();
const same = (a, b) => typeof a === 'string' && timingSafeEqual(sha(a), sha(b));
/** exact match, case included; only stray spaces around it (phone keyboards) are ignored */
const norm = (s) => String(s).normalize('NFC').trim();
/** independent keys for sealing and for cookies, both derived from CARD_KEY */
const subkey = (key, label) => createHmac('sha256', key).update(label).digest();

export function cardKey(env) {
  const raw = env.CARD_KEY;
  if (!raw) throw fail(503, 'cards are not configured: set CARD_KEY');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw fail(503, 'CARD_KEY must be base64 of exactly 32 bytes');
  return key;
}

/**
 * File format: "CARD1" | iv (12) | tag (16) | AES-256-GCM( u32 metaLength | meta JSON | image bytes ).
 * The slug is bound in as associated data, so one card's file can't be served under another card's password.
 */
export function sealCard(slug, meta, image, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', subkey(key, 'seal'), iv);
  c.setAAD(Buffer.from('card:' + slug));
  const m = Buffer.from(JSON.stringify(meta));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(m.length);
  const data = Buffer.concat([c.update(Buffer.concat([len, m, image])), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), data]);
}

export function openCard(slug, sealed, key) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw fail(500, 'not a card file');
  let at = MAGIC.length;
  const iv = sealed.subarray(at, (at += 12));
  const tag = sealed.subarray(at, (at += 16));
  const d = createDecipheriv('aes-256-gcm', subkey(key, 'seal'), iv);
  d.setAAD(Buffer.from('card:' + slug));
  d.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([d.update(sealed.subarray(at)), d.final()]);
  } catch {
    throw fail(500, 'card does not decrypt: CARD_KEY differs from the key it was sealed with');
  }
  const n = plain.readUInt32BE(0);
  return { meta: JSON.parse(plain.subarray(4, 4 + n).toString('utf8')), image: plain.subarray(4 + n) };
}

// cookie value: "<expiry seconds>.<mac>". The mac covers the password's hash, so changing the password signs everyone out.
function mac(key, slug, password, exp) {
  return createHmac('sha256', subkey(key, 'cookie')).update(`${slug}|${exp}|`).update(sha(password)).digest('base64url');
}
function validCookie(value, key, slug, password, nowMs) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
  if (!m || Number(m[1]) * 1000 < nowMs) return false;
  return timingSafeEqual(Buffer.from(m[2]), Buffer.from(mac(key, slug, password, m[1])));
}

/** Pure request handler: no I/O except `readCard`. Returns {status, json} or {status, bytes, type}, plus `cookie`/`miss`. */
export function createCards({ env, readCard, now = () => Date.now() }) {
  return async ({ method, action, query = {}, body = {}, cookies = {}, secure = true }) => {
    const slug = String((method === 'POST' ? body?.slug : query.slug) ?? '');
    const password = SLUG.test(slug) ? env[passwordVar(slug)] : undefined;
    if (!password) return { status: 404, json: { error: 'not found' } };
    const key = cardKey(env);

    if (action === 'unlock') {
      if (method !== 'POST') return { status: 405, json: { error: 'method not allowed' } };
      if (typeof body?.password !== 'string' || !same(norm(body.password), norm(password))) return { status: 401, json: { error: 'wrong password' }, miss: true };
      const exp = String(Math.floor(now() / 1000) + COOKIE_DAYS * 86400);
      const cookie = [
        `${cookieName(slug)}=${exp}.${mac(key, slug, password, exp)}`,
        'Path=/__card',
        `Max-Age=${COOKIE_DAYS * 86400}`,
        'HttpOnly',
        'SameSite=Strict',
        ...(secure ? ['Secure'] : []),
      ].join('; ');
      return { status: 200, json: { ok: true }, cookie };
    }

    if (action !== 'meta' && action !== 'image') return { status: 404, json: { error: 'not found' } };
    if (method !== 'GET') return { status: 405, json: { error: 'method not allowed' } };
    if (!validCookie(cookies[cookieName(slug)], key, slug, password, now())) return { status: 401, json: { error: 'locked' } };

    const sealed = await readCard(slug);
    if (!sealed) return { status: 409, json: { error: 'not ready yet' } };
    const { meta, image } = openCard(slug, sealed, key);
    if (action === 'meta') {
      const { type, ...rest } = meta;
      return { status: 200, json: rest };
    }
    return { status: 200, bytes: image, type: meta.type, cache: 'private, max-age=86400' };
  };
}

/** cards/<slug>.card under `root`, or null if it isn't there yet */
export const fileReader = (root) => async (slug) => {
  try {
    return await fs.readFile(path.join(root, 'cards', `${slug}.card`));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    if ((size += c.length) > 16 * 1024) throw fail(413, 'request too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** Node (req, res) adapter shared by the Vercel function and the dev server. */
export async function serveCards(req, res, { env, root, local = false }) {
  const send = (status, body, type = 'application/json', cache = 'no-store') => {
    res.statusCode = status;
    res.setHeader('content-type', type);
    res.setHeader('cache-control', cache);
    res.setHeader('x-robots-tag', 'noindex');
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    // on Vercel the rewrite passes ?action=; on the dev server the action is the last path segment
    const action = url.searchParams.get('action') ?? url.pathname.split('/').filter(Boolean).pop();
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== host) return send(403, { error: 'forbidden' });

    const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',')[0].trim();
    if (req.method === 'POST' && blocked(ip)) return send(429, { error: 'too many tries; wait a few minutes' });

    const handle = createCards({ env, readCard: fileReader(root) });
    const out = await handle({
      method: req.method,
      action,
      query: Object.fromEntries(url.searchParams),
      body: req.method === 'POST' ? await readBody(req) : {},
      cookies: parseCookies(req.headers.cookie),
      secure: !local,
    });
    if (out.miss) await recordMiss(ip);
    else if (out.cookie) clearMisses(ip);
    if (out.cookie) res.setHeader('set-cookie', out.cookie);
    if (out.bytes) return send(out.status, out.bytes, out.type, out.cache);
    return send(out.status, out.json);
  } catch (e) {
    return send(e.status ?? 500, { error: String(e?.message ?? e) });
  }
}
