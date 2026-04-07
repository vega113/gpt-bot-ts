/**
 * Convert Markdown text to Wave plain-text content + style annotations.
 *
 * Wave blips render formatting via annotations (character ranges with a name/value).
 * This module strips Markdown syntax and produces the equivalent annotations so
 * that bold, italic, and link formatting appear correctly in the SupaWave UI.
 *
 * Supported Markdown:
 *   **bold**, __bold__
 *   *italic*, _italic_
 *   ***bold italic***
 *   [link text](url)   (only http/https/mailto schemes are emitted as annotations)
 *   ![alt text](url)   (images → rendered as clickable link with alt text)
 *   # / ## / ### headers (rendered as bold)
 *   - / * / + bullet lists (converted to • prefix)
 *   1. / 2. numbered lists (number prefix preserved)
 *   | tables |          (separator rows dropped; header row bolded; cells joined with │)
 *   `inline code` (rendered as plain text — Wave has no monospace annotation)
 *   Blank lines are preserved
 *
 * Annotation names follow the Google Wave / SupaWave convention:
 *   style/fontWeight  "bold"
 *   style/fontStyle   "italic"
 *   link/manual       "<url>"
 */

export interface WaveAnnotation {
  name: string;
  value: string;
  range: { start: number; end: number };
}

export interface WaveContent {
  /** Plain text without Markdown syntax. */
  content: string;
  /** Style annotations with character ranges into `content`. */
  annotations: WaveAnnotation[];
}

// ── inline span types ────────────────────────────────────────

interface Span {
  text: string;
  bold: boolean;
  italic: boolean;
  link?: string;
}

// ── inline parser ─────────────────────────────────────────────

/**
 * Parse a single line of inline Markdown into annotated spans.
 *
 * Handles (in priority order):
 *   ***bold italic***
 *   **bold**
 *   *italic* / _italic_
 *   `code`        → plain text, no style
 *   [text](url)
 *   plain text
 */
/**
 * Replace `\X` escape sequences with private-use-area placeholders so the
 * inline regex never sees the escaped delimiter characters.
 * Restored by `unescapeSpan` after spans are collected.
 */
const ESCAPED_CHARS = '*_`[]()\\' as const;
const CHAR_TO_PLACEHOLDER: Record<string, string> = {};
const PLACEHOLDER_TO_CHAR: Record<string, string> = {};
for (let i = 0; i < ESCAPED_CHARS.length; i++) {
  const ch = ESCAPED_CHARS[i];
  const ph = `\uE700${String.fromCodePoint(0xE700 + i)}`;  // two private-use chars
  CHAR_TO_PLACEHOLDER[ch] = ph;
  PLACEHOLDER_TO_CHAR[ph] = ch;
}
const ESCAPE_RE = /\\([*_`\[\]()\\/])/g;
const PLACEHOLDER_RE = /\uE700[\uE700-\uE7FF]/g;

function encodeEscapes(s: string): string {
  return s.replace(ESCAPE_RE, (_, ch: string) => CHAR_TO_PLACEHOLDER[ch] ?? ch);
}
function decodeEscapes(s: string): string {
  return s.replace(PLACEHOLDER_RE, (ph) => PLACEHOLDER_TO_CHAR[ph] ?? ph);
}

function parseInline(text: string): Span[] {
  const spans: Span[] = [];

  // Safe-link pattern — only http/https/mailto URIs become link annotations.
  // This is enforced here (at the source) rather than relying solely on callers.
  const SAFE_URL_RE = /^https?:\/\/|^mailto:/i;

  // Encode backslash-escaped delimiters so the regex below never matches them.
  // e.g. `\*literal\*` → placeholders → not matched as italic → decoded back to `*literal*`
  const encoded = encodeEscapes(text);

  // Single regex that matches all inline tokens, left-to-right.
  // Groups:
  //   1  — full match (unused)
  //   2  — ***bold italic*** content
  //   3  — **bold** content — content-boundary-aware: leading/trailing char must be
  //        non-whitespace so `2 ** 3 ** 2` (exponent operator) is NOT treated as bold
  //   4  — __bold__ content — word-boundary-aware ((?<!\w) / (?!\w)) so
  //        `my__init__method` is NOT treated as bold
  //   5  — *italic* content — content-boundary-aware: leading/trailing char must be
  //        non-whitespace so `2 * 3 * 4` and `ls *.ts` are NOT treated as italic
  //   6  — _italic_ content — word-boundary-aware: (?<!\w) / (?!\w) so
  //        snake_case identifiers like set_user_name are NOT treated as italic
  //   7  — `code` content  (single-backtick only; not `` ` `` inside ``` fences)
  //   8  — ![image alt] text  (image before link so `![…](…)` takes priority)
  //   9  — ![image] url — allows one level of balanced parens
  //   10 — [link] text
  //   11 — (link) url — allows one level of balanced parens for Wikipedia-style URLs
  const inlineRx =
    /(\*\*\*(.+?)\*\*\*|\*\*([^\s*][^*\n]*[^\s]|[^\s*])\*\*|(?<!\w)__(.+?)__(?!\w)|\*([^\s*][^*\n]*[^\s*]|[^\s*])\*|(?<!\w)_(.+?)_(?!\w)|(?<!`)`([^`]+)`(?!`)|!\[([^\]]*)\]\(((?:[^()]+|\([^()]*\))*)\)|\[([^\]]+)\]\(((?:[^()]+|\([^()]*\))*)\))/gs;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRx.exec(encoded)) !== null) {
    // Plain text before this token — decode escape placeholders back to literals
    if (match.index > lastIndex) {
      spans.push({ text: decodeEscapes(encoded.slice(lastIndex, match.index)), bold: false, italic: false });
    }

    if (match[2] !== undefined) {
      // ***bold italic***
      spans.push({ text: decodeEscapes(match[2]), bold: true, italic: true });
    } else if (match[3] !== undefined) {
      // **bold**
      spans.push({ text: decodeEscapes(match[3]), bold: true, italic: false });
    } else if (match[4] !== undefined) {
      // __bold__ (word-boundary-aware — intraword __ not matched)
      spans.push({ text: decodeEscapes(match[4]), bold: true, italic: false });
    } else if (match[5] !== undefined) {
      // *italic* (content starts/ends with non-whitespace)
      spans.push({ text: decodeEscapes(match[5]), bold: false, italic: true });
    } else if (match[6] !== undefined) {
      // _italic_ (word-boundary-aware)
      spans.push({ text: decodeEscapes(match[6]), bold: false, italic: true });
    } else if (match[7] !== undefined) {
      // `code` — strip backticks, no annotation
      spans.push({ text: decodeEscapes(match[7]), bold: false, italic: false });
    } else if (match[8] !== undefined && match[9] !== undefined) {
      // ![alt text](url) — Wave cannot embed images; render as a clickable link.
      // The alt text becomes the visible label; the URL is the link target.
      // If the alt text is empty, fall back to "image".
      const url = decodeEscapes(match[9]);
      const alt = decodeEscapes(match[8]).trim() || 'image';
      spans.push({ text: alt, bold: false, italic: false, link: SAFE_URL_RE.test(url) ? url : undefined });
    } else if (match[10] !== undefined && match[11] !== undefined) {
      // [link text](url) — only annotate safe schemes
      const url = decodeEscapes(match[11]);
      spans.push({ text: decodeEscapes(match[10]), bold: false, italic: false, link: SAFE_URL_RE.test(url) ? url : undefined });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < encoded.length) {
    spans.push({ text: decodeEscapes(encoded.slice(lastIndex)), bold: false, italic: false });
  }

  return spans;
}

// ── main converter ───────────────────────────────────────────

/**
 * Convert a Markdown string to Wave `{ content, annotations }`.
 *
 * The returned `content` is plain text (no Markdown syntax).
 * Annotations reference character ranges in that plain text.
 *
 * Wave blip content must start with `\n` — the caller (WaveClient) is
 * responsible for prepending it and offsetting annotations by 1.
 *
 * @example
 * markdownToWave('Hello **world**!')
 * // → { content: 'Hello world!', annotations: [{ name: 'style/fontWeight', value: 'bold', range: { start: 6, end: 11 } }] }
 */
// ── table helpers ────────────────────────────────────────────

/**
 * Regex that matches a Markdown table separator row such as:
 *   |---|  or  |---|---|---|  or  |:---:|--:|---|  or  --- | --- | ---
 * Each "cell" consists of optional colons around one or more dashes.
 * The repeating-cell group is `*` (zero or more) so single-column
 * separators like `|---|` are matched correctly.
 */
const TABLE_SEP_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Returns true when `line` looks like a Markdown table row.
 * A table row must start (optionally) with `|` and contain at least
 * one `|` separator between cells.
 */
function isTableRow(line: string): boolean {
  return line.includes('|') && /^\|?.+\|/.test(line);
}

/**
 * Split a table row into its cell texts, stripping the outer `|` delimiters
 * and trimming each cell.
 * e.g. `| Source | Price |` → `['Source', 'Price']`
 */
function splitTableCells(line: string): string[] {
  // Split on `|`, remove first (before the leading `|`) and last (after trailing `|`)
  // elements if they're empty/whitespace.
  const parts = line.split('|');
  const cells: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    // Skip the empty segment that appears when the row starts/ends with `|`
    if ((i === 0 || i === parts.length - 1) && parts[i]!.trim() === '') continue;
    cells.push(parts[i]!.trim());
  }
  return cells;
}

export function markdownToWave(markdown: string): WaveContent {
  const annotations: WaveAnnotation[] = [];
  let content = '';

  const lines = markdown.split('\n');
  let inFencedBlock = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (lineIndex > 0) {
      content += '\n';
    }

    let line = lines[lineIndex];
    let isHeader = false;
    let prefix = '';

    // --- Block-level patterns ---

    // Fenced code blocks: ``` or ~~~ (3+ backticks/tildes).
    // Toggle in/out of fenced mode; emit fence delimiters and code lines as
    // plain text so that inline patterns never fire inside a code block.
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFencedBlock = !inFencedBlock;
      // Emit the fence line itself as plain text (strip the fence marker but keep
      // any language hint after it for the opening fence).
      content += inFencedBlock ? line.replace(/^(`{3,}|~{3,})\s*/, '') : '';
      continue;
    }
    if (inFencedBlock) {
      // Inside a fenced block: pass through verbatim, no inline processing.
      content += line;
      continue;
    }

    // Horizontal rules FIRST — before header stripping, so `# ---` is not
    // misidentified as a rule after the `#` is removed.
    // Require the same char repeated 3+ times (no mixed markers like -=-).
    if (/^[ \t]*([-*=])\1{2,}[ \t]*$/.test(line)) {
      content += '──────────';
      continue;
    }

    // ── Table handling ───────────────────────────────────────
    //
    // Separator rows (|---|---|) are dropped entirely — they provide column-
    // alignment info for renderers but carry no content.
    //
    // Header rows (the row immediately before a separator) are bolded.
    // Data rows are rendered as plain inline-parsed text with │ separators.
    if (TABLE_SEP_RE.test(line)) {
      // Drop the separator; don't emit a newline placeholder (already emitted above).
      // To avoid a blank line where the separator was, undo the \n that was prepended.
      if (content.endsWith('\n')) content = content.slice(0, -1);
      continue;
    }

    if (isTableRow(line)) {
      const cells = splitTableCells(line);
      if (cells.length > 0) {
        // Detect whether this is a header row: the NEXT non-empty line is a separator.
        let nextNonEmpty = '';
        for (let j = lineIndex + 1; j < lines.length; j++) {
          if (lines[j]!.trim() !== '') { nextNonEmpty = lines[j]!; break; }
        }
        const isTableHeader = TABLE_SEP_RE.test(nextNonEmpty);

        const rowStart = content.length;
        // Render each cell through the inline parser, join with ' │ '
        const cellSpans: Array<{ text: string; start: number; end: number; bold: boolean; italic: boolean; link?: string }> = [];
        let rowText = '';
        for (let ci = 0; ci < cells.length; ci++) {
          if (ci > 0) rowText += ' │ ';
          const cellStart = rowText.length;
          const spans = parseInline(cells[ci]!);
          for (const span of spans) {
            if (span.text.length === 0) continue;
            const s = rowText.length;
            rowText += span.text;
            cellSpans.push({ text: span.text, start: rowStart + s, end: rowStart + rowText.length, bold: span.bold || isTableHeader, italic: span.italic, link: span.link });
          }
          void cellStart;
        }
        content += rowText;
        for (const cs of cellSpans) {
          if (cs.bold) annotations.push({ name: 'style/fontWeight', value: 'bold', range: { start: cs.start, end: cs.end } });
          if (cs.italic) annotations.push({ name: 'style/fontStyle', value: 'italic', range: { start: cs.start, end: cs.end } });
          if (cs.link) annotations.push({ name: 'link/manual', value: cs.link, range: { start: cs.start, end: cs.end } });
        }
        continue;
      }
    }

    // Headers: # text, ## text, …
    const headerMatch = line.match(/^#{1,6}\s+(.*)/);
    if (headerMatch) {
      line = headerMatch[1];
      isHeader = true;
    }

    // Bullet lists: - item / * item / + item
    // Use negative lookahead on * to avoid matching **bold** or ***bold italic***.
    // Skip when processing header content — `# - item` is a heading whose text
    // happens to start with a dash, not a nested bullet.
    const bulletMatch = !isHeader ? line.match(/^(\s*)(?:[-+]|\*(?!\*))\s+(.*)/) : null;
    if (bulletMatch) {
      prefix = bulletMatch[1] + '• ';
      line = bulletMatch[2];
    }

    // Numbered lists: 1. item — keep the number prefix
    // (no transformation needed, just pass through)

    // Add any block-level prefix (e.g. bullet •)
    content += prefix;

    // --- Inline parsing ---

    const lineStart = content.length;
    const spans = parseInline(line);

    for (const span of spans) {
      if (span.text.length === 0) continue;

      const start = content.length;
      content += span.text;
      const end = content.length;

      if (span.bold) {
        annotations.push({ name: 'style/fontWeight', value: 'bold', range: { start, end } });
      }
      if (span.italic) {
        annotations.push({ name: 'style/fontStyle', value: 'italic', range: { start, end } });
      }
      if (span.link) {
        annotations.push({ name: 'link/manual', value: span.link, range: { start, end } });
      }
    }

    // Bold the entire header line (may overlap span-level bold — that's fine)
    if (isHeader && content.length > lineStart) {
      annotations.push({
        name: 'style/fontWeight',
        value: 'bold',
        range: { start: lineStart, end: content.length },
      });
    }
  }

  return { content, annotations };
}
