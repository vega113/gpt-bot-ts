/**
 * Serialize asynchronous jobs that share the same wave-scoped session.
 *
 * The bot keeps one OpenAI session per wave, so processing multiple blips from
 * the same wave concurrently can reorder history and produce stale replies.
 * Queueing by waveId preserves session ordering while allowing different waves
 * to run independently.
 */

const waveJobTails = new Map<string, Promise<void>>();

export function enqueueWaveJob<T>(waveId: string, job: () => Promise<T>): Promise<T> {
  const previous = waveJobTails.get(waveId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(job);
  const tail = run.then(() => undefined, () => undefined);

  waveJobTails.set(waveId, tail);

  return run.finally(() => {
    if (waveJobTails.get(waveId) === tail) {
      waveJobTails.delete(waveId);
    }
  });
}
