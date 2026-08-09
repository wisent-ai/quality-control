#!/bin/sh
set -eu

root="${1:-.}"
stado release catalog sync --root "$root"
stado release catalog audit
