/**
 * Utilities for cleaning LLM response text before posting to Wave.
 *
 * OpenAI web-search responses include inline citation markers in Unicode
 * bracket notation (e.g. 【turn0finance0】) and sometimes a mangled ASCII
 * form (e.g. .citeturn0finance0) if the brackets are stripped mid-pipeline.
 * These markers are meaningless to Wave users and must be removed.
 */

/**
 * Strip OpenAI citation artifacts and normalize whitespace in an LLM response.
 *
 * Operations performed (in order):
 *  1. Remove Unicode bracket citations matching the known OpenAI artifact shape:
 *     【turn<digits><alphanum/hyphen/dagger chars>】 (e.g. 【turn0finance0】,
 *     【turn0search0†source】, 【turn0finance0-source】). Full-width brackets
 *     containing other content
 *     (e.g. CJK prose) are left intact.
 *  2. Remove leaked ASCII cite tokens   .citeXXX  (e.g. .citeturn0finance0)
 *  3. Collapse runs of 3+ consecutive blank lines down to 1 blank line
 *  4. Trim trailing whitespace (leading whitespace is preserved so that
 *     intentional indentation at the start of a response is not destroyed)
 *
 * Nothing else is modified — markdown syntax, links, bold, lists, and
 * actual content are left intact.
 *
 * @param text - Raw text returned by the LLM
 * @returns Sanitized text ready for markdown-to-wave conversion or posting
 */
export function sanitizeLlmResponse(text: string): string {
  let result = text;

  // 1. Strip Unicode bracket citations.  The OpenAI web-search tool injects
  //    references inside 【 】 (U+3010 / U+3011) lenticular brackets.
  //    The bracket content always starts with an optional "cite" prefix
  //    (sometimes separated from "turn" by a dagger † U+2020, e.g.
  //    【cite†turn0finance0】) followed by "turn<digits>".  Anchoring to the
  //    bracket start prevents accidental removal of legitimate text that
  //    merely contains "turn" elsewhere (e.g. 【Saturn2026】, 【return plan】).
  //    The optional group (?:cite[^\w\s】]?)? matches "cite" with at most
  //    one non-word, non-space separator before "turn".  This covers the
  //    observed dagger (†) and future Unicode symbol separators while
  //    excluding spaces and letters so that legitimate bracket content
  //    like 【cite turn2 plan】 is never falsely removed.
  //    Handled formats:
  //      【turn0finance0】       (no cite prefix)
  //      【citeturn0finance0】   (cite immediately before turn)
  //      【cite†turn0finance0】  (cite + dagger + turn — U+2020)
  //      【turn0search0†source】 【turn0finance0-source】 (suffixes after turn)
  result = result.replace(/【(?:cite[^\w\s】]?)?turn\d+[^】\n]*】/gi, '');

  // 1b. Remove any empty lenticular bracket pairs (e.g. 【】) that may appear
  //     in the response for any reason.
  result = result.replace(/【\s*】/g, '');

  // 2. Strip ASCII-mangled cite tokens.  These appear with or without a leading
  //    dot, e.g. .citeturn0finance0, citeturn0search0, .citeturn0finance0-source.
  //    The pattern requires "citeturn" together so normal English words like
  //    "cited", "cite", "return", etc. are never accidentally removed.
  result = result.replace(/\.?citeturn\d+[-a-z0-9†]*/gi, '');

  // 3. Collapse 3+ consecutive blank lines → 1 blank line (i.e. at most one
  //    empty line between paragraphs).  A "blank line" is a line that contains
  //    only whitespace.
  //    Pattern: one leading \n, then 2+ repetitions of (optional whitespace + \n).
  //    This avoids consuming the leading indentation of the next content line,
  //    which the naive /(\n[ \t]*){3,}/ pattern would swallow.
  result = result.replace(/\n([ \t]*\n){2,}/g, '\n\n');

  // 4. Trim trailing whitespace only.  Leading whitespace (e.g. the 4-space
  //    indent of a code block or the leading spaces of a nested list at the
  //    very top of the reply) must be preserved so downstream markdown
  //    conversion sees the correct indentation.
  result = result.trimEnd();

  return result;
}

// ── Common TLDs for bare-domain detection ───────────────────
// Kept as a module-level constant so the regex is compiled once.
const TLD_RE =
  'com|org|net|io|ai|co|edu|gov|me|dev|app|info|biz|xyz|tech|' +
  'uk|de|fr|jp|cn|us|ca|au|nl|ru|br|in|it|es|pl|se|no|fi|ch';


/**
 * Convert bare domain names and URLs in the text to Markdown links so that
 * downstream `markdownToWave` can produce `link/manual` annotations.
 *
 * OpenAI web-search source attributions often appear as bare domain names
 * in parentheses (e.g. `(coinmarketcap.com)`).  These are not Markdown
 * links, so `markdownToWave` passes them through as plain text.  This
 * function rewrites them into proper Markdown link syntax:
 *
 *   (coinmarketcap.com) → ([coinmarketcap.com](https://coinmarketcap.com))
 *   https://example.com → [example.com](https://example.com)
 *
 * @param text - Sanitized LLM response (citation markers already stripped)
 * @returns Text with bare domains/URLs converted to Markdown links
 */
export function linkifyBareUrls(text: string): string {
  // Process through a single alternation regex that matches EITHER
  // verbatim regions (fenced code blocks, inline code spans, existing
  // markdown links) OR linkification targets (bare domains/URLs).
  // Verbatim regions are returned as-is so their content is never rewritten.
  //
  // Alternation priority (left to right):
  //   1. Fenced code blocks  (```…``` or ~~~…~~~)
  //   2. Inline code spans   (`…`)
  //   3. Existing markdown links  [text](url)
  //   4. Bare domain in parens    (domain.tld)
  //   5. Bare URL                 https://…

  // Build a combined regex with capture groups:
  // Group 1: fenced code block — returned as-is
  // Group 2: inline code span — returned as-is
  // Group 3: existing markdown link — returned as-is
  // Group 4: domain inside parens → linkify
  // Group 5: bare URL → linkify
  const COMBINED_RE = new RegExp(
    '(```[\\s\\S]*?(?:```|$)|~~~[\\s\\S]*?(?:~~~|$))'     + // fenced code block (incl. unterminated)
    '|(`[^`]+`)'                                          + // inline code span
    '|(\\[[^\\]]+\\]\\((?:[^()]+|\\([^()]*\\))*\\))'     + // existing markdown link
    '|\\((' +
      '(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:' + TLD_RE + ')' +
      '(?:\\/[^\\s)]*)?' +
    ')\\)'                                                + // domain in parens
    '|(?<!\\]\\()(https?:\\/\\/(?:[^\\s()\\]>]|\\([^\\s)]*\\))+)', // bare URL
    'gi',
  );

  return text.replace(
    COMBINED_RE,
    (match, _fenced?: string, _codeSpan?: string, _mdLink?: string, domain?: string, url?: string) => {
    // Fenced code block, inline code span, or existing markdown link — return as-is
    if (_fenced || _codeSpan || _mdLink) return match;

    // Bare domain in parens → markdown link
    if (domain) {
      return `([${domain}](https://${domain}))`;
    }

    // Bare URL → markdown link
    if (url) {
      // Trim trailing punctuation that likely isn't part of the URL
      let cleaned = url;
      const trailingPunct = /[.,;:!?]+$/;
      const punct = cleaned.match(trailingPunct);
      if (punct) cleaned = cleaned.slice(0, -punct[0].length);

      // Display text: strip protocol and www, truncate if very long
      let display = cleaned.replace(/^https?:\/\//, '').replace(/^www\./, '');
      if (display.endsWith('/')) display = display.slice(0, -1);
      if (display.length > 60) display = display.slice(0, 57) + '...';

      return `[${display}](${cleaned})${punct ? punct[0] : ''}`;
    }

    return match;
  });
}
