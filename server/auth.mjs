import { createHash, timingSafeEqual } from 'node:crypto';
import { PASSWORD_SHA256 } from '../src/lib/editor-key.js';
import { fail, strongKey } from './publish-core.mjs';

const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

/**
 * Deployed site: the only way in is PUBLISH_PASSWORD (a Vercel env var, never in the repo).
 * Local dev: PUBLISH_PASSWORD from .env.local if set, otherwise the old hash in src/lib/editor-key.js.
 */
export function makeVerify({ env, local }) {
  return async (key) => {
    if (typeof key !== 'string' || !key) return false;
    const secret = env.PUBLISH_PASSWORD;
    if (secret) {
      if (!strongKey(secret)) throw fail(503, 'PUBLISH_PASSWORD must be at least 12 characters');
      return same(key, secret);
    }
    if (local) return digest(key).toString('hex') === PASSWORD_SHA256;
    throw fail(503, 'publishing is not configured: set PUBLISH_PASSWORD and GITHUB_TOKEN in the Vercel project settings');
  };
}

// Best effort per serverless instance: a few wrong guesses locks that address out for a while, and every wrong
// guess is slow. The real defence is a long password.
const misses = new Map();
const WINDOW = 10 * 60_000;
const MAX_MISSES = 8;

export function blocked(ip) {
  const m = misses.get(ip);
  if (!m) return false;
  if (Date.now() - m.first > WINDOW) { misses.delete(ip); return false; }
  return m.n >= MAX_MISSES;
}
export async function recordMiss(ip) {
  const m = misses.get(ip);
  if (!m || Date.now() - m.first > WINDOW) misses.set(ip, { n: 1, first: Date.now() });
  else m.n++;
  await new Promise((r) => setTimeout(r, 700));
}
export const clearMisses = (ip) => misses.delete(ip);
