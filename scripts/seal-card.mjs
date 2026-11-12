/**
 * Encrypts a card for the site: node scripts/seal-card.mjs <slug> <photo> [--split 0.5] [--alt "text"]
 *
 * <photo> is the two-page spread (keep it out of the repo, e.g. in .private/cards/<slug>/, which is gitignored).
 * --split is where the left page ends, as a fraction of the width (default 0.5); portrait screens cut the spread
 * there into two stacked pages. Writes cards/<slug>.card (ciphertext, safe to commit).
 * Needs CARD_KEY in the environment or .env.local.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { cardKey, sealCard, openCard } from '../server/cards.mjs';
import { loadEnv } from '../integrations/local-publish.mjs';

const MAX_WIDTH = 3200; // enough to read handwriting zoomed in on a phone; keeps the file well under Vercel's 4.5 MB response cap
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const split = Number(opt('--split') ?? 0.5);
const alt = opt('--alt');
const [slug, photo] = args;
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? '') || !photo) {
  console.error('usage: node scripts/seal-card.mjs <slug> <photo> [--split 0.5] [--alt "text"]');
  process.exit(1);
}
if (!(split > 0 && split < 1)) throw new Error('--split must be between 0 and 1');

// rotate() applies the phone's EXIF orientation
const { data: image, info } = await sharp(path.resolve(photo))
  .rotate()
  .resize({ width: MAX_WIDTH, withoutEnlargement: true })
  .webp({ quality: 82 })
  .toBuffer({ resolveWithObject: true });

const meta = {
  width: info.width,
  height: info.height,
  split,
  v: createHash('sha256').update(image).digest('hex').slice(0, 12),
  type: 'image/webp',
  ...(alt ? { alt } : {}),
};
const key = cardKey(loadEnv(root));
const sealed = sealCard(slug, meta, image, key);
openCard(slug, sealed, key); // round-trip check before writing
await fs.mkdir(path.join(root, 'cards'), { recursive: true });
const out = path.join(root, 'cards', `${slug}.card`);
await fs.writeFile(out, sealed);
console.log(`${path.relative(root, out)}: ${info.width}x${info.height}, ${(sealed.length / 1024).toFixed(0)} KB, split ${split}`);
if (sealed.length > 4 * 1024 * 1024) console.warn('warning: over 4 MB; Vercel caps responses at 4.5 MB. Lower MAX_WIDTH or quality.');
