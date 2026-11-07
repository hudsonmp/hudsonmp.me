/**
 * Publishing from the deployed site. vercel.json maps /__essays/* and /__readings/* here, so the editors call
 * the same URLs as on the dev server. Changes are committed to GitHub; Vercel rebuilds on the push.
 *
 * Needed in the Vercel project (Settings > Environment Variables):
 *   PUBLISH_PASSWORD  the editor password, 12+ characters
 *   GITHUB_TOKEN      fine-grained token for this repo only: Contents read and write
 * Optional: GITHUB_REPO (default hudsonmp/hudsonmp.me), GITHUB_BRANCH (default main)
 */
import { createPublisher } from '../server/publish-core.mjs';
import { githubStore } from '../server/stores.mjs';
import { makeVerify, blocked, recordMiss, clearMisses } from '../server/auth.mjs';

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store');
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const scope = url.searchParams.get('scope');
    const action = url.searchParams.get('action');
    if (!['essays', 'readings'].includes(scope) || !/^[a-z]+$/.test(action ?? '')) return send(res, 404, { error: 'not found' });
    const pathname = `/__${scope}/${action}`;

    // refuse cross-site requests
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    if (origin && new URL(origin).host !== host) return send(res, 403, { error: 'forbidden' });

    const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',')[0].trim();
    if (blocked(ip)) return send(res, 429, { error: 'too many wrong passwords; try again later' });

    const token = process.env.GITHUB_TOKEN;
    if (!token && req.method === 'POST') return send(res, 503, { error: 'publishing is not configured: set GITHUB_TOKEN in the Vercel project settings' });
    const store = githubStore({
      token,
      repo: process.env.GITHUB_REPO || 'hudsonmp/hudsonmp.me',
      branch: process.env.GITHUB_BRANCH || 'main',
      api: process.env.GITHUB_API || 'https://api.github.com',
    });
    const handle = createPublisher({ store, verify: makeVerify({ env: process.env, local: false }) });

    const body = req.method === 'POST' ? await readBody(req) : {};
    const out = await handle({ method: req.method, pathname, query: Object.fromEntries(url.searchParams), body });
    if (out.status === 401) await recordMiss(ip);
    else if (out.status === 200 && req.method === 'POST') clearMisses(ip);
    if (out.bytes) return send(res, out.status, out.bytes, out.type);
    return send(res, out.status, out.json);
  } catch (e) {
    return send(res, 500, { error: String(e?.message ?? e) });
  }
}
