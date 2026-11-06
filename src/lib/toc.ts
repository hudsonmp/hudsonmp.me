import type { Heading } from './essay';

export function tocHtml(headings: Heading[]): string {
  if (!headings.length) return '';
  return (
    '<ul>' +
    headings.map((h) => `<li class="d${Math.min(h.depth, 4)}"><a href="#${h.id}">${h.label}</a></li>`).join('') +
    '</ul>'
  );
}

/**
 * Smooth-scroll on click and highlight the section currently at the top of `root`.
 * Returns an unmount function; call again after the content changes.
 */
export function mountToc(root: HTMLElement, toc: HTMLElement): () => void {
  const links = [...toc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
  const pairs = links
    .map((a) => ({ a, el: root.querySelector<HTMLElement>('#' + CSS.escape(a.getAttribute('href')!.slice(1))) }))
    .filter((p): p is { a: HTMLAnchorElement; el: HTMLElement } => !!p.el);

  const onClick = (e: Event) => {
    const a = (e.target as HTMLElement).closest('a[href^="#"]');
    const hit = pairs.find((p) => p.a === a);
    if (!hit) return;
    e.preventDefault();
    // scroll only the essay container (scrollIntoView would also nudge the locked page)
    const top = root.scrollTop + hit.el.getBoundingClientRect().top - root.getBoundingClientRect().top - 8;
    root.scrollTo({ top, behavior: 'smooth' });
  };
  toc.addEventListener('click', onClick);

  let raf = 0;
  const update = () => {
    raf = 0;
    if (!pairs.length) return;
    const top = root.getBoundingClientRect().top + 24;
    let active = pairs[0];
    for (const p of pairs) if (p.el.getBoundingClientRect().top <= top) active = p;
    // pinned to the bottom: the last section can never reach the top, so activate it explicitly
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) active = pairs[pairs.length - 1];
    for (const p of pairs) p.a.classList.toggle('active', p === active);
    // keep the active entry visible inside the toc without scrolling anything else
    const tr = toc.getBoundingClientRect();
    const ar = active.a.getBoundingClientRect();
    if (ar.top < tr.top) toc.scrollTop -= tr.top - ar.top + 8;
    else if (ar.bottom > tr.bottom) toc.scrollTop += ar.bottom - tr.bottom + 8;
  };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
  root.addEventListener('scroll', onScroll, { passive: true });
  update();

  return () => {
    toc.removeEventListener('click', onClick);
    root.removeEventListener('scroll', onScroll);
  };
}
