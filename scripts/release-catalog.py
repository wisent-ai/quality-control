#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, pathlib, subprocess

def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()

def remote_slug(remote: str) -> str:
    value=remote.removesuffix(".git").rstrip("/")
    if "huggingface.co/" in value:
        return "huggingface:" + value.split("huggingface.co/", 1)[1]
    return "/".join(value.split("/")[-2:])

def git(checkout: pathlib.Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=checkout,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise SystemExit(
            f"{checkout}: git {' '.join(args)} failed: {result.stderr.strip()}"
        )
    return result.stdout.strip()


def update_checkout(catalog: dict[str, object], checkout: pathlib.Path) -> str:
    checkout = checkout.resolve()
    repository = remote_slug(git(checkout, "remote", "get-url", "origin"))
    entries = [
        entry
        for entry in catalog["repositories"]
        if entry.get("repository") == repository
    ]
    if len(entries) != 1:
        raise SystemExit(
            f"{checkout}: expected one release catalog entry for {repository}, found {len(entries)}"
        )
    commit = git(checkout, "rev-parse", "HEAD")
    branch = git(checkout, "symbolic-ref", "--short", "HEAD")
    try:
        manifest = json.loads(
            git(checkout, "show", f"{commit}:.wisent-release.json")
        )
    except json.JSONDecodeError as error:
        raise SystemExit(f"{checkout}: invalid committed .wisent-release.json: {error}") from error
    entry = entries[0]
    entry.update(
        {
            "remote": git(checkout, "remote", "get-url", "origin"),
            "releases": bool(manifest.get("releases")),
            "product": manifest.get("product"),
            "source_branch": branch,
            "source_commit": commit,
            "manifest_sha256": hashlib.sha256(canonical(manifest)).hexdigest(),
            "manifest": manifest,
        }
    )
    return repository


def write_catalog(path: pathlib.Path, catalog: dict[str, object]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(catalog, indent=2) + "\n")
    temporary.replace(path)


def main() -> None:
    parser=argparse.ArgumentParser(); parser.add_argument("--catalog",default="release-catalog.json"); parser.add_argument("--root"); parser.add_argument("--update-checkout",action="append",default=[],metavar="PATH"); args=parser.parse_args()
    catalog_path=pathlib.Path(args.catalog)
    catalog=json.loads(catalog_path.read_text())
    if catalog.get("schema_version") != 1 or not isinstance(catalog.get("repositories"),list): raise SystemExit("invalid release catalog")
    updated = [
        update_checkout(catalog, pathlib.Path(checkout))
        for checkout in args.update_checkout
    ]
    repositories=set(); products=set()
    for entry in catalog["repositories"]:
        repository=entry.get("repository"); manifest=entry.get("manifest"); commit=entry.get("source_commit","")
        if not isinstance(repository,str) or repository in repositories: raise SystemExit(f"duplicate or invalid repository: {repository}")
        repositories.add(repository)
        if not isinstance(manifest,dict) or manifest.get("schema_version") != 1: raise SystemExit(f"{repository}: invalid manifest")
        if bool(manifest.get("releases")) != bool(entry.get("releases")): raise SystemExit(f"{repository}: release decision mismatch")
        if manifest.get("product") != entry.get("product"): raise SystemExit(f"{repository}: product mismatch")
        if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit): raise SystemExit(f"{repository}: source commit is not canonical")
        digest=hashlib.sha256(canonical(manifest)).hexdigest()
        if digest != entry.get("manifest_sha256"): raise SystemExit(f"{repository}: manifest digest mismatch")
        if entry["releases"]:
            product=entry.get("product")
            if not isinstance(product,str) or product in products: raise SystemExit(f"duplicate or invalid product: {product}")
            products.add(product)
            if not isinstance(manifest.get("platforms"),dict) or not manifest["platforms"]: raise SystemExit(f"{repository}: releasing product has no platform recipe")
        elif not isinstance(manifest.get("reason"),str) or not manifest["reason"].strip(): raise SystemExit(f"{repository}: non-release decision has no reason")
    if args.root:
        root=pathlib.Path(args.root)
        for checkout in root.iterdir():
            if not (checkout/".git").exists(): continue
            result=subprocess.run(["git","remote","get-url","origin"],cwd=checkout,text=True,capture_output=True)
            if result.returncode: continue
            slug=remote_slug(result.stdout.strip())
            if slug not in repositories: raise SystemExit(f"uncatalogued repository checkout: {slug}")
    if updated:
        write_catalog(catalog_path, catalog)
    print(f"release catalog: {len(repositories)} repositories, {len(products)} releasing products")
if __name__ == "__main__": main()
