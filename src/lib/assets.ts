/**
 * Image assets for the essay editor. Pasted/dropped images are stored as real files (Blobs) in IndexedDB
 * under a content-hash name and referenced from markdown as `asset:<name>`. Publishing uploads them to
 * public/essays/<slug>/<name> and rewrites the references. Falls back to memory if IndexedDB is unavailable.
 */

export type Asset = { name: string; type: string; blob: Blob };

const DB = 'essay-editor';
const STORE = 'assets';
const memory = new Map<string, Asset>();
const urls = new Map<string, string>();

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
};
export const isSupportedImage = (type: string) => type in EXT;

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function hash(blob: Blob): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Store an image blob; returns its asset name (same bytes -> same name). */
export async function saveAsset(blob: Blob): Promise<string> {
  const type = isSupportedImage(blob.type) ? blob.type : 'image/png';
  const name = `img-${await hash(blob)}.${EXT[type]}`;
  const asset = { name, type, blob };
  memory.set(name, asset);
  await tx('readwrite', (s) => s.put(asset));
  return name;
}

/** Load every stored asset into memory (call once on startup so previews can resolve synchronously). */
export async function loadAssets(): Promise<void> {
  const all = (await tx<Asset[]>('readonly', (s) => s.getAll())) ?? [];
  for (const a of all) memory.set(a.name, a);
}

export const getAsset = (name: string) => memory.get(name) ?? null;

/** Object URL for an `asset:` reference (sync; empty string if unknown). */
export function assetUrl(name: string): string {
  const a = memory.get(name);
  if (!a) return '';
  let u = urls.get(name);
  if (!u) { u = URL.createObjectURL(a.blob); urls.set(name, u); }
  return u;
}

export const ASSET_REF = /asset:(img-[0-9a-f]+\.(?:png|jpg|gif|webp|avif))/g;

export function referencedAssets(md: string): string[] {
  return [...new Set([...md.matchAll(ASSET_REF)].map((m) => m[1]))];
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
