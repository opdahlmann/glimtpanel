# glimt-site: statisk Astro-side servert av nginx. Dokploy: Dockerfile Path infra/glimt-site/Dockerfile, Build Context .
#   docker build -f infra/glimt-site/Dockerfile -t glimt-site:local .
# Ingen build args og ingen miljøvariabler.
FROM public.ecr.aws/docker/library/node:26-alpine AS build
WORKDIR /repo
# Alle workspace-manifestene må med, ellers stemmer ikke lockfila og npm ci nekter.
COPY package.json package-lock.json ./
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/protocol/package.json packages/protocol/
COPY apps/glimt-web/package.json apps/glimt-web/
COPY apps/glimt-site/package.json apps/glimt-site/
COPY e2e/package.json e2e/
RUN npm ci --workspace apps/glimt-site --include-workspace-root=false
COPY packages/design-tokens packages/design-tokens
COPY apps/glimt-site apps/glimt-site
RUN npm --workspace apps/glimt-site run build

FROM public.ecr.aws/nginx/nginx:1.27-alpine
COPY infra/glimt-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/glimt-site/dist /usr/share/nginx/html
# 127.0.0.1, ikke localhost: i Alpine peker localhost også på ::1, og nginx lytter bare på IPv4, så sjekken feilet alltid.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
EXPOSE 80
