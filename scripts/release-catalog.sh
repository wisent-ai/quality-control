#!/bin/sh
set -eu
root="${1:-.}"
python3 "$(dirname "$0")/release-catalog.py" --catalog "$(dirname "$0")/../release-catalog.json" --root "$root"
stado release catalog sync --root "$root"
stado release catalog audit
