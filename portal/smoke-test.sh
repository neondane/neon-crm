#!/usr/bin/env bash
# smoke-test.sh — hit the LIVE portal URLs and verify they're not broken.
# Run AFTER `wrangler pages deploy`. Tests real-world behavior.

set -e
HOST="${HOST:-https://refer.neongiantmoving.com}"
TEST_SLUG="${TEST_SLUG:-dane-test-231}"

FAIL=0
ok()   { printf '  ✓ %s\n' "$*"; }
fail() { printf '  ❌ %s\n' "$*"; FAIL=1; }

echo "── Smoke test: $HOST ────────────────────────────"

# 1. refer page loads with submit handler
echo "[1] /refer?r=$TEST_SLUG"
R=$(curl -fsS "$HOST/refer?r=$TEST_SLUG" || echo "")
if [ -z "$R" ]; then fail "refer page failed to fetch"
elif ! echo "$R" | grep -q "</html>"; then fail "refer page TRUNCATED — no </html>"
elif ! echo "$R" | grep -q "location.href = dashUrl"; then fail "refer missing post-submit redirect"
elif ! echo "$R" | grep -q "submitForm"; then fail "refer missing submitForm function"
else ok "refer page: $(echo -n "$R" | wc -c) bytes, redirect present"; fi

# 2. portal dashboard loads with render+load
echo "[2] /portal?r=$TEST_SLUG"
P=$(curl -fsS "$HOST/portal?r=$TEST_SLUG" || echo "")
if [ -z "$P" ]; then fail "portal page failed to fetch"
elif ! echo "$P" | grep -q "</html>"; then fail "portal page TRUNCATED — no </html>"
elif ! echo "$P" | grep -q "^load();"; then fail "portal missing load() kick-off"
elif ! echo "$P" | grep -q "function render("; then fail "portal missing render fn"
else ok "portal page: $(echo -n "$P" | wc -c) bytes, render+load present"; fi

# 3. API proxy reaches Apps Script
echo "[3] /api/getRealtorBySlug"
J=$(curl -fsS -X POST -H "Content-Type: application/json" \
     "$HOST/api/getRealtorBySlug" \
     -d "{\"slug\":\"$TEST_SLUG\"}" || echo "")
if echo "$J" | grep -q '"ok":true'; then ok "API proxy works"
elif echo "$J" | grep -q "Realtor not found"; then ok "API proxy works (slug $TEST_SLUG not in DB)"
else fail "API proxy broken: ${J:0:200}"; fi

echo "─────────────────────────────────────────"
if [ $FAIL -ne 0 ]; then
  echo "🛑 SMOKE TEST FAILED — site is broken in production. Rollback!"
  exit 1
else
  echo "✅ Live site is healthy."
fi
