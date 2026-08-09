#!/bin/sh
# Enforce the explicit release contract of every repository in the pack.
#
# releases=true requires the distribution type, the path of the emitted
# manifest, and every publisher that receives the exact release bytes.
# releases=false requires a reason. Workflow-name heuristics are deliberately
# not accepted: a publisher without policy and a non-publisher without policy
# are both silent, and silence is a contract failure.
set -eu

root="${PACK_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)}"
format=text
if [ "${1:-}" = "--json" ]; then
  format=json
elif [ "$#" -ne 0 ]; then
  echo "usage: scripts/release-policy.sh [--json]" >&2
  exit 2
fi

python3 - "$root" "$format" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
output_format = sys.argv[2]
publishes = []
no_release = []
silent = []
malformed = []

for repo in sorted(path for path in root.iterdir() if (path / ".git").exists()):
    policy_path = repo / ".github" / "release-policy.json"
    if not policy_path.is_file():
        silent.append(repo.name)
        continue
    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        if not isinstance(policy, dict) or set(policy) - {
            "schema_version", "releases", "type", "manifest", "publisher", "reason"
        }:
            raise ValueError("unsupported or non-object policy")
        if policy.get("schema_version") != 1:
            raise ValueError("schema_version must be 1")
        releases = policy.get("releases")
        if releases is True:
            if "reason" in policy:
                raise ValueError("releases=true forbids reason")
            release_type = policy.get("type")
            manifest = policy.get("manifest")
            publishers = policy.get("publisher")
            if not isinstance(release_type, str) or not release_type.strip():
                raise ValueError("releases=true requires non-empty type")
            if (
                not isinstance(manifest, str)
                or not manifest.strip()
                or pathlib.PurePosixPath(manifest).is_absolute()
                or ".." in pathlib.PurePosixPath(manifest).parts
            ):
                raise ValueError("releases=true requires a repository-relative manifest")
            if (
                not isinstance(publishers, list)
                or not publishers
                or any(not isinstance(value, str) or not value.strip() for value in publishers)
                or len(set(publishers)) != len(publishers)
            ):
                raise ValueError("releases=true requires a non-empty unique publisher array")
            publishes.append({
                "repository": repo.name,
                "type": release_type,
                "manifest": manifest,
                "publisher": publishers,
            })
        elif releases is False:
            if set(policy) - {"schema_version", "releases", "reason"}:
                raise ValueError("releases=false permits only reason")
            reason = policy.get("reason")
            if not isinstance(reason, str) or not reason.strip():
                raise ValueError("releases=false requires a non-empty reason")
            no_release.append({"repository": repo.name, "reason": reason})
        else:
            raise ValueError("releases must be true or false")
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as error:
        malformed.append({"repository": repo.name, "error": str(error)})

report = {
    "publishes": publishes,
    "declared_no_release": no_release,
    "silent": silent,
    "malformed": malformed,
}
if output_format == "json":
    print(json.dumps(report, separators=(",", ":"), sort_keys=True))
else:
    print(f"publishes ({len(publishes)}):")
    for item in publishes:
        print(
            f"  {item['repository']} — {item['type']}; {item['manifest']}; "
            f"{', '.join(item['publisher'])}"
        )
    print(f"\ndeclared no release ({len(no_release)}):")
    for item in no_release:
        print(f"  {item['repository']} — {item['reason']}")
    print(f"\nsilent ({len(silent)}):")
    for name in silent:
        print(f"  {name}")
    print(f"\nmalformed ({len(malformed)}):")
    for item in malformed:
        print(f"  {item['repository']} — {item['error']}")

raise SystemExit(1 if silent or malformed else 0)
PY
