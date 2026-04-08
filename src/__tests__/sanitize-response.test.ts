import { describe, it, expect } from 'vitest';
import { sanitizeLlmResponse, linkifyBareUrls } from '../sanitize-response.js';

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

  it('strips bracket citation prefixed with cite inside brackets【citeturn0finance0】', () => {
    // The OpenAI Responses API sometimes wraps citations as 【citeturnXXX】
    // (content starts with "cite" before "turn"), which was not matched by the
    // original regex that required content to start with "turn".
    const input = 'The price increased.【citeturn0finance0】';
    expect(sanitizeLlmResponse(input)).toBe('The price increased.');
  });

  it('strips bracket citation with dagger between cite and turn (【cite†turn0finance0】)', () => {
    const input = 'The market fell today【cite†turn0finance0】.';
    expect(sanitizeLlmResponse(input)).toBe('The market fell today.');
  });

  it('strips 【cite†turn0search0†source】 (double-dagger form)', () => {
    const input = 'As reported【cite†turn0search0†source】 by analysts.';
    expect(sanitizeLlmResponse(input)).toBe('As reported by analysts.');
  });

  it('strips bracket citation with any single non-word separator after cite', () => {
    // Future-proofing: (?:cite[^\w\s】]?)? matches non-word, non-space separators
    const input = 'Data shows【cite‡turn0finance0】 growth.';
    expect(sanitizeLlmResponse(input)).toBe('Data shows growth.');
  });

  // ── Regression: bracket content starting with "cite" but not a citation ───
  it('does not strip bracketed text like 【cite our turn2 plan】', () => {
    const input = 'See 【cite our turn2 plan】 for context.';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('does not strip 【cite turn2 plan】 (space between cite and turn)', () => {
    // The separator [^\w\s】]? excludes spaces so this is preserved
    const input = 'See 【cite turn2 plan】 for details.';
    expect(sanitizeLlmResponse(input)).toBe(input);
  });

  it('cleans up leftover empty lenticular brackets after citation removal', () => {
    // If a bracket pair is left with no content after stripping, it is removed too.
    const input = 'See this【】 result.';
    expect(sanitizeLlmResponse(input)).toBe('See this result.');
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

  it('does not strip leading whitespace (preserves indentation)', () => {
    // trimEnd() only — leading spaces/tabs must survive so downstream
    // markdown conversion sees correct indentation.
    expect(sanitizeLlmResponse('  \n  hello')).toBe('  \n  hello');
  });

  it('trims trailing whitespace', () => {
    expect(sanitizeLlmResponse('hello\n  ')).toBe('hello');
  });

  it('preserves leading indentation on the first content line', () => {
    const input = '    indented code block\nnormal text';
    expect(sanitizeLlmResponse(input)).toBe('    indented code block\nnormal text');
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

  it('does not strip bracketed text that contains "turn" mid-word (e.g. Saturn)', () => {
    // Regression: broad "turn anywhere" regex would strip 【Saturn2026】 because
    // "Saturn" contains "turn".  The precise regex anchors to the bracket start.
    const input = 'See 【Saturn2026】 and 【return plan】 for details.';
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

// ── linkifyBareUrls ─────────────────────────────────────────────

describe('linkifyBareUrls', () => {
  // ── Bare domain names in parentheses ──────────────────────────

  it('converts (domain.com) to a markdown link', () => {
    const input = 'Data from (coinmarketcap.com) shows growth.';
    expect(linkifyBareUrls(input)).toBe(
      'Data from ([coinmarketcap.com](https://coinmarketcap.com)) shows growth.',
    );
  });

  it('converts multiple bare domain parens in one line', () => {
    const input = 'Sources: (coinbase.com) and (cryptoslate.com).';
    expect(linkifyBareUrls(input)).toBe(
      'Sources: ([coinbase.com](https://coinbase.com)) and ([cryptoslate.com](https://cryptoslate.com)).',
    );
  });

  it('handles subdomains in parens', () => {
    const input = 'See (api.example.com) for docs.';
    expect(linkifyBareUrls(input)).toBe(
      'See ([api.example.com](https://api.example.com)) for docs.',
    );
  });

  it('handles domain with path in parens', () => {
    const input = 'Check (example.com/api/v1) for details.';
    expect(linkifyBareUrls(input)).toBe(
      'Check ([example.com/api/v1](https://example.com/api/v1)) for details.',
    );
  });

  it('handles various TLDs', () => {
    expect(linkifyBareUrls('(example.io)')).toBe('([example.io](https://example.io))');
    expect(linkifyBareUrls('(example.ai)')).toBe('([example.ai](https://example.ai))');
    expect(linkifyBareUrls('(example.dev)')).toBe('([example.dev](https://example.dev))');
    expect(linkifyBareUrls('(example.org)')).toBe('([example.org](https://example.org))');
  });

  it('does not convert non-domain text in parens', () => {
    expect(linkifyBareUrls('(e.g. this)')).toBe('(e.g. this)');
    expect(linkifyBareUrls('(v1.0)')).toBe('(v1.0)');
    expect(linkifyBareUrls('(Fig. 1)')).toBe('(Fig. 1)');
    expect(linkifyBareUrls('(≈2.96%)')).toBe('(≈2.96%)');
  });

  it('does not convert text in parens with unrecognized TLDs', () => {
    expect(linkifyBareUrls('(Node.js)')).toBe('(Node.js)');
    expect(linkifyBareUrls('(test.txt)')).toBe('(test.txt)');
  });

  // ── Bare URLs ─────────────────────────────────────────────────

  it('converts a bare https URL to a markdown link', () => {
    const input = 'Visit https://example.com for more info.';
    expect(linkifyBareUrls(input)).toBe(
      'Visit [example.com](https://example.com) for more info.',
    );
  });

  it('converts a bare URL with path', () => {
    const input = 'See https://example.com/docs/api for details.';
    expect(linkifyBareUrls(input)).toBe(
      'See [example.com/docs/api](https://example.com/docs/api) for details.',
    );
  });

  it('strips trailing punctuation from bare URLs', () => {
    const input = 'Check https://example.com.';
    expect(linkifyBareUrls(input)).toBe('Check [example.com](https://example.com).');
  });

  it('does not double-wrap URLs already in markdown link syntax', () => {
    const input = 'See [report](https://example.com) for details.';
    expect(linkifyBareUrls(input)).toBe(input);
  });

  it('does not double-wrap domain links created by the parens step', () => {
    // Step 1 converts (example.com) → ([example.com](https://example.com))
    // Step 2 must NOT re-wrap the https://example.com inside the markdown link
    const input = 'Data from (example.com) shows growth.';
    const result = linkifyBareUrls(input);
    // Should produce exactly ONE link wrapper, not nested
    expect(result).toBe('Data from ([example.com](https://example.com)) shows growth.');
  });

  it('strips www from display text', () => {
    const input = 'Visit https://www.example.com for info.';
    expect(linkifyBareUrls(input)).toBe('Visit [example.com](https://www.example.com) for info.');
  });

  it('truncates long display text', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(80);
    const result = linkifyBareUrls(`See ${longUrl} here.`);
    expect(result).toContain('...](');
    expect(result).toContain(longUrl); // full URL preserved in href
  });

  it('preserves text with no domains or URLs', () => {
    const input = 'Hello world, this has no links.';
    expect(linkifyBareUrls(input)).toBe(input);
  });

  it('does not linkify URLs inside code spans', () => {
    const input = 'Run `curl https://example.com/api` to test.';
    expect(linkifyBareUrls(input)).toBe(input);
  });

  it('does not linkify domains inside code spans', () => {
    const input = 'Use `(api.example.com)` as the host.';
    expect(linkifyBareUrls(input)).toBe(input);
  });

  it('handles Wikipedia-style URLs with balanced parens', () => {
    const input = 'See https://en.wikipedia.org/wiki/Foo_(bar) for details.';
    expect(linkifyBareUrls(input)).toBe(
      'See [en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_(bar)) for details.',
    );
  });

  // ── Combined realistic scenario ──────────────────────────────

  it('linkifies source attributions in a web search response', () => {
    const input = [
      '- CoinMarketCap reports a price of $71,531. (coinmarketcap.com)',
      '- CryptoSlate shows BTC at $71,637. (cryptoslate.com)',
      '',
      'See https://coinbase.com/price/bitcoin for live data.',
    ].join('\n');

    const expected = [
      '- CoinMarketCap reports a price of $71,531. ([coinmarketcap.com](https://coinmarketcap.com))',
      '- CryptoSlate shows BTC at $71,637. ([cryptoslate.com](https://cryptoslate.com))',
      '',
      'See [coinbase.com/price/bitcoin](https://coinbase.com/price/bitcoin) for live data.',
    ].join('\n');

    expect(linkifyBareUrls(input)).toBe(expected);
  });
});
