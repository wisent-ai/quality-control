#!/bin/sh
# Which repositories publish, which have said they do not, and which are
# simply silent.
#
# Forty-four of the pack's repositories carry no workflow at all, and today
# there is no way to tell "this is a library that ships nothing" from "nobody
# set this up". That is the same defect the Skarbiec dashboard had, one layer
# up: a state chosen deliberately and a state nobody attended to rendered
# identically, which teaches a reader to skim past both.
#
# The remedy is a declaration a repository can make about itself:
#
#   .github/release-policy.json
#   {"releases": false, "reason": "manuscripts; nothing is built or shipped"}
#
# A repository that publishes needs no file - its release workflow says so.
# A repository that publishes nothing says why. Anything left is silent, and
# silence is what this prints last, because it is the only column that is a
# question rather than an answer.
#
# Usage: scripts/release-policy.sh [--json]
set -eu

# The pack root: this script lives in quality-control, which owns review and
# scanning policy, and reads its siblings. PACK_ROOT overrides for a checkout
# laid out differently.
root="${PACK_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)}"
cd "$root"

as_json=false
if [ "${1:-}" = "--json" ]; then
  as_json=true
fi

publishes=""
declared=""
silent=""

for entry in */; do
  repo="${entry%/}"
  [ -d "$repo/.git" ] || continue

  policy="$repo/.github/release-policy.json"
  if [ -f "$policy" ]; then
    declared="$declared $repo"
    continue
  fi

  # A repository publishes if any workflow creates a release. Matching the
  # publishing action rather than the word "release" keeps a workflow merely
  # NAMED release.yml from counting as one that publishes.
  if [ -d "$repo/.github/workflows" ] && grep -rlq \
      -e 'softprops/action-gh-release' \
      -e 'gh release create' \
      -e 'actions/create-release' \
      -e 'macos-sparkle-release.yml' \
      "$repo/.github/workflows" 2>/dev/null; then
    publishes="$publishes $repo"
    continue
  fi

  silent="$silent $repo"
done

count() {
  # shellcheck disable=SC2086
  set -- $1
  printf '%s' "$#"
}

if [ "$as_json" = true ]; then
  emit() {
    printf '['
    separator=""
    # shellcheck disable=SC2086
    for name in $2; do
      printf '%s"%s"' "$separator" "$name"
      separator=","
    done
    printf ']'
  }
  printf '{"publishes":'
  emit publishes "$publishes"
  printf ',"declared_no_release":'
  emit declared "$declared"
  printf ',"silent":'
  emit silent "$silent"
  printf '}\n'
  exit 0
fi

printf 'publishes (%s):\n' "$(count "$publishes")"
for name in $publishes; do printf '  %s\n' "$name"; done

printf '\ndeclared no release (%s):\n' "$(count "$declared")"
for name in $declared; do
  reason="$(sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$name/.github/release-policy.json" | head -1)"
  printf '  %s — %s\n' "$name" "${reason:-no reason given}"
done

printf '\nsilent (%s) — neither publishes nor says why:\n' "$(count "$silent")"
for name in $silent; do printf '  %s\n' "$name"; done
