#!/usr/bin/env bash
# Run terraform with Freeport's credentials:
#   Cloudflare: the scoped freeport-deploy token in ~/.cloudflare/freeport-deploy-token
#   AWS (state bucket only): FREEPORT_AWS_PROFILE, or your default AWS credentials
# Usage: terraform/tf.sh plan | apply | ...
set -euo pipefail
cd "$(dirname "$0")"
TOKEN_FILE="${FREEPORT_TOKEN_FILE:-$HOME/.cloudflare/freeport-deploy-token}"
CLOUDFLARE_API_TOKEN="$(grep '^API_TOKEN=' "$TOKEN_FILE" | cut -d= -f2-)"
export CLOUDFLARE_API_TOKEN
if [[ -n "${FREEPORT_AWS_PROFILE:-}" ]]; then export AWS_PROFILE="$FREEPORT_AWS_PROFILE"; fi
if [[ "${1:-}" == init ]]; then
  shift
  exec terraform init -backend-config=backend.hcl "$@"
fi
if [[ "${1:-}" == plan || "${1:-}" == apply ]]; then
  (cd .. && npm run build >/dev/null)
fi
exec terraform "$@"
