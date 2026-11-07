/**
 * Password encryption for private essays. Runs unchanged in Node (local publish) and the browser (reader).
 *
 * The site is static and the repo is public, so a private essay is only private if it is stored encrypted:
 *   - the markdown (images inlined) is encrypted once with a random content key (AES-256-GCM)
 *   - that key is wrapped once per reader password ("slots"), each with a key derived by PBKDF2-SHA256
 *   - any one password unwraps the content key; changing passwords re-seals every private essay
 * Strength is the strength of the weakest password: the ciphertext is public and can be attacked offline.
 */

const ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-SHA256
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function passwordKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt `text` so that any one of `passwords` opens it. */
export async function seal(text, passwords) {
  if (!passwords.length) throw new Error('at least one password is required');
  const contentKeyBytes = random(32);
  const salt = random(16);
  const iv = random(12);
  const contentKey = await subtle().importKey('raw', contentKeyBytes, 'AES-GCM', false, ['encrypt']);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, contentKey, enc.encode(text)));

  const slots = [];
  for (const p of passwords) {
    const k = await passwordKey(p, salt, ITERATIONS);
    const slotIv = random(12);
    const wrapped = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: slotIv }, k, contentKeyBytes));
    slots.push({ iv: toB64(slotIv), key: toB64(wrapped) });
  }
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toB64(salt) },
    slots,
    iv: toB64(iv),
    data: toB64(data),
  };
}

/** Returns the plaintext, or null if `password` opens no slot. One key derivation per call. */
export async function unseal(payload, password) {
  const k = await passwordKey(password, fromB64(payload.kdf.salt), payload.kdf.iterations);
  for (const slot of payload.slots) {
    let contentKeyBytes;
    try {
      contentKeyBytes = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(slot.iv) }, k, fromB64(slot.key));
    } catch {
      continue; // not this slot
    }
    const contentKey = await subtle().importKey('raw', contentKeyBytes, 'AES-GCM', false, ['decrypt']);
    return dec.decode(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, contentKey, fromB64(payload.data)));
  }
  return null;
}
