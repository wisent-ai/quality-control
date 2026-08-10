#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, pathlib, subprocess

def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()

def remote_slug(remote: str) -> str:
    value=remote.removesuffix(".git").rstrip("/")
    return "/".join(value.split("/")[-2:])

def main() -> None:
    parser=argparse.ArgumentParser(); parser.add_argument("--catalog",default="release-catalog.json"); parser.add_argument("--root"); args=parser.parse_args()
    catalog=json.loads(pathlib.Path(args.catalog).read_text())
    if catalog.get("schema_version") != 1 or not isinstance(catalog.get("repositories"),list): raise SystemExit("invalid release catalog")
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
    print(f"release catalog: {len(repositories)} repositories, {len(products)} releasing products")
if __name__ == "__main__": main()
