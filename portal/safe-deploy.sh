#!/usr/bin/env bash
# safe-deploy.sh — preflight → deploy → smoke test, with automatic rollback signal.
# Usage:  bash safe-deploy.sh "commit message describing what changed"

set -e
cd "$(dirname "$0")"

MSG="${1:-portal deploy}"

echo ""
echo "════════════════════════════════════════"
echo "  SAFE DEPLOY: $MSG"
echo "════════════════════════════════════════"
echo ""

# Step 1: Preflight (refuses to continue if files are broken)
bash ./preflight.sh

echo ""
echo "── Deploying to Cloudflare Pages ──"
CF_TOKEN=$(cat /sessions/wizardly-magical-brown/mnt/outputs/.cf-token)
CF_ACCOUNT=$(cat /sessions/wizardly-magical-brown/mnt/outputs/.cf-account)
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT"

npx --yes wrangler@latest pages deploy . \
  --project-name=neon-portal \
  --branch=main \
  --commit-message="$MSG" 2>&1 | tail -8

echo ""
echo "── Waiting 5s for edge propagation ──"
sleep 5

# Step 3: Smoke-test the live site
bash ./smoke-test.sh

echo ""
echo "🎉 Deploy + verify complete: $MSG"
