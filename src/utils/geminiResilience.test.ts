import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiQueueError,
  GeminiRequestQueue,
  ModelHealthTracker,
  ShortTtlCache,
  computeExponentialBackoffMs,
  executeGeminiWithResilience,
  extractRetryAfterMs,
} from './geminiResilience.ts';

test('computeExponentialBackoffMs applies exponential scaling, jitter bounds, max cap, and Retry-After', () => {
  // randomFn = 0.5 -> jitterFactor = 0.75 + 0.25 = 1.0
  assert.equal(
    computeExponentialBackoffMs({
      attempt: 0,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      randomFn: () => 0.5,
    }),
    500
  );
  assert.equal(
    computeExponentialBackoffMs({
      attempt: 2,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      randomFn: () => 0.5,
    }),
    2000
  );

  // Jitter lower bound (randomFn = 0 -> 0.75x) and upper bound (randomFn = 1 -> 1.25x)
  assert.equal(
    computeExponentialBackoffMs({
      attempt: 1,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      randomFn: () => 0,
    }),
    750
  );
  assert.equal(
    computeExponentialBackoffMs({
      attempt: 1,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      randomFn: () => 1,
    }),
    1250
  );

  // Respects Retry-After hint up to maxDelayMs
  assert.equal(
    computeExponentialBackoffMs({
      attempt: 0,
      baseDelayMs: 500,
      maxDelayMs: 5000,
      retryAfterMs: 3200,
      randomFn: () => 0.5,
    }),
    3200
  );
  assert.equal(
    computeExponentialBackoffMs({
      attempt: 5,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      retryAfterMs: 9000,
      randomFn: () => 1,
    }),
    4000
  );
});

test('extractRetryAfterMs parses HTTP Retry-After header and Gemini retryDelay JSON hints', () => {
  assert.equal(
    extractRetryAfterMs({ headers: { 'Retry-After': '4' }, message: '503 Unavailable' }),
    4000
  );
  assert.equal(
    extractRetryAfterMs(
      new Error('{"error":{"code":503,"details":[{"retryDelay":"2.5s"}]}}')
    ),
    2500
  );
  assert.equal(extractRetryAfterMs(new Error('Please retry in 3.2s.')), 3200);
  assert.equal(extractRetryAfterMs(new Error('Generic error without hint')), null);
});

test('ModelHealthTracker escalates cooldown progressively and recovers immediately on success', () => {
  let currentTime = 1_000_000;
  const tracker = new ModelHealthTracker({
    baseCooldownMs: 10_000,
    maxCooldownMs: 60_000,
    nowFn: () => currentTime,
  });

  const chain = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
  assert.deepEqual(tracker.getOrderedModels(chain), chain);

  // First 503 failure on primary model -> 10s cooldown
  const firstCooldown = tracker.recordTransientFailure('gemini-3.8-flash');
  assert.equal(firstCooldown, 10_000);
  assert.deepEqual(tracker.getOrderedModels(chain), [
    'gemini-flash-latest',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash',
  ]);

  // Second consecutive failure -> 20s cooldown
  const secondCooldown = tracker.recordTransientFailure('gemini-3.8-flash');
  assert.equal(secondCooldown, 20_000);

  // Advance clock past 20s -> healthy again
  currentTime += 21_000;
  assert.deepEqual(tracker.getOrderedModels(chain), chain);

  // Record failure then immediate success -> resets cooldown
  tracker.recordTransientFailure('gemini-flash-latest');
  tracker.recordSuccess('gemini-flash-latest');
  assert.deepEqual(tracker.getOrderedModels(chain), chain);
});

test('executeGeminiWithResilience retries 503 with exponential backoff and falls back across models', async () => {
  const recordedDelays: number[] = [];
  const callLog: string[] = [];
  const tracker = new ModelHealthTracker();

  let primaryCalls = 0;
  const { result, usedModel, attempts } = await executeGeminiWithResilience(
    ['gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    async (modelName, attempt) => {
      callLog.push(`${modelName}#${attempt}`);
      if (modelName === 'gemini-3.8-flash') {
        primaryCalls++;
        if (primaryCalls < 3) {
          const err = Object.assign(
            new Error(
              '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'
            ),
            { status: 503 }
          );
          throw err;
        }
      }
      return 'Berhasil setelah backoff';
    },
    {
      maxRetriesPerModel: 2,
      fallbackRetriesPerModel: 1,
      baseDelayMs: 400,
      maxDelayMs: 3000,
      healthTracker: tracker,
      randomFn: () => 0.5,
      sleepFn: async (ms) => {
        recordedDelays.push(ms);
      },
    }
  );

  assert.equal(result, 'Berhasil setelah backoff');
  assert.equal(usedModel, 'gemini-3.8-flash');
  assert.equal(attempts, 3);
  assert.deepEqual(callLog, [
    'gemini-3.8-flash#0',
    'gemini-3.8-flash#1',
    'gemini-3.8-flash#2',
  ]);
  assert.deepEqual(recordedDelays, [400, 800]);

  // When primary exhausts all retries on 503, falls back to secondary and retries secondary too if needed
  const fallbackCallLog: string[] = [];
  const fallbackResult = await executeGeminiWithResilience(
    ['gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    async (modelName, attempt) => {
      fallbackCallLog.push(`${modelName}#${attempt}`);
      if (modelName === 'gemini-3.8-flash' || attempt === 0) {
        throw Object.assign(new Error('503 Service Unavailable'), { status: 503 });
      }
      return 'Pulih di model cadangan';
    },
    {
      maxRetriesPerModel: 1,
      fallbackRetriesPerModel: 1,
      baseDelayMs: 300,
      randomFn: () => 0.5,
      sleepFn: async () => {},
    }
  );

  assert.equal(fallbackResult.result, 'Pulih di model cadangan');
  assert.equal(fallbackResult.usedModel, 'gemini-3.1-flash-lite');
  assert.deepEqual(fallbackCallLog, [
    'gemini-3.8-flash#0',
    'gemini-3.8-flash#1',
    'gemini-3.1-flash-lite#0',
    'gemini-3.1-flash-lite#1',
  ]);

  // Non-retryable 403 error fails fast without wasting retries or fallback calls
  let authAttempts = 0;
  await assert.rejects(
    async () => {
      await executeGeminiWithResilience(
        ['gemini-3.8-flash', 'gemini-3.1-flash-lite'],
        async () => {
          authAttempts++;
          throw Object.assign(new Error('PERMISSION_DENIED: API_KEY_INVALID'), { status: 403 });
        },
        {
          maxRetriesPerModel: 2,
          sleepFn: async () => {},
        }
      );
    },
    /API_KEY_INVALID/
  );
  assert.equal(authAttempts, 1);
});

test('GeminiRequestQueue enforces max concurrency, prioritizes high over normal, and handles overflow/abort', async () => {
  const queue = new GeminiRequestQueue({
    maxConcurrent: 1,
    maxQueueSize: 2,
    queueTimeoutMs: 500,
    minIntervalMs: 0,
  });

  const executionOrder: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  // 1st task occupies the single active concurrency slot
  const p1 = queue.enqueue(
    async () => {
      executionOrder.push('first-active');
      await firstGate;
      return 'done-1';
    },
    { label: 'first', priority: 'normal' }
  );

  // Enqueue a normal-priority TTS task, then a high-priority Chat task -> Chat must run before TTS!
  const pNormal = queue.enqueue(
    async () => {
      executionOrder.push('tts-normal');
      return 'done-normal';
    },
    { label: 'tts', priority: 'normal' }
  );

  const pHigh = queue.enqueue(
    async () => {
      executionOrder.push('chat-high');
      return 'done-high';
    },
    { label: 'chat', priority: 'high' }
  );

  // Queue now has 2 waiting items (at maxQueueSize = 2); 4th waiting task must reject with 503 QUEUE_FULL
  await assert.rejects(
    async () => {
      await queue.enqueue(async () => 'overflow');
    },
    (err: unknown) =>
      err instanceof GeminiQueueError &&
      err.code === 'QUEUE_FULL' &&
      err.httpStatus === 503
  );

  releaseFirst();
  const results = await Promise.all([p1, pHigh, pNormal]);
  assert.deepEqual(results, ['done-1', 'done-high', 'done-normal']);
  assert.deepEqual(executionOrder, ['first-active', 'chat-high', 'tts-normal']);

  // Test pre-execution client disconnect abort while waiting in queue
  let releaseBlocker!: () => void;
  const blockerGate = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const blocker = queue.enqueue(async () => {
    await blockerGate;
    return 'blocker';
  });

  const abortCtrl = new AbortController();
  let abortedTaskRan = false;
  const abortedPromise = queue.enqueue(
    async () => {
      abortedTaskRan = true;
      return 'should-not-run';
    },
    { signal: abortCtrl.signal }
  );

  abortCtrl.abort();
  await assert.rejects(
    abortedPromise,
    (err: unknown) => err instanceof GeminiQueueError && err.code === 'REQUEST_ABORTED'
  );
  releaseBlocker();
  await blocker;
  assert.equal(abortedTaskRan, false);
});

test('executeGeminiWithResilience handles 429 quota exhaustion by skipping same-model retries, cooling down exhausted models, and falling back cleanly', async () => {
  let now = 5_000_000;
  const tracker = new ModelHealthTracker({
    baseCooldownMs: 25_000,
    maxCooldownMs: 180_000,
    nowFn: () => now,
  });

  const callSequence: string[] = [];
  const sleepDelays: number[] = [];

  const res = await executeGeminiWithResilience(
    ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'],
    async (modelName, attempt) => {
      callSequence.push(`${modelName}#${attempt}`);
      if (modelName !== 'gemini-3.1-flash-lite') {
        throw Object.assign(
          new Error(
            '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"2s"}]}}'
          ),
          { status: 429 }
        );
      }
      return 'Berhasil di model flash-lite hemat kuota';
    },
    {
      maxRetriesPerModel: 2,
      fallbackRetriesPerModel: 1,
      healthTracker: tracker,
      randomFn: () => 0.5,
      sleepFn: async (ms) => {
        sleepDelays.push(ms);
      },
    }
  );

  assert.equal(res.result, 'Berhasil di model flash-lite hemat kuota');
  assert.equal(res.usedModel, 'gemini-3.1-flash-lite');
  // Hard quota 429 does 0 retries on the exhausted model, switching directly across the chain
  assert.deepEqual(callSequence, [
    'gemini-3.8-flash#0',
    'gemini-flash-latest#0',
    'gemini-3.1-flash-lite#0',
  ]);
  // Switch delays honor the 2000ms retryDelay hint instead of rushing in 250ms
  assert.deepEqual(sleepDelays, [2000, 2000]);

  // Next request within 90s immediately prioritizes healthy gemini-3.1-flash-lite first!
  now += 30_000;
  assert.equal(
    tracker.getOrderedModels([
      'gemini-3.8-flash',
      'gemini-flash-latest',
      'gemini-3.1-flash-lite',
    ])[0],
    'gemini-3.1-flash-lite'
  );
});

test('ShortTtlCache caches values within TTL and deduplicates concurrent in-flight requests', async () => {
  let clock = 10_000;
  const cache = new ShortTtlCache<string>({
    maxEntries: 4,
    defaultTtlMs: 5_000,
    nowFn: () => clock,
  });

  let computeCount = 0;
  const [r1, r2] = await Promise.all([
    cache.getOrCompute('tts:halo', async () => {
      computeCount++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'WAV_DATA_1';
    }),
    cache.getOrCompute('tts:halo', async () => {
      computeCount++;
      return 'WAV_DATA_2';
    }),
  ]);

  assert.equal(r1, 'WAV_DATA_1');
  assert.equal(r2, 'WAV_DATA_1');
  assert.equal(computeCount, 1);

  // Cached hit before TTL expires
  clock += 3_000;
  assert.equal(cache.get('tts:halo'), 'WAV_DATA_1');

  // Expired after TTL
  clock += 3_000;
  assert.equal(cache.get('tts:halo'), undefined);
});
