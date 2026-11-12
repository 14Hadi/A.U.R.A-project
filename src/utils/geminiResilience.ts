import { classifyGeminiError } from './auraContext.ts';

export type QueuePriority = 'high' | 'normal';

export interface GeminiQueueOptions {
  maxConcurrent?: number;
  maxQueueSize?: number;
  queueTimeoutMs?: number;
  minIntervalMs?: number;
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface EnqueueTaskOptions {
  label?: string;
  priority?: QueuePriority;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GeminiQueueSnapshot {
  activeCount: number;
  queuedCount: number;
  maxConcurrent: number;
  maxQueueSize: number;
  totalProcessed: number;
  totalTimedOutOrRejected: number;
}

export class GeminiQueueError extends Error {
  readonly httpStatus: 503 | 499;
  readonly code: 'QUEUE_FULL' | 'QUEUE_TIMEOUT' | 'REQUEST_ABORTED';
  readonly retryAfterSeconds: number;

  constructor(params: {
    message: string;
    httpStatus: 503 | 499;
    code: 'QUEUE_FULL' | 'QUEUE_TIMEOUT' | 'REQUEST_ABORTED';
    retryAfterSeconds?: number;
  }) {
    super(params.message);
    this.name = 'GeminiQueueError';
    this.httpStatus = params.httpStatus;
    this.code = params.code;
    this.retryAfterSeconds = params.retryAfterSeconds ?? 5;
  }
}

interface QueuedEntry<T> {
  id: number;
  label: string;
  priority: QueuePriority;
  enqueuedAt: number;
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  cleanup: () => void;
  cancelled: boolean;
}

/**
 * Antrean permintaan asinkron sisi server dengan batas konkurensi, prioritas interaktif,
 * jeda antar-permintaan (pacing), batas antrean maksimum, dan pembatalan otomatis saat klien terputus.
 */
export class GeminiRequestQueue {
  private readonly maxConcurrent: number;
  private readonly maxQueueSize: number;
  private readonly queueTimeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  private activeCount = 0;
  private nextTaskId = 1;
  private lastDispatchAt = 0;
  private dispatchTimerScheduled = false;
  private totalProcessed = 0;
  private totalTimedOutOrRejected = 0;
  private readonly waitingQueue: Array<QueuedEntry<unknown>> = [];

  constructor(options?: GeminiQueueOptions) {
    this.maxConcurrent = Math.max(1, options?.maxConcurrent ?? 2);
    this.maxQueueSize = Math.max(1, options?.maxQueueSize ?? 24);
    this.queueTimeoutMs = Math.max(50, options?.queueTimeoutMs ?? 30_000);
    this.minIntervalMs = Math.max(0, options?.minIntervalMs ?? 120);
    this.nowFn = options?.nowFn ?? (() => Date.now());
    this.sleepFn =
      options?.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  getSnapshot(): GeminiQueueSnapshot {
    return {
      activeCount: this.activeCount,
      queuedCount: this.waitingQueue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize,
      totalProcessed: this.totalProcessed,
      totalTimedOutOrRejected: this.totalTimedOutOrRejected,
    };
  }

  enqueue<T>(task: () => Promise<T>, options?: EnqueueTaskOptions): Promise<T> {
    if (options?.signal?.aborted) {
      this.totalTimedOutOrRejected++;
      return Promise.reject(
        new GeminiQueueError({
          message: 'Permintaan dibatalkan karena koneksi klien telah ditutup.',
          httpStatus: 499,
          code: 'REQUEST_ABORTED',
          retryAfterSeconds: 1,
        })
      );
    }

    if (this.waitingQueue.length >= this.maxQueueSize) {
      this.totalTimedOutOrRejected++;
      return Promise.reject(
        new GeminiQueueError({
          message:
            'Antrean server A.U.R.A sedang penuh karena lonjakan trafik tinggi. Silakan coba lagi dalam beberapa detik.',
          httpStatus: 503,
          code: 'QUEUE_FULL',
          retryAfterSeconds: 6,
        })
      );
    }

    const priority: QueuePriority = options?.priority ?? 'normal';
    const effectiveTimeoutMs = Math.max(50, options?.timeoutMs ?? this.queueTimeoutMs);
    const label = options?.label ?? 'gemini-request';

    return new Promise<T>((resolve, reject) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const entry: QueuedEntry<T> = {
        id: this.nextTaskId++,
        label,
        priority,
        enqueuedAt: this.nowFn(),
        task,
        resolve,
        reject,
        cancelled: false,
        cleanup: () => {
          if (timeoutHandle !== null) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          if (options?.signal) {
            options.signal.removeEventListener('abort', onAbort);
          }
        },
      };

      const removeFromWaitingQueue = (): boolean => {
        const idx = this.waitingQueue.indexOf(entry as QueuedEntry<unknown>);
        if (idx !== -1) {
          this.waitingQueue.splice(idx, 1);
          return true;
        }
        return false;
      };

      const onAbort = () => {
        if (entry.cancelled) return;
        if (removeFromWaitingQueue()) {
          entry.cancelled = true;
          entry.cleanup();
          this.totalTimedOutOrRejected++;
          reject(
            new GeminiQueueError({
              message: 'Permintaan dibatalkan sebelum diproses karena koneksi klien terputus.',
              httpStatus: 499,
              code: 'REQUEST_ABORTED',
              retryAfterSeconds: 1,
            })
          );
        }
      };

      timeoutHandle = setTimeout(() => {
        if (entry.cancelled) return;
        if (removeFromWaitingQueue()) {
          entry.cancelled = true;
          entry.cleanup();
          this.totalTimedOutOrRejected++;
          reject(
            new GeminiQueueError({
              message:
                'Waktu tunggu antrean habis karena layanan AI sedang mengalami permintaan sangat tinggi. Silakan coba lagi sebentar lagi.',
              httpStatus: 503,
              code: 'QUEUE_TIMEOUT',
              retryAfterSeconds: 5,
            })
          );
        }
      }, effectiveTimeoutMs);

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.insertByPriority(entry as QueuedEntry<unknown>);
      void this.pumpQueue();
    });
  }

  private insertByPriority(entry: QueuedEntry<unknown>): void {
    if (entry.priority === 'high') {
      const firstNormalIdx = this.waitingQueue.findIndex((item) => item.priority === 'normal');
      if (firstNormalIdx !== -1) {
        this.waitingQueue.splice(firstNormalIdx, 0, entry);
        return;
      }
    }
    this.waitingQueue.push(entry);
  }

  private async pumpQueue(): Promise<void> {
    if (this.activeCount >= this.maxConcurrent || this.waitingQueue.length === 0) {
      return;
    }

    if (this.minIntervalMs > 0 && this.lastDispatchAt > 0) {
      const elapsed = this.nowFn() - this.lastDispatchAt;
      const remainingWait = this.minIntervalMs - elapsed;
      if (remainingWait > 0) {
        if (!this.dispatchTimerScheduled) {
          this.dispatchTimerScheduled = true;
          await this.sleepFn(remainingWait);
          this.dispatchTimerScheduled = false;
          void this.pumpQueue();
        }
        return;
      }
    }

    while (this.activeCount < this.maxConcurrent && this.waitingQueue.length > 0) {
      if (this.minIntervalMs > 0 && this.lastDispatchAt > 0) {
        const elapsed = this.nowFn() - this.lastDispatchAt;
        if (elapsed < this.minIntervalMs) {
          if (!this.dispatchTimerScheduled) {
            this.dispatchTimerScheduled = true;
            const waitMs = this.minIntervalMs - elapsed;
            void this.sleepFn(waitMs).then(() => {
              this.dispatchTimerScheduled = false;
              void this.pumpQueue();
            });
          }
          return;
        }
      }

      const nextEntry = this.waitingQueue.shift();
      if (!nextEntry || nextEntry.cancelled) {
        continue;
      }

      nextEntry.cleanup();
      this.activeCount++;
      this.lastDispatchAt = this.nowFn();

      void (async () => {
        try {
          const result = await nextEntry.task();
          this.totalProcessed++;
          nextEntry.resolve(result);
        } catch (err) {
          nextEntry.reject(err);
        } finally {
          this.activeCount--;
          void this.pumpQueue();
        }
      })();
    }
  }
}

export interface BackoffComputeParams {
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryAfterMs?: number | null;
  randomFn?: () => number;
}

/**
 * Menghitung jeda exponential backoff dengan bounded jitter [0.75x .. 1.25x]
 * untuk mencegah efek thundering-herd saat server Gemini pulih dari HTTP 503.
 */
export function computeExponentialBackoffMs(params: BackoffComputeParams): number {
  const baseDelayMs = Math.max(50, params.baseDelayMs ?? 700);
  const maxDelayMs = Math.max(baseDelayMs, params.maxDelayMs ?? 5000);
  const randomVal = Math.min(1, Math.max(0, (params.randomFn ?? Math.random)()));

  const exponentialRaw = baseDelayMs * Math.pow(2, Math.max(0, params.attempt));
  const cappedExponential = Math.min(maxDelayMs, exponentialRaw);
  const jitterFactor = 0.75 + randomVal * 0.5;
  const jitteredDelay = Math.round(cappedExponential * jitterFactor);

  if (typeof params.retryAfterMs === 'number' && params.retryAfterMs > 0) {
    return Math.min(maxDelayMs, Math.max(jitteredDelay, Math.round(params.retryAfterMs)));
  }

  return Math.min(maxDelayMs, Math.max(50, jitteredDelay));
}

/**
 * Mengekstrak petunjuk durasi tunggu (ms) dari header/pesan error Gemini API bila tersedia
 * (misalnya `Retry-After: 3` atau `"retryDelay":"2.5s"`).
 */
export function extractRetryAfterMs(error: unknown): number | null {
  if (!error) return null;

  const headers = (error as { headers?: Record<string, unknown> | Headers })?.headers;
  if (headers) {
    let rawHeader: string | null = null;
    if (typeof (headers as Headers).get === 'function') {
      rawHeader = (headers as Headers).get('retry-after');
    } else if (typeof headers === 'object') {
      const record = headers as Record<string, unknown>;
      const val = record['retry-after'] ?? record['Retry-After'];
      if (typeof val === 'string' || typeof val === 'number') {
        rawHeader = String(val);
      }
    }
    if (rawHeader) {
      const seconds = Number(rawHeader.trim());
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.round(seconds * 1000);
      }
    }
  }

  const rawMsg = error instanceof Error ? error.message : String(error);
  const retryDelayMatch = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(rawMsg);
  if (retryDelayMatch) {
    const seconds = Number(retryDelayMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1000);
    }
  }

  const retryInMatch = /retry in\s+(\d+(?:\.\d+)?)\s*s/i.exec(rawMsg);
  if (retryInMatch) {
    const seconds = Number(retryInMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1000);
    }
  }

  return null;
}

/**
 * Circuit-breaker adaptif per model Gemini:
 * Cooldown meningkat secara progresif ketika model mengalami 503/429 berturut-turut,
 * dan langsung pulih ke status sehat begitu satu permintaan berhasil.
 */
export class ModelHealthTracker {
  private readonly state = new Map<
    string,
    { consecutiveFailures: number; cooldownUntil: number }
  >();
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly nowFn: () => number;

  constructor(options?: {
    baseCooldownMs?: number;
    maxCooldownMs?: number;
    nowFn?: () => number;
  }) {
    this.baseCooldownMs = Math.max(1000, options?.baseCooldownMs ?? 20_000);
    this.maxCooldownMs = Math.max(this.baseCooldownMs, options?.maxCooldownMs ?? 120_000);
    this.nowFn = options?.nowFn ?? (() => Date.now());
  }

  recordSuccess(modelName: string): void {
    this.state.delete(modelName);
  }

  recordTransientFailure(modelName: string): number {
    const now = this.nowFn();
    const prev = this.state.get(modelName);
    const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
    const cooldownDuration = Math.min(
      this.maxCooldownMs,
      this.baseCooldownMs * Math.pow(2, consecutiveFailures - 1)
    );
    const cooldownUntil = now + cooldownDuration;
    this.state.set(modelName, { consecutiveFailures, cooldownUntil });
    return cooldownDuration;
  }

  recordQuotaFailure(
    modelName: string,
    isHardQuotaExhausted?: boolean,
    retryAfterMs?: number | null
  ): number {
    const now = this.nowFn();
    const prev = this.state.get(modelName);
    const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
    const baseQuotaCooldown = isHardQuotaExhausted
      ? Math.max(this.baseCooldownMs * 3, 90_000)
      : Math.max(this.baseCooldownMs, 20_000);
    const scaledCooldown = baseQuotaCooldown * Math.pow(2, consecutiveFailures - 1);
    const hintedCooldown =
      typeof retryAfterMs === 'number' && retryAfterMs > 0 ? retryAfterMs : 0;
    const cooldownDuration = Math.min(
      this.maxCooldownMs,
      Math.max(scaledCooldown, hintedCooldown)
    );
    const cooldownUntil = now + cooldownDuration;
    this.state.set(modelName, { consecutiveFailures, cooldownUntil });
    return cooldownDuration;
  }

  getOrderedModels(chain: readonly string[]): string[] {
    const now = this.nowFn();
    const healthy: string[] = [];
    const coolingDown: Array<{ model: string; cooldownUntil: number }> = [];

    for (const model of chain) {
      const entry = this.state.get(model);
      if (entry && entry.cooldownUntil > now) {
        coolingDown.push({ model, cooldownUntil: entry.cooldownUntil });
      } else {
        healthy.push(model);
      }
    }

    coolingDown.sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return [...healthy, ...coolingDown.map((item) => item.model)];
  }
}

export interface ShortTtlCacheOptions {
  maxEntries?: number;
  defaultTtlMs?: number;
  nowFn?: () => number;
}

/**
 * Cache memori berbatas waktu (TTL) dengan deduplikasi permintaan konkuren (in-flight)
 * agar teks sintesis suara atau kueri identik berulang tidak memboroskan kuota Gemini API.
 */
export class ShortTtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly nowFn: () => number;

  constructor(options?: ShortTtlCacheOptions) {
    this.maxEntries = Math.max(4, options?.maxEntries ?? 48);
    this.defaultTtlMs = Math.max(1000, options?.defaultTtlMs ?? 60_000);
    this.nowFn = options?.nowFn ?? (() => Date.now());
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.nowFn()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    const now = this.nowFn();
    const effectiveTtl = Math.max(500, ttlMs ?? this.defaultTtlMs);
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      for (const [k, v] of this.store.entries()) {
        if (v.expiresAt <= now) {
          this.store.delete(k);
        }
      }
      if (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) {
          this.store.delete(oldestKey);
        }
      }
    }
    this.store.set(key, { value, expiresAt: now + effectiveTtl });
  }

  async getOrCompute(key: string, computeFn: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      try {
        const computed = await computeFn();
        this.set(key, computed, ttlMs);
        return computed;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }
}

export interface ResilientExecutionOptions {
  maxRetriesPerModel?: number;
  fallbackRetriesPerModel?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  healthTracker?: ModelHealthTracker;
  sleepFn?: (ms: number) => Promise<void>;
  randomFn?: () => number;
  onRetry?: (info: {
    modelName: string;
    attempt: number;
    delayMs: number;
    httpStatus: number;
    reason: string;
  }) => void;
}

export interface ResilientExecutionResult<T> {
  result: T;
  usedModel: string;
  attempts: number;
  totalBackoffMs: number;
}

/**
 * Mengeksekusi pemanggilan Gemini API melintasi rantai model dengan strategi
 * Exponential Backoff + Jitter + Circuit-Breaker adaptif untuk menangani 503 & 429 secara tangguh.
 */
export async function executeGeminiWithResilience<T>(
  models: readonly string[],
  invokeModel: (modelName: string, attempt: number) => Promise<T>,
  options?: ResilientExecutionOptions
): Promise<ResilientExecutionResult<T>> {
  if (models.length === 0) {
    throw new Error('Daftar model Gemini tidak boleh kosong.');
  }

  const primaryRetries = Math.max(0, options?.maxRetriesPerModel ?? 2);
  const fallbackRetries = Math.max(0, options?.fallbackRetriesPerModel ?? 1);
  const baseDelayMs = Math.max(50, options?.baseDelayMs ?? 700);
  const maxDelayMs = Math.max(baseDelayMs, options?.maxDelayMs ?? 4500);
  const sleep =
    options?.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const orderedModels = options?.healthTracker
    ? options.healthTracker.getOrderedModels(models)
    : [...models];

  let totalAttempts = 0;
  let totalBackoffMs = 0;
  let lastError: unknown = new Error('Gagal memanggil Gemini API.');

  for (let modelIdx = 0; modelIdx < orderedModels.length; modelIdx++) {
    const modelName = orderedModels[modelIdx];
    const allowedRetries = modelIdx === 0 ? primaryRetries : fallbackRetries;

    for (let attempt = 0; attempt <= allowedRetries; attempt++) {
      if (options?.signal?.aborted) {
        throw new GeminiQueueError({
          message: 'Permintaan dibatalkan karena koneksi klien telah ditutup.',
          httpStatus: 499,
          code: 'REQUEST_ABORTED',
          retryAfterSeconds: 1,
        });
      }

      totalAttempts++;
      try {
        const result = await invokeModel(modelName, attempt);
        options?.healthTracker?.recordSuccess(modelName);
        return {
          result,
          usedModel: modelName,
          attempts: totalAttempts,
          totalBackoffMs,
        };
      } catch (err: unknown) {
        lastError = err;
        const classified = classifyGeminiError(err);
        const retryAfterMs = extractRetryAfterMs(err);

        // Gagal permanen (mis. 401/403 kunci API tidak valid atau 400 payload buruk): langsung hentikan
        if (!classified.retryable && !classified.shouldTryFallbackModel) {
          throw err;
        }

        // Untuk 429 transien (RPM per menit), batasi maks 1 retry pada model terakhir,
        // agar bila masih ada model cadangan dengan bucket kuota terpisah kita beralih terukur.
        const effectiveRetriesForError =
          classified.httpStatus === 429
            ? modelIdx === orderedModels.length - 1
              ? Math.min(1, allowedRetries)
              : 0
            : allowedRetries;

        if (classified.retryable && attempt < effectiveRetriesForError) {
          const delayMs = computeExponentialBackoffMs({
            attempt,
            baseDelayMs: classified.httpStatus === 429 ? Math.max(1000, baseDelayMs) : baseDelayMs,
            maxDelayMs,
            retryAfterMs,
            randomFn: options?.randomFn,
          });
          options?.onRetry?.({
            modelName,
            attempt: attempt + 1,
            delayMs,
            httpStatus: classified.httpStatus,
            reason: err instanceof Error ? err.message : String(err),
          });
          totalBackoffMs += delayMs;
          await sleep(delayMs);
          continue;
        }

        // Tandai model di circuit-breaker lalu beralih ke model cadangan berikutnya dengan jeda transisi adaptif
        if (classified.shouldTryFallbackModel) {
          if (classified.httpStatus === 429) {
            options?.healthTracker?.recordQuotaFailure(
              modelName,
              classified.isHardQuotaExhausted,
              retryAfterMs
            );
          } else {
            options?.healthTracker?.recordTransientFailure(modelName);
          }

          if (modelIdx < orderedModels.length - 1) {
            const switchDelayMs =
              classified.httpStatus === 429
                ? computeExponentialBackoffMs({
                    attempt: 0,
                    baseDelayMs: Math.min(900, maxDelayMs),
                    maxDelayMs: Math.min(3500, maxDelayMs),
                    retryAfterMs:
                      retryAfterMs !== null ? Math.min(retryAfterMs, 3500) : undefined,
                    randomFn: options?.randomFn,
                  })
                : computeExponentialBackoffMs({
                    attempt: 0,
                    baseDelayMs: Math.min(250, baseDelayMs),
                    maxDelayMs: 600,
                    randomFn: options?.randomFn,
                  });
            totalBackoffMs += switchDelayMs;
            await sleep(switchDelayMs);
            break;
          }
        }
      }
    }
  }

  throw lastError;
}
