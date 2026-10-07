// Отпечаток сборки: хеш исходников игры (src/, index.html, package.json).
// Одинаковый код — одинаковый отпечаток, хоть у кого собран; по нему сервер не пускает в комнату с другой версией.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

export function buildId(root = '.') {
  const h = createHash('sha1');
  for (const p of [...files(join(root, 'src')), join(root, 'index.html'), join(root, 'package.json')]) {
    h.update(relative(root, p).replaceAll('\\', '/'));
    // переводы строк не считаем — у кого-то git сделает CRLF, у кого-то LF
    h.update(readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
  }
  return h.digest('hex').slice(0, 8);
}
