# glimt-site

Skall for nettsiden til Glimtpanel (Astro, statisk, ren CSS med delte tokens fra `@glimt/design-tokens`).
Kun én blank forside «Velkommen til Glimtpanel». Landingsside, demo, dokumentasjon og SEO (FUNKSJONSBESKRIVELSE kap. 15)
utvikles av eier på et senere tidspunkt.

- `npm run dev:site` fra rot (port 4321), `npm --workspace apps/glimt-site run build` bygger til `dist/`.
- `infra/glimt-site/Dockerfile` bygger et nginx-image (med `infra/glimt-site/nginx.conf`); se `infra/` for Dokploy-oppsettet.
