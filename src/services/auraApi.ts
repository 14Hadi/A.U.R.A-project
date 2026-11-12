import type {
  AuraChatRequest,
  AuraChatResponse,
  AuraTranscribeRequest,
  AuraTranscribeResponse,
  AuraTtsRequest,
  AuraTtsResponse,
} from '../types/aura.ts';
import { getAccessToken } from './googleAuth.ts';

export class UnauthorizedTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedTokenError';
  }
}

export class AuraApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;

  constructor(params: {
    message: string;
    status: number;
    code?: string;
    retryAfterSeconds?: number;
  }) {
    super(params.message);
    this.name = 'AuraApiError';
    this.status = params.status;
    this.code = params.code;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

function parseRetryAfterSeconds(
  response: Response,
  data: { retryAfterSeconds?: unknown } | null
): number | undefined {
  if (
    typeof data?.retryAfterSeconds === 'number' &&
    Number.isFinite(data.retryAfterSeconds) &&
    data.retryAfterSeconds > 0
  ) {
    return Math.ceil(data.retryAfterSeconds);
  }
  const headerVal = response.headers.get('Retry-After');
  if (headerVal) {
    const parsed = Number(headerVal.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.ceil(parsed);
    }
  }
  return undefined;
}

function throwStructuredApiError(
  response: Response,
  data: { error?: string; code?: string; retryAfterSeconds?: unknown } | null,
  fallbackLabel: string
): never {
  if (response.status === 401) {
    throw new UnauthorizedTokenError(
      data?.error || 'Token akses Google telah kedaluwarsa. Silakan masuk kembali.'
    );
  }

  throw new AuraApiError({
    message: data?.error || `${fallbackLabel} (HTTP ${response.status}).`,
    status: response.status,
    code: typeof data?.code === 'string' ? data.code : undefined,
    retryAfterSeconds: parseRetryAfterSeconds(response, data),
  });
}

function getClientLocalTimeLabel(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Waktu Lokal';
    const formatted = new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date());
    return `${formatted} (${tz})`;
  } catch {
    return new Date().toLocaleString('id-ID');
  }
}

function requireBearerToken(): string {
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new UnauthorizedTokenError(
      'Sesi token akses tidak ditemukan di memori. Silakan masuk kembali dengan Akun Google Anda.'
    );
  }
  return accessToken;
}

/**
 * Mengirim pesan percakapan ke endpoint backend `/api/aura/chat` beserta waktu lokal perangkat.
 */
export async function sendAuraMessage(payload: AuraChatRequest): Promise<AuraChatResponse> {
  const accessToken = requireBearerToken();

  const response = await fetch('/api/aura/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      ...payload,
      clientLocalTime: payload.clientLocalTime || getClientLocalTimeLabel(),
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throwStructuredApiError(response, data, 'Permintaan ke server A.U.R.A gagal');
  }

  return data as AuraChatResponse;
}

/**
 * Mengirim rekaman audio perintah suara ke `/api/aura/transcribe` (Gemini 3.5 Transcribe).
 */
export async function transcribeAuraAudio(
  payload: AuraTranscribeRequest
): Promise<AuraTranscribeResponse> {
  const accessToken = requireBearerToken();

  const response = await fetch('/api/aura/transcribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throwStructuredApiError(response, data, 'Gagal mentranskripsikan perintah suara');
  }

  return data as AuraTranscribeResponse;
}

/**
 * Meminta sintesis suara (WAV 24kHz) dari teks balasan A.U.R.A melalui `/api/aura/tts` (Gemini 3.8 TTS).
 */
export async function synthesizeAuraSpeech(
  payload: AuraTtsRequest
): Promise<AuraTtsResponse> {
  const accessToken = requireBearerToken();

  const response = await fetch('/api/aura/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throwStructuredApiError(response, data, 'Gagal menghasilkan suara balasan A.U.R.A');
  }

  return data as AuraTtsResponse;
}
