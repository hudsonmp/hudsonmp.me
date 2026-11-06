/**
 * Local publishing for the password-gated editors (dev server only: `npm run dev`).
 *
 *   POST /__readings/save   { key, items:[{title,url}] }  -> writes src/data/readings.json
 *   POST /__readings/title  { key, url }                  -> { title } read from the page's <title>/og:title
 *
 *   GET  /__essays/check?slug=<slug>         -> { exists }
 *   POST /__essays/publish  { key, slug, title, date, body, assets:[{name,type,data}], overwrite }
 *        writes src/essays/<slug>.md and public/essays/<slug>/<asset>, rewrites `asset:<name>` refs
 *   POST /__essays/fetch    { key, url }     -> image bytes (server-side fetch, so Docs/remote images
 *                                               become real files even when the host blocks CORS)
 *
 * Every write/fetch re-checks the password hash server-side. Nothing here exists in the production build;
 * going live = commit + deploy the written files.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD_SHA256 } from '../src/lib/editor-key.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(['add', 'index']);
const ASSET = /^img-[0-9a-f]{6,64}\.(png|jpg|gif|webp|avif)$/;
const MAX_BODY = 80 * 1024 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;

const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k] ?? m;
  });

const sha256 = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');

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

const exists = (p) => fs.access(p).then(() => true, () => false);

export default function localPublish() {
  let root = process.cwd();
  return {
    name: 'local-publish',
    hooks: {
      'astro:config:done': ({ config }) => {
        root = fileURLToPath(config.root);
      },
      'astro:server:setup': ({ server, logger }) => {
        const mdPath = (slug) => path.join(root, 'src', 'essays', `${slug}.md`);
        const assetDir = (slug) => path.join(root, 'public', 'essays', slug);

        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/__essays/') && !req.url?.startsWith('/__readings/')) return next();
          // reject cross-site requests to the local dev server
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' });

          try {
            const url = new URL(req.url, 'http://localhost');

            if (req.method === 'GET' && url.pathname === '/__essays/check') {
              const slug = url.searchParams.get('slug') ?? '';
              if (!SLUG.test(slug)) return send(res, 400, { error: 'invalid slug' });
              return send(res, 200, { exists: await exists(mdPath(slug)), reserved: RESERVED.has(slug) });
            }

            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
            const body = await readJson(req);
            if (sha256(body.key) !== PASSWORD_SHA256) return send(res, 401, { error: 'wrong password' });

            if (url.pathname === '/__readings/save') {
              const items = Array.isArray(body.items) ? body.items : null;
              if (!items || items.length > 1000) return send(res, 400, { error: 'bad list' });
              const clean = [];
              for (const it of items) {
                const title = String(it?.title ?? '').replace(/\s+/g, ' ').trim();
                const link = String(it?.url ?? '').trim();
                if (!title || title.length > 300) return send(res, 400, { error: 'every reading needs a title' });
                try { if (!/^https?:$/.test(new URL(link).protocol)) throw 0; } catch { return send(res, 400, { error: `not a link: ${link}` }); }
                clean.push({ title, url: link });
              }
              const file = path.join(root, 'src', 'data', 'readings.json');
              await fs.mkdir(path.dirname(file), { recursive: true });
              await fs.writeFile(file, JSON.stringify(clean, null, 2) + '\n');
              logger.info(`saved ${clean.length} readings`);
              return send(res, 200, { items: clean });
            }

            if (url.pathname === '/__readings/title') {
              const target = new URL(String(body.url));
              if (!/^https?:$/.test(target.protocol)) return send(res, 400, { error: 'only http(s) urls' });
              const r = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 (title lookup)' } });
              const html = (await r.text()).slice(0, 1_000_000);
              const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1]
                ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1];
              const t = og ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
              return send(res, 200, { title: decodeEntities(t).replace(/\s+/g, ' ').trim() });
            }

            if (url.pathname === '/__essays/fetch') {
              const target = new URL(String(body.url));
              if (!/^https?:$/.test(target.protocol)) return send(res, 400, { error: 'only http(s) urls' });
              const r = await fetch(target, { redirect: 'follow' });
              const type = (r.headers.get('content-type') ?? '').split(';')[0].trim();
              if (!r.ok || !type.startsWith('image/')) return send(res, 502, { error: `not an image (${r.status} ${type})` });
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length > MAX_IMAGE) return send(res, 413, { error: 'image too large' });
              return send(res, 200, buf, type);
            }

            if (url.pathname === '/__essays/publish') {
              const slug = String(body.slug ?? '');
              const title = String(body.title ?? '').replace(/[\r\n]+/g, ' ').trim();
              const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? '') ? body.date : new Date().toISOString().slice(0, 10);
              if (!SLUG.test(slug) || slug.length > 80) return send(res, 400, { error: 'slug must be lowercase letters, numbers and dashes' });
              if (RESERVED.has(slug)) return send(res, 400, { error: `"${slug}" is reserved` });
              if (!title) return send(res, 400, { error: 'add a title first' });

              const assets = Array.isArray(body.assets) ? body.assets : [];
              for (const a of assets) if (!ASSET.test(a?.name ?? '')) return send(res, 400, { error: `bad asset name ${a?.name}` });

              const file = mdPath(slug);
              if ((await exists(file)) && !body.overwrite) return send(res, 409, { error: 'exists' });

              let md = String(body.body ?? '').replace(/\r\n?/g, '\n').replace(/^\s+/, '');
              for (const a of assets) md = md.replaceAll(`asset:${a.name}`, `/essays/${slug}/${a.name}`);
              const unresolved = [...md.matchAll(/asset:(img-[0-9a-f]+\.\w+)/g)].map((m) => m[1]);
              if (unresolved.length) return send(res, 400, { error: `missing image data for ${unresolved.join(', ')}` });

              const dir = assetDir(slug);
              await fs.rm(dir, { recursive: true, force: true });
              if (assets.length) await fs.mkdir(dir, { recursive: true });
              for (const a of assets) {
                const buf = Buffer.from(String(a.data ?? ''), 'base64');
                if (buf.length > MAX_IMAGE) return send(res, 413, { error: `${a.name} too large` });
                await fs.writeFile(path.join(dir, a.name), buf);
              }
              await fs.mkdir(path.dirname(file), { recursive: true });
              await fs.writeFile(file, `---\ntitle: ${title}\ndate: ${date}\n---\n\n${md.trimEnd()}\n`);

              const written = [path.relative(root, file), ...assets.map((a) => path.relative(root, path.join(dir, a.name)))];
              logger.info(`published /essays/${slug} (${written.length} file${written.length === 1 ? '' : 's'})`);
              return send(res, 200, { url: `/essays/${slug}`, files: written });
            }

            return send(res, 404, { error: 'not found' });
          } catch (e) {
            return send(res, e.status ?? 500, { error: String(e?.message ?? e) });
          }
        });
      },
    },
  };
}
