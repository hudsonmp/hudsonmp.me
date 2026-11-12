/**
 * Encrypts a card for the site: node scripts/seal-card.mjs <slug>
 *
 * Reads .private/cards/<slug>/card.json (gitignored), e.g.
 *   { "image": "clean.jpg", "split": 0.5,
 *     "links": [ { "x": 0.12, "y": 0.40, "w": 0.20, "h": 0.05, "href": "https://..." } ] }
 * x, y, w, h are fractions of the image (scripts/card-boxes.mjs measures them); split is where the left page ends.
 * Writes cards/<slug>.card (ciphertext, safe to commit). Needs CARD_KEY in the environment or .env.local.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { cardKey, sealCard, openCard } from '../server/cards.mjs';
import { loadEnv } from '../integrations/local-publish.mjs';

const MAX_WIDTH = 3200; // enough to read handwriting when zoomed on a phone; keeps the file well under Vercel's 4.5 MB response cap
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const slug = process.argv[2];
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? '')) {
  console.error('usage: node scripts/seal-card.mjs <slug>');
  process.exit(1);
}
const dir = path.join(root, '.private', 'cards', slug);
const config = JSON.parse(await fs.readFile(path.join(dir, 'card.json'), 'utf8'));

const split = config.split ?? 0.5;
if (!(split > 0 && split < 1)) throw new Error('split must be between 0 and 1');
const frac = (n) => typeof n === 'number' && n >= 0 && n <= 1;
const links = (config.links ?? []).map((l, i) => {
  if (![l.x, l.y, l.w, l.h].every(frac) || l.x + l.w > 1.0001 || l.y + l.h > 1.0001) throw new Error(`link ${i + 1}: x, y, w, h must be fractions inside the image`);
  if (!/^(https?:|mailto:)/.test(l.href ?? '')) throw new Error(`link ${i + 1}: href must be an http(s) or mailto URL (got ${JSON.stringify(l.href)})`);
  const r = (n) => Math.round(n * 1e4) / 1e4;
  return { x: r(l.x), y: r(l.y), w: r(l.w), h: r(l.h), href: l.href, ...(l.label ? { label: String(l.label) } : {}) };
});

// rotate() applies the phone's EXIF orientation, the same way card-boxes.mjs reads the image
const { data: image, info } = await sharp(path.resolve(dir, config.image))
  .rotate()
  .resize({ width: MAX_WIDTH, withoutEnlargement: true })
  .webp({ quality: 82 })
  .toBuffer({ resolveWithObject: true });

const meta = {
  width: info.width,
  height: info.height,
  split,
  links,
  v: createHash('sha256').update(image).digest('hex').slice(0, 12),
  type: 'image/webp',
  ...(config.alt ? { alt: String(config.alt) } : {}),
};
const key = cardKey(loadEnv(root));
const sealed = sealCard(slug, meta, image, key);
openCard(slug, sealed, key); // round-trip check before writing
await fs.mkdir(path.join(root, 'cards'), { recursive: true });
const out = path.join(root, 'cards', `${slug}.card`);
await fs.writeFile(out, sealed);
console.log(`${path.relative(root, out)}: ${info.width}x${info.height}, ${(sealed.length / 1024).toFixed(0)} KB, ${links.length} link(s), split ${split}`);
if (sealed.length > 4 * 1024 * 1024) console.warn('warning: over 4 MB; Vercel caps responses at 4.5 MB. Lower MAX_WIDTH or quality.');
