#!/bin/sh
# Re-render the console from the live database into the publish staging path.
# Used by the 2-minute refresh loop; safe to run by hand.
set -e
REPO="/home/user/automaton"
DB="${1:-$REPO/tools/observatory/.live/state.db}"
OUT="${2:-/tmp/claude-0/-home-user-automaton/96f94adf-47e7-5221-a735-7556988c15a9/scratchpad/automaton-console.html}"
cd "$REPO"
npx tsx tools/observatory/render-dashboard.ts "$DB" "$OUT"
