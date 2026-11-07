/**
 * Publishing logic shared by the local dev server (integrations/local-publish.mjs, writes files) and the
 * deployed site (api/publish.mjs, commits to GitHub, which redeploys). Storage is injected, see ./stores.mjs.
 *
 *   GET  /__essays/check?slug=<slug>                  -> { exists, private, reserved }
 *   POST /__essays/auth      { key }                  -> { ok, mode }
 *   POST /__essays/asset     { key, name, type, data }-> { name, id }       stage one image (keeps requests small)
 *   POST /__essays/publish   { key, slug, title, date, body, assets:[{name,type,id}], overwrite, private }
 *   POST /__essays/list      { key }                  -> { essays:[{slug,title,date,private}] }
 *   POST /__essays/privacy   { key, slug, private }   -> seal / unseal an existing essay
 *   POST /__essays/delete    { key, slug }            -> remove the essay and its images
 *   POST /__essays/passwords { key, passwords? }      -> read, or replace + re-seal every private essay
 *   POST /__essays/fetch     { key, url }             -> image bytes (server-side fetch for remote images)
 *   POST /__readings/save    { key, items }           -> src/data/readings.json
 *   POST /__readings/title   { key, url }             -> { title }
 *
 * Every POST re-checks the publish password. The reader-password list is stored sealed with that password
 * (src/data/reader-passwords.json), so the public repo holds only ciphertext.
 */
import { createHash } from 'node:crypto';
import { seal, unseal } from '../src/lib/seal.js';
import { PASSWORD_SHA256 } from '../src/lib/editor-key.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(['add', 'index']);
const ASSET = /^img-[0-9a-f]{6,64}\.(png|jpg|gif|webp|avif)$/;
const MAX_IMAGE = 25 * 1024 * 1024;
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const EXT = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]));
export const PASSWORDS_FILE = 'src/data/reader-passwords.json';
const READINGS_FILE = 'src/data/readings.json';
const mdPath = (slug) => `src/essays/${slug}.md`;
const assetDir = (slug) => `public/essays/${slug}`;

export const sha256 = (s) => createHash('sha256').update(String(s ?? '')).digest('hex');
export const fail = (status, message) => Object.assign(new Error(message), { status });
const ok = (json) => ({ status: 200, json });
const bad = (status, error) => ({ status, json: { error } });

/** A password that protects the sealed reader-password list must resist offline guessing. */
export const strongKey = (key) => typeof key === 'string' && key.length >= 12 && sha256(key) !== PASSWORD_SHA256;

const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k] ?? m;
  });

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

/** Keep the server from being pointed at its own network. */
function publicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw fail(400, 'not a link'); }
  if (!/^https?:$/.test(u.protocol)) throw fail(400, 'only http(s) urls');
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
    /^\[?(::1?|fe80:|fc|fd)/.test(h) || /^(0|10|127)\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h)
  ) throw fail(400, 'that address is not allowed');
  return u;
}

/**
 * @param store  { mode, read, readBytes, list, stage, readStaged, apply, legacyPasswords? }  see ./stores.mjs
 * @param verify (key) => Promise<boolean>
 */
export function createPublisher({ store, verify, log = () => {} }) {
  /** Changes made while handling one request; applied together (one commit when publishing from the site). */
  const newTx = () => {
    const ops = [];
    return {
      ops,
      write: (path, content) => ops.push({ op: 'write', path, content }),
      remove: (path) => ops.push({ op: 'remove', path }),
      removeDir: (dir) => ops.push({ op: 'removeDir', dir }),
    };
  };

  async function readEssay(slug) {
    const src = await store.read(mdPath(slug));
    if (src === null) return null;
    const { meta, body } = parseFrontmatter(src);
    return { slug, title: meta.title || slug, date: meta.date || '', isPrivate: meta.private === 'true', body };
  }
  async function listEssays() {
    const names = (await store.list('src/essays')).filter((f) => f.endsWith('.md'));
    const all = (await Promise.all(names.map((f) => readEssay(f.slice(0, -3))))).filter(Boolean);
    return all
      .map(({ slug, title, date, isPrivate }) => ({ slug, title, date, private: isPrivate }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  }

  // -- reader passwords: sealed with the publish password so the public repo only holds ciphertext
  async function readPasswords(key) {
    const raw = await store.read(PASSWORDS_FILE);
    if (raw !== null) {
      const text = await unseal(JSON.parse(raw), key);
      if (text === null) throw fail(409, `can't open ${PASSWORDS_FILE} with this publish password (was it changed?)`);
      return JSON.parse(text).passwords ?? [];
    }
    return (await store.legacyPasswords?.()) ?? [];
  }
  async function sealPasswords(passwords, key) {
    return JSON.stringify(await seal(JSON.stringify({ passwords }), [key]), null, 2) + '\n';
  }
  /** One-time: lift the old local-only list into the sealed file so the deployed site can use it too. */
  async function migratePasswords(key) {
    if (!store.legacyPasswords || !strongKey(key) || (await store.read(PASSWORDS_FILE)) !== null) return false;
    const legacy = await store.legacyPasswords();
    if (!legacy.length) return false;
    const tx = newTx();
    tx.write(PASSWORDS_FILE, await sealPasswords(legacy, key));
    await store.apply(tx.ops, 'reader passwords: seal list');
    log(`sealed ${legacy.length} reader password${legacy.length === 1 ? '' : 's'} into ${PASSWORDS_FILE}`);
    return true;
  }

  async function openSealed(essay, passwords) {
    const payload = JSON.parse(essay.body);
    for (const p of passwords) {
      const text = await unseal(payload, p);
      if (text !== null) return text;
    }
    throw fail(409, `can't open "${essay.title}" with the saved reader passwords`);
  }

  /** /essays/<slug>/img-*.png references -> data URIs (so a sealed essay carries its images). */
  async function inlineImages(md, slug) {
    const re = new RegExp(`/essays/${slug}/(img-[0-9a-f]+\\.(png|jpg|gif|webp|avif))`, 'g');
    let out = md;
    const refs = new Map([...md.matchAll(re)].map((m) => [m[0], m]));
    for (const [ref, [, name, ext]] of refs) {
      const buf = await store.readBytes(`${assetDir(slug)}/${name}`);
      if (!buf) throw fail(409, `missing image ${name}`);
      out = out.replaceAll(ref, `data:${MIME[ext]};base64,${buf.toString('base64')}`);
    }
    return out;
  }

  /** data:image URIs -> files in public/essays/<slug>/ (when an essay is made public again). */
  function extractImages(md, slug, tx) {
    const re = /data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/=]+)/g;
    const seen = new Set();
    let out = md;
    for (const m of [...md.matchAll(re)]) {
      const buf = Buffer.from(m[2], 'base64');
      const name = `img-${sha256(buf).slice(0, 12)}.${EXT[m[1]]}`;
      if (!seen.has(name)) { seen.add(name); tx.write(`${assetDir(slug)}/${name}`, buf); }
      out = out.replace(m[0], `/essays/${slug}/${name}`);
    }
    return out;
  }

  const needEssay = async (slug) => {
    if (!SLUG.test(slug)) throw fail(404, 'no such essay');
    const e = await readEssay(slug);
    if (!e) throw fail(404, 'no such essay');
    return e;
  };

  return async function handle({ method, pathname, query = {}, body = {} }) {
    try {
      if (method === 'GET' && pathname === '/__essays/check') {
        const slug = String(query.slug ?? '');
        if (!SLUG.test(slug)) return bad(400, 'invalid slug');
        const e = await readEssay(slug);
        return ok({ exists: !!e, private: !!e?.isPrivate, reserved: RESERVED.has(slug) });
      }
      if (method !== 'POST') return bad(405, 'method not allowed');
      if (!(await verify(body.key))) return bad(401, 'wrong password');
      const key = body.key;

      if (pathname === '/__essays/auth') {
        await migratePasswords(key);
        return ok({ ok: true, mode: store.mode });
      }

      // -- readings
      if (pathname === '/__readings/save') {
        const items = Array.isArray(body.items) ? body.items : null;
        if (!items || items.length > 1000) return bad(400, 'bad list');
        const clean = [];
        for (const it of items) {
          const title = String(it?.title ?? '').replace(/\s+/g, ' ').trim();
          const link = String(it?.url ?? '').trim();
          if (!title || title.length > 300) return bad(400, 'every reading needs a title');
          try { if (!/^https?:$/.test(new URL(link).protocol)) throw 0; } catch { return bad(400, `not a link: ${link}`); }
          clean.push({ title, url: link });
        }
        const tx = newTx();
        tx.write(READINGS_FILE, JSON.stringify(clean, null, 2) + '\n');
        await store.apply(tx.ops, `readings: ${clean.length} links`);
        log(`saved ${clean.length} readings`);
        return ok({ items: clean });
      }

      if (pathname === '/__readings/title') {
        const target = publicUrl(body.url);
        const r = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 (title lookup)' } });
        const html = (await r.text()).slice(0, 1_000_000);
        const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1]
          ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1];
        const t = og ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
        return ok({ title: decodeEntities(t).replace(/\s+/g, ' ').trim() });
      }

      // -- essays
      if (pathname === '/__essays/fetch') {
        const target = publicUrl(body.url);
        const r = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        const type = (r.headers.get('content-type') ?? '').split(';')[0].trim();
        if (!r.ok || !type.startsWith('image/')) return bad(502, `not an image (${r.status} ${type})`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_IMAGE) return bad(413, 'image too large');
        return { status: 200, bytes: buf, type };
      }

      if (pathname === '/__essays/asset') {
        const name = String(body.name ?? '');
        if (!ASSET.test(name)) return bad(400, `bad asset name ${name}`);
        const buf = Buffer.from(String(body.data ?? ''), 'base64');
        if (!buf.length) return bad(400, 'empty image');
        if (buf.length > MAX_IMAGE) return bad(413, `${name} too large`);
        return ok({ name, id: await store.stage(buf) });
      }

      if (pathname === '/__essays/list') return ok({ essays: await listEssays() });

      if (pathname === '/__essays/delete') {
        const slug = String(body.slug ?? '');
        await needEssay(slug);
        const tx = newTx();
        tx.remove(mdPath(slug));
        tx.removeDir(assetDir(slug));
        await store.apply(tx.ops, `essay: delete ${slug}`);
        log(`deleted /essays/${slug}`);
        return ok({ essays: await listEssays() });
      }

      if (pathname === '/__essays/privacy') {
        const slug = String(body.slug ?? '');
        const essay = await needEssay(slug);
        const makePrivate = !!body.private;
        const passwords = await readPasswords(key);
        const tx = newTx();
        if (makePrivate && !essay.isPrivate) {
          if (!passwords.length) return bad(400, 'add a password for private essays first');
          const sealed = await seal(await inlineImages(essay.body, slug), passwords);
          tx.write(mdPath(slug), serialize({ ...essay, isPrivate: true }, JSON.stringify(sealed)));
          tx.removeDir(assetDir(slug));
        } else if (!makePrivate && essay.isPrivate) {
          const plain = await openSealed(essay, passwords);
          tx.removeDir(assetDir(slug));
          tx.write(mdPath(slug), serialize({ ...essay, isPrivate: false }, extractImages(plain, slug, tx)));
        }
        if (tx.ops.length) await store.apply(tx.ops, `essay: ${slug} is now ${makePrivate ? 'private' : 'public'}`);
        log(`/essays/${slug} is now ${makePrivate ? 'private' : 'public'}`);
        return ok({ essays: await listEssays() });
      }

      if (pathname === '/__essays/passwords') {
        const current = await readPasswords(key);
        if (!Array.isArray(body.passwords)) return ok({ passwords: current });

        if (!strongKey(key)) return bad(400, 'the publish password must be 12+ characters (and not the old default) before the reader password list can be saved');
        const next = [...new Set(body.passwords.map((p) => String(p ?? '').trim()).filter(Boolean))];
        if (next.some((p) => p.length > 200)) return bad(400, 'password too long');
        const privates = (await listEssays()).filter((e) => e.private);
        if (!next.length && privates.length) return bad(400, 'private essays need at least one password');

        const same = next.length === current.length && next.every((p) => current.includes(p));
        const tx = newTx();
        if (!same && privates.length) {
          // open everything with the old passwords before changing anything
          const opened = [];
          for (const e of privates) {
            const essay = await readEssay(e.slug);
            opened.push({ essay, text: await openSealed(essay, current) });
          }
          for (const { essay, text } of opened) tx.write(mdPath(essay.slug), serialize(essay, JSON.stringify(await seal(text, next))));
        }
        tx.write(PASSWORDS_FILE, await sealPasswords(next, key));
        await store.apply(tx.ops, 'reader passwords: update');
        log(`saved ${next.length} reader password${next.length === 1 ? '' : 's'}${same ? '' : `, re-sealed ${privates.length} private essay${privates.length === 1 ? '' : 's'}`}`);
        return ok({ passwords: next, resealed: same ? 0 : privates.length });
      }

      if (pathname === '/__essays/publish') {
        const slug = String(body.slug ?? '');
        const title = String(body.title ?? '').replace(/[\r\n]+/g, ' ').trim();
        const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? '') ? body.date : new Date().toISOString().slice(0, 10);
        if (!SLUG.test(slug) || slug.length > 80) return bad(400, 'slug must be lowercase letters, numbers and dashes');
        if (RESERVED.has(slug)) return bad(400, `"${slug}" is reserved`);
        if (!title) return bad(400, 'add a title first');

        const assets = Array.isArray(body.assets) ? body.assets : [];
        for (const a of assets) if (!ASSET.test(a?.name ?? '')) return bad(400, `bad asset name ${a?.name}`);
        if ((await readEssay(slug)) && !body.overwrite) return bad(409, 'exists');

        const isPrivate = !!body.private;
        const passwords = isPrivate ? await readPasswords(key) : [];
        if (isPrivate && !passwords.length) return bad(400, 'add a password for private essays first');

        // image bytes: staged by /__essays/asset (preferred, keeps requests small) or sent inline
        const bytes = new Map();
        for (const a of assets) {
          const buf = a.id ? await store.readStaged(String(a.id)) : Buffer.from(String(a.data ?? ''), 'base64');
          if (!buf?.length) return bad(400, `missing image data for ${a.name}`);
          if (buf.length > MAX_IMAGE) return bad(413, `${a.name} too large`);
          bytes.set(a.name, buf);
        }

        let md = String(body.body ?? '').replace(/\r\n?/g, '\n').replace(/^\s+/, '');
        for (const a of assets) {
          const ext = a.name.split('.').pop();
          const ref = isPrivate ? `data:${MIME[ext]};base64,${bytes.get(a.name).toString('base64')}` : `/essays/${slug}/${a.name}`;
          md = md.replaceAll(`asset:${a.name}`, ref);
        }
        const unresolved = [...md.matchAll(/asset:(img-[0-9a-f]+\.\w+)/g)].map((m) => m[1]);
        if (unresolved.length) return bad(400, `missing image data for ${unresolved.join(', ')}`);

        const tx = newTx();
        tx.removeDir(assetDir(slug));
        if (isPrivate) {
          tx.write(mdPath(slug), serialize({ title, date, isPrivate: true }, JSON.stringify(await seal(md, passwords))));
        } else {
          for (const [name, buf] of bytes) tx.write(`${assetDir(slug)}/${name}`, buf);
          tx.write(mdPath(slug), serialize({ title, date, isPrivate: false }, md));
        }
        const result = await store.apply(tx.ops, `essay: publish ${slug}${isPrivate ? ' (private)' : ''}`);
        const files = tx.ops.filter((o) => o.op === 'write').map((o) => o.path);
        log(`published /essays/${slug}${isPrivate ? ' (private)' : ` (${files.length} file${files.length === 1 ? '' : 's'})`}`);
        return ok({ url: `/essays/${slug}`, files, private: isPrivate, mode: store.mode, commit: result?.url });
      }

      return bad(404, 'not found');
    } catch (e) {
      return bad(e.status ?? 500, String(e?.message ?? e));
    }
  };
}
