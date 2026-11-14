#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:---check}"
if [[ "$#" -gt 1 || ( "$mode" != --check && "$mode" != --write ) ]]; then
  echo 'Usage: format-go.sh [--check|--write]' >&2
  exit 2
fi
failed=0
while IFS= read -r -d '' file; do
  case "$file" in data/*|private/*|*/private/*|.e2e/*|vendor/*) continue ;; esac
  if [[ "$mode" == --write ]]; then
    gofmt -w -- "$file"
  else
    unformatted="$(gofmt -l -- "$file")"
    if [[ -n "$unformatted" ]]; then
      printf '%s\n' "$unformatted"
      failed=1
    fi
  fi
done < <(git ls-files --cached --others --exclude-standard -z -- '*.go')
exit "$failed"
