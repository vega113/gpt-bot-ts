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
 *  1. Remove Unicode bracket citations  【...】  (e.g. 【turn0finance0】)
 *  2. Remove leaked ASCII cite tokens   .citeXXX  (e.g. .citeturn0finance0)
 *  3. Collapse runs of 3+ consecutive blank lines down to 2 blank lines
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

  // 1. Strip Unicode bracket citations: 【anything】
  //    These are inserted by OpenAI web-search as inline source references.
  result = result.replace(/【[^】]*】/g, '');

  // 2. Strip ASCII-mangled cite tokens: an optional leading dot followed by
  //    the word "cite" and alphanumeric characters (e.g. .citeturn0finance0,
  //    citeturn0search0source).  Use a word-boundary anchor on the right so
  //    we don't clip the next real word.
  result = result.replace(/\.?cite[a-z0-9]+\b/gi, '');

  // 3. Collapse 3+ consecutive blank lines → 2 blank lines (i.e. at most one
  //    empty line between paragraphs).  A "blank line" is a line that contains
  //    only whitespace.
  result = result.replace(/(\n[ \t]*){3,}/g, '\n\n');

  // 4. Trim the whole string
  result = result.trim();

  return result;
}
