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
  //    immediately followed by "turn<digits>" (e.g. 【turn0finance0】,
  //    【citeturn0finance0】, 【turn1search0†source】).  Anchoring to the
  //    bracket start prevents accidental removal of legitimate text that
  //    merely contains "turn" elsewhere (e.g. 【Saturn2026】, 【return plan】).
  result = result.replace(/【(?:cite)?turn\d+[^】\n]*】/gi, '');

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
