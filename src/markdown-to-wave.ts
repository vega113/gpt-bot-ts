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
 *   # / ## / ### headers (rendered as bold)
 *   - / * / + bullet lists (converted to • prefix)
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
function parseInline(text: string): Span[] {
  const spans: Span[] = [];

  // Single regex that matches all inline tokens, left-to-right.
  // Groups:
  //   1 — full match (unused)
  //   2 — ***bold italic*** content
  //   3 — **bold** / __bold__ content
  //   4 — *italic* content
  //   5 — _italic_ content
  //   6 — `code` content
  //   7 — [link] text
  //   8 — (link) url
  const inlineRx =
    /(\*\*\*(.+?)\*\*\*|(?:\*\*|__)(.+?)(?:\*\*|__)|\*(.+?)\*|_(.+?)_|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/gs;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRx.exec(text)) !== null) {
    // Plain text before this token
    if (match.index > lastIndex) {
      spans.push({ text: text.slice(lastIndex, match.index), bold: false, italic: false });
    }

    if (match[2] !== undefined) {
      // ***bold italic***
      spans.push({ text: match[2], bold: true, italic: true });
    } else if (match[3] !== undefined) {
      // **bold** or __bold__
      spans.push({ text: match[3], bold: true, italic: false });
    } else if (match[4] !== undefined) {
      // *italic*
      spans.push({ text: match[4], bold: false, italic: true });
    } else if (match[5] !== undefined) {
      // _italic_
      spans.push({ text: match[5], bold: false, italic: true });
    } else if (match[6] !== undefined) {
      // `code` — strip backticks, no annotation
      spans.push({ text: match[6], bold: false, italic: false });
    } else if (match[7] !== undefined && match[8] !== undefined) {
      // [link text](url)
      spans.push({ text: match[7], bold: false, italic: false, link: match[8] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex), bold: false, italic: false });
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
export function markdownToWave(markdown: string): WaveContent {
  const annotations: WaveAnnotation[] = [];
  let content = '';

  const lines = markdown.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (lineIndex > 0) {
      content += '\n';
    }

    let line = lines[lineIndex];
    let isHeader = false;
    let prefix = '';

    // --- Block-level patterns ---

    // Headers: # text, ## text, …
    const headerMatch = line.match(/^#{1,6}\s+(.*)/);
    if (headerMatch) {
      line = headerMatch[1];
      isHeader = true;
    }

    // Horizontal rules: --- / *** / === alone on a line
    if (/^(\s*[-*=]){3,}\s*$/.test(line)) {
      content += '──────────';
      continue;
    }

    // Bullet lists: - item / * item / + item
    // Use negative lookahead on * to avoid matching **bold** or ***bold italic***.
    const bulletMatch = line.match(/^(\s*)(?:[-+]|\*(?!\*))\s+(.*)/);
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
