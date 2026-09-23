#!/bin/sh
set -eu

DSH_HOME="${DSH_HOME:-/root/.dsh}"
export DSH_HOME
mkdir -p "$DSH_HOME"
cp /dsh/.env "$DSH_HOME/.env"
chmod 600 "$DSH_HOME/.env"

# Cordis evaluates provider configuration before the collaboration bundle's
# apply hook runs, so both bundled values must already be exported here.
set -a
. "$DSH_HOME/.env"
set +a

if [ "${AGENTHARNESS_GIT_CREDENTIALS_ENABLED:-0}" = 1 ]; then
  cp /run/secrets/gitee-credentials /run/gitee-credentials
  chmod 600 /run/gitee-credentials
  git config --global credential.helper 'store --file=/run/gitee-credentials'
fi

/dsh/acceptance/development-room/prepare-workspace.sh
node /dsh/acceptance/development-room/migrate-profile.mjs

cd /dsh
exec pnpm dsh web "$@"
