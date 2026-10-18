#!/usr/bin/env bash
# Bring up a local receiving SEP-31 anchor: Stellar's own Anchor Platform,
# configured for the Corridor corridor under test. Testnet only.
#
#   ./up.sh         start it and wait for SEP-1 to answer
#   ./down.sh       stop it and remove the volumes
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT=$(cd ../.. && pwd)

echo "==> Creating and funding the anchor's testnet accounts"
(cd "$ROOT" && pnpm -s tsx examples/anchor/keys.ts)

set -a; . ./.env; set +a
SEP_PORT=${ANCHOR_SEP_PORT:-8080}
BASE_URL="http://localhost:$SEP_PORT"

# A process already on the port is easy to miss: curl may prefer IPv6 and
# reach Docker while an IPv4-first client reaches the squatter instead.
if [ -z "$(docker compose ps -q platform 2>/dev/null)" ] && lsof -nP -iTCP:"$SEP_PORT" -sTCP:LISTEN 2>/dev/null | grep -qv '^COMMAND'; then
  echo "Port $SEP_PORT is already in use:" >&2
  lsof -nP -iTCP:"$SEP_PORT" -sTCP:LISTEN >&2
  echo >&2
  echo "Pick another: ANCHOR_SEP_PORT=8180 ./up.sh" >&2
  exit 1
fi

echo "==> Filling the config templates"
sed -e "s|\${DISTRIBUTION_ACCOUNT}|$DISTRIBUTION_ACCOUNT|g" config/assets.yaml.template > config/assets.yaml
sed -e "s|\${DISTRIBUTION_ACCOUNT}|$DISTRIBUTION_ACCOUNT|g" -e "s|\${HOST_SEP10_ACCOUNT}|$HOST_SEP10_ACCOUNT|g" \
  -e "s|\${SEP_PORT}|$SEP_PORT|g" config/stellar.localhost.toml.template > config/stellar.localhost.toml
sed -e "s|\${DISTRIBUTION_ACCOUNT_SECRET_KEY}|$DISTRIBUTION_ACCOUNT_SECRET_KEY|g" -e "s|\${DISTRIBUTION_ACCOUNT}|$DISTRIBUTION_ACCOUNT|g" \
  config/reference-config.yaml.template > config/reference-config.yaml

echo "==> Starting the stack"
ANCHOR_SEP_PORT=$SEP_PORT docker compose up -d --force-recreate platform reference-server
ANCHOR_SEP_PORT=$SEP_PORT docker compose up -d

printf '==> Waiting for SEP-1 at %s' "$BASE_URL"
for _ in $(seq 1 120); do
  if curl -fsS "$BASE_URL/.well-known/stellar.toml" >/dev/null 2>&1; then
    echo " · up"
    echo
    echo "  SEP server         $BASE_URL"
    echo "  SEP-10 signing key $HOST_SEP10_ACCOUNT"
    echo "  Receiving account  $DISTRIBUTION_ACCOUNT"
    echo
    echo "Point Corridor at it:"
    echo "  CORRIDOR_ANCHOR_BASE_URL=$BASE_URL pnpm stellar:payout"
    exit 0
  fi
  printf '.'
  sleep 2
done
echo
echo "SEP-1 did not answer in four minutes. Logs: docker compose logs platform" >&2
exit 1
