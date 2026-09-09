// Skall for nettsiden. Utvikles senere av eier (IMPLEMENTERINGSPLAN 1.2, FB 15).
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://glimtpanel.com',
  output: 'static',
  build: { inlineStylesheets: 'auto' },
});
