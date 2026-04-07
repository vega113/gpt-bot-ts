import { describe, it, expect } from 'vitest';
import { sanitizeLlmResponse } from '../sanitize-response.js';

describe('sanitizeLlmResponse', () => {
  // ── Unicode bracket citations ──────────────────────────────────

  it('strips a simple Unicode bracket citation', () => {
    expect(sanitizeLlmResponse('The market fell today【turn0finance0】.')).toBe(
      'The market fell today.',
    );
  });

  it('strips multiple bracket citations', () => {
    const input = 'Fact one【turn0search0】 and fact two【turn1finance1】.';
    expect(sanitizeLlmResponse(input)).toBe('Fact one and fact two.');
  });

  it('strips bracket citation with dagger source notation', () => {
    const input = 'See the report【turn0search0†source】 for details.';
    expect(sanitizeLlmResponse(input)).toBe('See the report for details.');
  });

  it('strips bracket citations that appear mid-word boundary', () => {
    const input = 'Revenue grew 12%【turn0finance2】, driven by cloud services.';
    expect(sanitizeLlmResponse(input)).toBe('Revenue grew 12%, driven by cloud services.');
  });

  it('strips bracket citation with hyphenated suffix (e.g. -source)', () => {
    const input = 'Market data【turn0finance0-source】 confirms the trend.';
    expect(sanitizeLlmResponse(input)).toBe('Market data confirms the trend.');
  });

  it('strips bracket citation with hyphenated -result suffix', () => {
    const input = 'Search results【turn0search0-result】 are shown below.';
    expect(sanitizeLlmResponse(input)).toBe('Search results are shown below.');
  });

  // ── ASCII mangled cite tokens ──────────────────────────────────

  it('strips .citeXXX token with leading dot', () => {
    expect(sanitizeLlmResponse('Sources indicate.citeturn0finance0 that rates rose.')).toBe(
      'Sources indicate that rates rose.',
    );
  });

  it('strips citeXXX token without leading dot', () => {
    expect(sanitizeLlmResponse('As reportedciteturn0search1 yesterday.')).toBe(
      'As reported yesterday.',
    );
  });

  it('strips multiple .citeXXX tokens', () => {
    const input = 'First claim.citeturn0finance0. Second claim.citeturn0search1.';
    expect(sanitizeLlmResponse(input)).toBe('First claim. Second claim.');
  });

  it('is case-insensitive for cite tokens', () => {
    expect(sanitizeLlmResponse('Note.CITEturn0finance0 here.')).toBe('Note here.');
  });

  it('strips .citeXXX token with hyphenated -source suffix', () => {
    expect(sanitizeLlmResponse('Sources indicate.citeturn0finance0-source that rates rose.')).toBe(
      'Sources indicate that rates rose.',
    );
  });

  it('strips .citeXXX token with hyphenated -result suffix', () => {
    expect(sanitizeLlmResponse('Data from.citeturn0search0-result was compiled.')).toBe(
      'Data from was compiled.',
    );
  });

  // ── Regression: normal words containing "cite" must not be stripped ───
  it('does not strip the word "cited" from normal prose', () => {
    const input = 'As cited in the report, the study was influential.';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('does not strip the word "cite" used as a verb', () => {
    const input = 'Please cite your sources.';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('does not strip "incited" from normal prose', () => {
    const input = 'The speech incited the crowd.';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  // ── Blank line normalization ───────────────────────────────────

  it('collapses three consecutive blank lines to two', () => {
    const input = 'Para one.\n\n\nPara two.';
    expect(sanitizeLlmResponse(input)).toBe('Para one.\n\nPara two.');
  });

  it('collapses many consecutive blank lines to two', () => {
    const input = 'A\n\n\n\n\n\nB';
    expect(sanitizeLlmResponse(input)).toBe('A\n\nB');
  });

  it('leaves exactly two blank lines unchanged', () => {
    const input = 'A\n\nB';
    expect(sanitizeLlmResponse(input)).toBe('A\n\nB');
  });

  it('leaves single newlines unchanged', () => {
    const input = 'Line 1\nLine 2\nLine 3';
    expect(sanitizeLlmResponse(input)).toBe('Line 1\nLine 2\nLine 3');
  });

  it('preserves leading indentation of the line after collapsed blank lines', () => {
    // 3+ consecutive blank lines before an indented line must not strip the indent
    const input = 'A\n\n\n  indented code';
    expect(sanitizeLlmResponse(input)).toBe('A\n\n  indented code');
  });

  it('collapses whitespace-only blank lines without stripping next line indent', () => {
    // Blank lines may themselves contain spaces; the next line's indent must survive
    const input = 'A\n  \n  \n  indented';
    expect(sanitizeLlmResponse(input)).toBe('A\n\n  indented');
  });

  // ── Whitespace trimming ────────────────────────────────────────

  it('trims leading whitespace', () => {
    expect(sanitizeLlmResponse('  \n  hello')).toBe('hello');
  });

  it('trims trailing whitespace', () => {
    expect(sanitizeLlmResponse('hello\n  ')).toBe('hello');
  });

  // ── Content preservation ───────────────────────────────────────

  it('does not modify markdown bold syntax', () => {
    const input = '**Important:** this is critical.';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('does not modify markdown links', () => {
    const input = 'See [OpenAI](https://openai.com) for more.';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('does not modify bullet lists', () => {
    const input = '- First item\n- Second item\n- Third item';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('does not modify numbered lists', () => {
    const input = '1. First\n2. Second\n3. Third';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('does not modify markdown headers', () => {
    const input = '## Section Header\n\nContent here.';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(sanitizeLlmResponse('')).toBe('');
  });

  it('handles string with only citation markers', () => {
    expect(sanitizeLlmResponse('【turn0finance0】')).toBe('');
  });

  // ── Regression: valid full-width bracket content must not be stripped ───
  it('does not strip CJK prose enclosed in full-width brackets', () => {
    const input = '这是一个测试【示例文本】，请勿删除。';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('does not strip arbitrary labels in full-width brackets', () => {
    const input = 'See section 【Appendix A】 for details.';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('strips OpenAI citation but preserves adjacent full-width bracket content', () => {
    const input = 'Result【turn0finance0】 and label【Appendix A】.';
    expect(sanitizeLlmResponse(input)).toBe('Result and label【Appendix A】.');
  });

  // ── Combined scenarios ─────────────────────────────────────────

  it('strips citations and normalizes blank lines in a realistic response', () => {
    const input = [
      'The S&P 500 rose 1.2% today【turn0finance0】.',
      '',
      '',
      '',
      '**Key drivers:**',
      '- Tech stocks led gains【turn0finance1】',
      '- Bond yields fell.citeturn0search0',
      '',
      'See [full report](https://example.com) for details.',
    ].join('\n');

    const expected = [
      'The S&P 500 rose 1.2% today.',
      '',
      '**Key drivers:**',
      '- Tech stocks led gains',
      '- Bond yields fell',
      '',
      'See [full report](https://example.com) for details.',
    ].join('\n');

    expect(sanitizeLlmResponse(input)).toBe(expected);
  });
});
