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

  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(endQuotes(body));
  let minDepth = 6;
  marked.walkTokens(tokens, (t: Token) => {
    if (t.type === 'heading') minDepth = Math.min(minDepth, (t as { depth: number }).depth);
  });

  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
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

  return {
    title: meta.title || fallbackTitle,
    date: meta.date || '',
    html: marked.parser(tokens) as string,
    headings,
  };
}
