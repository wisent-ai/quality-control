#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EXIT, REPORT_SCHEMA_VERSION } from './lib/constants.mjs';
import {
  candidateFiles, isGuardSource, parseArgs, repositoryRoot, resolveMode, selectedLineNumbers, usageOf
} from './lib/change-selection.mjs';
import { documentationLineNumbers, isCommentOnlyLine, codeWithoutInlineComment } from './lib/source-lines.mjs';

const ROOT = repositoryRoot();
const SOURCE_EXTENSIONS = new Set([
  '.swift',
  '.mjs',
  '.js',
  '.ts',
  '.tsx',
  '.py'
]);
const EXCLUDED_PREFIXES = [
  '.build/',
  '.git/',
  '.swiftpm/',
  '.work/',
  'Tests/',
  'test/',
  'node_modules/'
];

const FALLBACK_IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*fallback[A-Za-z0-9_]*\b/i;
const NULLISH_DEFAULT_RE = /\?\?/;
const LOGICAL_DEFAULT_RE = /(?:=|return|\(|:|,)\s*[^;\n]+(?:\|\|)\s*(?:["'`\[{(]|\d|true\b|false\b|null\b|undefined\b|[A-Za-z_$][A-Za-z0-9_$]*)/;
const OPTIONAL_TRY_RE = /\btry\?/;
const PY_GET_DEFAULT_RE = /\.get\(\s*[^=,\n]+,\s*[^)\n]+\)/;
const PROMISE_CATCH_DEFAULT_RE = /\.catch\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*(?:["'`\[{(]|\d|true\b|false\b|null\b|undefined\b)/;
const CATCH_RETURN_DEFAULT_RE = /\bcatch\b[^{]*{\s*return\s+(?:["'`\[{(]|\d|true\b|false\b|null\b|undefined\b)/;
const EMPTY_CATCH_RE = /\bcatch\b[^{]*{\s*}/;

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
  const documentationLines = documentationLineNumbers(lines);
  const changedLines = selectedLineNumbers(mode, file, lines, ROOT);
  if (changedLines.size === 0) continue;

  for (const lineNumber of changedLines) {
    const line = lineNumber <= lines.length ? lines[lineNumber - 1] : '';
    if (documentationLines.has(lineNumber)) continue;
    if (isCommentOnlyLine(line)) continue;
    const code = codeWithoutInlineComment(line);

    const rule = fallbackRule(code);
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

function fallbackRule(code) {
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
  if (LOGICAL_DEFAULT_RE.test(code) && !isBooleanExpression(code)) {
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
  return /^\s*(?:if|while|for)\s*\(/.test(code)
    || /\b(?:true|false)\b\s*(?:\|\|)\s*\b(?:true|false)\b/.test(code)
    || /(?:&&|\|\|)\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:&&|\|\|)/.test(code);
}

function isScannedFile(file) {
  if (isGuardSource(ROOT, file)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) return false;
  if (file.endsWith('/config.py') || file === 'config.py') return false;
  if (file.includes('/profiles/')) return false;
  const extension = path.extname(file);
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  if (file.includes('/node_modules/')) return false;
  return true;
}

