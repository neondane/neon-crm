#!/usr/bin/env bash
# preflight.sh — refuse to deploy if any HTML/JS file in portal/ is busted.
# Run from the portal/ directory before `wrangler pages deploy`.
# Exit 0 = safe to deploy.  Exit non-zero = ABORT.

set -e

cd "$(dirname "$0")"

FAIL=0
say()  { printf '  %s\n' "$*"; }
fail() { printf '  ❌ %s\n' "$*"; FAIL=1; }
ok()   { printf '  ✓ %s\n' "$*"; }

echo "── Preflight: portal/ deploy guard ─────────────────────────────"

# ----- 1. Every .html must end with </html> -----
echo "[1] HTML files end with </html>"
for f in *.html; do
  [ -f "$f" ] || continue
  if grep -q '</html>' "$f"; then ok "$f closes properly"
  else fail "$f is TRUNCATED — missing </html>"; fi
done

# ----- 2. Every .html with <script> must close with </script> -----
echo "[2] HTML <script> blocks balanced"
for f in *.html; do
  [ -f "$f" ] || continue
  OPEN=$(grep -c "<script\b" "$f"  || true)
  CLOSE=$(grep -c "</script>" "$f" || true)
  if [ "$OPEN" -eq "$CLOSE" ] && [ "$OPEN" -gt 0 ]; then ok "$f $OPEN/$CLOSE <script>"
  elif [ "$OPEN" -eq 0 ]; then ok "$f no <script> (skip)"
  else fail "$f imbalanced: $OPEN open / $CLOSE close"; fi
done

# ----- 3. Extract inline JS and node --check it -----
echo "[3] Inline JS parses cleanly"
TMP=$(mktemp -d)
for f in *.html; do
  [ -f "$f" ] || continue
  awk '/^<script>$/{flag=1; next} /^<\/script>$/{flag=0} flag' "$f" > "$TMP/$f.js"
  if [ -s "$TMP/$f.js" ]; then
    if node --check "$TMP/$f.js" >/dev/null 2>"$TMP/err"; then
      ok "$f JS parses"
    else
      fail "$f JS SyntaxError: $(head -3 "$TMP/err" | tr '\n' ' ')"
    fi
  fi
done

# ----- 4. Pages Functions parse -----
echo "[4] Pages Functions parse"
if [ -d functions ]; then
  while IFS= read -r f; do
    if node --check "$f" >/dev/null 2>"$TMP/err"; then
      ok "$f parses"
    else
      fail "$f SyntaxError: $(head -3 "$TMP/err" | tr '\n' ' ')"
    fi
  done < <(find functions -name '*.js')
fi

# ----- 5. CRITICAL anchor strings present (per-file canary list) -----
echo "[5] Required anchor strings"
check() {
  local file="$1"; shift
  for anchor in "$@"; do
    if grep -qF "$anchor" "$file"; then ok "$file has: $anchor"
    else fail "$file MISSING: $anchor"; fi
  done
}
check portal.html "function load()" "function render(" "document.getElementById('body').innerHTML = h;" "load();"
check refer.html  "submitForm" "location.href = dashUrl" "encodeURIComponent(getSlug())"
check index.html  "</body>"

# ----- 6. File size sanity (catch wildly-shrunk files) -----
echo "[6] File size sanity"
MIN_PORTAL=15000
MIN_REFER=10000
for f in portal.html refer.html; do
  if [ -f "$f" ]; then
    SZ=$(wc -c < "$f")
    MIN_VAR="MIN_$(echo "${f%.html}" | tr a-z A-Z)"
    MIN=${!MIN_VAR}
    if [ "$SZ" -lt "$MIN" ]; then fail "$f only $SZ bytes (min $MIN)"
    else ok "$f $SZ bytes (≥ $MIN)"; fi
  fi
done

rm -rf "$TMP"
echo "─────────────────────────────────────────────────────────────"

if [ $FAIL -ne 0 ]; then
  echo "🛑 ABORT: preflight checks failed. DO NOT DEPLOY."
  exit 1
else
  echo "✅ All checks passed. Safe to deploy."
fi
