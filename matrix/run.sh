#!/usr/bin/env bash
# Builds every simulated site of the matrix against a test API and writes
# matrix/results.txt: one block per site with the plugin's log lines, the
# outputs and their page counts. Usage: LEGIVEL_API_URL=… LEGIVEL_API_KEY=… matrix/run.sh [site…]
set -u
cd "$(dirname "$0")"
: "${LEGIVEL_API_URL:?set LEGIVEL_API_URL to the test API origin}"
export LEGIVEL_API_URL
DOCUSAURUS="${DOCUSAURUS:-$(cd .. && pwd)/node_modules/@docusaurus/core/bin/docusaurus.mjs}"
sites=("$@"); [ ${#sites[@]} -eq 0 ] && sites=($(ls sites))
out=results.txt; : > "$out"
for s in "${sites[@]}"; do
  echo "=== $s — $(cat sites/$s/SHAPE.txt)" | tee -a "$out"
  rm -rf "sites/$s/build" "sites/$s/.docusaurus"
  start=$(date +%s)
  (cd "sites/$s" && node "$DOCUSAURUS" build 2>&1) | grep -E '\[legivel-pdf\]|\[ERROR\]|Error:|legivel answered' | sed 's/^/  /' | tee -a "$out"
  echo "  build: $(( $(date +%s) - start )) s, exit ${PIPESTATUS[0]}" | tee -a "$out"
  # A shape that claims «a second build renders nothing again» is built twice,
  # the cache under .docusaurus kept, so the claim is checked and not assumed.
  if grep -q "second build" "sites/$s/SHAPE.txt"; then
    echo "  --- second build, cache kept" | tee -a "$out"
    (cd "sites/$s" && node "$DOCUSAURUS" build 2>&1) | grep -E '\[legivel-pdf\] (page PDFs|[0-9]+ documents?|.*unchanged)' | sed 's/^/  /' | tee -a "$out"
  fi
  for f in $(cd "sites/$s" && find build -name '*.pdf' | sort); do
    echo "  $f: $(pdfinfo "sites/$s/$f" 2>/dev/null | awk '/^Pages/{print $2" pages"}')" | tee -a "$out"
  done
done
