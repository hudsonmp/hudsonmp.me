/**
 * Storage back ends for publish-core.
 *   fsStore     local dev server: writes straight into the working tree (you commit and push yourself)
 *   githubStore deployed site: every change is one commit on the branch via the Git Data API; Vercel then rebuilds
 *
 * Both implement: read(path) -> string|null, readBytes(path) -> Buffer|null, list(dir) -> file names,
 * stage(buf) -> id, readStaged(id) -> Buffer, apply(ops, message). ops: {op:'write',path,content}
 * | {op:'remove',path} | {op:'removeDir',dir}, applied in order.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './publish-core.mjs';

const toBuffer = (c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));

export function fsStore(root) {
  const abs = (rel) => path.join(root, rel);
  const stagedDir = path.join(root, '.private', 'staged');
  return {
    mode: 'local',
    async read(rel) { try { return await fs.readFile(abs(rel), 'utf8'); } catch { return null; } },
    async readBytes(rel) { try { return await fs.readFile(abs(rel)); } catch { return null; } },
    async list(dir) {
      try {
        return (await fs.readdir(abs(dir), { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
      } catch { return []; }
    },
    async stage(buf) {
      const id = createHash('sha256').update(buf).digest('hex');
      await fs.mkdir(stagedDir, { recursive: true });
      await fs.writeFile(path.join(stagedDir, id), buf);
      return id;
    },
    async readStaged(id) {
      if (!/^[0-9a-f]{64}$/.test(id)) return null;
      try { return await fs.readFile(path.join(stagedDir, id)); } catch { return null; }
    },
    async apply(ops) {
      for (const op of ops) {
        if (op.op === 'write') {
          await fs.mkdir(path.dirname(abs(op.path)), { recursive: true });
          await fs.writeFile(abs(op.path), toBuffer(op.content));
        } else if (op.op === 'remove') {
          await fs.rm(abs(op.path), { force: true });
        } else if (op.op === 'removeDir') {
          await fs.rm(abs(op.dir), { recursive: true, force: true });
        }
      }
      return {};
    },
    /** The pre-sealing, local-only reader password list (gitignored). */
    async legacyPasswords() {
      try { return JSON.parse(await fs.readFile(path.join(root, '.private', 'essay-passwords.json'), 'utf8')).passwords ?? []; } catch { return []; }
    },
  };
}

export function githubStore({ token, repo, branch = 'main', api = 'https://api.github.com' }) {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

  async function gh(url, { raw = false, ...init } = {}) {
    const r = await fetch(api + url, {
      ...init,
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token}`,
        accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'hudsonmp-me-publish',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    return r;
  }
  async function json(url, init) {
    const r = await gh(url, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint = r.status === 401 || r.status === 403 || r.status === 404
        ? ' (check that GITHUB_TOKEN can read and write contents on this repo)'
        : '';
      throw Object.assign(fail(502, `GitHub ${r.status}: ${j.message ?? 'request failed'}${hint}`), { github: r.status });
    }
    return j;
  }

  async function readRaw(rel) {
    const r = await gh(`/repos/${repo}/contents/${enc(rel)}?ref=${encodeURIComponent(branch)}`, { raw: true });
    if (r.status === 404) return null;
    if (!r.ok) throw fail(502, `GitHub ${r.status} reading ${rel}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const createBlob = async (content) =>
    (await json(`/repos/${repo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: toBuffer(content).toString('base64'), encoding: 'base64' }) })).sha;

  return {
    mode: 'github',
    async read(rel) { return (await readRaw(rel))?.toString('utf8') ?? null; },
    readBytes: readRaw,
    async list(dir) {
      const r = await gh(`/repos/${repo}/contents/${enc(dir)}?ref=${encodeURIComponent(branch)}`);
      if (r.status === 404) return [];
      if (!r.ok) throw fail(502, `GitHub ${r.status} listing ${dir}`);
      const items = await r.json();
      return Array.isArray(items) ? items.filter((i) => i.type === 'file').map((i) => i.name) : [];
    },
    // staged images live as unreferenced git blobs until a publish commits them
    stage: createBlob,
    async readStaged(id) {
      if (!/^[0-9a-f]{40}$/.test(id)) return null;
      const r = await gh(`/repos/${repo}/git/blobs/${id}`, { raw: true });
      return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    },

    async apply(ops, message) {
      if (!ops.length) return {};
      for (let attempt = 0; attempt < 3; attempt++) {
        const head = (await json(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
        const baseTree = (await json(`/repos/${repo}/git/commits/${head}`)).tree.sha;

        const state = new Map(); // path -> blob sha, or null = delete
        let existing = null;
        const files = async () => (existing ??= (await json(`/repos/${repo}/git/trees/${baseTree}?recursive=1`)).tree.filter((t) => t.type === 'blob').map((t) => t.path));
        for (const op of ops) {
          if (op.op === 'write') state.set(op.path, await createBlob(op.content));
          else if (op.op === 'remove') {
            if ((await files()).includes(op.path)) state.set(op.path, null); else state.delete(op.path);
          } else if (op.op === 'removeDir') {
            const prefix = op.dir.replace(/\/+$/, '') + '/';
            for (const f of await files()) if (f.startsWith(prefix)) state.set(f, null);
            for (const k of [...state.keys()]) if (k.startsWith(prefix) && state.get(k) !== null) state.delete(k);
          }
        }
        const entries = [...state].map(([p, sha]) => ({ path: p, mode: '100644', type: 'blob', sha }));
        if (!entries.length) return {};

        const tree = await json(`/repos/${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree: entries }) });
        if (tree.sha === baseTree) return {};
        const commit = await json(`/repos/${repo}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [head] }) });
        const r = await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
        if (r.ok) return { sha: commit.sha, url: `https://github.com/${repo}/commit/${commit.sha}` };
        if (r.status !== 422) throw fail(502, `GitHub ${r.status} updating ${branch}`);
        // someone pushed in between: start over from the new head
      }
      throw fail(409, `${branch} moved while publishing; try again`);
    },
  };
}
