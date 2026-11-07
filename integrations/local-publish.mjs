/**
 * Local publishing for the password-gated editors (dev server only: `npm run dev`).
 * The logic lives in server/publish-core.mjs (shared with the deployed site's api/publish.mjs); here it is
 * wired to the filesystem, so a publish writes files into the working tree and you commit them yourself.
 *
 * Password: set PUBLISH_PASSWORD (12+ characters) in .env.local to use the same password as the deployed
 * site. Without it, the old editor password (hash in src/lib/editor-key.js) still works locally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublisher } from '../server/publish-core.mjs';
import { fsStore } from '../server/stores.mjs';
import { makeVerify } from '../server/auth.mjs';

const MAX_BODY = 80 * 1024 * 1024;

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store');
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** KEY=value lines from .env.local / .env (real environment variables win). */
function loadEnv(root) {
  const env = { ...process.env };
  for (const name of ['.env', '.env.local']) {
    let text;
    try { text = fs.readFileSync(path.join(root, name), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return env;
}

export default function localPublish() {
  let root = process.cwd();
  return {
    name: 'local-publish',
    hooks: {
      'astro:config:done': ({ config }) => {
        root = fileURLToPath(config.root);
      },
      'astro:server:setup': ({ server, logger }) => {
        const handle = createPublisher({
          store: fsStore(root),
          verify: (key) => makeVerify({ env: loadEnv(root), local: true })(key),
          log: (m) => logger.info(m),
        });

        // The file watcher can miss a delete-then-recreate of the same file (macOS coalesces the events), which left
        // a deleted essay being served. After every successful change, drop cached modules and reload explicitly.
        const MUTATING = new Set(['/__essays/delete', '/__essays/privacy', '/__essays/passwords', '/__essays/publish']);
        let refreshTimer;
        function refresh() {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            const graphs = new Set([server.moduleGraph, ...Object.values(server.environments ?? {}).map((env) => env.moduleGraph)]);
            for (const g of graphs) g?.invalidateAll?.();
            server.hot.send({ type: 'full-reload' });
          }, 150);
        }

        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (!url.pathname.startsWith('/__essays/') && !url.pathname.startsWith('/__readings/')) return next();
          if (req.method === 'POST' && MUTATING.has(url.pathname)) {
            res.on('finish', () => { if (res.statusCode === 200) refresh(); });
          }
          // reject cross-site requests to the local dev server
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' });
          try {
            const body = req.method === 'POST' ? await readJson(req) : {};
            const out = await handle({ method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body });
            if (out.bytes) return send(res, out.status, out.bytes, out.type);
            return send(res, out.status, out.json);
          } catch (e) {
            return send(res, e.status ?? 500, { error: String(e?.message ?? e) });
          }
        });
      },
    },
  };
}
