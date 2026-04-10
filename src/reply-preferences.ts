export type ReplyMode = 'normal' | 'only_when_mentioned';

export interface ReplyPreferenceState {
  mode: ReplyMode;
  updatedBy?: string;
  updatedAt?: number;
}

export interface ReplyPreferenceUpdateInput {
  isExplicitMention: boolean;
  author?: string;
  now?: number;
}

const QUIET_ANYWHERE_PATTERNS = [
  /\bonly reply when mentioned\b/i,
  /\bdon'?t reply unless (?:i )?mention you\b/i,
  /\bdon'?t answer unless (?:i )?mention you\b/i,
  /\bonly respond when mentioned\b/i,
];

const QUIET_DIRECTED_PATTERNS = [
  /\bstop responding\b/i,
  /\bstop replying\b/i,
  /\bbe quiet\b/i,
  /\bshut up\b/i,
  /\bdon'?t reply\b/i,
  /\bdon'?t respond\b/i,
  /\bdo not reply\b/i,
  /\bdo not respond\b/i,
];

const RESUME_PATTERNS = [
  /\byou can reply normally again\b/i,
  /\byou can respond again\b/i,
  /\breply normally again\b/i,
  /\brespond normally again\b/i,
  /\bokay[, ]+you can answer now\b/i,
  /\byou may answer now\b/i,
];

export function detectReplyPreferenceUpdate(
  text: string,
  { isExplicitMention, author, now = Date.now() }: ReplyPreferenceUpdateInput,
): ReplyPreferenceState | null {
  const normalized = text.trim();
  if (!normalized) return null;

  const isDirected =
    isExplicitMention ||
    /^(?:\s*(?:you|bot)\b(?:[,!:]\s*|\s+))(?:please\s+)?(?:stop\s+responding|stop\s+replying|be\s+quiet|shut\s+up|don't\s+reply|don't\s+respond|do\s+not\s+reply|do\s+not\s+respond)\b/i.test(
      normalized,
    );

  if (isDirected && RESUME_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { mode: 'normal', updatedBy: author, updatedAt: now };
  }

  const isQuietCommand =
    QUIET_ANYWHERE_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    (isDirected && QUIET_DIRECTED_PATTERNS.some((pattern) => pattern.test(normalized)));

  if (isQuietCommand) {
    return { mode: 'only_when_mentioned', updatedBy: author, updatedAt: now };
  }

  return null;
}

export function shouldSuppressReply(
  state: ReplyPreferenceState | undefined,
  isExplicitMention: boolean,
): boolean {
  return state?.mode === 'only_when_mentioned' && !isExplicitMention;
}
