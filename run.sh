#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v swipl >/dev/null 2>&1; then
  echo "SWI-Prolog 9.x was not found. Install it and make sure 'swipl' is on PATH." >&2
  exit 1
fi
exec swipl -q -s prolog/web_server.pl
