// Расшифровка data.enc в браузере (формат — collector/src/site/vault.js):
//   "FFD1" | итерации PBKDF2 (uint32 BE) | соль (16) | IV (12) | шифротекст + тег GCM.
// Ключ — PBKDF2-SHA256 от пароля; «Запомнить на этом устройстве» хранит в IndexedDB сам ключ
// (неизвлекаемый CryptoKey), а не пароль. Ключ привязан к соли: после смены пароля он не подходит.

export class WrongPassword extends Error {}

export function parseHeader(buf) {
  const bytes = new Uint8Array(buf);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== 'FFD1' || bytes.length < 8 + 16 + 12 + 16) throw new Error('The data file is damaged or has an unknown format');
  const iterations = new DataView(buf).getUint32(4);
  return {
    iterations,
    salt: bytes.slice(8, 24),
    iv: bytes.slice(24, 36),
    body: bytes.slice(36),
    saltId: [...bytes.subarray(8, 24)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

export async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

export async function decrypt(header, key) {
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.iv }, key, header.body);
  } catch {
    throw new WrongPassword('Wrong password');
  }
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

// ---------- Запомненный ключ (IndexedDB) ----------

const DB = 'ffads';
const STORE = 'keys';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function rememberKey(saltId, key) {
  try {
    await tx('readwrite', (s) => { s.clear(); return s.put(key, saltId); });
  } catch { /* приватный режим и т. п. — просто не запоминаем */ }
}

export async function recallKey(saltId) {
  try {
    return (await tx('readonly', (s) => s.get(saltId))) ?? null;
  } catch {
    return null;
  }
}

export async function forgetKeys() {
  try {
    await tx('readwrite', (s) => s.clear());
  } catch { /* нечего удалять */ }
}
