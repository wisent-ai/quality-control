// Reading one source line the way every guard does: what is a comment, what is
// documentation, and where a string literal starts and ends.

// The comment openers a guard treats as "no code on this line". Swift and Rust have no `#`
// comments; YAML and Markdown carry `<!--`.
export const CODE_COMMENT_MARKERS = ['//', '///', '#', '*', '/*'];
export const MARKUP_COMMENT_MARKERS = [...CODE_COMMENT_MARKERS, '<!--'];
export const SWIFT_COMMENT_MARKERS = ['//', '///', '*', '/*'];
export const RUST_COMMENT_MARKERS = ['//', '///', '//!', '*', '/*'];
const HEADER_LINE_COMMENTS = ['//', '#', '--'];
const HEADER_BLOCK_COMMENTS = {
  '/*': '*/', '<!--': '-->', '"""': '"""', "'''": "'''",
};
const HEADER_BLOCK_OPENERS = Object.keys(HEADER_BLOCK_COMMENTS);

export const STRING_LITERAL_RE = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

export function isCommentOnlyLine(line, markers = CODE_COMMENT_MARKERS) {
  const trimmed = line.trim();
  return markers.some(marker => trimmed.startsWith(marker));
}

// `hashComments` is false for a language where `#` opens no comment: a Rust attribute such as
// `#[serde(default)]` is code, and stripping from the `#` left the guard nothing to read.
export function codeWithoutInlineComment(line, { hashComments = true } = {}) {
  const withoutLineComment = line.replace(/\s+\/\/.*$/, '');
  return hashComments ? withoutLineComment.replace(/\s+#.*$/, '') : withoutLineComment;
}

// A file whose head says it is generated is the generator's output; the generator's source
// is what a guard reads, so every guard leaves the rendered file alone. The head is the
// leading run of comment and blank lines, wherever it ends.
const GENERATED_HEADER_RE = /generated\b[\s\S]*do not edit/i;

export function isGeneratedSource(lines) {
  const header = [];
  let closing;
  for (const line of lines) {
    let remaining = line.trimStart();
    while (remaining) {
      if (closing) {
        const end = remaining.indexOf(closing);
        if (end === -1) {
          header.push(remaining);
          break;
        }
        header.push(remaining.slice(0, end));
        remaining = remaining.slice(end + closing.length).trimStart();
        closing = undefined;
        continue;
      }
      if (HEADER_LINE_COMMENTS.some(marker => remaining.startsWith(marker))) {
        header.push(remaining);
        break;
      }
      const opener = HEADER_BLOCK_OPENERS.find(marker => remaining.startsWith(marker));
      if (!opener) return GENERATED_HEADER_RE.test(header.join('\n'));
      closing = HEADER_BLOCK_COMMENTS[opener];
      remaining = remaining.slice(opener.length);
    }
  }
  return GENERATED_HEADER_RE.test(header.join('\n'));
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
