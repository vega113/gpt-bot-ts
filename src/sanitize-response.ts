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
 *     【turn<digits><alphanum/dagger chars>】 (e.g. 【turn0finance0】,
 *     【turn0search0†source】). Full-width brackets containing other content
 *     (e.g. CJK prose) are left intact.
 *  2. Remove leaked ASCII cite tokens   .citeXXX  (e.g. .citeturn0finance0)
 *  3. Collapse runs of 3+ consecutive blank lines down to 1 blank line
 *  4. Trim leading/trailing whitespace from the whole string
 *
 * Nothing else is modified — markdown syntax, links, bold, lists, and
 * actual content are left intact.
 *
 * @param text - Raw text returned by the LLM
 * @returns Sanitized text ready for markdown-to-wave conversion or posting
 */
export function sanitizeLlmResponse(text: string): string {
  let result = text;

  // 1. Strip Unicode bracket citations matching the known OpenAI artifact shape:
  //    【turn<digits><optional alphanumeric/dagger suffix>】
  //    e.g. 【turn0finance0】, 【turn1search0†source】
  //    This avoids stripping arbitrary CJK prose or other valid uses of 【...】.
  result = result.replace(/【turn\d+[a-z0-9†]*】/gi, '');

  // 2. Strip ASCII-mangled cite tokens that match the known OpenAI artifact
  //    shape: an optional leading dot, then "citeturn", then digits, then an
  //    optional alphanumeric suffix (e.g. .citeturn0finance0,
  //    citeturn0search0source). This avoids removing normal words like
  //    "cited" or "cite".
  result = result.replace(/\.?citeturn\d+[a-z0-9]*\b/gi, '');

  // 3. Collapse 3+ consecutive blank lines → 1 blank line (i.e. at most one
  //    empty line between paragraphs).  A "blank line" is a line that contains
  //    only whitespace.
  result = result.replace(/(\n[ \t]*){3,}/g, '\n\n');

  // 4. Trim the whole string
  result = result.trim();

  return result;
}
