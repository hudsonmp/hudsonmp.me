/**
 * Finds hand-drawn link boxes by diffing a marked-up copy of the card against the clean photo:
 *   node scripts/card-boxes.mjs <clean image> <marked image> [--split 0.5] [--preview preview.png]
 * Prints the boxes as JSON fractions, numbered in reading order (left page top to bottom, then right page), ready for
 * the "links" list in card.json. The preview draws the numbered boxes on the clean photo so the order can be checked.
 * The marked copy must be the same photo with boxes drawn on it (any colour), not a re-cropped screenshot.
 */
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i < 0 ? dflt : args.splice(i, 2)[1];
};
const split = Number(opt('--split', 0.5));
const previewPath = opt('--preview', null);
const [cleanPath, markedPath] = args;
if (!cleanPath || !markedPath) {
  console.error('usage: node scripts/card-boxes.mjs <clean> <marked> [--split 0.5] [--preview out.png]');
  process.exit(1);
}

const W = 1200; // working resolution
const oriented = async (p) => sharp(await sharp(p).rotate().toBuffer());
const clean = await oriented(cleanPath);
const marked = await oriented(markedPath);
const [cm, mm] = [await clean.metadata(), await marked.metadata()];
if (Math.abs(cm.width / cm.height - mm.width / mm.height) > 0.01) {
  throw new Error(`the two images have different shapes (${cm.width}x${cm.height} vs ${mm.width}x${mm.height}); draw on a copy of the same photo`);
}
const H = Math.round((W * cm.height) / cm.width);
const raw = (img) => img.clone().resize(W, H, { fit: 'fill' }).removeAlpha().blur(1).raw().toBuffer();
const [a, b] = await Promise.all([raw(clean), raw(marked)]);

// pixels where the drawing changed the photo
const THRESH = 70;
const mask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const d = Math.max(Math.abs(a[3 * i] - b[3 * i]), Math.abs(a[3 * i + 1] - b[3 * i + 1]), Math.abs(a[3 * i + 2] - b[3 * i + 2]));
  mask[i] = d > THRESH ? 1 : 0;
}
// close small gaps in a stroke (dilate by R) so one box is one component
const R = 4;
const grown = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!mask[y * W + x]) continue;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const yy = y + dy, xx = x + dx;
    if (yy >= 0 && yy < H && xx >= 0 && xx < W) grown[yy * W + xx] = 1;
  }
}
// connected components (8-neighbour), keeping each one's bounding box of original stroke pixels
const seen = new Uint8Array(W * H);
let boxes = [];
for (let s = 0; s < W * H; s++) {
  if (!grown[s] || seen[s]) continue;
  const stack = [s];
  seen[s] = 1;
  let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p - x) / W;
    if (mask[p]) { n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx, q = yy * W + xx;
      if (yy >= 0 && yy < H && xx >= 0 && xx < W && grown[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
  }
  if (n >= 40 && x1 - x0 >= W * 0.015 && y1 - y0 >= W * 0.008) boxes.push({ x0, y0, x1, y1 });
}
// merge boxes that overlap (a box drawn in two strokes)
for (let merged = true; merged; ) {
  merged = false;
  outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const p = boxes[i], q = boxes[j];
    if (p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1) {
      boxes[i] = { x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1) };
      boxes.splice(j, 1);
      merged = true;
      break outer;
    }
  }
}
// reading order: page, then line (boxes whose vertical centres are within half a box height share a line), then x
const page = (r) => ((r.x0 + r.x1) / 2 < split * W ? 0 : 1);
const cy = (r) => (r.y0 + r.y1) / 2;
boxes.sort((p, q) => {
  if (page(p) !== page(q)) return page(p) - page(q);
  const tol = Math.min(p.y1 - p.y0, q.y1 - q.y0) / 2;
  return Math.abs(cy(p) - cy(q)) > tol ? cy(p) - cy(q) : p.x0 - q.x0;
});
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const links = boxes.map((r, i) => ({
  n: i + 1,
  x: r4(r.x0 / W), y: r4(r.y0 / H), w: r4((r.x1 - r.x0 + 1) / W), h: r4((r.y1 - r.y0 + 1) / H),
  href: '',
}));
console.log(JSON.stringify(links, null, 2));

if (previewPath) {
  const PW = 1600, PH = Math.round((PW * cm.height) / cm.width);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}">
    <line x1="${split * PW}" y1="0" x2="${split * PW}" y2="${PH}" stroke="#08f" stroke-dasharray="8 8" stroke-width="2"/>
    ${links.map((l) => `<rect x="${l.x * PW}" y="${l.y * PH}" width="${l.w * PW}" height="${l.h * PH}" fill="rgba(255,220,0,.25)" stroke="#e00" stroke-width="3"/>
    <text x="${l.x * PW}" y="${l.y * PH - 6}" font-size="28" font-family="Helvetica" font-weight="bold" fill="#e00">${l.n}</text>`).join('')}
  </svg>`;
  await clean.clone().resize(PW, PH, { fit: 'fill' }).composite([{ input: Buffer.from(svg) }]).png().toFile(previewPath);
  console.error(`preview: ${previewPath}`);
}
