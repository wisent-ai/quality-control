// Reading one source line the way every guard does: what is a comment, what is
// documentation, and where a string literal starts and ends.

// The comment openers a guard treats as "no code on this line". Swift has no `#`
// comments; YAML and Markdown carry `<!--`.
export const CODE_COMMENT_MARKERS = ['//', '///', '#', '*', '/*'];
export const MARKUP_COMMENT_MARKERS = [...CODE_COMMENT_MARKERS, '<!--'];
export const SWIFT_COMMENT_MARKERS = ['//', '///', '*', '/*'];

export const STRING_LITERAL_RE = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

export function isCommentOnlyLine(line, markers = CODE_COMMENT_MARKERS) {
  const trimmed = line.trim();
  return markers.some(marker => trimmed.startsWith(marker));
}

export function codeWithoutInlineComment(line) {
  return line.replace(/\s+\/\/.*$/, '').replace(/\s+#.*$/, '');
}

// The one-based numbers of every line inside or touching a Python triple-quoted string.
export function documentationLineNumbers(lines) {
  const docs = new Set();
  let activeToken = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let searchFrom = 0;
    let lineIsDocumentation = Boolean(activeToken);
    while (searchFrom < line.length) {
      const next = nextTripleQuote(line, searchFrom);
      if (!next) break;
      lineIsDocumentation = true;
      if (activeToken) {
        if (next.token === activeToken) activeToken = '';
      } else {
        activeToken = next.token;
      }
      searchFrom = next.index + next.token.length;
    }
    if (lineIsDocumentation) docs.add(index + 1);
  }
  return docs;
}

function nextTripleQuote(line, searchFrom) {
  const doubleIndex = line.indexOf('"""', searchFrom);
  const singleIndex = line.indexOf("'''", searchFrom);
  if (doubleIndex === -1 && singleIndex === -1) return null;
  if (singleIndex === -1 || (doubleIndex !== -1 && doubleIndex < singleIndex)) {
    return { index: doubleIndex, token: '"""' };
  }
  return { index: singleIndex, token: "'''" };
}
