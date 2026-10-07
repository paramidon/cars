import { defineConfig } from 'vite';
import { buildId } from './scripts/build-id.mjs';

export default defineConfig({
  base: './',
  server: { host: true },
  define: {
    // отпечаток исходников — для проверки, что у всех в сетевой комнате одна и та же версия игры
    __BUILD__: JSON.stringify(buildId()),
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
    // сжимаем, но не переименовываем функции и классы — чтобы стектрейс в журнале ошибок был читаемым
    minify: false,
    rolldownOptions: {
      output: {
        minify: { compress: true, mangle: false, codegen: true },
      },
    },
  },
});
