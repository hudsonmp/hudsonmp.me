/**
 * Clipboard HTML -> markdown. Written against what Google Docs puts on the clipboard (the main source),
 * and tolerant of ordinary web/Word/Notion HTML:
 *  - Docs wraps everything in <b style="font-weight:normal"> and expresses bold/italic as span styles
 *  - Docs links go through google.com/url?q=<real url>
 *  - Docs nested bullets are flat lists with li[aria-level]
 * Browser only (uses DOMParser).
 */

type Block = { text: string; kind: 'p' | 'ul' | 'ol' | 'quote' | 'other' };
type Ctx = { noEmph?: boolean; code?: boolean };

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'hr',
  'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'aside', 'nav', 'main', 'dl', 'dt', 'dd',
  'tr', 'thead', 'tbody', 'tfoot', 'caption',
]);
const BLOCK_SELECTOR = 'p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,table,blockquote,pre,hr,figure';
const SKIP_TAGS = new Set(['script', 'style', 'meta', 'head', 'title', 'link', 'noscript', 'template']);

const norm = (s: string) => s.replace(/[\s ]+/g, ' ');

/** Escape markdown syntax in plain prose. */
function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/([*`\[\]<~])/g, '\\$1')
    .replace(/(^|[^A-Za-z0-9])_|_(?=[^A-Za-z0-9]|$)/g, (m) => m.replace('_', '\\_'));
}

/** `**text **` is not bold in CommonMark: keep edge whitespace outside the markers. */
function wrapMark(s: string, mark: string): string {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
}

function cleanHref(href: string): string | null {
  if (!href || href.startsWith('#')) return null; // Docs bookmarks / footnote jumps
  try {
    const u = new URL(href, 'https://placeholder.invalid');
    if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
      const q = u.searchParams.get('q');
      if (q) return q;
    }
  } catch { /* keep as is */ }
  return href;
}

const dest = (url: string) => (/[\s()<>]/.test(url) ? `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>` : url);

function styleFlags(el: HTMLElement, tag: string) {
  const fw = el.style?.fontWeight ?? '';
  const fs = el.style?.fontStyle ?? '';
  const td = `${el.style?.textDecorationLine ?? ''} ${el.style?.textDecoration ?? ''}`;
  const ff = el.style?.fontFamily ?? '';
  const isBoldTag = tag === 'b' || tag === 'strong';
  const isItalTag = tag === 'i' || tag === 'em' || tag === 'cite';
  const weightNum = fw === 'bold' || fw === 'bolder' ? 700 : fw === 'normal' ? 400 : parseInt(fw, 10);
  return {
    bold: fw ? weightNum >= 600 : isBoldTag,
    italic: fs ? fs === 'italic' || fs === 'oblique' : isItalTag,
    strike: /line-through/.test(td) || tag === 'del' || tag === 's' || tag === 'strike',
    code: tag === 'code' || tag === 'kbd' || tag === 'tt' || /courier|consolas|menlo|monospace/i.test(ff),
  };
}

function inline(node: Node, ctx: Ctx = {}): string {
  if (node.nodeType === 3) {
    const v = node.nodeValue ?? '';
    return ctx.code ? v.replace(/\s+/g, ' ') : esc(norm(v));
  }
  if (node.nodeType !== 1) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return '';
  if (tag === 'br') return '\\\n';
  if (tag === 'img') {
    const src = el.getAttribute('src');
    if (!src) return '';
    return `![${esc(el.getAttribute('alt') ?? '')}](${dest(src)})`;
  }
  if (tag === 'input') return '';

  const f = styleFlags(el, tag);
  const insideCode = !!ctx.code;
  const childCtx: Ctx = { ...ctx, code: ctx.code || (f.code && !f.bold && !f.italic) };
  let out = [...el.childNodes].map((c) => inline(c, childCtx)).join('');

  if (tag === 'a') {
    const href = cleanHref(el.getAttribute('href') ?? '');
    const label = out.trim();
    if (!href || !label) return out;
    return out.replace(label, () => `[${label}](${dest(href)})`);
  }
  if (tag === 'sup' || tag === 'sub') return out.trim() ? `<${tag}>${out}</${tag}>` : out;

  if (!out.trim()) return out;
  if (f.code && !insideCode && !ctx.noEmph) {
    const raw = el.textContent?.replace(/\s+/g, ' ') ?? '';
    return wrapMark(raw, raw.includes('`') ? '``' : '`');
  }
  if (!ctx.noEmph) {
    if (f.italic) out = wrapMark(out, '*');
    if (f.bold) out = wrapMark(out, '**');
    if (f.strike) out = wrapMark(out, '~~');
  }
  return out;
}

function cleanPara(s: string): string {
  let t = s
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/ {2,}/g, ' ')
    .replace(/(\\\n)+$/g, '')
    .trim();
  // don't let prose accidentally start a heading / quote / list
  if (/^\d+[.)]\s/.test(t)) t = t.replace(/^(\d+)([.)])/, '$1\\$2');
  else if (/^(#{1,6}\s|>|[-+]\s)/.test(t)) t = '\\' + t;
  return t;
}

const hasBlockDescendant = (el: Element) => !!el.querySelector(BLOCK_SELECTOR);

/** Docs has no quote style; an indented paragraph (margin-left) is how quotes are written there. */
function isIndented(el: HTMLElement): boolean {
  const m = (el.style?.marginLeft || el.style?.paddingLeft || '').match(/^([\d.]+)(pt|px|em|rem|in|cm)$/);
  if (!m) return false;
  const px = parseFloat(m[1]) * ({ pt: 4 / 3, px: 1, em: 16, rem: 16, in: 96, cm: 37.8 } as Record<string, number>)[m[2]];
  return px >= 18;
}
const quote = (text: string): Block => ({ text: text.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n'), kind: 'quote' });

function blocks(parent: Node): Block[] {
  const out: Block[] = [];
  let buf = '';
  const flush = () => {
    const t = cleanPara(buf);
    if (t) out.push({ text: t, kind: 'p' });
    buf = '';
  };

  for (const child of [...parent.childNodes]) {
    if (child.nodeType === 3) { buf += inline(child); continue; }
    if (child.nodeType !== 1) continue;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) continue;

    const isBlock = BLOCK_TAGS.has(tag);
    if (!isBlock && !hasBlockDescendant(el)) { buf += inline(el); continue; }

    flush();
    if (!isBlock) { out.push(...blocks(el)); continue; } // inline wrapper around blocks (Docs' <b> guid wrapper)

    if (/^h[1-6]$/.test(tag)) {
      const text = cleanPara([...el.childNodes].map((c) => inline(c, { noEmph: true })).join('')).replace(/\\\n/g, ' ');
      if (text) out.push({ text: '#'.repeat(+tag[1]) + ' ' + text.replace(/^\\(#)/, '$1'), kind: 'other' });
    } else if (tag === 'ul' || tag === 'ol') {
      const text = listMd(el, 0);
      if (text) out.push({ text, kind: tag });
    } else if (tag === 'blockquote') {
      const inner = blocks(el).map((b) => b.text).join('\n\n');
      if (inner) out.push(quote(inner));
    } else if (tag === 'pre') {
      const code = el.textContent?.replace(/\n$/, '') ?? '';
      const lang = el.querySelector('code')?.className.match(/language-(\S+)/)?.[1] ?? '';
      out.push({ text: '```' + lang + '\n' + code + '\n```', kind: 'other' });
    } else if (tag === 'hr') {
      out.push({ text: '---', kind: 'other' });
    } else if (tag === 'table') {
      const t = tableMd(el);
      if (t) out.push({ text: t, kind: 'other' });
    } else if (hasBlockDescendant(el)) {
      out.push(...blocks(el)); // div/section/figure with nested blocks
    } else if ((tag === 'p' || tag === 'div') && isIndented(el)) {
      const t = cleanPara([...el.childNodes].map((c) => inline(c)).join(''));
      if (t) out.push(quote(t.replace(/^\\(>)/, '$1')));
    } else {
      buf += inline(el);
      flush();
    }
  }
  flush();
  return out;
}

function listMd(list: Element, depth: number): string {
  const ordered = list.tagName.toLowerCase() === 'ol';
  const start = parseInt(list.getAttribute('start') ?? '1', 10) || 1;
  const lines: string[] = [];
  let i = 0;
  for (const li of [...list.children]) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const aria = parseInt(li.getAttribute('aria-level') ?? '', 10);
    const level = Number.isFinite(aria) ? aria - 1 : depth;

    const parts: string[] = [];
    const nested: Element[] = [];
    for (const c of [...li.childNodes]) {
      if (c.nodeType === 1 && /^(ul|ol)$/i.test((c as Element).tagName)) nested.push(c as Element);
      else parts.push(inline(c));
    }
    const text = cleanPara(parts.join(' ')).replace(/\\\n/g, ' ');
    const marker = ordered ? `${start + i}.` : '-';
    if (text) lines.push(`${' '.repeat(4 * level)}${marker} ${text}`);
    i++;
    for (const n of nested) {
      const sub = listMd(n, level + 1);
      if (sub) lines.push(sub);
    }
  }
  return lines.join('\n');
}

function tableMd(table: Element): string {
  const rows = [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.children]
      .filter((c) => /^(td|th)$/i.test(c.tagName))
      .map((c) => blocks(c).map((b) => b.text).join(' ').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')),
  );
  if (!rows.length || !rows[0].length) return '';
  const w = Math.max(...rows.map((r) => r.length));
  const fmt = (r: string[]) => '| ' + Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [fmt(rows[0]), '| ' + Array(w).fill('---').join(' | ') + ' |', ...rows.slice(1).map(fmt)].join('\n');
}

/** Does this clipboard HTML carry structure worth converting (vs. e.g. an editor's colored-span copy of markdown source)? */
export function hasStructure(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('h1,h2,h3,h4,h5,h6,a[href],img,ul,ol,table,blockquote,pre,strong,em,b,i,del,s')) return true;
  return [...doc.querySelectorAll<HTMLElement>('[style]')].some((e) => {
    const s = e.style;
    return /bold|[6-9]00/.test(s.fontWeight) || s.fontStyle === 'italic' || /line-through/.test(s.textDecorationLine + s.textDecoration);
  });
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const list = blocks(doc.body);
  let out = '';
  list.forEach((b, i) => {
    const prev = list[i - 1];
    if (i) out += b.kind === prev.kind && (b.kind === 'ul' || b.kind === 'ol') ? '\n' : b.kind === 'quote' && prev.kind === 'quote' ? '\n>\n' : '\n\n';
    out += b.text;
  });
  return out
    .replace(/\*\*( ?)\*\*/g, '$1') // adjacent bold spans: "**a** **b**" -> "**a b**"
    .replace(/(?<![*\\])\* \*(?!\*)/g, ' ') // same for italic: "*a* *b*" -> "*a b*"
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
