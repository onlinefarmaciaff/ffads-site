// Источник данных страницы в варианте GitHub Pages: зашифрованный файл data.enc.
// Тот же интерфейс, что у dashboard/public/js/api.js (api(path, params)), но ответы считает
// engine.js по расшифрованным данным. Пока данные не расшифрованы, показывается экран входа.
import { createEngine } from './engine.js';
import { decrypt, deriveKey, forgetKeys, parseHeader, recallKey, rememberKey, WrongPassword } from './vault.js';

export class ApiError extends Error {}

const DATA_URL = 'data.enc';
const RECHECK_MS = 5 * 60_000; // новые данные появляются раз в час; Pages кэширует файл до 10 минут

const $ = (id) => document.getElementById(id);

let engine = null;
let key = null;
let saltId = null;
let generatedAt = null;
let checkedAt = 0;
let unlocking = null;

async function fetchData() {
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status === 404 ? 'Data has not been published yet — wait for the first update run' : `Could not load data (${res.status})`);
  return parseHeader(await res.arrayBuffer());
}

function use(payload) {
  engine = createEngine(payload);
  generatedAt = payload.generatedAt;
  checkedAt = Date.now();
}

// Экран входа: ждёт правильный пароль, затем расшифровывает данные.
function askPassword(header) {
  return new Promise((resolve) => {
    document.body.classList.add('locked');
    $('unlock').hidden = false;
    $('unlock-password').focus();
    const onSubmit = async (e) => {
      e.preventDefault();
      const button = $('unlock-submit');
      button.disabled = true;
      $('unlock-error').hidden = true;
      try {
        const k = await deriveKey($('unlock-password').value, header.salt, header.iterations);
        const payload = await decrypt(header, k);
        if ($('unlock-remember').checked) await rememberKey(header.saltId, k);
        key = k;
        $('unlock-form').removeEventListener('submit', onSubmit);
        $('unlock').hidden = true;
        $('unlock-password').value = '';
        document.body.classList.remove('locked');
        resolve(payload);
      } catch (err) {
        $('unlock-error').textContent = err instanceof WrongPassword ? 'Wrong password' : `Error: ${err.message}`;
        $('unlock-error').hidden = false;
      } finally {
        button.disabled = false;
      }
    };
    $('unlock-form').addEventListener('submit', onSubmit);
  });
}

async function unlock() {
  const header = await fetchData();
  saltId = header.saltId;
  const remembered = await recallKey(header.saltId);
  if (remembered) {
    try {
      key = remembered;
      use(await decrypt(header, remembered));
      return;
    } catch {
      await forgetKeys();
    }
  }
  use(await askPassword(header));
}

// Новые данные: тот же ключ, пока не сменился пароль (соль файла).
async function refresh() {
  checkedAt = Date.now();
  const header = await fetchData();
  if (header.saltId !== saltId) {
    window.location.reload();
    return;
  }
  const payload = await decrypt(header, key);
  if (payload.generatedAt !== generatedAt) use(payload);
}

export async function api(path, params = {}) {
  if (!engine) {
    unlocking ??= unlock().finally(() => { unlocking = null; });
    await unlocking;
  } else if (Date.now() - checkedAt > RECHECK_MS) {
    try { await refresh(); } catch { /* остаются прежние данные */ }
  }
  try {
    return engine.handle(path, new URLSearchParams(params));
  } catch (err) {
    throw new ApiError(err.message);
  }
}

$('logout')?.addEventListener('click', async () => {
  await forgetKeys();
  window.location.reload();
});
