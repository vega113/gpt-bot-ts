import { describe, it, expect } from 'vitest';
import { markdownToWave } from '../markdown-to-wave.js';
import type { WaveAnnotation } from '../markdown-to-wave.js';

// ── helpers ──────────────────────────────────────────────────

function ann(name: string, value: string, start: number, end: number): WaveAnnotation {
  return { name, value, range: { start, end } };
}

// ── plain text ────────────────────────────────────────────────

describe('markdownToWave — plain text', () => {
  it('returns text unchanged when no markdown', () => {
    const { content, annotations } = markdownToWave('Hello world');
    expect(content).toBe('Hello world');
    expect(annotations).toHaveLength(0);
  });

  it('handles empty string', () => {
    const { content, annotations } = markdownToWave('');
    expect(content).toBe('');
    expect(annotations).toHaveLength(0);
  });

  it('preserves newlines', () => {
    const { content } = markdownToWave('line1\nline2\nline3');
    expect(content).toBe('line1\nline2\nline3');
  });

  it('preserves blank lines', () => {
    const { content } = markdownToWave('a\n\nb');
    expect(content).toBe('a\n\nb');
  });
});

// ── bold ─────────────────────────────────────────────────────

describe('markdownToWave — bold', () => {
  it('strips ** and creates fontWeight annotation', () => {
    const { content, annotations } = markdownToWave('Say **hello** now');
    expect(content).toBe('Say hello now');
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 4, 9));
  });

  it('handles bold at start of string', () => {
    const { content, annotations } = markdownToWave('**Bold** text');
    expect(content).toBe('Bold text');
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 0, 4));
  });

  it('handles bold at end of string', () => {
    const { content, annotations } = markdownToWave('text **Bold**');
    expect(content).toBe('text Bold');
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 5, 9));
  });

  it('handles multiple bold spans', () => {
    const { content, annotations } = markdownToWave('**a** and **b**');
    expect(content).toBe('a and b');
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 0, 1));
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 6, 7));
  });
});

// ── italic ────────────────────────────────────────────────────

describe('markdownToWave — italic', () => {
  it('strips * and creates fontStyle annotation', () => {
    const { content, annotations } = markdownToWave('Say *hello* now');
    expect(content).toBe('Say hello now');
    expect(annotations).toContainEqual(ann('style/fontStyle', 'italic', 4, 9));
  });

  it('strips _ and creates fontStyle annotation', () => {
    const { content, annotations } = markdownToWave('Say _hello_ now');
    expect(content).toBe('Say hello now');
    expect(annotations).toContainEqual(ann('style/fontStyle', 'italic', 4, 9));
  });
});

// ── bold italic ───────────────────────────────────────────────

describe('markdownToWave — bold italic', () => {
  it('strips *** and creates both annotations', () => {
    const { content, annotations } = markdownToWave('***important***');
    expect(content).toBe('important');
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 0, 9));
    expect(annotations).toContainEqual(ann('style/fontStyle', 'italic', 0, 9));
  });
});

// ── links ─────────────────────────────────────────────────────

describe('markdownToWave — links', () => {
  it('strips [text](url) and creates link/manual annotation', () => {
    const { content, annotations } = markdownToWave('Visit [CoinGecko](https://coingecko.com) today');
    expect(content).toBe('Visit CoinGecko today');
    expect(annotations).toContainEqual(
      ann('link/manual', 'https://coingecko.com', 6, 15),
    );
  });

  it('handles link at start of string', () => {
    const { content, annotations } = markdownToWave('[Click here](https://example.com)');
    expect(content).toBe('Click here');
    expect(annotations).toContainEqual(ann('link/manual', 'https://example.com', 0, 10));
  });

  it('handles multiple links', () => {
    const { content, annotations } = markdownToWave('[A](https://a.com) and [B](https://b.com)');
    expect(content).toBe('A and B');
    expect(annotations).toContainEqual(ann('link/manual', 'https://a.com', 0, 1));
    expect(annotations).toContainEqual(ann('link/manual', 'https://b.com', 6, 7));
  });

  it('does not add fontWeight for linked text by default', () => {
    const { annotations } = markdownToWave('[text](https://example.com)');
    const boldAnns = annotations.filter((a) => a.name === 'style/fontWeight');
    expect(boldAnns).toHaveLength(0);
  });
});

// ── code ─────────────────────────────────────────────────────

describe('markdownToWave — inline code', () => {
  it('strips backticks and adds no annotation', () => {
    const { content, annotations } = markdownToWave('Use `npm install` to install');
    expect(content).toBe('Use npm install to install');
    expect(annotations).toHaveLength(0);
  });
});

// ── headers ──────────────────────────────────────────────────

describe('markdownToWave — headers', () => {
  it('strips # and creates fontWeight bold for h1', () => {
    const { content, annotations } = markdownToWave('# Summary');
    expect(content).toBe('Summary');
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 0, 7));
  });

  it('strips ## for h2', () => {
    const { content, annotations } = markdownToWave('## Subtitle');
    expect(content).toBe('Subtitle');
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 0, 8));
  });

  it('handles header with inline bold (no duplicate)', () => {
    // Header adds bold for whole line; inline **bold** inside adds span-level too.
    // Both annotations are present (Wave merges overlapping same-type annotations).
    const { content, annotations } = markdownToWave('# **Hello** world');
    expect(content).toBe('Hello world');
    // Span-level bold for "Hello"
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 0, 5));
    // Header-level bold for "Hello world"
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 0, 11));
  });
});

// ── bullet lists ──────────────────────────────────────────────

describe('markdownToWave — bullet lists', () => {
  it('converts - item to • item', () => {
    const { content } = markdownToWave('- First item');
    expect(content).toBe('• First item');
  });

  it('converts + item to • item', () => {
    const { content } = markdownToWave('+ Second item');
    expect(content).toBe('• Second item');
  });

  it('handles multi-line list', () => {
    const { content } = markdownToWave('- A\n- B\n- C');
    expect(content).toBe('• A\n• B\n• C');
  });

  it('handles bold in list item', () => {
    const { content, annotations } = markdownToWave('- **Important** note');
    // prefix "• " = 2 chars, "Important" starts at 2
    expect(content).toBe('• Important note');
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 2, 11));
  });
});

// ── multi-line / mixed ────────────────────────────────────────

describe('markdownToWave — multi-line', () => {
  it('handles a typical bot response with multiple elements', () => {
    const input = [
      '**Summary:** Bitcoin is up 5%.',
      '',
      'Key points:',
      '- Price: **$65,000**',
      '- Source: [CoinGecko](https://coingecko.com)',
    ].join('\n');

    const { content, annotations } = markdownToWave(input);

    expect(content).toBe(
      'Summary: Bitcoin is up 5%.\n\nKey points:\n• Price: $65,000\n• Source: CoinGecko',
    );

    // "Summary:" bold
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 0, 8));
    // "$65,000" bold — after "• Price: " (9 chars) on the 4th line
    // line 1 = "Summary: Bitcoin is up 5%." (26) + \n(1) + \n(1) + "Key points:" (11) + \n(1) + "• Price: "(9) = 49
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 49, 56));
    // "CoinGecko" link
    const linkAnn = annotations.find((a) => a.name === 'link/manual');
    expect(linkAnn?.value).toBe('https://coingecko.com');
  });

  it('handles annotations across multiple lines correctly', () => {
    const { content, annotations } = markdownToWave('**a**\n**b**');
    expect(content).toBe('a\nb');
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 0, 1));
    expect(annotations).toContainEqual(ann('style/fontWeight', 'bold', 2, 3));
  });
});
