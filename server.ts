import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  buildAuraSystemInstruction,
  classifyGeminiError,
  cleanTranscribedText,
  deriveAutomaticMemoryCandidate,
  ensurePlayableWavBase64,
  ensureWarmAuraOpening,
  estimateApproximateTokens,
  extractGroundingCitations,
  extractProfileFromPeopleApi,
  extractUrlsFromText,
  normalizeAudioMimeType,
  normalizeConversationTurns,
  parseBearerToken,
  sanitizeDisplayName,
  sanitizeImageAttachment,
  sanitizeStoredMemories,
  sanitizeStoredRoutines,
  shouldInvokeWebSearchTool,
  stripMarkdownForSpeech,
  type PeopleApiPayload,
} from './src/utils/auraContext.ts';
import {
  GeminiQueueError,
  GeminiRequestQueue,
  ModelHealthTracker,
  ShortTtlCache,
  executeGeminiWithResilience,
  extractRetryAfterMs,
} from './src/utils/geminiResilience.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Urutan prioritas model Gemini Flash aktif untuk percakapan teks, analisis gambar multimodal, & kode:
 */
const GEMINI_MODEL_CHAIN = [
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite',
] as const;

/**
 * Urutan prioritas model Gemini untuk transkripsi perintah suara (Speech-to-Text):
 */
const GEMINI_TRANSCRIBE_CHAIN = [
  'gemini-3.5-transcribe',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite',
] as const;

/**
 * Urutan prioritas model Gemini untuk sintesis respons suara perempuan AI (Text-to-Speech):
 */
const GEMINI_TTS_CHAIN = [
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
] as const;

const VALID_TTS_VOICES = new Set(['Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir']);

/**
 * Antrean permintaan Gemini sisi server & circuit-breaker adaptif untuk meredam lonjakan beban
 * HTTP 503 Service Unavailable dan menjaga ritme kuota RPM (HTTP 429) tanpa membanjiri upstream API.
 */
const geminiRequestQueue = new GeminiRequestQueue({
  maxConcurrent: 2,
  maxQueueSize: 24,
  queueTimeoutMs: 35_000,
  minIntervalMs: 350,
});

const modelHealthTracker = new ModelHealthTracker({
  baseCooldownMs: 25_000,
  maxCooldownMs: 180_000,
});

const ttsAudioCache = new ShortTtlCache<{ audioBase64: string; mimeType: 'audio/wav' }>({
  maxEntries: 40,
  defaultTtlMs: 15 * 60 * 1000,
});

function createClientDisconnectGuard(res: Response): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on('close', onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      res.off('close', onClose);
    },
  };
}

function sendResilientGeminiError(res: Response, endpointLabel: string, error: unknown): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  if (error instanceof GeminiQueueError) {
    if (error.code === 'REQUEST_ABORTED') {
      return;
    }
    console.warn(`[A.U.R.A ${endpointLabel}] Queue ${error.code}: ${error.message}`);
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
    res.status(error.httpStatus).json({
      error: error.message,
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
    });
    return;
  }

  const classified = classifyGeminiError(error);
  const upstreamRetryMs = extractRetryAfterMs(error);
  const retryAfterSeconds =
    classified.httpStatus === 503 || classified.httpStatus === 429
      ? Math.max(
          3,
          Math.ceil(
            (upstreamRetryMs ??
              (classified.httpStatus === 429
                ? classified.isHardQuotaExhausted
                  ? 15_000
                  : 10_000
                : 5_000)) / 1000
          )
        )
      : undefined;

  if (
    classified.httpStatus === 429 ||
    classified.httpStatus === 503 ||
    classified.httpStatus === 403
  ) {
    console.warn(
      `[A.U.R.A ${endpointLabel}] Upstream HTTP ${classified.httpStatus} (${classified.code}) — meneruskan panduan pemulihan ke klien.`
    );
  } else {
    console.error(
      `[A.U.R.A ${endpointLabel}] HTTP ${classified.httpStatus}:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  if (retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }

  res.status(classified.httpStatus).json({
    error: classified.userMessage,
    code: classified.code,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

/**
 * ============================================================================
 * KONFIGURASI KEAMANAN GEMINI API (SERVER-SIDE ONLY)
 * ============================================================================
 * `GEMINI_API_KEY` dibaca secara eksklusif di sisi server dari `process.env.GEMINI_API_KEY`
 * dan TIDAK PERNAH dikirim ke kode browser klien.
 */
let sharedAiClient: GoogleGenAI | null = null;
let cachedApiKeyRef: string | undefined;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY belum terkonfigurasi di lingkungan server. Pastikan kunci tersedia di Settings > Secrets.'
    );
  }

  if (!sharedAiClient || cachedApiKeyRef !== apiKey) {
    sharedAiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
        retryOptions: {
          attempts: 1,
        },
      },
    });
    cachedApiKeyRef = apiKey;
  }

  return sharedAiClient;
}

interface CachedVerifiedIdentity {
  displayName: string;
  email: string;
  expiresAt: number;
}

const verifiedTokenCache = new Map<string, CachedVerifiedIdentity>();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

function hashAccessToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function pruneExpiredTokens(now: number): void {
  if (verifiedTokenCache.size <= 250) return;
  for (const [digest, entry] of verifiedTokenCache.entries()) {
    if (entry.expiresAt <= now) {
      verifiedTokenCache.delete(digest);
    }
  }
}

class GoogleAuthVerificationError extends Error {
  readonly statusCode: 401 | 503;
  constructor(message: string, statusCode: 401 | 503) {
    super(message);
    this.name = 'GoogleAuthVerificationError';
    this.statusCode = statusCode;
  }
}

async function verifyGoogleTokenAndGetIdentity(
  accessToken: string
): Promise<{ displayName: string; email: string }> {
  const tokenDigest = hashAccessToken(accessToken);
  const now = Date.now();
  pruneExpiredTokens(now);

  const cached = verifiedTokenCache.get(tokenDigest);
  if (cached && cached.expiresAt > now) {
    return { displayName: cached.displayName, email: cached.email };
  }

  try {
    const peopleRes = await fetch(
      'https://people.googleapis.com/v1/people/me?personFields=names,emailAddresses',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (peopleRes.ok) {
      const peopleData = (await peopleRes.json()) as PeopleApiPayload;
      const extracted = extractProfileFromPeopleApi(peopleData, {});
      const identity = {
        displayName: extracted.displayName,
        email: extracted.email,
      };
      verifiedTokenCache.set(tokenDigest, {
        ...identity,
        expiresAt: now + TOKEN_CACHE_TTL_MS,
      });
      return identity;
    }

    if (peopleRes.status === 401) {
      verifiedTokenCache.delete(tokenDigest);
      throw new GoogleAuthVerificationError(
        'Token akses Google tidak valid atau sudah kedaluwarsa. Silakan login kembali.',
        401
      );
    }
  } catch (err) {
    if (err instanceof GoogleAuthVerificationError) {
      throw err;
    }
  }

  let userInfoRes: globalThis.Response;
  try {
    userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new GoogleAuthVerificationError(
      'Koneksi verifikasi identitas Google sedang sibuk sementara. Silakan coba lagi.',
      503
    );
  }

  if (!userInfoRes.ok) {
    verifiedTokenCache.delete(tokenDigest);
    throw new GoogleAuthVerificationError(
      'Token akses Google tidak valid atau sudah kedaluwarsa. Silakan login kembali.',
      401
    );
  }

  const userInfo = (await userInfoRes.json()) as {
    name?: string;
    given_name?: string;
    email?: string;
  };

  const identity = {
    displayName: sanitizeDisplayName(
      userInfo.name || userInfo.given_name || userInfo.email?.split('@')[0],
      'Pengguna'
    ),
    email: userInfo.email || 'tidak-tersedia@google.com',
  };

  verifiedTokenCache.set(tokenDigest, {
    ...identity,
    expiresAt: now + TOKEN_CACHE_TTL_MS,
  });

  return identity;
}

async function authenticateBearerRequest(
  req: Request,
  res: Response
): Promise<{ displayName: string; email: string } | null> {
  const accessToken = parseBearerToken(req.headers.authorization);
  if (!accessToken) {
    res.status(401).json({
      error: 'Header otorisasi Bearer token tidak ditemukan atau tidak valid.',
    });
    return null;
  }

  try {
    return await verifyGoogleTokenAndGetIdentity(accessToken);
  } catch (err) {
    const status = err instanceof GoogleAuthVerificationError ? err.statusCode : 401;
    const message =
      err instanceof GoogleAuthVerificationError
        ? err.message
        : 'Token akses Google tidak valid atau sudah kedaluwarsa. Silakan login kembali.';
    res.status(status).json({ error: message });
    return null;
  }
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  // Kapasitas JSON 14MB untuk mendukung lampiran gambar terkompresi & perintah suara base64
  app.use(express.json({ limit: '14mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      voiceEnabled: true,
      webGroundingEnabled: true,
      imageMultimodalEnabled: true,
      tokenSaverEnabled: true,
      retryStrategy: 'exponential-backoff-with-jitter',
      requestQueue: geminiRequestQueue.getSnapshot(),
    });
  });

  /**
   * POST /api/aura/chat
   * Percakapan multimodal (teks + analisis gambar berlanjut) dengan:
   * - Mode Hemat Token (pemangkasan memori relevan, jendela riwayat ringkas, smart search gating, ThinkingLevel.LOW)
   * - Persona perempuan lembut, sabar, menenangkan + konfirmasi hangat saat dipanggil "Aura"
   * - Penelusuran internet & verifikasi fakta (Google Search Grounding + URL Context)
   * - Pendampingan pemrograman & debugging
   */
  app.post('/api/aura/chat', async (req: Request, res: Response) => {
    try {
      const verifiedIdentity = await authenticateBearerRequest(req, res);
      if (!verifiedIdentity) return;

      const latestImage = sanitizeImageAttachment(req.body?.imageAttachment);
      const rawInputMessage =
        typeof req.body?.message === 'string' ? req.body.message.trim() : '';

      const effectiveMessage =
        rawInputMessage ||
        (latestImage
          ? 'Aura, tolong amati gambar ini secara saksama dan jelaskan poin pentingnya agar dapat kita bahas lebih lanjut.'
          : '');

      if (!effectiveMessage) {
        res.status(400).json({
          error: 'Masukkan pesan atau lampirkan sebuah gambar terlebih dahulu.',
        });
        return;
      }
      if (effectiveMessage.length > 12000) {
        res.status(400).json({
          error: 'Pesan atau potongan kode melebihi batas 12.000 karakter.',
        });
        return;
      }

      const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
      const sanitizedRoutines = sanitizeStoredRoutines(req.body?.routines, []).slice(0, 20);
      const sanitizedMemories = sanitizeStoredMemories(req.body?.memories).slice(0, 25);
      const enableWebSearch = req.body?.enableWebSearch !== false;
      const tokenSaver = req.body?.tokenSaver !== false;

      const clientLocalTime =
        typeof req.body?.clientLocalTime === 'string' && req.body.clientLocalTime.trim()
          ? req.body.clientLocalTime.trim().slice(0, 120)
          : new Date().toISOString();

      const effectiveDisplayName =
        verifiedIdentity.displayName !== 'Pengguna'
          ? verifiedIdentity.displayName
          : sanitizeDisplayName(req.body?.clientDisplayName, 'Pengguna');

      const systemInstruction = buildAuraSystemInstruction({
        displayName: effectiveDisplayName,
        routines: sanitizedRoutines,
        memories: sanitizedMemories,
        currentTimeIso: clientLocalTime,
        latestUserMessage: effectiveMessage,
        tokenSaver,
        hasImageAttachment: Boolean(latestImage),
      });

      const detectedUrls = extractUrlsFromText(effectiveMessage);
      const webSearchInvoked = shouldInvokeWebSearchTool({
        message: effectiveMessage,
        enableWebSearch,
        tokenSaver,
      });

      const primaryTools: Array<Record<string, Record<string, never>>> | undefined =
        webSearchInvoked
          ? [
              { googleSearch: {} },
              ...(detectedUrls.length > 0 ? [{ urlContext: {} }] : []),
            ]
          : undefined;

      const contents = normalizeConversationTurns(rawHistory, effectiveMessage, {
        tokenSaver,
        latestImage,
      });

      const ai = getGeminiClient();
      const disconnectGuard = createClientDisconnectGuard(res);

      let geminiResponse;
      let usedModel: string;
      let effectiveWebSearchUsed = webSearchInvoked;
      try {
        const execution = await geminiRequestQueue.enqueue(
          async () => {
            try {
              return await executeGeminiWithResilience(
                GEMINI_MODEL_CHAIN,
                async (modelName) => {
                  // gemini-3.8-flash mendukung ThinkingLevel.LOW; gemini-3.1-flash-lite sudah MINIMAL secara default
                  const applyLowThinking = tokenSaver && modelName === 'gemini-3.8-flash';
                  try {
                    return await ai.models.generateContent({
                      model: modelName,
                      contents,
                      config: {
                        systemInstruction,
                        ...(primaryTools ? { tools: primaryTools } : {}),
                        ...(applyLowThinking
                          ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                          : {}),
                        httpOptions: {
                          retryOptions: { attempts: 1 },
                          timeout: 35000,
                        },
                      },
                    });
                  } catch (modelErr: unknown) {
                    const status = (modelErr as { status?: number })?.status;
                    const errMsg = modelErr instanceof Error ? modelErr.message : String(modelErr);

                    // Hanya tangani ketidakcocokan argumen HTTP 400 (jangan ulangi 429/503/403 di blok ini)
                    if (
                      status === 400 ||
                      (status !== 429 &&
                        status !== 503 &&
                        status !== 401 &&
                        status !== 403 &&
                        /INVALID_ARGUMENT|thinking|url_context/i.test(errMsg))
                    ) {
                      try {
                        return await ai.models.generateContent({
                          model: modelName,
                          contents,
                          config: {
                            systemInstruction,
                            ...(webSearchInvoked ? { tools: [{ googleSearch: {} }] } : {}),
                            httpOptions: {
                              retryOptions: { attempts: 1 },
                              timeout: 30000,
                            },
                          },
                        });
                      } catch (innerErr: unknown) {
                        const innerStatus = (innerErr as { status?: number })?.status;
                        if (innerStatus === 429 || innerStatus === 503 || innerStatus === 403) {
                          throw innerErr;
                        }
                        effectiveWebSearchUsed = false;
                        return await ai.models.generateContent({
                          model: modelName,
                          contents,
                          config: {
                            systemInstruction,
                            httpOptions: {
                              retryOptions: { attempts: 1 },
                              timeout: 25000,
                            },
                          },
                        });
                      }
                    }

                    throw modelErr;
                  }
                },
                {
                  maxRetriesPerModel: 2,
                  fallbackRetriesPerModel: 1,
                  baseDelayMs: 700,
                  maxDelayMs: 4500,
                  signal: disconnectGuard.signal,
                  healthTracker: modelHealthTracker,
                  onRetry: ({ modelName, attempt, delayMs, httpStatus }) => {
                    console.warn(
                      `[A.U.R.A Gemini Chat] HTTP ${httpStatus} pada ${modelName} — percobaan ulang #${attempt} dalam ${delayMs}ms`
                    );
                  },
                }
              );
            } catch (chainErr: unknown) {
              // Kuota Google Search Grounding jauh lebih ketat di tier gratis daripada teks murni.
              // Jika 429 terjadi saat tools aktif, coba sekali tanpa tools pada gemini-3.1-flash-lite.
              if (primaryTools && classifyGeminiError(chainErr).httpStatus === 429) {
                effectiveWebSearchUsed = false;
                const ungroundedResult = await ai.models.generateContent({
                  model: 'gemini-3.1-flash-lite',
                  contents,
                  config: {
                    systemInstruction,
                    httpOptions: {
                      retryOptions: { attempts: 1 },
                      timeout: 25000,
                    },
                  },
                });
                return {
                  result: ungroundedResult,
                  usedModel: 'gemini-3.1-flash-lite',
                  attempts: 1,
                  totalBackoffMs: 0,
                };
              }
              throw chainErr;
            }
          },
          {
            label: 'aura-chat',
            priority: 'high',
            signal: disconnectGuard.signal,
            timeoutMs: 35_000,
          }
        );
        geminiResponse = execution.result;
        usedModel = execution.usedModel;
      } finally {
        disconnectGuard.dispose();
      }

      const rawReplyText =
        geminiResponse.text?.trim() ||
        `Halo ${effectiveDisplayName}, Aura hadir mendampingi Anda. Silakan sampaikan bagian mana yang ingin kita bahas lebih dalam.`;

      const replyText = ensureWarmAuraOpening(rawReplyText, effectiveMessage);

      const { sources, searchQueries } = extractGroundingCitations(
        geminiResponse.candidates?.[0]?.groundingMetadata
      );

      const promptTokens =
        geminiResponse.usageMetadata?.promptTokenCount ??
        estimateApproximateTokens(systemInstruction + effectiveMessage);
      const outputTokens =
        geminiResponse.usageMetadata?.candidatesTokenCount ??
        estimateApproximateTokens(replyText);
      const totalTokens =
        geminiResponse.usageMetadata?.totalTokenCount ?? promptTokens + outputTokens;

      const extractedMemory = deriveAutomaticMemoryCandidate({
        userMessage: effectiveMessage,
        replyText,
        sources,
        searchQueries,
        attachmentLabel: latestImage?.label,
      });

      res.json({
        reply: replyText,
        verifiedDisplayName: effectiveDisplayName,
        appliedSystemInstruction: systemInstruction,
        model: usedModel,
        timestamp: new Date().toISOString(),
        sources,
        searchQueries,
        tokenUsage: {
          promptTokens,
          outputTokens,
          totalTokens,
          tokenSaverActive: tokenSaver,
          webSearchInvoked: effectiveWebSearchUsed,
        },
        extractedMemory,
      });
    } catch (error: unknown) {
      sendResilientGeminiError(res, 'Gemini Chat', error);
    }
  });

  /**
   * POST /api/aura/transcribe
   * Mentranskripsikan rekaman perintah audio pengguna menjadi teks menggunakan `gemini-3.5-transcribe`.
   */
  app.post('/api/aura/transcribe', async (req: Request, res: Response) => {
    try {
      const verifiedIdentity = await authenticateBearerRequest(req, res);
      if (!verifiedIdentity) return;

      const rawBase64 =
        typeof req.body?.audioBase64 === 'string' ? req.body.audioBase64.trim() : '';
      const cleanBase64 = rawBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');

      if (!cleanBase64 || cleanBase64.length < 32) {
        res.status(400).json({
          error: 'Data rekaman audio kosong atau terlalu pendek. Silakan rekam ulang suara Anda.',
        });
        return;
      }

      const normalizedMimeType = normalizeAudioMimeType(
        typeof req.body?.mimeType === 'string' ? req.body.mimeType : 'audio/wav'
      );

      const ai = getGeminiClient();
      const disconnectGuard = createClientDisconnectGuard(res);

      let cleanedTranscript = '';
      let emptyModelCount = 0;
      try {
        const execution = await geminiRequestQueue.enqueue(
          () =>
            executeGeminiWithResilience(
              GEMINI_TRANSCRIBE_CHAIN,
              async (modelName) => {
                const resp = await ai.models.generateContent({
                  model: modelName,
                  contents: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: normalizedMimeType,
                          data: cleanBase64,
                        },
                      },
                      {
                        text: 'Transkripsikan ucapan manusia dalam rekaman audio ini secara akurat kata demi kata dalam Bahasa Indonesia (pertahankan nama panggilan seperti Aura serta istilah teknis bahasa Inggris seperti kode, debug, error, function, API bila diucapkan). Kembalikan hanya teks kalimat yang diucapkan tanpa tanda kutip atau penjelasan tambahan. Jika rekaman benar-benar hening tanpa ucapan manusia, kembalikan string kosong.',
                      },
                    ],
                  },
                  config: {
                    httpOptions: {
                      retryOptions: { attempts: 1 },
                      timeout: 22000,
                    },
                  },
                });

                const candidateText = cleanTranscribedText(resp.text);
                if (!candidateText) {
                  emptyModelCount++;
                  // Bila model pertama belum menangkap teks (misal perbedaan dekoder format), coba 1 model multimodal cadangan
                  if (emptyModelCount <= 1) {
                    throw Object.assign(
                      new Error('Transkripsi kosong pada model utama, mencoba model cadangan.'),
                      { status: 404 }
                    );
                  }
                }
                return candidateText;
              },
              {
                maxRetriesPerModel: 1,
                fallbackRetriesPerModel: 0,
                baseDelayMs: 600,
                maxDelayMs: 3000,
                signal: disconnectGuard.signal,
                healthTracker: modelHealthTracker,
                onRetry: ({ modelName, attempt, delayMs, httpStatus }) => {
                  console.warn(
                    `[A.U.R.A Gemini Transcribe] HTTP ${httpStatus} pada ${modelName} — percobaan ulang #${attempt} dalam ${delayMs}ms`
                  );
                },
              }
            ),
          {
            label: 'aura-transcribe',
            priority: 'high',
            signal: disconnectGuard.signal,
            timeoutMs: 30_000,
          }
        );
        cleanedTranscript = execution.result;
      } finally {
        disconnectGuard.dispose();
      }

      if (!cleanedTranscript) {
        res.status(422).json({
          error:
            'Suara belum terdengar jelas pada rekaman tersebut. Pastikan perangkat mikrofon yang tepat aktif lalu ucapkan kembali perintah Anda.',
        });
        return;
      }

      res.json({ transcript: cleanedTranscript });
    } catch (error: unknown) {
      sendResilientGeminiError(res, 'Gemini Transcribe', error);
    }
  });

  /**
   * POST /api/aura/tts
   * Mengubah teks balasan A.U.R.A menjadi audio WAV 24kHz bersuara perempuan lembut (`Kore`)
   * menggunakan `gemini-3.8-flash-lite-tts`.
   */
  app.post('/api/aura/tts', async (req: Request, res: Response) => {
    try {
      const verifiedIdentity = await authenticateBearerRequest(req, res);
      if (!verifiedIdentity) return;

      const rawText = typeof req.body?.text === 'string' ? req.body.text : '';
      const cleanedText = stripMarkdownForSpeech(rawText);
      if (!cleanedText) {
        res.status(400).json({ error: 'Teks untuk sintesis suara tidak boleh kosong.' });
        return;
      }

      const requestedVoice = typeof req.body?.voiceName === 'string' ? req.body.voiceName : 'Kore';
      const voiceName = VALID_TTS_VOICES.has(requestedVoice) ? requestedVoice : 'Kore';
      const ttsCacheKey = crypto
        .createHash('sha256')
        .update(`${voiceName}:${cleanedText}`)
        .digest('hex');

      const cachedAudio = ttsAudioCache.get(ttsCacheKey);
      if (cachedAudio) {
        res.json(cachedAudio);
        return;
      }

      const ai = getGeminiClient();
      const disconnectGuard = createClientDisconnectGuard(res);

      try {
        const payload = await ttsAudioCache.getOrCompute(ttsCacheKey, async () => {
          const execution = await geminiRequestQueue.enqueue(
            () =>
              executeGeminiWithResilience(
                GEMINI_TTS_CHAIN,
                async (modelName) =>
                  ai.models.generateContent({
                    model: modelName,
                    contents: [
                      {
                        role: 'user',
                        parts: [{ text: cleanedText }],
                      },
                    ],
                    config: {
                      responseModalities: ['AUDIO'],
                      speechConfig: {
                        voiceConfig: {
                          prebuiltVoiceConfig: { voiceName },
                        },
                      },
                      httpOptions: {
                        retryOptions: { attempts: 1 },
                        timeout: 25000,
                      },
                    },
                  }),
                {
                  maxRetriesPerModel: 2,
                  fallbackRetriesPerModel: 1,
                  baseDelayMs: 650,
                  maxDelayMs: 4000,
                  signal: disconnectGuard.signal,
                  healthTracker: modelHealthTracker,
                  onRetry: ({ modelName, attempt, delayMs, httpStatus }) => {
                    console.warn(
                      `[A.U.R.A Gemini TTS] HTTP ${httpStatus} pada ${modelName} — percobaan ulang #${attempt} dalam ${delayMs}ms`
                    );
                  },
                }
              ),
            {
              label: 'aura-tts',
              priority: 'normal',
              signal: disconnectGuard.signal,
              timeoutMs: 30_000,
            }
          );

          const base64Audio =
            execution.result.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || '';
          if (!base64Audio) {
            throw Object.assign(new Error('Layanan suara belum mengembalikan data audio.'), {
              status: 502,
            });
          }

          return {
            audioBase64: ensurePlayableWavBase64(base64Audio, 24000),
            mimeType: 'audio/wav' as const,
          };
        });

        res.json(payload);
      } finally {
        disconnectGuard.dispose();
      }
    } catch (error: unknown) {
      sendResilientGeminiError(res, 'Gemini TTS', error);
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    process.env.DISABLE_HMR = 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });

    app.use(async (req: Request, res: Response, next) => {
      if (req.path !== '/@vite/client') {
        next();
        return;
      }
      try {
        const transformed = await vite.transformRequest(req.originalUrl);
        if (transformed?.code) {
          const hmrSafeClientCode = transformed.code
            .replace('console.debug("[vite] connecting...");', '')
            .replace(
              'const createWebSocketModuleRunnerTransport = (options) => {',
              'const createWebSocketModuleRunnerTransport = (_options) => ({ async connect() {}, async disconnect() {}, send() {} }); const __unusedViteWsTransport = (options) => {'
            );
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.status(200).send(hmrSafeClientCode);
          return;
        }
      } catch {
        // Fallback aman ke middleware Vite standar
      }
      next();
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`A.U.R.A Full-Stack Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start A.U.R.A server:', err);
  process.exit(1);
});
