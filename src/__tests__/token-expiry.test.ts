/**
 * Tests for JWT token expiry utilities exported from index.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeTokenExpiry, checkTokenExpiry } from '../token-utils.js';

// ── helpers ──────────────────────────────────────────────────

/**
 * Build a minimal JWT with the given `exp` (unix seconds).
 * Signature is bogus — these utilities only inspect the payload.
 */
function buildJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'gpt-ts-bot@supawave.ai',
      iat: exp - 3600,
      exp,
    }),
  ).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

// ── decodeTokenExpiry ────────────────────────────────────────

describe('decodeTokenExpiry', () => {
  it('returns a Date matching the exp field', () => {
    const expUnix = Math.floor(Date.now() / 1000) + 3600;
    const jwt = buildJwt(expUnix);
    const result = decodeTokenExpiry(jwt);
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(expUnix * 1000);
  });

  it('returns null for a token with fewer than 3 segments', () => {
    expect(decodeTokenExpiry('header.payload')).toBeNull();
  });

  it('returns null for a token with non-base64 payload', () => {
    expect(decodeTokenExpiry('header.!!!.sig')).toBeNull();
  });

  it('returns null when exp is missing from payload', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'bot' })).toString('base64url');
    expect(decodeTokenExpiry(`${header}.${payload}.sig`)).toBeNull();
  });

  it('returns null when exp is not a number', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: 'not-a-number' })).toString('base64url');
    expect(decodeTokenExpiry(`${header}.${payload}.sig`)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(decodeTokenExpiry('')).toBeNull();
  });
});

// ── checkTokenExpiry ─────────────────────────────────────────

describe('checkTokenExpiry', () => {
  const realProcessExit = process.exit.bind(process);

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with code 1 when token is expired and no secret', () => {
    const expiredUnix = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    const jwt = buildJwt(expiredUnix);
    checkTokenExpiry(jwt, false);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('warns but does NOT exit when token is expired but secret is available', () => {
    const expiredUnix = Math.floor(Date.now() / 1000) - 3600;
    const jwt = buildJwt(expiredUnix);
    checkTokenExpiry(jwt, true);
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });

  it('warns when token expires within 7 days (no secret)', () => {
    const soonUnix = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3; // 3 days
    const jwt = buildJwt(soonUnix);
    checkTokenExpiry(jwt, false);
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('expires in'));
  });

  it('warns when token expires within 7 days and mentions auto-refresh when secret set', () => {
    const soonUnix = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3; // 3 days
    const jwt = buildJwt(soonUnix);
    checkTokenExpiry(jwt, true);
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('refreshed automatically'));
  });

  it('logs a normal message when token is valid beyond 7 days', () => {
    const farFutureUnix = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
    const jwt = buildJwt(farFutureUnix);
    checkTokenExpiry(jwt, false);
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('valid until'));
  });

  it('warns (does not crash) when token is malformed', () => {
    checkTokenExpiry('not-a-jwt', false);
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not decode'));
  });

  void realProcessExit; // keep reference to avoid lint warning
});
