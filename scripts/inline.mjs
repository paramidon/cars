// Собирает dist/index.html в один самодостаточный файл dist/cars-and-guts.html
// (JS и CSS встраиваются инлайном) — удобно, чтобы открыть игру где угодно.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildId } from './build-id.mjs';

const dist = 'dist';
let html = readFileSync(join(dist, 'index.html'), 'utf8');

html = html.replace(/<script\b[^>]*\bsrc="\.\/([^"]+\.js)"[^>]*><\/script>/g, (_, file) => {
  const js = readFileSync(join(dist, file), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\.\/([^"]+\.css)"[^>]*>/g, (_, file) => {
  return `<style>${readFileSync(join(dist, file), 'utf8')}</style>`;
});

writeFileSync(join(dist, 'cars-and-guts.html'), html);
console.log(`single-file build: ${join(dist, 'cars-and-guts.html')} (${(html.length / 1024).toFixed(0)} KB)`);

// версия собранной игры — сервер показывает её в лобби, чтобы было видно, кто отстал
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(join(dist, 'build.json'), JSON.stringify({ version: `${pkg.version}+${buildId()}` }));
