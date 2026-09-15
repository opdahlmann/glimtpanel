# glimt-web: Angular-appen bygd med Node, servert av nginx. Dokploy: Dockerfile Path infra/glimt-web/Dockerfile, Build Context .
#   docker build -f infra/glimt-web/Dockerfile -t glimt-web:local .
# Ingen build args: samme image for dev og prod; config.json skrives fra GLIMT_*-variabler når containeren starter.
FROM public.ecr.aws/docker/library/node:26-alpine AS build
WORKDIR /repo
# Kun manifestene først, slik at npm ci caches til en avhengighet endres.
COPY package.json package-lock.json ./
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/protocol/package.json packages/protocol/
COPY apps/glimt-web/package.json apps/glimt-web/
COPY apps/glimt-site/package.json apps/glimt-site/
COPY e2e/package.json e2e/
RUN npm ci --workspace apps/glimt-web --include-workspace-root=false
COPY packages/design-tokens packages/design-tokens
COPY apps/glimt-web apps/glimt-web
# En lokalt generert config.json skal aldri inn i imaget; entrypointet skriver den fra env ved oppstart.
RUN rm -f apps/glimt-web/public/config.json \
 && npm --workspace apps/glimt-web run build -- --configuration production

FROM public.ecr.aws/nginx/nginx:1.27-alpine
# NGINX_ENVSUBST_FILTER: kun GLIMT_*-variabler byttes ut i malen, så nginx-variabler som $uri står urørt.
# GLIMT_DNS_RESOLVER settes av 10-glimt-resolver.envsh fra /etc/resolv.conf hvis den ikke gis eksplisitt.
ENV GLIMT_HUB_INTERNAL_URL=http://glimt-hub:8080 \
    GLIMT_ENV=production \
    NGINX_ENVSUBST_FILTER=GLIMT_
COPY infra/glimt-web/nginx.conf /etc/nginx/templates/default.conf.template
COPY infra/glimt-web/security-headers.conf /etc/nginx/glimt/security-headers.conf
COPY --chmod=755 infra/glimt-web/10-glimt-resolver.envsh /docker-entrypoint.d/10-glimt-resolver.envsh
COPY --chmod=755 infra/glimt-web/40-glimt-config.sh /docker-entrypoint.d/40-glimt-config.sh
COPY --from=build /repo/apps/glimt-web/dist/glimt-web/browser /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
EXPOSE 80
