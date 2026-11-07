/**
 * Local publishing for the password-gated editors (dev server only: `npm run dev`).
 *
 *   POST /__readings/save   { key, items:[{title,url}] }  -> writes src/data/readings.json
 *   POST /__readings/title  { key, url }                  -> { title } read from the page's <title>/og:title
 *
 *   GET  /__essays/check?slug=<slug>         -> { exists, private }
 *   POST /__essays/publish  { key, slug, title, date, body, assets:[{name,type,data}], overwrite, private }
 *        public:  writes src/essays/<slug>.md and public/essays/<slug>/<asset>, rewrites `asset:<name>` refs
 *        private: images are inlined, the markdown is sealed with the reader passwords (src/lib/seal.js),
 *                 and only ciphertext is written (no public image files)
 *   POST /__essays/list     { key }                     -> { essays:[{slug,title,date,private}] }
 *   POST /__essays/privacy  { key, slug, private }      -> seal / unseal an existing essay
 *   POST /__essays/delete   { key, slug }               -> removes the essay and its images
 *   POST /__essays/passwords { key, passwords? }        -> read, or replace + re-seal every private essay
 *   POST /__essays/fetch    { key, url }     -> image bytes (server-side fetch, so Docs/remote images
 *                                               become real files even when the host blocks CORS)
 *
 * Reader passwords live in .private/essay-passwords.json (gitignored: the repo is public). Without that file
 * existing private essays can't be re-sealed or made public again, so back it up.
 *
 * Every write/fetch re-checks the password hash server-side. Nothing here exists in the production build;
 * going live = commit + deploy the written files.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD_SHA256 } from '../src/lib/editor-key.js';
import { seal, unseal } from '../src/lib/seal.js';

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
const fail = (status, message) => Object.assign(new Error(message), { status });

const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const EXT = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]));

function parseFrontmatter(src) {
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^(["'])(.*)\1$/, '$2').trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

const serialize = ({ title, date, isPrivate }, body) =>
  `---\ntitle: ${title}\ndate: ${date}\n${isPrivate ? 'private: true\n' : ''}---\n\n${body.trimEnd()}\n`;

export default function localPublish() {
  let root = process.cwd();
  return {
    name: 'local-publish',
    hooks: {
      'astro:config:done': ({ config }) => {
        root = fileURLToPath(config.root);
      },
      'astro:server:setup': ({ server, logger }) => {
        const essaysDir = path.join(root, 'src', 'essays');
        const mdPath = (slug) => path.join(essaysDir, `${slug}.md`);
        const assetDir = (slug) => path.join(root, 'public', 'essays', slug);
        const passwordsFile = path.join(root, '.private', 'essay-passwords.json');

        async function readPasswords() {
          try { return JSON.parse(await fs.readFile(passwordsFile, 'utf8')).passwords ?? []; } catch { return []; }
        }
        async function writePasswords(passwords) {
          await fs.mkdir(path.dirname(passwordsFile), { recursive: true });
          await fs.writeFile(passwordsFile, JSON.stringify({ passwords }, null, 2) + '\n');
        }

        async function readEssay(slug) {
          const src = await fs.readFile(mdPath(slug), 'utf8');
          const { meta, body } = parseFrontmatter(src);
          return { slug, title: meta.title || slug, date: meta.date || '', isPrivate: meta.private === 'true', body };
        }
        async function listEssays() {
          let files = [];
          try { files = (await fs.readdir(essaysDir)).filter((f) => f.endsWith('.md')); } catch {}
          const all = await Promise.all(files.map((f) => readEssay(f.slice(0, -3))));
          return all
            .map(({ slug, title, date, isPrivate }) => ({ slug, title, date, private: isPrivate }))
            .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
        }

        async function openSealed(essay, passwords) {
          const payload = JSON.parse(essay.body);
          for (const p of passwords) {
            const text = await unseal(payload, p);
            if (text !== null) return text;
          }
          throw fail(409, `can't open "${essay.title}" with the saved passwords (.private/essay-passwords.json)`);
        }

        /** /essays/<slug>/img-*.png references -> data URIs (so a sealed essay carries its images). */
        async function inlineImages(md, slug) {
          const re = new RegExp(`/essays/${slug}/(img-[0-9a-f]+\\.(png|jpg|gif|webp|avif))`, 'g');
          let out = md;
          const refs = new Map([...md.matchAll(re)].map((m) => [m[0], m]));
          for (const [ref, [, name, ext]] of refs) {
            const buf = await fs.readFile(path.join(assetDir(slug), name));
            out = out.replaceAll(ref, `data:${MIME[ext]};base64,${buf.toString('base64')}`);
          }
          return out;
        }

        /** data:image URIs -> files in public/essays/<slug>/ (when an essay is made public again). */
        async function extractImages(md, slug) {
          const dir = assetDir(slug);
          const re = /data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/=]+)/g;
          const files = [];
          let out = md;
          for (const m of [...md.matchAll(re)]) {
            const buf = Buffer.from(m[2], 'base64');
            const name = `img-${createHash('sha256').update(buf).digest('hex').slice(0, 12)}.${EXT[m[1]]}`;
            if (!files.includes(name)) {
              await fs.mkdir(dir, { recursive: true });
              await fs.writeFile(path.join(dir, name), buf);
              files.push(name);
            }
            out = out.replace(m[0], `/essays/${slug}/${name}`);
          }
          return out;
        }

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
          if (req.method === 'POST' && MUTATING.has((req.url ?? '').split('?')[0])) {
            res.on('finish', () => { if (res.statusCode === 200) refresh(); });
          }
          if (!req.url?.startsWith('/__essays/') && !req.url?.startsWith('/__readings/')) return next();
          // reject cross-site requests to the local dev server
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' });

          try {
            const url = new URL(req.url, 'http://localhost');

            if (req.method === 'GET' && url.pathname === '/__essays/check') {
              const slug = url.searchParams.get('slug') ?? '';
              if (!SLUG.test(slug)) return send(res, 400, { error: 'invalid slug' });
              const found = await exists(mdPath(slug));
              return send(res, 200, { exists: found, private: found && (await readEssay(slug)).isPrivate, reserved: RESERVED.has(slug) });
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

            if (url.pathname === '/__essays/list') {
              return send(res, 200, { essays: await listEssays() });
            }

            if (url.pathname === '/__essays/delete') {
              const slug = String(body.slug ?? '');
              if (!SLUG.test(slug) || !(await exists(mdPath(slug)))) return send(res, 404, { error: 'no such essay' });
              await fs.rm(mdPath(slug));
              await fs.rm(assetDir(slug), { recursive: true, force: true });
              logger.info(`deleted /essays/${slug}`);
              return send(res, 200, { essays: await listEssays() });
            }

            if (url.pathname === '/__essays/privacy') {
              const slug = String(body.slug ?? '');
              if (!SLUG.test(slug) || !(await exists(mdPath(slug)))) return send(res, 404, { error: 'no such essay' });
              const essay = await readEssay(slug);
              const makePrivate = !!body.private;
              const passwords = await readPasswords();
              if (makePrivate && !essay.isPrivate) {
                if (!passwords.length) return send(res, 400, { error: 'add a password for private essays first' });
                const sealed = await seal(await inlineImages(essay.body, slug), passwords);
                await fs.writeFile(mdPath(slug), serialize({ ...essay, isPrivate: true }, JSON.stringify(sealed)));
                await fs.rm(assetDir(slug), { recursive: true, force: true });
              } else if (!makePrivate && essay.isPrivate) {
                const plain = await openSealed(essay, passwords);
                await fs.rm(assetDir(slug), { recursive: true, force: true });
                await fs.writeFile(mdPath(slug), serialize({ ...essay, isPrivate: false }, await extractImages(plain, slug)));
              }
              logger.info(`/essays/${slug} is now ${makePrivate ? 'private' : 'public'}`);
              return send(res, 200, { essays: await listEssays() });
            }

            if (url.pathname === '/__essays/passwords') {
              const current = await readPasswords();
              if (!Array.isArray(body.passwords)) return send(res, 200, { passwords: current });

              const next = [...new Set(body.passwords.map((p) => String(p ?? '').trim()).filter(Boolean))];
              if (next.some((p) => p.length > 200)) return send(res, 400, { error: 'password too long' });
              const privates = (await listEssays()).filter((e) => e.private);
              if (!next.length && privates.length) return send(res, 400, { error: 'private essays need at least one password' });

              const same = next.length === current.length && next.every((p) => current.includes(p));
              if (!same && privates.length) {
                // open everything with the old passwords before writing anything
                const opened = [];
                for (const e of privates) {
                  const essay = await readEssay(e.slug);
                  opened.push({ essay, text: await openSealed(essay, current) });
                }
                for (const { essay, text } of opened) {
                  await fs.writeFile(mdPath(essay.slug), serialize(essay, JSON.stringify(await seal(text, next))));
                }
              }
              await writePasswords(next);
              logger.info(`saved ${next.length} reader password${next.length === 1 ? '' : 's'}${same ? '' : `, re-sealed ${privates.length} private essay${privates.length === 1 ? '' : 's'}`}`);
              return send(res, 200, { passwords: next, resealed: same ? 0 : privates.length });
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

              const isPrivate = !!body.private;
              const passwords = isPrivate ? await readPasswords() : [];
              if (isPrivate && !passwords.length) return send(res, 400, { error: 'add a password for private essays first' });

              let md = String(body.body ?? '').replace(/\r\n?/g, '\n').replace(/^\s+/, '');
              for (const a of assets) {
                const ref = isPrivate ? `data:${a.type || MIME[a.name.split('.').pop()]};base64,${a.data}` : `/essays/${slug}/${a.name}`;
                md = md.replaceAll(`asset:${a.name}`, ref);
              }
              const unresolved = [...md.matchAll(/asset:(img-[0-9a-f]+\.\w+)/g)].map((m) => m[1]);
              if (unresolved.length) return send(res, 400, { error: `missing image data for ${unresolved.join(', ')}` });

              const dir = assetDir(slug);
              await fs.rm(dir, { recursive: true, force: true });
              if (isPrivate) {
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(file, serialize({ title, date, isPrivate: true }, JSON.stringify(await seal(md, passwords))));
                logger.info(`published /essays/${slug} (private)`);
                return send(res, 200, { url: `/essays/${slug}`, files: [path.relative(root, file)], private: true });
              }
              if (assets.length) await fs.mkdir(dir, { recursive: true });
              for (const a of assets) {
                const buf = Buffer.from(String(a.data ?? ''), 'base64');
                if (buf.length > MAX_IMAGE) return send(res, 413, { error: `${a.name} too large` });
                await fs.writeFile(path.join(dir, a.name), buf);
              }
              await fs.mkdir(path.dirname(file), { recursive: true });
              await fs.writeFile(file, serialize({ title, date, isPrivate: false }, md));

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
