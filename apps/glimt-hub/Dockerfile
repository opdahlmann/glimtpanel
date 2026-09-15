# glimt-hub: .NET 10 hub. Bygg-kontekst = repo-rot (IMPLEMENTERINGSPLAN 5.5).
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
RUN mkdir -p /data/buffer && chown -R app:app /data
USER app
ENV ASPNETCORE_HTTP_PORTS= \
    GLIMT_HUB_URL=http://0.0.0.0:8080 \
    GLIMT_BUFFER_PATH=/data/buffer
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/healthz || exit 1
ENTRYPOINT ["dotnet", "Glimt.Hub.dll"]
