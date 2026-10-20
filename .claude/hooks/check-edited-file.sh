#!/usr/bin/env bash
# PostToolUse hook: formats the file Claude just edited, then lints and type-checks it.
# Exit code 2 sends the problems back to Claude so they are fixed immediately.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
bin=node_modules/.bin

file=$(node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path??"")}catch{}})')
case "$file" in
  "$PWD"/*) ;;
  *) exit 0 ;;
esac
[[ -f "$file" ]] || exit 0

problems=""
"$bin/prettier" --write --ignore-unknown --log-level warn "$file" >/dev/null 2>&1 || true

if [[ "$file" =~ \.(ts|tsx|js|mjs|cjs)$ ]]; then
  if ! output=$("$bin/eslint" --no-warn-ignored "$file" 2>&1); then
    problems+="ESLint:\n$output\n"
  fi
fi
if [[ "$file" =~ \.ts$ ]]; then
  if ! output=$("$bin/tsc" -b 2>&1); then
    problems+="Type check (tsc -b):\n$output\n"
  fi
fi

if [[ -n "$problems" ]]; then
  printf '%b' "$problems" >&2
  exit 2
fi
exit 0
