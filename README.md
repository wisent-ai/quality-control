# Wisent quality control

Central PR quality checks for `wisent-ai` repositories.

The first check rejects pull requests whose commit subjects are too vague to audit later. Examples that fail:

- `fix`
- `update`
- `wip`
- `more changes`
- `fix bug`

Examples that pass:

- `Add Apple Ads credential connector`
- `fix: persist Google Ads account chooser`
- `Improve Swiatowid transcript provider grouping`

The second check rejects pull requests that introduce keyword-driven lexical logic. It runs `scripts/check-no-keyword-logic.mjs` against the PR diff, the same guard used by the local git hook.

This catches introduced identifiers such as `keywords`, word-list gates, phrase/prefix/pattern lists wired into contains/match checks, and regex alternations over natural-language tokens.

The fallback check rejects introduced fallback behavior: fallback identifiers, nullish/default coalescing, logical-or defaults, optional `try?`, dictionary defaults, promise catch defaults, catch blocks that return substitute values, and empty catch blocks.

The constants check rejects introduced magic values in logic. It flags non-trivial string literals and numeric literals outside the small structural set `-1`, `0`, `1`, `2`, while allowing imports and named uppercase constant declarations.

## How it is enforced

GitHub supports organization rulesets that require a workflow to pass before pull requests merge. The required workflow lives in this repository at `.github/workflows/required-pr-quality.yml`.

The intended organization ruleset targets the default branch of every `wisent-ai` repository except this host repo. It requires pull requests and requires the workflow in this repository to pass.

Install it with an org-admin token:

```bash
gh auth refresh -h github.com -s admin:org
node scripts/install-org-ruleset.mjs
```

## Local test

```bash
npm test
```
