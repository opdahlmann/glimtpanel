#!/bin/sh
# Kjøres av nginx-imagets entrypoint før nginx starter. Skriver /usr/share/nginx/html/config.json fra
# GLIMT_*-miljøvariabler, samme JSON-form som scripts/web-config.mjs lager for `ng serve`.
set -eu

out="${GLIMT_WEB_ROOT:-/usr/share/nginx/html}/config.json"

# Escaper \ og " slik at verdien kan stå i en JSON-streng.
json_str() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Kommaseparert liste -> JSON-array. Tomme elementer og mellomrom rundt fjernes.
json_flags() {
  old_ifs=$IFS
  IFS=','
  # shellcheck disable=SC2086
  set -- $1
  IFS=$old_ifs
  printf '['
  first=1
  for flag in "$@"; do
    flag=$(printf '%s' "$flag" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -n "$flag" ] || continue
    [ "$first" -eq 1 ] || printf ','
    printf '"%s"' "$(json_str "$flag")"
    first=0
  done
  printf ']'
}

printf '{\n  "env": "%s",\n  "apiUrl": "/api",\n  "hubUrl": "/hub/live",\n  "hubPublicUrl": "%s",\n  "installUrl": "%s",\n  "docsUrl": "%s",\n  "vapidPublic": "%s",\n  "defaultLang": "%s",\n  "featureFlags": %s\n}\n' \
  "$(json_str "${GLIMT_ENV:-production}")" \
  "$(json_str "${GLIMT_HUB_PUBLIC_URL:-}")" \
  "$(json_str "${GLIMT_INSTALL_URL:-}")" \
  "$(json_str "${GLIMT_DOCS_URL:-https://github.com/opdahlmann/glimtpanel#readme}")" \
  "$(json_str "${GLIMT_VAPID_PUBLIC:-}")" \
  "$(json_str "${GLIMT_DEFAULT_LANG:-en}")" \
  "$(json_flags "${GLIMT_FEATURE_FLAGS:-}")" \
  > "$out"

echo "glimt-web: wrote $out (env=${GLIMT_ENV:-production}, hub=${GLIMT_HUB_INTERNAL_URL:-unset})"
