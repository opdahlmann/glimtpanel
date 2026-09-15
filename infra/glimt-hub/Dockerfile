# glimt-hub: .NET 10 hub. Dokploy: Build Type Dockerfile, Dockerfile Path infra/glimt-hub/Dockerfile, Build Context .
#   docker build -f infra/glimt-hub/Dockerfile -t glimt-hub:local .
# Ingen build args; all konfigurasjon er GLIMT_*-variabler ved kjøring (infra/glimt-hub/.env.dev og .env.prod).
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /repo
# Prosjektfiler først, så restore-laget caches til en pakke endres.
COPY apps/glimt-hub/Directory.Build.props apps/glimt-hub/
COPY apps/glimt-hub/src/Glimt.Hub/Glimt.Hub.csproj apps/glimt-hub/src/Glimt.Hub/
RUN dotnet restore apps/glimt-hub/src/Glimt.Hub/Glimt.Hub.csproj
COPY apps/glimt-hub/src apps/glimt-hub/src
# install.sh bakes inn i huben og serveres på /install (steg 11.3).
COPY apps/glimt-agent/install/install.sh apps/glimt-agent/install/install.sh
RUN dotnet publish apps/glimt-hub/src/Glimt.Hub/Glimt.Hub.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
# curl for HEALTHCHECK; installeres før vi bytter til app-brukeren.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .
# Glimtpanel-agenten i samme container, så appen vises som containernode i dashbordet. Den starter bare når GLIMT_TOKEN
# er satt (fra «Add container»); ellers kjører appen alene som før. Appen er PID 1 via exec og får signalene selv.
# :latest = siste agentutgivelse (infra/glimt-agent/README.md); en Rebuild etter en utgivelse henter den nye.
COPY --from=ghcr.io/opdahlmann/glimt-agent:latest /glimt-agent /usr/local/bin/glimt-agent
RUN mkdir -p /data/buffer && chown -R app:app /data
USER app
ENV ASPNETCORE_HTTP_PORTS= \
    GLIMT_HUB_URL=http://0.0.0.0:8080 \
    GLIMT_BUFFER_PATH=/data/buffer
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/healthz || exit 1
ENTRYPOINT ["/bin/sh", "-c", "[ -z \"$GLIMT_TOKEN\" ] || glimt-agent run & exec \"$0\" \"$@\""]
CMD ["dotnet", "Glimt.Hub.dll"]
