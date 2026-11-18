#!/bin/sh
set -eu

validate_name() {
    printf '%s\n' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$' &&
        [ "${#1}" -le 253 ] && [ "$(printf '%s' "$1" | tr -cd '\r\n' | wc -c)" -eq 0 ]
}

validate_authority() {
    name=${1%%:*}
    validate_name "$name" || return 1
    if [ "$name" != "$1" ]; then
        port=${1#*:}
        case "$port" in ''|0*|*[!0-9]*) return 1 ;; esac
        [ "${#port}" -le 5 ] && [ "$port" -le 65535 ] || return 1
    fi
}

for variable in GATEWAY_HOST CORE_UPSTREAM AUDIT_UPSTREAM LIVE_UPSTREAM; do
    eval 'value=${'"$variable"':-}'
    if ! validate_authority "$value"; then
        printf 'Invalid or missing %s\n' "$variable" >&2
        exit 64
    fi
done

case "${GATEWAY_MODE:-}" in
    local-http) GATEWAY_TLS='' ;;
    tls) GATEWAY_TLS='ssl' ;;
    *) printf 'GATEWAY_MODE must be local-http or tls\n' >&2; exit 64 ;;
esac
GATEWAY_NAME=${GATEWAY_HOST%%:*}
GATEWAY_TLS_CONFIG=''
if [ "$GATEWAY_MODE" = tls ]; then
    GATEWAY_TLS_CONFIG='ssl_certificate /run/agrotrac/tls/fullchain.pem;
    ssl_certificate_key /run/agrotrac/tls/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;'
fi
export GATEWAY_NAME GATEWAY_TLS GATEWAY_TLS_CONFIG
envsubst '$GATEWAY_HOST $GATEWAY_NAME $GATEWAY_TLS $GATEWAY_TLS_CONFIG $CORE_UPSTREAM $AUDIT_UPSTREAM $LIVE_UPSTREAM' \
    < /etc/agrotrac/nginx.conf.template > /etc/nginx/nginx.conf
exec "$@"
