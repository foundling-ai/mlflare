import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
      '/agent': 'http://localhost:8787',
      '/sdk': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
});
