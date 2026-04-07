/**
 * JWT token expiry utilities.
 *
 * These are extracted into their own module so they can be imported by tests
 * without triggering the side-effects in index.ts (env-var validation,
 * process.exit, server start).
 */

/**
 * Decode a JWT payload (no signature verification) and return `exp` as a Date,
 * or null if the token is malformed or missing an `exp` claim.
 */
export function decodeTokenExpiry(token: string): Date | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    if (typeof payload['exp'] !== 'number') return null;
    return new Date(payload['exp'] * 1000);
  } catch {
    return null;
  }
}

/**
 * Check the SUPAWAVE_TOKEN expiry on startup.
 *
 * - Expired + no secret  → logs a clear error and exits with code 1.
 * - Expired + has secret → logs a warning (refresh will be attempted at first use).
 * - Expires within 7 days → logs a warning.
 * - Valid                → logs an info message.
 * - Malformed            → logs a warning and continues.
 */
export function checkTokenExpiry(token: string, hasSecret: boolean): void {
  const expiry = decodeTokenExpiry(token);
  if (!expiry) {
    console.warn('[token] Could not decode SUPAWAVE_TOKEN expiry — skipping check');
    return;
  }

  const now = Date.now();
  const msUntilExpiry = expiry.getTime() - now;
  const hoursUntilExpiry = msUntilExpiry / (1000 * 60 * 60);
  const daysUntilExpiry = hoursUntilExpiry / 24;

  if (msUntilExpiry <= 0) {
    if (hasSecret) {
      console.warn(
        `[token] SUPAWAVE_TOKEN expired at ${expiry.toISOString()}. ` +
          'SUPAWAVE_SECRET is set — a new token will be fetched automatically on first API call.',
      );
    } else {
      console.error(
        `[token] SUPAWAVE_TOKEN expired at ${expiry.toISOString()}. ` +
          'The bot will not be able to communicate with the Wave Data API.\n' +
          'To fix: obtain a new token from the Wave server and update SUPAWAVE_TOKEN in .env,\n' +
          'or set SUPAWAVE_SECRET to enable automatic token refresh.',
      );
      process.exit(1);
    }
  } else if (daysUntilExpiry <= 7) {
    console.warn(
      `[token] SUPAWAVE_TOKEN expires in ${hoursUntilExpiry.toFixed(1)}h ` +
        `(at ${expiry.toISOString()}). ` +
        (hasSecret
          ? 'It will be refreshed automatically when it expires.'
          : 'Consider renewing it or setting SUPAWAVE_SECRET for auto-refresh.'),
    );
  } else {
    console.log(`[token] SUPAWAVE_TOKEN valid until ${expiry.toISOString()}`);
  }
}
