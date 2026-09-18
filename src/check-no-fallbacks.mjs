#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EXIT, REPORT_SCHEMA_VERSION } from './lib/constants.mjs';
import {
  candidateFiles, isGuardSource, parseArgs, repositoryRoot, resolveMode, selectedLineNumbers, usageOf
} from './lib/change-selection.mjs';
import {
  CODE_COMMENT_MARKERS, RUST_COMMENT_MARKERS, codeWithoutInlineComment, documentationLineNumbers,
  isCommentOnlyLine, isGeneratedSource
} from './lib/source-lines.mjs';

const ROOT = repositoryRoot();
const SOURCE_EXTENSIONS = new Set([
  '.swift',
  '.mjs',
  '.cjs',
  '.jsx',
  '.js',
  '.ts',
  '.tsx',
  '.py',
  '.rs'
]);
// Test trees hold the fixtures that exercise these patterns on purpose, as the other guards
// and the write hooks already leave them alone.
const EXCLUDED_PREFIXES = [
  '.build/',
  '.git/',
  '.swiftpm/',
  '.work/',
  'Tests/',
  'test/',
  'tests/',
  '__tests__/',
  'node_modules/'
];

const FALLBACK_IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*fallback[A-Za-z0-9_]*\b/i;
const NULLISH_DEFAULT_RE = /\?\?/;
const LOGICAL_DEFAULT_RE = /(?:=|return|\(|:|,)\s*[^;\n]+(?:\|\|)\s*(?:["'`\[{(]|\d|true\b|false\b|null\b|undefined\b|[A-Za-z_$][A-Za-z0-9_$]*)/;
const OPTIONAL_TRY_RE = /\btry\?/;
// `.get(key, substitute)`: a key with no parentheses or `=` in it, then one positional second
// argument. `.get(url, params=...)` is an HTTP call and `.get(key)` alone is a lookup.
const PY_GET_DEFAULT_RE = /\.get\(\s*[^=,()\n]+,\s*[^)=\n]+\)/;
const PROMISE_CATCH_DEFAULT_RE = /\.catch\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*(?:["'`\[{(]|\d|true\b|false\b|null\b|undefined\b)/;
const CATCH_RETURN_DEFAULT_RE = /\bcatch\b[^{]*{\s*return\s+(?:["'`\[{(]|\d|true\b|false\b|null\b|undefined\b)/;
// A logical-or is a default only when the right side stands in for a missing left side. A
// negated left operand (`!query || ...`) or a right operand that is itself a predicate
// (`... || list.includes(x)`, `... || a === b`) is boolean logic, and stays untouched.
const PREDICATE_CALL_RE = /\.(?:includes|startsWith|endsWith|test|has|some|every|is[A-Z][A-Za-z]*)\(/;
const COMPARISON_RE = /(?:===|!==|==|!=|<=|>=|<|>)/;
const EMPTY_CATCH_RE = /\bcatch\b[^{]*{\s*}/;
// A condition that spans lines: `if (` opened above and not yet closed, so a line inside it is
// a piece of boolean logic whatever it looks like on its own. The look-back is bounded because
// a condition longer than this is not something a guard should be reading either.
const CONDITION_LOOKBACK_LINES = 8;
const CONDITION_OPENER_RE = /^\s*(?:(?:\}\s*)?else\s+)?(?:if|while)\s*\(/;
// Rust states a substitute in one of two ways: `unwrap_or` and its relatives hand back a value
// where a missing or failed one was, and a serde `default` lets a document that left a field out
// deserialize as though it had been written. A `default` on an `Option` field is not a substitute:
// the absence stays visible as `None`, so the type of the field the attribute sits on decides.
const RUST_SUBSTITUTE_RE = /\.unwrap_or(?:_else|_default)?\s*\(/;
const RUST_SERDE_DEFAULT_RE = /#\s*\[\s*serde\s*\([^)]*\bdefault\b/;
const RUST_OPTION_FIELD_RE = /:\s*Option\s*</;
const RUST_ATTRIBUTE_RE = /^\s*#\s*\[/;
// A serde attribute names the field below it; the fields of a struct do not nest deeper than the
// attributes stacked on one of them, so the type is found within a few lines or not at all.
const RUST_FIELD_LOOKAHEAD_LINES = 4;

const usage = usageOf('check-no-fallbacks.mjs', ' [--json]');
const args = parseArgs(process.argv.slice(2), usage, { '--json': 'json' });
const mode = resolveMode(args, usage);
const files = candidateFiles(mode, isScannedFile);
const violations = [];
const sourceDigest = createHash('sha256');

for (const file of files) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;

  const text = readFileSync(absolute, 'utf8');
  sourceDigest.update(file).update('\0').update(text).update('\0');
  const lines = text.split(/\r?\n/);
  if (isGeneratedSource(lines)) continue;
  const documentationLines = documentationLineNumbers(lines);
  const changedLines = selectedLineNumbers(mode, file, lines, ROOT);
  if (changedLines.size === 0) continue;
  const isRust = path.extname(file) === '.rs';

  for (const lineNumber of changedLines) {
    const line = lineNumber <= lines.length ? lines[lineNumber - 1] : '';
    if (documentationLines.has(lineNumber)) continue;
    if (isCommentOnlyLine(line, isRust ? RUST_COMMENT_MARKERS : CODE_COMMENT_MARKERS)) continue;
    const code = codeWithoutInlineComment(line, { hashComments: !isRust });

    const rule = isRust
      ? rustFallbackRule(code, lines, lineNumber)
      : fallbackRule(code, insideOpenCondition(lines, lineNumber));
    if (!rule) continue;

    violations.push({
      file,
      line: lineNumber,
      rule: rule.name,
      detail: rule.detail,
      source: line.trim()
    });
  }
}

// The report is set as the exit code rather than through process.exit(): on macOS a pipe is
// written asynchronously, and exiting right after console.log truncated reports at the pipe buffer.
if (args.json) {
  console.log(JSON.stringify({ schemaVersion: REPORT_SCHEMA_VERSION, root: ROOT, mode: mode.kind, checkedFiles: files.length, sourceDigest: sourceDigest.digest('hex'), violations }));
  process.exitCode = violations.length > 0 ? EXIT.findings : EXIT.clean;
} else if (violations.length > 0) {
  console.error('No-fallbacks guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`);
    if (violation.source) console.error(`  ${violation.source}`);
  }
  console.error('');
  console.error('Fail explicitly, validate upstream data, or require configuration instead of adding fallback behavior.');
  process.exitCode = EXIT.findings;
} else {
  console.log(`No-fallbacks guard passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);
}

function countOf(text, character) {
  let count = 0;
  for (const candidate of text) if (candidate === character) count += 1;
  return count;
}

function insideOpenCondition(lines, lineNumber) {
  let depth = 0;
  const earliest = Math.max(0, lineNumber - 2 - CONDITION_LOOKBACK_LINES);
  for (let index = lineNumber - 2; index >= earliest; index -= 1) {
    const earlier = codeWithoutInlineComment(lines[index]);
    depth += countOf(earlier, ')') - countOf(earlier, '(');
    if (CONDITION_OPENER_RE.test(earlier)) return depth < 0;
  }
  return false;
}

function rustFallbackRule(code, lines, lineNumber) {
  if (FALLBACK_IDENTIFIER_RE.test(code)) {
    return {
      name: 'fallback-identifier',
      detail: 'fallback identifiers introduce hidden alternate behavior'
    };
  }
  if (RUST_SUBSTITUTE_RE.test(code)) {
    return {
      name: 'unwrap-or-substitute',
      detail: 'unwrap_or hands back a substitute where a missing or failed value was'
    };
  }
  if (RUST_SERDE_DEFAULT_RE.test(code) && !rustOptionFieldFollows(lines, lineNumber)) {
    return {
      name: 'serde-default-substitute',
      detail: 'a serde default lets a document that left the field out deserialize as though it had not'
    };
  }
  return null;
}

function rustOptionFieldFollows(lines, lineNumber) {
  const last = Math.min(lines.length, lineNumber + RUST_FIELD_LOOKAHEAD_LINES);
  for (let number = lineNumber + 1; number <= last; number += 1) {
    const field = codeWithoutInlineComment(lines[number - 1]);
    if (field.trim() === '' || RUST_ATTRIBUTE_RE.test(field)) continue;
    return RUST_OPTION_FIELD_RE.test(field);
  }
  return false;
}

function fallbackRule(code, inCondition) {
  if (isAllowedFallbackContext(code)) {
    return null;
  }
  if (FALLBACK_IDENTIFIER_RE.test(code)) {
    return {
      name: 'fallback-identifier',
      detail: 'fallback identifiers introduce hidden alternate behavior'
    };
  }
  if (NULLISH_DEFAULT_RE.test(code)) {
    return {
      name: 'nullish-default',
      detail: 'nullish coalescing hides missing data behind a substitute value'
    };
  }
  if (LOGICAL_DEFAULT_RE.test(code) && !inCondition && !isBooleanExpression(code)) {
    return {
      name: 'logical-default',
      detail: 'logical-or defaulting hides missing data behind a substitute value'
    };
  }
  if (OPTIONAL_TRY_RE.test(code)) {
    return {
      name: 'optional-try',
      detail: 'optional try converts errors into missing values'
    };
  }
  if (PY_GET_DEFAULT_RE.test(code)) {
    return {
      name: 'dictionary-default',
      detail: 'dictionary defaults hide missing keys'
    };
  }
  if (PROMISE_CATCH_DEFAULT_RE.test(code)) {
    return {
      name: 'promise-catch-default',
      detail: 'promise catch returns a substitute value'
    };
  }
  if (CATCH_RETURN_DEFAULT_RE.test(code)) {
    return {
      name: 'catch-return-default',
      detail: 'catch block returns a substitute value'
    };
  }
  if (EMPTY_CATCH_RE.test(code)) {
    return {
      name: 'empty-catch',
      detail: 'empty catch block swallows errors'
    };
  }
  return null;
}

function isAllowedFallbackContext(code) {
  const trimmed = code.trim();
  if (/\b_os\.environ\.get\(|\bos\.environ\.get\(/.test(trimmed)) return true;
  if (/\.get\(/.test(trimmed) && (
    trimmed.startsWith('click.echo')
    || trimmed.startsWith('print(')
    || trimmed.startsWith('logger.')
    || trimmed.startsWith('_log(')
    || trimmed.startsWith('f"')
    || trimmed.startsWith("f'")
  )) return true;
  if (/\[[^\]]+\]\s*=\s*[^=\n]+\.get\([^,\n]+,\s*(?:0|0\.0|\[\]|\{\})\)\s*(?:\+|\|)/.test(trimmed)) {
    return true;
  }
  return false;
}

function isBooleanExpression(code) {
  if (/^\s*(?:(?:\}\s*)?else\s+)?(?:if|while|for)\s*\(/.test(code)) return true;
  if (/\b(?:true|false)\b\s*(?:\|\|)\s*\b(?:true|false)\b/.test(code)) return true;
  if (/(?:&&|\|\|)\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:&&|\|\|)/.test(code)) return true;
  const split = code.indexOf('||');
  if (split === -1) return false;
  const left = code.slice(0, split);
  const right = code.slice(split);
  return /(?:=|return|\(|:|,)\s*!/.test(left) || PREDICATE_CALL_RE.test(right) || COMPARISON_RE.test(right);
}

function isScannedFile(file) {
  if (isGuardSource(ROOT, file)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) return false;
  const extension = path.extname(file);
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  if (file.includes('/node_modules/')) return false;
  return true;
}

