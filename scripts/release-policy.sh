#!/bin/sh
# Enforce the explicit release contract of every repository in either a local
# pack checkout or the complete repository inventory returned by GitHub.
set -eu

root="${PACK_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)}"
format=text
org=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json)
      format=json
      shift
      ;;
    --github-org)
      [ "$#" -ge 2 ] || {
        echo "--github-org requires an organization" >&2
        exit 2
      }
      org="$2"
      shift 2
      ;;
    *)
      echo "usage: scripts/release-policy.sh [--json] [--github-org ORGANIZATION]" >&2
      exit 2
      ;;
  esac
done

if [ -n "$org" ] && [ -z "${QUALITY_CONTROL_ORG_AUDIT_TOKEN:-${GH_TOKEN:-}}" ]; then
  echo "QUALITY_CONTROL_ORG_AUDIT_TOKEN (or GH_TOKEN) is required for a complete organization audit" >&2
  exit 2
fi

python3 - "$root" "$format" "$org" <<'PY'
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

root = pathlib.Path(sys.argv[1])
output_format = sys.argv[2]
organization = sys.argv[3]
token = os.environ.get("QUALITY_CONTROL_ORG_AUDIT_TOKEN") or os.environ.get("GH_TOKEN", "")
api_origin = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")


def github_get(path, accept="application/vnd.github+json", allow_missing=False):
    request = urllib.request.Request(
        f"{api_origin}{path}",
        headers={
            "Accept": accept,
            "Authorization": f"Bearer {token}",
            "User-Agent": "wisent-release-policy-audit",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if allow_missing and error.code == 404:
            return None
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {path} returned HTTP {error.code}: {detail}") from error


def github_repositories(org):
    encoded = urllib.parse.quote(org, safe="")
    metadata = json.loads(github_get(f"/orgs/{encoded}"))
    private_count = metadata.get("total_private_repos")
    public_count = metadata.get("public_repos")
    if not isinstance(private_count, int) or not isinstance(public_count, int):
        raise RuntimeError(
            "organization token cannot prove the private and public repository counts; "
            "refusing a partial inventory"
        )
    repositories = []
    page = 1
    while True:
        batch = json.loads(
            github_get(f"/orgs/{encoded}/repos?type=all&per_page=100&page={page}")
        )
        if not isinstance(batch, list):
            raise RuntimeError("GitHub repository inventory is not an array")
        repositories.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    expected = public_count + private_count
    if len(repositories) != expected:
        raise RuntimeError(
            f"GitHub inventory returned {len(repositories)} repositories but organization "
            f"metadata declares {expected}; refusing a partial inventory"
        )
    return sorted(repositories, key=lambda item: item["name"])


def local_policies():
    for repo in sorted(path for path in root.iterdir() if (path / ".git").exists()):
        policy_path = repo / ".github" / "release-policy.json"
        yield repo.name, (
            policy_path.read_text(encoding="utf-8") if policy_path.is_file() else None
        ), None


def github_policies(org):
    for repo in github_repositories(org):
        name = repo.get("name")
        full_name = repo.get("full_name")
        default_branch = repo.get("default_branch")
        if not all(isinstance(value, str) and value for value in (name, full_name, default_branch)):
            yield str(name or full_name or "<unknown>"), None, "repository metadata is incomplete"
            continue
        quoted_name = urllib.parse.quote(full_name, safe="/")
        quoted_ref = urllib.parse.quote(default_branch, safe="")
        try:
            raw = github_get(
                f"/repos/{quoted_name}/contents/.github/release-policy.json?ref={quoted_ref}",
                accept="application/vnd.github.raw+json",
                allow_missing=True,
            )
            yield name, raw.decode("utf-8") if raw is not None else None, None
        except (RuntimeError, UnicodeDecodeError) as error:
            yield name, None, str(error)


def validate(repository, raw):
    policy = json.loads(raw)
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
        return "publishes", {
            "repository": repository,
            "type": release_type,
            "manifest": manifest,
            "publisher": publishers,
        }
    if releases is False:
        if set(policy) - {"schema_version", "releases", "reason"}:
            raise ValueError("releases=false permits only reason")
        reason = policy.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("releases=false requires a non-empty reason")
        return "declared_no_release", {"repository": repository, "reason": reason}
    raise ValueError("releases must be true or false")


report = {
    "publishes": [],
    "declared_no_release": [],
    "silent": [],
    "malformed": [],
}
try:
    policies = github_policies(organization) if organization else local_policies()
    for repository, raw, retrieval_error in policies:
        if retrieval_error:
            report["malformed"].append({"repository": repository, "error": retrieval_error})
        elif raw is None:
            report["silent"].append(repository)
        else:
            try:
                category, declaration = validate(repository, raw)
                report[category].append(declaration)
            except (json.JSONDecodeError, ValueError, TypeError) as error:
                report["malformed"].append({"repository": repository, "error": str(error)})
except (RuntimeError, urllib.error.URLError, json.JSONDecodeError, KeyError, TypeError) as error:
    report["malformed"].append({"repository": f"organization:{organization}", "error": str(error)})

if output_format == "json":
    print(json.dumps(report, separators=(",", ":"), sort_keys=True))
else:
    print(f"publishes ({len(report['publishes'])}):")
    for item in report["publishes"]:
        print(
            f"  {item['repository']} — {item['type']}; {item['manifest']}; "
            f"{', '.join(item['publisher'])}"
        )
    print(f"\ndeclared no release ({len(report['declared_no_release'])}):")
    for item in report["declared_no_release"]:
        print(f"  {item['repository']} — {item['reason']}")
    print(f"\nsilent ({len(report['silent'])}):")
    for name in report["silent"]:
        print(f"  {name}")
    print(f"\nmalformed ({len(report['malformed'])}):")
    for item in report["malformed"]:
        print(f"  {item['repository']} — {item['error']}")

raise SystemExit(1 if report["silent"] or report["malformed"] else 0)
PY
