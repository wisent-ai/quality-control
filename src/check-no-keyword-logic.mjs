#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './lib/constants.mjs';
import {
  candidateFiles, isGuardSource, parseArgs, repositoryRoot, resolveMode, selectedLineNumbers, usageOf
} from './lib/change-selection.mjs';
import { MARKUP_COMMENT_MARKERS, STRING_LITERAL_RE, isCommentOnlyLine } from './lib/source-lines.mjs';

const ROOT = repositoryRoot();
const SOURCE_EXTENSIONS = new Set([
  '.swift',
  '.mjs',
  '.js',
  '.ts',
  '.tsx',
  '.py',
  '.sh',
  '.yml',
  '.yaml',
  '.json'
]);
const EXCLUDED_FILES = new Set([
  '.github/workflows/no-fallbacks.yml',
  '.github/workflows/no-keyword-logic.yml'
]);
const EXCLUDED_PREFIXES = [
  '.build/',
  '.git/',
  '.swiftpm/',
  '.work/',
  'Tests/',
  'test/',
  'tests/',
  'node_modules/'
];

const KEYWORD_IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*(?:keyword|keywords)[A-Za-z0-9_]*\b/i;
const SUSPICIOUS_LIST_NAME_RE = /\b(?:signals?|fragments?|phrases?|prefixes?|suffixes?|triggers?|words?|terms?|markers?|patterns?)\b/i;
const DECLARES_LIST_RE = /\b(?:let|var|const|static\s+let|static\s+var)\s+[A-Za-z_][A-Za-z0-9_]*\s*(?::[^=]+)?=\s*(?:\[|Set\s*\(|new\s+Set\s*\()/;
const LEXICAL_GATE_RE = /\.(?:contains|hasPrefix|hasSuffix|localizedCaseInsensitiveContains|range|includes|startsWith|endsWith|some|every|test|match)\b|\b(?:contains|hasPrefix|startswith|endswith|includes|re\.search|RegExp|NSRegularExpression|localizedLowercase|lowercased|toLowerCase|lower)\b/;
const DIRECT_LITERAL_GATE_RE = /\.(?:contains|hasPrefix|hasSuffix|localizedCaseInsensitiveContains|includes|startsWith|endsWith|test|match)\s*\(\s*(["'`])([^"'`]{3,})\1/;
const REGEX_ALTERNATION_RE = /\/[^/\n]*(?:[A-Za-z][A-Za-z0-9_-]{2,}\|){2,}[A-Za-z][A-Za-z0-9_-]{2,}[^/\n]*\/|#["'][^"'\n]*(?:[A-Za-z][A-Za-z0-9_-]{2,}\|){2,}[A-Za-z][A-Za-z0-9_-]{2,}[^"'\n]*["']/;
// A string-list gate is judged over the lines around the suspicious one, and needs three literals to count.
const GATE_WINDOW_RADIUS = 12;
const GATE_LITERAL_COUNT = 3;

const usage = usageOf('check-no-keyword-logic.mjs');
const args = parseArgs(process.argv.slice(2), usage);
const mode = resolveMode(args, usage);
const files = candidateFiles(mode, isScannedFile);
const violations = [];

for (const file of files) {
  const absolute = path.join(ROOT, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;

  const text = readFileSync(absolute, 'utf8');
  const lines = text.split(/\r?\n/);
  const changedLines = selectedLineNumbers(mode, file, lines, ROOT);
  if (changedLines.size === 0) continue;

  for (const lineNumber of changedLines) {
    const line = lineNumber <= lines.length ? lines[lineNumber - 1] : '';
    if (isCommentOnlyLine(line, MARKUP_COMMENT_MARKERS)) continue;
    if (isLikelyDocumentationLine(line)) continue;

    if (KEYWORD_IDENTIFIER_RE.test(line)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'keyword-identifier',
        detail: 'identifier names cannot introduce keyword-based logic',
        source: line.trim()
      });
      continue;
    }

    if (REGEX_ALTERNATION_RE.test(line)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'regex-keyword-gate',
        detail: 'regex alternation over words is keyword-based logic',
        source: line.trim()
      });
      continue;
    }

    if (DIRECT_LITERAL_GATE_RE.test(line) && directGateHasNaturalLanguageLiteral(line)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'literal-keyword-gate',
        detail: 'natural-language literals cannot drive contains/prefix/match logic',
        source: line.trim()
      });
      continue;
    }

    if (!isPotentialStringListGateLine(line)) continue;

    const window = sourceWindow(lines, lineNumber, GATE_WINDOW_RADIUS);
    if (isStringListGate(window.text)) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'string-list-keyword-gate',
        detail: 'string lists cannot drive lexical contains/prefix/match decisions',
        source: line.trim()
      });
    }
  }
}

if (violations.length > 0) {
  console.error('No-keyword-logic guard failed.');
  console.error('');
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`);
    if (violation.source) console.error(`  ${violation.source}`);
  }
  console.error('');
  console.error('Use structured state, typed metadata, parser output, or model/classifier output.');
  console.error('Do not make behavior depend on word lists, phrase lists, prefix lists, or contains checks.');
  process.exit(EXIT.findings);
}

console.log(`No-keyword-logic guard passed (${files.length} file${files.length === 1 ? '' : 's'} checked).`);

function isScannedFile(file) {
  if (isGuardSource(ROOT, file)) return false;
  if (EXCLUDED_FILES.has(file)) return false;
  if (EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))) return false;
  const extension = path.extname(file);
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  if (file.includes('/node_modules/')) return false;
  return true;
}

function sourceWindow(lines, lineNumber, radius) {
  const start = Math.max(1, lineNumber - radius);
  const end = Math.min(lines.length, lineNumber + radius);
  return {
    start,
    end,
    text: lines
      .slice(start - 1, end)
      .filter(line => !isCommentOnlyLine(line, MARKUP_COMMENT_MARKERS))
      .filter(line => !isLikelyDocumentationLine(line))
      .join('\n')
  };
}

function isStringListGate(text) {
  const literalCount = naturalLanguageLiterals(text).length;
  if (literalCount < GATE_LITERAL_COUNT) return false;
  if (!LEXICAL_GATE_RE.test(text)) return false;
  if (SUSPICIOUS_LIST_NAME_RE.test(text)) return true;
  return false;
}

function isPotentialStringListGateLine(line) {
  const code = codeWithoutStrings(line);
  if (SUSPICIOUS_LIST_NAME_RE.test(code)) return true;
  if (DECLARES_LIST_RE.test(code)) return true;
  return LEXICAL_GATE_RE.test(code) && naturalLanguageLiterals(line).length > 0;
}

function directGateHasNaturalLanguageLiteral(line) {
  return naturalLanguageLiterals(line)
    .some(value => !/^[A-Za-z0-9_.-]+:$/.test(value));
}

function naturalLanguageLiterals(text) {
  const literals = [];
  for (const match of text.matchAll(STRING_LITERAL_RE)) {
    const value = stringLiteralValue(match);
    if (isNaturalLanguageToken(value)) literals.push(value);
  }
  return literals;
}

function isNaturalLanguageToken(value) {
  if (value.length < GATE_LITERAL_COUNT) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  if (/[/_]/.test(value)) return false;
  if (/^[A-Z0-9_./:-]+$/.test(value)) return false;
  if (/^https?:\/\//.test(value)) return false;
  if (/^[./~]/.test(value)) return false;
  return true;
}

function codeWithoutStrings(text) {
  return text.replace(STRING_LITERAL_RE, '""');
}

function stringLiteralValue(match) {
  for (const group of [match[1], match[2], match[3]]) {
    if (group !== undefined) return group.trim();
  }
  return '';
}

function isLikelyDocumentationLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) return true;
  if (trimmed.endsWith('"""') || trimmed.endsWith("'''")) return true;
  if (/[=({[;]|^\s*(?:if|for|while|return|const|let|var|def|class|func)\b/.test(trimmed)) return false;
  return /\s/.test(trimmed) && /[A-Za-z]/.test(trimmed);
}

