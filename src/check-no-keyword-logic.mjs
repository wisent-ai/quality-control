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
const DECLARES_LIST_RE = /\b(?:let|var|const|static\s+let|static\s+var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:\[|Set\s*\(|new\s+Set\s*\()/;
const IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const LEXICAL_GATE_RE = /\.(?:contains|hasPrefix|hasSuffix|localizedCaseInsensitiveContains|range|includes|startsWith|endsWith|some|every|test|match)\b|\b(?:contains|hasPrefix|startswith|endswith|includes|re\.search|RegExp|NSRegularExpression|localizedLowercase|lowercased|toLowerCase|lower)\b/;
const DIRECT_LITERAL_GATE_RE = /\.(?:contains|hasPrefix|hasSuffix|localizedCaseInsensitiveContains|includes|startsWith|endsWith|test|match)\s*\(\s*(["'`])([^"'`]{3,})\1/;
const REGEX_ALTERNATION_RE = /\/[^/\n]*(?:[A-Za-z][A-Za-z0-9_-]{2,}\|){2,}[A-Za-z][A-Za-z0-9_-]{2,}[^/\n]*\/|#["'][^"'\n]*(?:[A-Za-z][A-Za-z0-9_-]{2,}\|){2,}[A-Za-z][A-Za-z0-9_-]{2,}[^"'\n]*["']/;
// A string-list gate is a declared list of words that the file tests text against: the list is
// read from its declaration up to the bracket that closes it, and its name must meet a lexical
// operation somewhere in the file. A list is two or more literals; one is a comparison.
const LIST_LITERAL_COUNT = 2;
const OPENERS = '([{';
const CLOSERS = ')]}';

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

    const gate = stringListGate(lines, lineNumber);
    if (gate) {
      violations.push({
        file,
        line: lineNumber,
        rule: 'string-list-keyword-gate',
        detail: `string list ${gate} drives lexical contains/prefix/match decisions`,
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

function bracketBalance(line) {
  const code = codeWithoutStrings(line);
  let balance = 0;
  for (const character of code) {
    if (OPENERS.includes(character)) balance += 1;
    else if (CLOSERS.includes(character)) balance -= 1;
  }
  return balance;
}

/** The text of a declaration from its line to the bracket that closes what it opens. */
function declarationExtent(lines, lineNumber) {
  let open = 0;
  const extent = [];
  for (let number = lineNumber; number <= lines.length; number += 1) {
    const line = lines[number - 1];
    extent.push(line);
    open += bracketBalance(line);
    if (open <= 0) break;
  }
  return extent.join('\n');
}

/** The line declaring `name` as a list, or 0 when the file declares no such list. */
function listDeclarationLine(lines, name) {
  for (let number = 1; number <= lines.length; number += 1) {
    const match = codeWithoutStrings(lines[number - 1]).match(DECLARES_LIST_RE);
    if (match && match[1] === name) return number;
  }
  return 0;
}

/**
 * Whether the list declared at `declaration` holds words, is named or used as a word list
 * (SUSPICIOUS_LIST_NAME_RE on the declaration or a use), and its name meets a lexical test.
 */
function isWordListTestedLexically(lines, declaration, name) {
  const extent = declarationExtent(lines, declaration);
  if (naturalLanguageLiterals(extent).length < LIST_LITERAL_COUNT) return false;
  const named = new RegExp(`\\b${name}\\b`);
  const uses = lines.filter((line, index) => {
    const code = codeWithoutStrings(line);
    return index + 1 !== declaration && named.test(code) && LEXICAL_GATE_RE.test(code);
  });
  if (uses.length === 0) return false;
  return [extent, ...uses].some(text => SUSPICIOUS_LIST_NAME_RE.test(codeWithoutStrings(text)));
}

/**
 * The list that makes `lineNumber` a string-list gate, or null. The line is one when it declares
 * such a list, tests text against a list declared elsewhere in the file, or tests text against a
 * list written inline on the line itself.
 */
function stringListGate(lines, lineNumber) {
  const line = lines[lineNumber - 1];
  const code = codeWithoutStrings(line);
  const declared = code.match(DECLARES_LIST_RE);
  if (declared) {
    return isWordListTestedLexically(lines, lineNumber, declared[1]) ? declared[1] : null;
  }
  if (!LEXICAL_GATE_RE.test(code)) return null;
  if (code.includes('[') && SUSPICIOUS_LIST_NAME_RE.test(code) && naturalLanguageLiterals(line).length >= LIST_LITERAL_COUNT) return 'written inline';
  for (const [name] of code.matchAll(IDENTIFIER_RE)) {
    const declaration = listDeclarationLine(lines, name);
    if (declaration && isWordListTestedLexically(lines, declaration, name)) return name;
  }
  return null;
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
  if (value.length === 0) return false;
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

