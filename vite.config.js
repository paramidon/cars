import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true },
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
