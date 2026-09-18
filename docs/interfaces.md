# Primary interfaces

The command lines, flags, report shapes, refusals and reusable workflows of every
quality-control guard. The [README](../README.md) says what the product is for; this
page is the reference for using it.


All four source guards accept exactly one mode:

```text
--all
--staged
--worktree
--base <sha>
--range <before>..<after>
```

If no mode is supplied, `--staged` is used. Combining modes or passing an unknown
argument exits `2` with usage. A zero `before` SHA in `--range` becomes an
all-files scan.

### No-keyword-logic

```bash
node src/check-no-keyword-logic.mjs --base <base-sha>
```

Flags selected keyword-named identifiers, word-list gates, natural-language
literal comparisons, and regular-expression alternations. Findings recommend
structured state, typed metadata, parser output, or explicit model/classifier
output instead of word matching.

### No-fallbacks

```bash
node src/check-no-fallbacks.mjs --worktree
node src/check-no-fallbacks.mjs --all --json
```

Flags selected fallback identifiers, nullish/logical defaulting, optional Swift
`try?`, Python dictionary defaults, promise/catch substitute values, and empty
catch blocks. A dictionary default is `.get(key, substitute)` with a
positional second argument; `client.get(url, params=...)` is a call with a
keyword argument and `isinstance(x.get(key), dict)` is a lookup, and neither
is reported. Narrow source-level exceptions exist for environment lookup,
logging, and selected accumulation patterns; no file is exempt by name, so a
`config.py` or a `profiles/` folder is scanned like any other source. A test
tree (`test/`, `tests/`, `Tests/`, `__tests__/`) and a file whose first five
lines say it is generated and not to be edited are left alone, as the other
guards leave them: the fixtures exercise these patterns on purpose, and the
generator is the source that is read. `--json`
prints the same report object as the magic-constants guard (`schemaVersion`,
`root`, `mode`, `checkedFiles`, `sourceDigest`, `violations`) and exits `1` on
findings. The remedy is never a substitute value: a missing input is refused
with a message that names it, and a failed call is an error the caller sees.
`tests/no-fallbacks/` runs the guard against real repositories under `.build`
to hold that boundary.

### No-magic-constants

```bash
node src/check-no-magic-constants.mjs --range <before>..<after>
node src/check-no-magic-constants.mjs --all --numbers-only --json
```

Flags selected significant literals in assignment and logic-sensitive lines.
Name the value, derive it from typed metadata, or load it from configuration.
`-1`, `0`, `1` and `2` are never findings; a line that names an upper-case
constant is never a finding, so `const RETRY_LIMIT = 3` passes and
`let retries = 3` does not. A number handed to a parser as a string —
`Number('127')`, `Int("3")`, `"8080".parse()`, or `"120"` closing one line
with `.parse::<u64>()` opening the next — is reported as `number literal N is
hidden in a string`, because that is the same literal wearing quotes. A value
with a unit or percent sign (`260px`, `100%`) is a dimension and is left
alone. `--numbers-only` ignores string literals.
`--json` prints one report object on stdout — `schemaVersion`, `root`, `mode`,
`checkedFiles`, `sourceDigest` (SHA-256 over every checked file) and
`violations` (`file`, `line`, `rule`, `detail`, `source`) — and still exits
`1` on findings. A directory named `Tests`, `test`, `tests`, `__tests__`,
`target`, `node_modules`, `vendor`, `_catalog`, `profiles`, `.build`,
`.swiftpm` or `.work` is never scanned wherever it sits, and neither is a
test file (`test_*.py`, `*_test.py`, `*.test.*`, `*.spec.*`, `*Tests.swift`),
a minified script (`*.min.js`), `config.py`, or a file whose first five lines say it is
generated and not to be edited: its generator is the source that is read.

### File limits

```bash
node src/check-file-limits.mjs --all
node src/check-file-limits.mjs --all --json
```

The two size limits the workshop's write hooks enforce on every edit, applied
to the whole tracked tree: a file over 300 lines is a `file-lines` finding and
a folder holding more than five tracked files is a `folder-files` finding
(`file` names the folder, `line` is `null`). The limits are properties of the
tree, so only `--all` is accepted; asking for anything else is refused with
`--all is required`. Registries and manuscripts are exempt from the line count
(`.json`, `.jsonl`, `.ndjson`, `.lock`, `.csv`, `.tsv`, `.tex`, `.bib`, `.prisma`,
`.sty`, `.bst`, `.cls`, `.svg`), as are a tokenizer's `merges.txt` and
`vocab.txt`, a binary, and a file whose first five lines say it is generated
and not to be edited (its generator is what has to fit); a directory named
`test`, `tests*`, `__tests__`, `Tests`, `migrations*`, `node_modules`,
`vendor`, `target`, `__pycache__`, `.build`, `.swiftpm` or `.git` is left out
of both counts wherever it sits.
The fix is the one the hooks ask for: split the file into modules; move the
folder's files into sub-folders.

### Fleet audit of magic numbers, file limits or fallbacks

```bash
node src/magic-numbers/audit.mjs --workspace ~/Documents/CodingProjects/Wisent --checker magic-numbers|file-limits|fallbacks --output .build/<name> [--skip <repository>]...
```

Runs the named guard (`check-no-magic-constants --all --numbers-only --json`,
`check-file-limits --all --json` or `check-no-fallbacks --all --json`) in every immediate
Git repository of the workspace and writes `report.json` plus one evidence
directory per repository (`stdout.json`, `stderr.log`, `execution.json`) under
`quality-control/.build/`. `--skip <name>` leaves a repository out and records
it under `skipped` with the reason `named by --skip`; the workspace's checkout
of the upstream agent harness is audited that way. The report records the
checker's name, revision and SHA-256,
each repository's revision, branch, porcelain status, origin, checked-file
count, source digest and violations, every skipped entry with its reason, and
`counts` (`repositories`, `clean`, `findings`, `error`, `violations`). The
report is rewritten after every repository, so an interrupted run keeps what
it finished. Exit status `0` means no repository has findings, `1` means at
least one has, and `2` means a repository could not be audited or the arguments
were refused: `--workspace is required`, `--checker is required`, `--output is
required`; `--checker must be one of magic-numbers, file-limits, fallbacks`;
`--output must be a new direct child of quality-control/.build`; `output
already exists: <path>`.

```bash
node src/magic-numbers/combine.mjs <audit output directory>...
```

Joins several fleet audits into one tab-separated table on stdout: a `total`
column, one column per guard (named by the report's `checker.name`) and the
repository, one row per repository with at least one finding, smallest total
first, so a clean-up can be ordered by all the work a repository needs. An
audit that could not read a repository stops the join with that repository's
error rather than counting it as zero.

### No-desktop-cli-coupling

```bash
node src/check-no-desktop-cli-coupling.mjs --base <base-sha>
```

Runs only in repositories whose name ends in `-desktop`; any other repository is
skipped with a pass. Flags process launching outside the allowlisted
backend-launcher file (a `BackendProcess` or `Runtime` file name), `command:`
arguments on UI panels, and user-visible string literals containing shell
commands, install instructions, or environment assignments. A desktop
application reaches its product over loopback HTTP/JSON, local state files, or
a linked library instead of its command-line interface.

### Informative commit action

```yaml
- uses: wisent-ai/quality-control/.github/actions/informative-commits@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    min-informative-words: "2"
```

The action checks the subject (first line), ignores merge commits, recognizes a
Conventional Commit prefix, requires at least 12 characters, and applies token
specificity rules. The token threshold alone is not the full acceptance rule.

### Reusable workflows

Four workflows are consumed by other repositories directly, pinned to an exact
revision rather than a branch, so a change here cannot alter a consumer's gate
until that consumer moves its pin.

```yaml
jobs:
  gates:
    uses: wisent-ai/quality-control/.github/workflows/rust-gates.yml@<sha>
  tag:
    uses: wisent-ai/quality-control/.github/workflows/tag-on-manifest-bump.yml@<sha>
```

`rust-gates.yml` runs `cargo fmt --all --check`, `cargo clippy --all-targets -- -D
warnings`, and `cargo build --locked --release`. It accepts `runs-on`
(`ubuntu-latest`), `toolchain` (`stable`), and `working-directory` (`.`).

`swift-gates.yml` runs `swift build --build-tests` and `swift test`. It accepts
`runs-on` (the fleet's `["self-hosted", "macOS", "stado"]` runner, which holds
the credentials that resolve this organization's private SwiftPM dependencies),
`working-directory` (`.`), and the three `fixture-*` inputs that hand the tests
a product binary built earlier in the same run. It exists because 51 of the
repositories beside it carry a `Package.swift`, at least 20 carry a `Tests`
directory, and before it none of them ran `swift test` in CI.

`tag-on-manifest-bump.yml` tags the version declared in a manifest exactly once.
It accepts `manifest` (`Cargo.toml`) and `runs-on` (`ubuntu-latest`).

A caller must pin with the full forty-character commit. On 2026-09-03 nine
repositories pinned `design-gate.yml@73dd0c7`; every run ended as "This run
likely failed because of a workflow file issue" with zero jobs, and the same
file at `@73dd0c7e988227eeedc91e0c9f9b9ba9c4f3ba60` ran on the first push. The
resolver does not abbreviate.

`design-gate.yml` runs `wisent-design-lint`, the check shipped by
`@wisent-ai/components`, on a web repository at the package revision that
repository pins: raw colors outside the tokens, Tailwind's default palette,
gradients, backdrop blur, spinners, oversize radii and shadows, emoji, generic
icon sets, Google fonts, local primitives, marketing vocabulary and an
unpinned dependency all fail it. It accepts `runs-on` (the fleet's
`["self-hosted", "stado"]` runner) and `working-directory` (`.`), and the
secret `repository_token`, the same contract as `swift-gates`: a token with
`Contents: read` on the organization's private packages, used only to rewrite
`github.com` origins (https, `ssh://git@github.com/` and `git@github.com:`,
because npm pins `github:` dependencies over ssh) before `npm ci`. Without it
a private dependency must resolve through the runner's own git credentials,
and the fleet's publisher runner has none: measured on `preferences` run
33672201154, it died on the first private package with `Permission denied
(publickey)`. It is the first shared gate for the Node repositories; until
2026-09-01 none existed because no check was common to them, and the design
lint is that check.

`required-pr-quality.yml` is the required pull-request workflow described above,
and `repository-audit.yml` is the manual, always-green baseline inventory.

Consumers as of 2026-09-02: `brama`, `jeden`, `skarbiec`, `transcript-lake`,
`wisent-backend`, `wisent-integrations`, and `image-video-router` on
`rust-gates`, `skarbiec-desktop` on `swift-gates`, and `preferences` and
`echo-web` on `design-gate`. Pins are not synchronized automatically;
`skarbiec` currently sits on an older `rust-gates` revision than the other six.

