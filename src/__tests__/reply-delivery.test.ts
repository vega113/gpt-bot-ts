import { describe, expect, it, vi } from 'vitest';
import { createReplyDelivery, type ReplyDeliveryTarget } from '../reply-delivery.js';

function makeWaveClient() {
  return {
    replyToBlip: vi.fn().mockResolvedValue('b+reply'),
    continueThread: vi.fn().mockResolvedValue('b+reply'),
    deleteBlip: vi.fn().mockResolvedValue(undefined),
  };
}

const target: ReplyDeliveryTarget = {
  waveId: 'wave-1',
  waveletId: 'wave-1!conv+root',
  parentBlipId: 'b+parent',
  isInThread: false,
};

describe('createReplyDelivery', () => {
  it('posts the final reply before deleting the placeholder', async () => {
    const waveClient = makeWaveClient();
    const delivery = createReplyDelivery(waveClient as never, target);

    await delivery.completePlaceholder(
      { blipId: 'b+placeholder', content: 'Working on this.' },
      'Final answer',
    );

    expect(waveClient.replyToBlip).toHaveBeenCalledOnce();
    expect(waveClient.deleteBlip).toHaveBeenCalledOnce();
    expect(waveClient.replyToBlip.mock.invocationCallOrder[0]).toBeLessThan(
      waveClient.deleteBlip.mock.invocationCallOrder[0],
    );
  });

  it('posts the error reply before deleting the placeholder', async () => {
    const waveClient = makeWaveClient();
    const delivery = createReplyDelivery(waveClient as never, target);

    await delivery.failPlaceholder(
      { blipId: 'b+placeholder', content: 'Working on this.' },
      'Sorry, I ran into a problem while working on this. Please try again.',
    );

    expect(waveClient.replyToBlip).toHaveBeenCalledOnce();
    expect(waveClient.deleteBlip).toHaveBeenCalledOnce();
    expect(waveClient.replyToBlip.mock.invocationCallOrder[0]).toBeLessThan(
      waveClient.deleteBlip.mock.invocationCallOrder[0],
    );
  });
});
