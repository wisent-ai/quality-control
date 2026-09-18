// What counts as a magic literal on one line: the number and string shapes, the
// disguises a number wears to slip past a guard, and the contexts a literal may sit in.
import { STRING_LITERAL_RE, codeWithoutInlineComment } from '../lib/source-lines.mjs';

// A JavaScript regular-expression literal after an operator, opening bracket or keyword; digits inside it are pattern text.
const REGEX_LITERAL_RE = /(?<=^|[=(,:[!&|?{};]|\breturn|\btest|\bmatch)\s*\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[\n])+\/[a-z]*/g;
// A tuple field such as `.0` or `.1` follows a closing bracket or an identifier, never an operator.
const NUMBER_LITERAL_SOURCE = '(?:0x[\\da-f_]+|0b[01_]+|0o[0-7_]+|(?:\\d[\\d_]*(?:\\.[\\d_]+)?|(?<![\\])])\\.\\d[\\d_]*)(?:e[-+]?[\\d_]+)?)(?:_?(?:[ui](?:8|16|32|64|128|size)|f(?:32|64)))?';
// A unit or percent sign after the digits makes the value a dimension, and a digit glued to a
// hyphenated word (utf-8, sha-256) is part of the word; the guard leaves both alone.
const NUMBER_LITERAL_RE = new RegExp(`(?<![A-Za-z0-9_$.]|[A-Za-z]-)[-+]?${NUMBER_LITERAL_SOURCE}(?![A-Za-z0-9_$%])`, 'gi');
export const QUOTED_NUMBER_RE = new RegExp(`\\b(?:Number|parseInt|parseFloat|Int|UInt|Double|Float|CGFloat|int|float|Decimal)\\s*\\(\\s*["'](?<value>[-+]?${NUMBER_LITERAL_SOURCE})["']|["'](?<value2>[-+]?\\d[\\d_]*(?:\\.\\d+)?)["']\\s*\\.parse(?:::<[^>]+>)?\\(`, 'gi');
// A quoted number that ends its line, with `.parse` opening the next, is the same disguise split in two.
const QUOTED_NUMBER_AT_END_RE = /["'][-+]?\d[\d_]*(?:\.\d+)?["']\s*$/;
const PARSE_CONTINUATION_RE = /^\s*\.parse\b/;
const NAMED_CONSTANT_RE = /^\s*(?:(?:pub(?:\([^)]*\))?|export|private|fileprivate|public|internal)\s+)*(?:(?:const|let|var|static(?:\s+(?:let|var))?)\s+)?_?[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=/;
const IMPORT_RE = /^\s*(?:import|export)\b.*\bfrom\b|^\s*(?:import|require)\s*\(/;
const LOCAL_LITERAL_ASSIGN_RE = new RegExp(`^\\s*(?:const|let|var)?\\s*[a-z_][A-Za-z0-9_]*\\s*(?::[^="'\`]+)?=\\s*(?:["'\`]|[-+]?${NUMBER_LITERAL_SOURCE}(?![A-Za-z0-9_$]))`, 'i');
// A bare `<` or `>` is a comparison when written with spaces around it; `Vec<u8>`, `<code>` and `->` are not.
const LOGIC_LITERAL_RE = /^\s*(?:if|elif|while|for|return|assert)\b|(?:[=!<>]=|\s[<>]\s)|[-+*/%]=|\b(?:range|sleep|timeout|limit|max|min)\s*\(/;
const ALLOWED_NUMBER_LITERALS = new Set(['-1', '0', '1', '2']);
const ELLIPSIS = '...';
const DETAIL_EXCERPT_LIMIT = 32;
const SCHEMA_KEY_CONTEXT_BEFORE = 8;
const SCHEMA_KEY_CONTEXT_AFTER = 4;

// `"120"` at the end of one line and `.parse::<u64>()` at the start of the next read as one line.
export function withParseContinuation(lines, index) {
  const line = index < lines.length ? lines[index] : '';
  if (!QUOTED_NUMBER_AT_END_RE.test(codeWithoutInlineComment(line))) return line;
  let next = index + 1;
  while (next < lines.length && lines[next].trim() === '') next += 1;
  const continuation = next < lines.length ? lines[next] : '';
  return PARSE_CONTINUATION_RE.test(continuation) ? `${line.trimEnd()}${continuation.trim()}` : line;
}

export function literalViolations(line, numbersOnly) {
  const code = codeWithoutInlineComment(line);
  const withoutStrings = code.replace(STRING_LITERAL_RE, '""').replace(REGEX_LITERAL_RE, '/re/');
  const found = [];

  for (const match of code.matchAll(STRING_LITERAL_RE)) {
    const value = stringLiteralValue(match);
    if (numbersOnly || !isSignificantString(value)) continue;
    if (isSchemaKeyAccess(code, match.index, match[0].length)) continue;
    found.push({
      rule: 'magic-string',
      detail: `string literal "${abbreviate(value)}" is embedded in logic`
    });
  }

  for (const match of withoutStrings.matchAll(NUMBER_LITERAL_RE)) {
    const value = normalizeNumberLiteral(match[0]);
    if (ALLOWED_NUMBER_LITERALS.has(value)) continue;
    found.push({
      rule: 'magic-number',
      detail: `number literal ${value} is embedded in logic`
    });
  }

  // Number('127'), Int("3") or "3".parse() is the same literal wearing quotes to slip past a guard.
  for (const match of code.matchAll(QUOTED_NUMBER_RE)) {
    const value = normalizeNumberLiteral(match.groups.value === undefined ? match.groups.value2 : match.groups.value);
    if (ALLOWED_NUMBER_LITERALS.has(value)) continue;
    found.push({
      rule: 'magic-number',
      detail: `number literal ${value} is hidden in a string`
    });
  }

  return found;
}

function stringLiteralValue(match) {
  for (const group of [match[1], match[2], match[3]]) {
    if (group !== undefined) return group.trim();
  }
  return '';
}

function isSignificantString(value) {
  if (value.length < 3) return false;
  if (/[{}]/.test(value)) return false;
  if (value.startsWith('<')) return false;
  if (value.startsWith('--')) return false;
  if (/^[A-Z0-9_./:-]+$/.test(value)) return false;
  if (/^https?:\/\//.test(value)) return false;
  if (/^[./~]/.test(value)) return false;
  if (/^\$\{[^}]+\}$/.test(value)) return false;
  return /[A-Za-z]/.test(value);
}

export function isAllowedLiteralContext(line) {
  const trimmed = line.trim();
  return NAMED_CONSTANT_RE.test(line)
    || IMPORT_RE.test(line)
    || trimmed === 'if __name__ == "__main__":'
    || trimmed.startsWith('@')
    || trimmed.startsWith('"')
    || trimmed.startsWith('{"')
    || trimmed.startsWith("'")
    || trimmed.startsWith('<')
    || trimmed.startsWith('help=')
    || trimmed.startsWith('default=')
    || trimmed.startsWith('case ')
    || trimmed.startsWith('throw new ')
    || trimmed.startsWith('throw ')
    || trimmed.startsWith('console.')
    || trimmed.startsWith('click.echo')
    || trimmed.includes('flags.append(')
    || trimmed.startsWith('logger.')
    || trimmed.startsWith('print(')
    || trimmed.startsWith('sys.stderr.write')
    || trimmed.startsWith('_log(')
    || trimmed.startsWith('f"')
    || trimmed.startsWith("f'");
}

export function isLiteralSensitiveContext(line) {
  const code = codeWithoutInlineComment(line);
  return LOCAL_LITERAL_ASSIGN_RE.test(code) || LOGIC_LITERAL_RE.test(code) || code.search(QUOTED_NUMBER_RE) !== -1;
}

function isSchemaKeyAccess(code, start, length) {
  const before = code.slice(Math.max(0, start - SCHEMA_KEY_CONTEXT_BEFORE), start);
  const beforeFull = code.slice(0, start).trimEnd();
  const after = code.slice(start + length, start + length + SCHEMA_KEY_CONTEXT_AFTER).trimStart();
  if (before.endsWith('[') && after.startsWith(']')) return true;
  if (before.endsWith('.get(') && (after.startsWith(',') || after.startsWith(')'))) return true;
  if (/getattr\([^,\n]+,\s*$/.test(beforeFull) && (after.startsWith(',') || after.startsWith(')'))) return true;
  if (/setattr\([^,\n]+,\s*$/.test(beforeFull) && (after.startsWith(',') || after.startsWith(')'))) return true;
  if (
    after.startsWith(':')
    && (beforeFull.endsWith('{') || beforeFull.endsWith(',') || beforeFull.endsWith('('))
  ) {
    return true;
  }
  return false;
}

export function isLikelyDocumentationLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) return true;
  if (trimmed.endsWith('"""') || trimmed.endsWith("'''")) return true;
  if (trimmed.includes('"""') || trimmed.includes("'''")) return true;
  if (/^[A-Za-z][A-Za-z0-9 ,.;:()/_<>`'"\-–—]+$/.test(trimmed) && !/[=({[;]/.test(trimmed)) return true;
  return false;
}

function normalizeNumberLiteral(value) {
  return String(Number(value.replace(/_?(?:[ui](?:8|16|32|64|128|size)|f(?:32|64))$/i, '').replaceAll('_', '')));
}

function abbreviate(value, limit = DETAIL_EXCERPT_LIMIT) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`;
}
