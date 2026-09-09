# glimt-site: statisk Astro-skall servert av nginx. Bygg-kontekst = repo-rot.
FROM node:26-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/protocol/package.json packages/protocol/
COPY apps/glimt-site/package.json apps/glimt-site/
RUN npm ci --workspace apps/glimt-site --include-workspace-root=false || npm install --workspace apps/glimt-site
COPY packages/design-tokens packages/design-tokens
COPY apps/glimt-site apps/glimt-site
RUN npm --workspace apps/glimt-site run build

FROM nginx:1.27-alpine
COPY apps/glimt-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/glimt-site/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ >/dev/null || exit 1
EXPOSE 80
