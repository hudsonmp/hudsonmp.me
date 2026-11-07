// Shared by /essays/add and /readings/add. The password is checked by the server (the dev server locally, the
// publish function on hudsonmp.me); the page only keeps it for this tab session and sends it with every write.
const KEY = 'site-editor-key';

/** 'local' = files are written into the working tree; 'github' = changes are committed and deployed. */
export let publishMode: 'local' | 'github' = 'local';

type Check = { ok: true; mode: 'local' | 'github' } | { ok: false; message: string; wrong: boolean };

async function check(key: string): Promise<Check> {
  let r: Response;
  try {
    r = await fetch('/__essays/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
  } catch {
    return { ok: false, wrong: false, message: "can't reach the publishing server" };
  }
  const j = await r.json().catch(() => null);
  if (r.ok && j?.ok) return { ok: true, mode: j.mode === 'github' ? 'github' : 'local' };
  if (r.status === 401) return { ok: false, wrong: true, message: 'wrong password' };
  return { ok: false, wrong: false, message: j?.error ?? "publishing isn't available here" };
}

/**
 * Wires up `form#gate` (`input#pw`, `#gate-err`). Resolves with the password once it is entered,
 * or immediately if this tab already unlocked an editor.
 */
export async function gate(): Promise<string> {
  const form = document.getElementById('gate') as HTMLFormElement;
  const pw = document.getElementById('pw') as HTMLInputElement;
  const err = document.getElementById('gate-err')!;

  let saved = '';
  try { saved = sessionStorage.getItem(KEY) ?? ''; } catch {}
  if (saved) {
    const c = await check(saved);
    if (c.ok) {
      publishMode = c.mode;
      form.hidden = true;
      return saved;
    }
    if (c.wrong) { try { sessionStorage.removeItem(KEY); } catch {} }
    else err.textContent = c.message;
  }
  // no key, or it no longer works: the page hid the box optimistically, so bring it back
  form.hidden = false;
  pw.focus();

  return new Promise((resolve) => {
    // implicit submission isn't fired by every input method; make Enter explicit
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pw.value) return;
      err.textContent = '';
      const c = await check(pw.value);
      if (!c.ok) {
        err.textContent = c.message;
        pw.select();
        return;
      }
      publishMode = c.mode;
      try { sessionStorage.setItem(KEY, pw.value); } catch {}
      form.hidden = true;
      resolve(pw.value);
    });
  });
}
