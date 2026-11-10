import { isStrictInference, isVerifiedUpstream429, type InferenceEvent } from './inference.js';

/**
 * Experimental, opt-in adapter for the ledger coordinator's start callback.
 * The supplied inference must use the same abort signal and return the real
 * parser's event stream. Never emit the final client success/error from this
 * callback: await the coordinator's durable completion first. A rejected or
 * unclassified operation leaves its OPEN fenced. No production route uses it.
 */
export async function settleInferenceStream(
  inference: () => Promise<AsyncIterable<InferenceEvent>>,
  onEvent: (event: InferenceEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<{outcome:'SUCCESS'; terminal:InferenceEvent} | {outcome:'UNKNOWN_429'}> {
  signal?.throwIfAborted();
  if (!isStrictInference(inference)) throw new Error('Strict inference capability required');
  let iterator: AsyncIterator<InferenceEvent> | undefined;
  let exhausted = false;
  let terminal: InferenceEvent | undefined;
  try {
    let events: AsyncIterable<InferenceEvent>;
    try { events = await inference(); }
    catch (error) {
      signal?.throwIfAborted();
      if (isVerifiedUpstream429(error, inference)) return {outcome:'UNKNOWN_429'};
      throw error;
    }
    iterator = events[Symbol.asyncIterator]();
    while (true) {
      signal?.throwIfAborted();
      let step: IteratorResult<InferenceEvent>;
      try { step = await iterator.next(); }
      catch (error) {
        signal?.throwIfAborted();
        if (isVerifiedUpstream429(error, inference)) return {outcome:'UNKNOWN_429'};
        throw error;
      }
      signal?.throwIfAborted();
      if (step.done) { exhausted = true; if (!terminal) throw new Error('Missing verified upstream terminal'); return {outcome:'SUCCESS', terminal}; }
      if (step.value.finish) { if (terminal) throw new Error('Duplicate upstream terminal'); terminal = step.value; }
      else { if (terminal) throw new Error('Output after upstream terminal'); await onEvent(step.value); }
    }
  } finally {
    if (iterator && !exhausted) await iterator.return?.();
  }
}
