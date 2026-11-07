import { Marked, type Token } from 'marked';

export type Heading = { id: string; label: string; depth: number };
export type Essay = { title: string; date: string; html: string; headings: Heading[] };
export type RenderOptions = {
  /** Rewrite image sources (the editor maps `asset:<name>` to a local object URL). */
  resolveImage?: (src: string) => string;
};

/** `---\nkey: value\n---` at the top of the file. Values are plain strings. */
export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = src.replace(/^﻿/, '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^(["'])(.*)\1$/, '$2').trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

const slugify = (s: string) =>
  s.replace(/&[#\w]+;/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');


/**
 * Footnotes: `[^id]` in the text, `[^id]: note` (indented lines continue it) anywhere in the document.
 * Definitions are pulled out and references swapped for placeholders; both are rendered after parsing,
 * numbered by order of first reference. Code (fenced or inline) is left alone, undefined references stay as text.
 */
const FN_OPEN = '\uE000';
const FN_CLOSE = '\uE001';

function extractFootnotes(body: string): { body: string; notes: Map<string, string> } {
  const notes = new Map<string, string>();
  const lines = body.split('\n');
  const kept: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s{0,3}(```|~~~)/.test(l)) fence = !fence;
    const def = fence ? null : l.match(/^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/);
    if (!def) { kept.push(l); continue; }
    const parts = [def[2]];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (/^( {2,}|\t)\S/.test(next)) { parts.push(next.trim()); i++; }
      else if (!next.trim() && /^( {2,}|\t)\S/.test(lines[i + 2] ?? '')) { parts.push(lines[i + 2].trim()); i += 2; }
      else break;
    }
    if (!notes.has(def[1])) notes.set(def[1], parts.join(' ').trim());
  }
  if (!notes.size) return { body, notes };
  const text = kept.join('\n').replace(
    /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\[\^([^\]\s]+)\](?!:)/g,
    (m, code, id) => (code || !notes.has(id) ? m : `${FN_OPEN}${id}${FN_CLOSE}`),
  );
  return { body: text, notes };
}

const FN_REF = new RegExp(`${FN_OPEN}([^${FN_CLOSE}]+)${FN_CLOSE}`, 'g');

/**
 * A quote ends at the end of its line unless the next line is also quoted.
 * (CommonMark "lazy continuation" otherwise swallows every following line into the quote.)
 */
function endQuotes(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s{0,3}(```|~~~)/.test(l)) fence = !fence;
    out.push(l);
    const next = lines[i + 1];
    if (!fence && /^\s{0,3}>/.test(l) && next !== undefined && next.trim() && !/^\s{0,3}>/.test(next)) out.push('');
  }
  return out.join('\n');
}

/**
 * Markdown -> essay. Headings become the table of contents. Levels are relative: the shallowest heading
 * in the document is a top-level section (so `#`/`##` from markdown and Docs' Heading 2/3 both work).
 * The title is separate (frontmatter `title:` or `fallbackTitle`), so sections render from <h2> down.
 * Runs at build time (published essays) and in the browser (editor preview).
 */
export function renderEssay(src: string, fallbackTitle = '', opts: RenderOptions = {}): Essay {
  const { meta, body } = parseFrontmatter(src.replace(/\r\n?/g, '\n'));
  const headings: Heading[] = [];
  const seen = new Map<string, number>();

  const fn = extractFootnotes(body);
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(endQuotes(fn.body));
  let minDepth = 6;
  marked.walkTokens(tokens, (t: Token) => {
    if (t.type === 'heading') minDepth = Math.min(minDepth, (t as { depth: number }).depth);
  });

  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens).replace(FN_REF, '').trim(); // no footnote marks inside headings
        const label = inner.replace(/<[^>]+>/g, '');
        const base = slugify(label);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        const rel = depth - minDepth + 1; // 1 = section, 2 = subsection, ...
        headings.push({ id, label, depth: rel });
        const level = Math.min(rel + 1, 6);
        return `<h${level} id="${id}">${inner}</h${level}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const t = title ? ` title="${escAttr(title)}"` : '';
        const ext = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${escAttr(href)}"${t}${ext}>${inner}</a>`;
      },
      image({ href, title, text }) {
        const src = opts.resolveImage ? opts.resolveImage(href) : href;
        const t = title ? ` title="${escAttr(title)}"` : '';
        return `<img src="${escAttr(src)}" alt="${escAttr(text)}"${t} loading="lazy">`;
      },
    },
  });

  let html = marked.parser(tokens) as string;
  if (fn.notes.size) {
    const order: string[] = [];
    const uses = new Map<string, number>();
    html = html.replace(FN_REF, (_, id: string) => {
      if (!order.includes(id)) order.push(id);
      const n = order.indexOf(id) + 1;
      const k = (uses.get(id) ?? 0) + 1; // the same note can be cited more than once
      uses.set(id, k);
      return `<sup class="fnref"><a id="fnref-${n}${k > 1 ? `-${k}` : ''}" href="#fn-${n}" aria-label="footnote ${n}">${n}</a></sup>`;
    });
    if (order.length) {
      const items = order
        .map((id, i) => `<li id="fn-${i + 1}">${marked.parseInline(fn.notes.get(id)!) as string} <a class="fn-back" href="#fnref-${i + 1}" aria-label="back to text">\u21a9</a></li>`)
        .join('\n');
      html += `<section class="footnotes"><ol>\n${items}\n</ol></section>\n`;
    }
  }

  return {
    title: meta.title || fallbackTitle,
    date: meta.date || '',
    html,
    headings,
  };
}
