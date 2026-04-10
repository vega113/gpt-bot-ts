import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { ReplyMode } from './reply-preferences.js';

export interface FastPassInput {
  userMessage: string;
  author: string;
  parentContext?: string;
  isExplicitMention: boolean;
  participantCount: number;
  replyMode: ReplyMode;
}

export const FastPassDecisionSchema = z.object({
  action: z.enum(['ignore', 'clarify', 'quick_answer', 'ack_and_work']),
  message: z.string().nullable(),
  etaBucket: z.enum(['seconds', 'tens_of_seconds', 'under_minute']).nullable(),
  quickAnswerSafe: z.boolean(),
  reason: z.string(),
});

export type FastPassDecision = z.infer<typeof FastPassDecisionSchema>;

export interface FastPassClient<TInput = FastPassInput> {
  decide(input: TInput): Promise<FastPassDecision>;
}

const HIGH_RISK_RE = /\b(medical|doctor|diagnos|symptom|medicine|lawyer|legal|contract|sue|tax|invest|stock|financial|loan|mortgage)\b/i;
const FRESH_FACTS_RE = /\b(today|latest|current|right now|news|price|market|weather|who won|score)\b/i;
const QUICK_ANSWER_MAX_CHARS = parseInt(process.env['FAST_PASS_MAX_QUICK_ANSWER_CHARS'] ?? '280', 10);

export const FAST_PASS_SYSTEM_PROMPT = [
  'You are a fast first-pass router for a Wave robot.',
  'Return structured output only.',
  'Choose exactly one action: ignore, clarify, quick_answer, ack_and_work.',
  'Use quick_answer only for short, safe, tool-free replies.',
  'Use clarify for ambiguous or underspecified requests.',
  'Use ack_and_work for anything needing tools, deeper reasoning, multiple steps, or image generation.',
  'Set quickAnswerSafe=false if there is any safety or freshness doubt.',
  'If action is ack_and_work and message is null, the caller will supply a default acknowledgment.',
].join(' ');

export function buildAckMessage(bucket: FastPassDecision['etaBucket']): string {
  switch (bucket) {
    case 'tens_of_seconds':
      return 'Working on this. This may take around 10-20 seconds.';
    case 'under_minute':
      return 'Working on this. This could take up to about a minute.';
    case 'seconds':
      return 'Working on this. Should take a few seconds.';
    default:
      return 'Working on this.';
  }
}

export function shouldForceAckAndWork(
  decision: FastPassDecision,
  userMessage: string,
  maxChars = QUICK_ANSWER_MAX_CHARS,
): boolean {
  if (decision.action !== 'quick_answer') return false;
  if (!decision.quickAnswerSafe) return true;
  if (!decision.message?.trim()) return true;
  if (decision.message.length > maxChars) return true;
  if (HIGH_RISK_RE.test(userMessage)) return true;
  if (FRESH_FACTS_RE.test(userMessage)) return true;
  return false;
}

export function normalizeFastPassDecision(
  decision: FastPassDecision,
  userMessage: string,
): FastPassDecision {
  if ((decision.action === 'clarify' || decision.action === 'quick_answer') && !decision.message) {
    return {
      action: 'ack_and_work',
      message: buildAckMessage(decision.etaBucket ?? 'seconds'),
      etaBucket: decision.etaBucket ?? 'seconds',
      quickAnswerSafe: false,
      reason: `${decision.reason}:missing_message`,
    };
  }

  if (shouldForceAckAndWork(decision, userMessage)) {
    return {
      action: 'ack_and_work',
      message: buildAckMessage(decision.etaBucket ?? 'seconds'),
      etaBucket: decision.etaBucket ?? 'seconds',
      quickAnswerSafe: false,
      reason: `${decision.reason}:forced_ack`,
    };
  }

  if (decision.action === 'ack_and_work' && !decision.message) {
    return {
      ...decision,
      message: buildAckMessage(decision.etaBucket),
      etaBucket: decision.etaBucket,
    };
  }

  return decision;
}

export async function decideWithTimeout<TInput>(
  client: FastPassClient<TInput>,
  input: TInput,
  timeoutMs = parseInt(process.env['FAST_PASS_TIMEOUT_MS'] ?? '2500', 10),
): Promise<FastPassDecision | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), timeoutMs);
    });

    return await Promise.race([
      client.decide(input).then((decision) => {
        if (timeoutId) clearTimeout(timeoutId);
        return decision;
      }),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export class OpenAIFastPassClient implements FastPassClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(client = new OpenAI(), model = process.env['FAST_PASS_MODEL'] ?? 'gpt-5.4-mini') {
    this.client = client;
    this.model = model;
  }

  async decide(input: FastPassInput): Promise<FastPassDecision> {
    const completion = await this.client.chat.completions.parse({
      model: this.model,
      temperature: 0,
      messages: [
        { role: 'system', content: FAST_PASS_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(input) },
      ],
      response_format: zodResponseFormat(FastPassDecisionSchema, 'fast_pass_decision'),
    });

    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) {
      throw new Error('Fast pass returned no parsed decision');
    }

    return normalizeFastPassDecision(parsed, input.userMessage);
  }
}
