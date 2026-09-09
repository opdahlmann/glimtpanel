# e2e

Playwright-tester for Glimtpanel i tre prosjekter: `desktop-chromium` (1440×900), `mobile-webkit` (iPhone 14) og
`mobile-chromium` (Pixel 7). Hver skjerm testes i alle tre; `helpers/mobile-rules.ts` håndhever mobilsjekklisten
(ingen horisontal scroll, klikkbare flater minst 44×44 px).

- Lokalt: kjør `npm run dev` i ett vindu og `npm run test:e2e` i et annet (kjørende servere gjenbrukes).
- Uten `npm run dev` starter Playwright hub (`GLIMT_ENV=e2e`, uten ekte MongoDB) og web selv.
- `npx playwright install chromium webkit` første gang. Rapport: `npm --workspace e2e run report`.
