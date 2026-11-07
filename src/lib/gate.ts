import { PASSWORD_SHA256 } from './editor-key.js';

// Shared by /essays/add and /readings/add. The gate itself is client-side (keeps the editors out of casual
// view); every write re-checks the password on the local dev server, so the password is kept for this tab session.
const KEY = 'site-editor-key';

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
  if (saved && (await sha256(saved)) === PASSWORD_SHA256) {
    form.hidden = true;
    return saved;
  }
  // a stale or wrong saved key: the page hid the box optimistically, so bring it back
  form.hidden = false;
  pw.focus();

  return new Promise((resolve) => {
    // implicit submission isn't fired by every input method; make Enter explicit
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if ((await sha256(pw.value)) !== PASSWORD_SHA256) {
        err.textContent = 'wrong password';
        pw.select();
        return;
      }
      try { sessionStorage.setItem(KEY, pw.value); } catch {}
      form.hidden = true;
      resolve(pw.value);
    });
  });
}
