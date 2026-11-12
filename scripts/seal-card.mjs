/**
 * Encrypts a card for the site:
 *   node scripts/seal-card.mjs <slug> <letter photo> [--split 0.5] [--hotspot x,y,w,h] [--photos <folder>]
 *                              [--alt "text"] [--preview out.png]
 *
 * <letter photo>  the two-page spread. Keep originals out of the repo (e.g. .private/cards/<slug>/, gitignored).
 * --split         where the left page ends, as a fraction of the width (default 0.5); portrait screens cut there.
 * --hotspot       the "click here" box as fractions of the photo (left, top, width, height); it opens the collage.
 * --photos        a folder of collage photos (jpg, png, heic, webp), shown in file-name order.
 * --preview       writes the letter with the split and hotspot drawn on it, to check the numbers.
 * Replaces cards/<slug>/ with ciphertext (safe to commit). Needs CARD_KEY in the environment or .env.local.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { cardKey, seal, unseal } from '../server/cards.mjs';
import { loadEnv } from '../integrations/local-publish.mjs';

const LETTER_WIDTH = 4800; // sharp enough to zoom into handwriting (~17 MP decoded is still safe on phones); ~1 MB as WebP
const PHOTO_EDGE = 2400; // full-size collage photo, longest edge
const THUMB_WIDTH = 800; // collage tile: two columns on a 3x phone screen, three to four on a desktop
const IMAGE = /\.(jpe?g|png|heic|heif|webp|tiff?)$/i;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const split = Number(opt('--split') ?? 0.5);
const hotspotArg = opt('--hotspot');
const photosDir = opt('--photos');
const alt = opt('--alt');
const previewPath = opt('--preview');
const [slug, letter] = args;
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? '') || !letter) {
  console.error('usage: node scripts/seal-card.mjs <slug> <letter photo> [--split 0.5] [--hotspot x,y,w,h] [--photos <folder>] [--alt "text"] [--preview out.png]');
  process.exit(1);
}
if (!(split > 0 && split < 1)) throw new Error('--split must be between 0 and 1');
let hotspot;
if (hotspotArg) {
  const [x, y, w, h] = hotspotArg.split(',').map(Number);
  if (![x, y, w, h].every((n) => n >= 0 && n <= 1) || x + w > 1 || y + h > 1 || !w || !h) throw new Error('--hotspot must be four fractions x,y,w,h inside the photo');
  hotspot = { x, y, w, h };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'seal-card-'));
/** sharp can't decode iPhone HEIC (HEVC); macOS sips can, so convert those to JPEG first */
async function source(file) {
  if (!/\.hei[cf]$/i.test(file)) return file;
  const out = path.join(tmp, path.basename(file).replace(/\.\w+$/, '.jpg'));
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', file, '--out', out], { stdio: 'ignore' });
  return out;
}
// rotate() applies the phone's EXIF orientation
const webp = async (file, resize, quality) =>
  sharp(await source(file)).rotate().resize({ ...resize, withoutEnlargement: true }).webp({ quality }).toBuffer({ resolveWithObject: true });
const version = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

const files = new Map(); // id -> plaintext bytes
const letterImg = await webp(path.resolve(letter), { width: LETTER_WIDTH }, 82);
files.set('spread', letterImg.data);
const meta = {
  spread: { id: 'spread', width: letterImg.info.width, height: letterImg.info.height, split, v: version(letterImg.data), ...(hotspot ? { hotspot } : {}) },
  photos: [],
  ...(alt ? { alt } : {}),
};

if (photosDir) {
  const names = (await fs.readdir(photosDir)).filter((n) => IMAGE.test(n) && !n.startsWith('.'));
  names.sort(new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare);
  for (const [i, name] of names.entries()) {
    const file = path.join(photosDir, name);
    const full = await webp(file, { width: PHOTO_EDGE, height: PHOTO_EDGE, fit: 'inside' }, 80);
    const thumb = await webp(file, { width: THUMB_WIDTH }, 74);
    const id = `p${i + 1}`;
    files.set(id, full.data);
    files.set(`${id}t`, thumb.data);
    meta.photos.push({ id, thumb: `${id}t`, width: full.info.width, height: full.info.height, v: version(full.data) });
  }
}
if (hotspot && !meta.photos.length) console.warn('warning: --hotspot without --photos: the box will open an empty collage');
files.set('meta', Buffer.from(JSON.stringify(meta)));

// write everything to a fresh folder, check it decrypts, then swap it in (no stale photos left behind)
const key = cardKey(loadEnv(root));
const outDir = path.join(root, 'cards', slug);
const staging = `${outDir}.tmp`;
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
let total = 0;
for (const [id, bytes] of files) {
  const sealed = seal(slug, id, bytes, key);
  if (!unseal(slug, id, sealed, key).equals(bytes)) throw new Error(`round-trip failed for ${id}`);
  if (sealed.length > 4 * 1024 * 1024) throw new Error(`${id} is over 4 MB; Vercel caps responses at 4.5 MB`);
  await fs.writeFile(path.join(staging, `${id}.card`), sealed);
  total += sealed.length;
}
await fs.rm(outDir, { recursive: true, force: true });
await fs.rm(path.join(root, 'cards', `${slug}.card`), { force: true }); // the old single-file format
await fs.rename(staging, outDir);
await fs.rm(tmp, { recursive: true, force: true });

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(`cards/${slug}/: letter ${meta.spread.width}x${meta.spread.height} (${mb(letterImg.data.length)}), split ${split}` +
  `${hotspot ? `, hotspot ${hotspotArg}` : ''}, ${meta.photos.length} photo(s); ${files.size} files, ${mb(total)} total`);

if (previewPath) {
  const PW = 1600, PH = Math.round((PW * meta.spread.height) / meta.spread.width);
  const box = hotspot
    ? `<rect x="${hotspot.x * PW}" y="${hotspot.y * PH}" width="${hotspot.w * PW}" height="${hotspot.h * PH}" fill="rgba(255,214,0,.35)" stroke="#e00" stroke-width="3"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}"><line x1="${split * PW}" y1="0" x2="${split * PW}" y2="${PH}" stroke="#08f" stroke-dasharray="8 8" stroke-width="2"/>${box}</svg>`;
  await sharp(letterImg.data).resize(PW, PH).composite([{ input: Buffer.from(svg) }]).png().toFile(previewPath);
  console.log(`preview: ${previewPath}`);
}
