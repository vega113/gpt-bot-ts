import { describe, expect, it } from 'vitest';
import { enqueueWaveJob } from '../wave-job-queue.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('enqueueWaveJob', () => {
  it('serializes jobs for the same wave in enqueue order', async () => {
    const events: string[] = [];
    const firstJob = createDeferred<void>();
    const firstJobStarted = createDeferred<void>();

    const slowFirst = enqueueWaveJob('wave-1', async () => {
      events.push('slow-start');
      firstJobStarted.resolve();
      await firstJob.promise;
      events.push('slow-end');
      return 'slow';
    });

    const fastSecond = enqueueWaveJob('wave-1', async () => {
      events.push('fast-start');
      events.push('fast-end');
      return 'fast';
    });

    await firstJobStarted.promise;
    expect(events).toEqual(['slow-start']);

    firstJob.resolve();
    await expect(Promise.all([slowFirst, fastSecond])).resolves.toEqual(['slow', 'fast']);
    expect(events).toEqual(['slow-start', 'slow-end', 'fast-start', 'fast-end']);
  });

  it('allows different waves to run in parallel', async () => {
    const events: string[] = [];
    const waveOneGate = createDeferred<void>();
    const waveOneStarted = createDeferred<void>();
    const waveTwoStarted = createDeferred<void>();

    const waveOne = enqueueWaveJob('wave-1', async () => {
      events.push('wave-1-start');
      waveOneStarted.resolve();
      await waveOneGate.promise;
      events.push('wave-1-end');
    });

    const waveTwo = enqueueWaveJob('wave-2', async () => {
      events.push('wave-2-start');
      waveTwoStarted.resolve();
      events.push('wave-2-end');
    });

    await waveOneStarted.promise;
    await waveTwoStarted.promise;
    expect(events).toEqual(['wave-1-start', 'wave-2-start', 'wave-2-end']);

    waveOneGate.resolve();
    await Promise.all([waveOne, waveTwo]);
    expect(events).toEqual(['wave-1-start', 'wave-2-start', 'wave-2-end', 'wave-1-end']);
  });
});
