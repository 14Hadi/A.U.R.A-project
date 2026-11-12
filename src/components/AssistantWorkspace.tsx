import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Send,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  ArrowRight,
  ShieldCheck,
  Mic,
  Square,
  Volume2,
  VolumeX,
  X,
  Globe,
  ExternalLink,
  Copy,
  Check,
  Brain,
  ImagePlus,
  Leaf,
} from 'lucide-react';
import type {
  AuraImageAttachment,
  ChatMessage,
  MemoryItem,
  RoutineItem,
  UserProfile,
} from '../types/aura.ts';
import {
  buildAuraSystemInstruction,
  cleanTranscribedText,
  downsampleAndNormalizePcm,
  encodeFloat32PcmToWavBase64,
  estimateApproximateTokens,
  mergeSpeechTranscriptParts,
  normalizeAudioMimeType,
  parseInlineMarkdownSegments,
  parseMarkdownBlocks,
} from '../utils/auraContext.ts';
import { GoogleSignInButton } from './GoogleSignInButton.tsx';

export interface SendMessageOptions {
  isVoiceCommand?: boolean;
  imageAttachment?: AuraImageAttachment;
  imagePreviewUrl?: string;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface BrowserSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructorLike = new () => BrowserSpeechRecognitionLike;

function getBrowserSpeechRecognitionCtor(): SpeechRecognitionConstructorLike | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructorLike;
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

function getBrowserAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return win.AudioContext || win.webkitAudioContext || null;
}

function quantizeMicSignalStep(peak: number): number {
  if (peak < 0.004) return 0;
  if (peak < 0.015) return 1;
  if (peak < 0.04) return 2;
  if (peak < 0.09) return 3;
  if (peak < 0.18) return 4;
  return 5;
}

const PREFERRED_MIC_STORAGE_KEY = 'aura_preferred_mic_id';

interface AssistantWorkspaceProps {
  userProfile: UserProfile | null;
  needsAuth: boolean;
  isLoggingIn: boolean;
  authError: string | null;
  onGoogleLogin: () => void;
  messages: ChatMessage[];
  memories: MemoryItem[];
  webSearchEnabled: boolean;
  onToggleWebSearch: () => void;
  tokenSaverEnabled: boolean;
  onToggleTokenSaver: () => void;
  isSending: boolean;
  isTranscribing: boolean;
  chatError: string | null;
  isQuotaError?: boolean;
  retryCooldownSeconds?: number;
  onSendMessage: (messageText: string, options?: SendMessageOptions) => Promise<void>;
  onSendVoiceCommand: (audioBase64: string, mimeType: string) => Promise<void>;
  onTranscribeVoiceToText?: (audioBase64: string, mimeType: string) => Promise<string | null>;
  autoVoiceEnabled: boolean;
  onToggleAutoVoice: () => void;
  playingMessageId: string | null;
  loadingAudioMessageId: string | null;
  onToggleMessageAudio: (msg: ChatMessage) => void;
  onRetryLastAction?: () => void;
  onResetConversation: () => void;
  routines: RoutineItem[];
  prefilledDraft?: string | null;
  onConsumePrefilledDraft?: () => void;
  onNavigateTab: (tab: 'assistant' | 'memories' | 'routines' | 'architecture') => void;
}

const QUICK_PROMPTS = [
  'Aura, tolong telusuri dan verifikasi fakta perkembangan terbaru TypeScript & Node.js beserta sumber resminya.',
  'Aura, bantu saya debug dan perbaiki fungsi async JavaScript yang mengalami race condition saat memanggil API.',
  'Aura, susun prioritas rutinitas fokus saya hari ini secara ringkas dan menenangkan.',
];

const SUPPORTED_AUDIO_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
];

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function pickSupportedRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  for (const candidate of SUPPORTED_AUDIO_MIMES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return '';
}

function formatRecordingSeconds(totalSeconds: number): string {
  const mins = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const secs = String(totalSeconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        const commaIdx = reader.result.indexOf(',');
        resolve(commaIdx >= 0 ? reader.result.slice(commaIdx + 1) : reader.result);
      } else {
        reject(new Error('Gagal membaca berkas.'));
      }
    };
    reader.onerror = () => reject(new Error('Gagal memproses berkas media.'));
    reader.readAsDataURL(blob);
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Gagal membaca gambar.'));
      }
    };
    reader.onerror = () => reject(new Error('Gagal memuat berkas gambar.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Mengompresi dan menyesuaikan resolusi gambar di sisi klien (maks sisi terpanjang 1024px)
 * agar pengiriman sangat cepat dan menghemat konsumsi token visual Gemini secara signifikan.
 */
async function prepareOptimizedImageAttachment(file: File): Promise<{
  attachment: AuraImageAttachment;
  previewUrl: string;
}> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error('Format gambar harus berupa JPG, PNG, WEBP, atau GIF.');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('Ukuran berkas gambar maksimal 10 MB.');
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  const safeName = (file.name || 'gambar.jpg').replace(/[^\w.\-() ]+/g, '_').slice(0, 48);

  // Untuk GIF atau berkas kecil (< 180 KB), gunakan langsung tanpa kompresi ulang bila bukan foto raksasa
  if (file.type === 'image/gif') {
    const comma = rawDataUrl.indexOf(',');
    const base64Data = comma >= 0 ? rawDataUrl.slice(comma + 1) : rawDataUrl;
    const kb = Math.max(1, Math.round(file.size / 1024));
    return {
      attachment: {
        base64Data,
        mimeType: 'image/gif',
        label: `${safeName} (${kb} KB)`,
      },
      previewUrl: rawDataUrl,
    };
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const maxEdge = 1024;
        let targetW = img.naturalWidth || img.width || 512;
        let targetH = img.naturalHeight || img.height || 512;

        if (targetW > maxEdge || targetH > maxEdge) {
          if (targetW >= targetH) {
            targetH = Math.max(1, Math.round((targetH * maxEdge) / targetW));
            targetW = maxEdge;
          } else {
            targetW = Math.max(1, Math.round((targetW * maxEdge) / targetH));
            targetH = maxEdge;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          const comma = rawDataUrl.indexOf(',');
          resolve({
            attachment: {
              base64Data: comma >= 0 ? rawDataUrl.slice(comma + 1) : rawDataUrl,
              mimeType: (file.type as AuraImageAttachment['mimeType']) || 'image/jpeg',
              label: `${safeName} (${Math.max(1, Math.round(file.size / 1024))} KB)`,
            },
            previewUrl: rawDataUrl,
          });
          return;
        }

        // Latar putih untuk gambar transparan yang dikompresi ke JPEG hemat token
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(img, 0, 0, targetW, targetH);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
        const commaIdx = compressedDataUrl.indexOf(',');
        const base64Data =
          commaIdx >= 0 ? compressedDataUrl.slice(commaIdx + 1) : compressedDataUrl;
        const approxKb = Math.max(1, Math.round((base64Data.length * 3) / 4 / 1024));

        resolve({
          attachment: {
            base64Data,
            mimeType: 'image/jpeg',
            label: `${safeName} (${targetW}×${targetH} · ${approxKb} KB)`,
          },
          previewUrl: compressedDataUrl,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Gagal mengoptimalkan gambar.'));
      }
    };
    img.onerror = () => reject(new Error('Berkas gambar rusak atau tidak dapat dibaca.'));
    img.src = rawDataUrl;
  });
}

const InlineSegmentsView: React.FC<{ text: string; isUser: boolean }> = ({ text, isUser }) => {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, lineIdx) => {
        const segments = parseInlineMarkdownSegments(line);
        return (
          <React.Fragment key={lineIdx}>
            {segments.map((seg, segIdx) => {
              if (seg.type === 'bold') {
                return (
                  <strong key={segIdx} className="font-semibold">
                    {seg.content}
                  </strong>
                );
              }
              if (seg.type === 'code') {
                return (
                  <code
                    key={segIdx}
                    className={`rounded px-1.5 py-0.5 font-mono text-[0.85em] ${
                      isUser ? 'bg-blue-700 text-white' : 'bg-slate-200/80 text-slate-900'
                    }`}
                  >
                    {seg.content}
                  </code>
                );
              }
              if (seg.type === 'link' && seg.href) {
                return (
                  <a
                    key={segIdx}
                    href={seg.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`underline underline-offset-2 ${
                      isUser ? 'text-blue-100 hover:text-white' : 'text-blue-700 hover:text-blue-800'
                    }`}
                  >
                    {seg.content}
                  </a>
                );
              }
              return <React.Fragment key={segIdx}>{seg.content}</React.Fragment>;
            })}
            {lineIdx < lines.length - 1 && <br />}
          </React.Fragment>
        );
      })}
    </>
  );
};

const CodeSnippetBlock: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Abaikan jika clipboard dibatasi oleh iframe
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-slate-800 bg-slate-950 text-slate-100">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-400">
        <span className="font-mono">{language || 'kode'}</span>
        <button
          type="button"
          onClick={() => void handleCopyCode()}
          aria-label={`Salin kode ${language || 'program'}`}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              <span>Tersalin</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Salin Kode</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
};

const FormattedMessageContent: React.FC<{ text: string; isUser: boolean }> = ({
  text,
  isUser,
}) => {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="space-y-2.5">
      {blocks.map((block, idx) => {
        if (block.type === 'code') {
          return <CodeSnippetBlock key={idx} language={block.language} code={block.code} />;
        }
        if (block.type === 'heading') {
          const sizeClass =
            block.level === 1
              ? 'text-base font-bold'
              : block.level === 2
              ? 'text-sm font-bold'
              : 'text-sm font-semibold';
          return (
            <p key={idx} className={sizeClass}>
              <InlineSegmentsView text={block.text} isUser={isUser} />
            </p>
          );
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag
              key={idx}
              className={`space-y-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
            >
              {block.items.map((itemText, itemIdx) => (
                <li key={itemIdx}>
                  <InlineSegmentsView text={itemText} isUser={isUser} />
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <p key={idx} className="leading-relaxed">
            <InlineSegmentsView text={block.text} isUser={isUser} />
          </p>
        );
      })}
    </div>
  );
};

export const AssistantWorkspace: React.FC<AssistantWorkspaceProps> = ({
  userProfile,
  needsAuth,
  isLoggingIn,
  authError,
  onGoogleLogin,
  messages,
  memories,
  webSearchEnabled,
  onToggleWebSearch,
  tokenSaverEnabled,
  onToggleTokenSaver,
  isSending,
  isTranscribing,
  chatError,
  isQuotaError = false,
  retryCooldownSeconds = 0,
  onSendMessage,
  onSendVoiceCommand,
  onTranscribeVoiceToText,
  autoVoiceEnabled,
  onToggleAutoVoice,
  playingMessageId,
  loadingAudioMessageId,
  onToggleMessageAudio,
  onRetryLastAction,
  onResetConversation,
  routines,
  prefilledDraft,
  onConsumePrefilledDraft,
  onNavigateTab,
}) => {
  const [inputText, setInputText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [showSystemContext, setShowSystemContext] = useState(false);

  // State lampiran gambar multimodal
  const [pendingImage, setPendingImage] = useState<{
    attachment: AuraImageAttachment;
    previewUrl: string;
  } | null>(null);
  const [isOptimizingImage, setIsOptimizingImage] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  // State perekam perintah suara hibrida (Browser SpeechRecognition + 16kHz RIFF WAV)
  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizingVoice, setIsFinalizingVoice] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [micSignalStep, setMicSignalStep] = useState(0);
  const [liveSpeechPreview, setLiveSpeechPreview] = useState('');
  const [availableMics, setAvailableMics] = useState<Array<{ deviceId: string; label: string }>>(
    []
  );
  const [selectedMicId, setSelectedMicId] = useState<string>(() => {
    try {
      return window.localStorage.getItem(PREFERRED_MIC_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recorderMimeRef = useRef<string>('audio/webm');

  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const pcmTotalSamplesRef = useRef<number>(0);
  const pcmSampleRateRef = useRef<number>(48000);
  const maxObservedPeakRef = useRef<number>(0);
  const instantPeakRef = useRef<number>(0);

  const speechRecognitionRef = useRef<BrowserSpeechRecognitionLike | null>(null);
  const completedSpeechSessionsRef = useRef<string[]>([]);
  const currentSessionFinalsRef = useRef<string>('');
  const currentSessionInterimRef = useRef<string>('');
  const speechEndResolverRef = useRef<(() => void) | null>(null);

  const isStoppingRecordingRef = useRef<boolean>(false);
  const timerIntervalRef = useRef<number | null>(null);
  const levelIntervalRef = useRef<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshAudioInputDevices = useCallback(async () => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.enumerateDevices !== 'function'
    ) {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices
        .filter((d) => d.kind === 'audioinput' && d.deviceId)
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label?.trim() || `Mikrofon ${idx + 1}`,
        }));
      setAvailableMics(audioInputs);
    } catch {
      // Abaikan bila enumerasi perangkat dibatasi sebelum izin diberikan
    }
  }, []);

  useEffect(() => {
    void refreshAudioInputDevices();
  }, [refreshAudioInputDevices]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending, isTranscribing]);

  useEffect(() => {
    if (prefilledDraft) {
      setInputText(prefilledDraft);
      if (onConsumePrefilledDraft) onConsumePrefilledDraft();
      composerRef.current?.focus();
    }
  }, [prefilledDraft, onConsumePrefilledDraft]);

  const cleanupRecordingResources = useCallback(() => {
    isStoppingRecordingRef.current = true;

    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (levelIntervalRef.current !== null) {
      window.clearInterval(levelIntervalRef.current);
      levelIntervalRef.current = null;
    }

    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.onresult = null;
        speechRecognitionRef.current.onerror = null;
        speechRecognitionRef.current.onend = null;
        speechRecognitionRef.current.abort();
      } catch {
        // Abaikan error saat menghentikan SpeechRecognition
      }
      speechRecognitionRef.current = null;
    }

    if (scriptProcessorRef.current) {
      try {
        scriptProcessorRef.current.onaudioprocess = null;
        scriptProcessorRef.current.disconnect();
      } catch {
        // Abaikan error saat melepas node audio
      }
      scriptProcessorRef.current = null;
    }

    if (audioContextRef.current) {
      const ctx = audioContextRef.current;
      audioContextRef.current = null;
      void ctx.close().catch(() => {});
    }

    if (mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.onstop = null;
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // Abaikan bila recorder sudah berhenti
      }
      mediaRecorderRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    setIsRecording(false);
    setRecordingSeconds(0);
    setMicSignalStep(0);
    setLiveSpeechPreview('');
  }, []);

  useEffect(() => {
    return () => {
      cleanupRecordingResources();
    };
  }, [cleanupRecordingResources]);

  const handleAttachImageFile = async (file: File | null | undefined) => {
    if (!file) return;
    setInputError(null);
    setIsOptimizingImage(true);
    try {
      const optimized = await prepareOptimizedImageAttachment(file);
      setPendingImage(optimized);
      composerRef.current?.focus();
    } catch (err: unknown) {
      setInputError(
        err instanceof Error ? err.message : 'Gagal memproses berkas gambar.'
      );
    } finally {
      setIsOptimizingImage(false);
      if (imageInputRef.current) {
        imageInputRef.current.value = '';
      }
    }
  };

  const handleComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void handleAttachImageFile(file);
          return;
        }
      }
    }
  };

  const handleDropOnConversation = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) {
      void handleAttachImageFile(file);
    } else if (file) {
      setInputError('Hanya berkas gambar (JPG, PNG, WEBP, GIF) yang dapat dilampirkan.');
    }
  };

  const handleMicSelectionChange = (newDeviceId: string) => {
    setSelectedMicId(newDeviceId);
    try {
      if (newDeviceId) {
        window.localStorage.setItem(PREFERRED_MIC_STORAGE_KEY, newDeviceId);
      } else {
        window.localStorage.removeItem(PREFERRED_MIC_STORAGE_KEY);
      }
    } catch {
      // Abaikan bila localStorage tidak tersedia
    }
  };

  const startVoiceRecording = async (overrideMicId?: string) => {
    if (isSending || isTranscribing || isRecording || isFinalizingVoice) return;
    setInputError(null);

    const SpeechRecognitionCtor = getBrowserSpeechRecognitionCtor();
    const hasGetUserMedia =
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices) &&
      typeof navigator.mediaDevices.getUserMedia === 'function';

    if (!hasGetUserMedia && !SpeechRecognitionCtor) {
      setInputError(
        'Peramban ini belum mendukung akses mikrofon maupun pengenalan suara langsung. Silakan ketik pesan Anda.'
      );
      return;
    }

    try {
      isStoppingRecordingRef.current = false;
      recordedChunksRef.current = [];
      pcmChunksRef.current = [];
      pcmTotalSamplesRef.current = 0;
      maxObservedPeakRef.current = 0;
      instantPeakRef.current = 0;
      completedSpeechSessionsRef.current = [];
      currentSessionFinalsRef.current = '';
      currentSessionInterimRef.current = '';
      speechEndResolverRef.current = null;
      setLiveSpeechPreview('');
      setMicSignalStep(0);

      const effectiveMicId = overrideMicId !== undefined ? overrideMicId : selectedMicId;

      let stream: MediaStream | null = null;
      if (hasGetUserMedia) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
              ...(effectiveMicId ? { deviceId: { ideal: effectiveMicId } } : {}),
            },
          });
        } catch (constraintErr: unknown) {
          const errName = (constraintErr as { name?: string })?.name || '';
          if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
            throw constraintErr;
          }
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      }

      if (stream) {
        mediaStreamRef.current = stream;
        const activeTrack = stream.getAudioTracks()[0];
        const activeDeviceId = activeTrack?.getSettings?.()?.deviceId;
        if (activeDeviceId && !effectiveMicId) {
          setSelectedMicId(activeDeviceId);
        }
        void refreshAudioInputDevices();

        // 1. Perekam PCM Web Audio 16kHz + Pengukur Sinyal Suara Langsung
        const AudioCtxCtor = getBrowserAudioContextCtor();
        if (AudioCtxCtor) {
          try {
            const audioCtx = new AudioCtxCtor();
            audioContextRef.current = audioCtx;
            if (audioCtx.state === 'suspended') {
              await audioCtx.resume();
            }
            pcmSampleRateRef.current = audioCtx.sampleRate || 48000;

            const sourceNode = audioCtx.createMediaStreamSource(stream);
            const processor = audioCtx.createScriptProcessor(4096, 1, 1);
            const silentGain = audioCtx.createGain();
            silentGain.gain.value = 0;

            const maxAllowedSamples = Math.round(pcmSampleRateRef.current * 90);
            processor.onaudioprocess = (audioEvent: AudioProcessingEvent) => {
              if (isStoppingRecordingRef.current) return;
              const inputChannel = audioEvent.inputBuffer.getChannelData(0);
              let blockPeak = 0;
              for (let i = 0; i < inputChannel.length; i++) {
                const abs = Math.abs(inputChannel[i]);
                if (abs > blockPeak) blockPeak = abs;
              }
              if (blockPeak > maxObservedPeakRef.current) {
                maxObservedPeakRef.current = blockPeak;
              }
              if (blockPeak > instantPeakRef.current) {
                instantPeakRef.current = blockPeak;
              }

              if (pcmTotalSamplesRef.current < maxAllowedSamples) {
                const copy = new Float32Array(inputChannel.length);
                copy.set(inputChannel);
                pcmChunksRef.current.push(copy);
                pcmTotalSamplesRef.current += copy.length;
              }
            };

            sourceNode.connect(processor);
            processor.connect(silentGain);
            silentGain.connect(audioCtx.destination);
            scriptProcessorRef.current = processor;

            levelIntervalRef.current = window.setInterval(() => {
              const currentPeak = instantPeakRef.current;
              instantPeakRef.current = currentPeak * 0.45;
              setMicSignalStep(quantizeMicSignalStep(currentPeak));
            }, 125);
          } catch {
            // Bila Web Audio gagal diinisialisasi, MediaRecorder & SpeechRecognition tetap berjalan
          }
        }

        // 2. Cadangan MediaRecorder dengan timeslice 250ms agar potongan audio selalu tersimpan utuh
        if (typeof MediaRecorder !== 'undefined') {
          try {
            const preferredMime = pickSupportedRecorderMime();
            const recorder = preferredMime
              ? new MediaRecorder(stream, { mimeType: preferredMime })
              : new MediaRecorder(stream);
            recorderMimeRef.current = recorder.mimeType || preferredMime || 'audio/webm';
            recorder.ondataavailable = (event: BlobEvent) => {
              if (event.data && event.data.size > 0) {
                recordedChunksRef.current.push(event.data);
              }
            };
            recorder.start(250);
            mediaRecorderRef.current = recorder;
          } catch {
            // Abaikan bila MediaRecorder tidak tersedia karena PCM WAV & SpeechRecognition aktif
          }
        }
      }

      // 3. Pengenalan Ucapan Langsung Browser (Web Speech API Bahasa Indonesia + istilah teknis)
      if (SpeechRecognitionCtor) {
        try {
          const recognition = new SpeechRecognitionCtor();
          recognition.lang = 'id-ID';
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.maxAlternatives = 1;

          recognition.onresult = (event: SpeechRecognitionEventLike) => {
            const finals: string[] = [];
            const interims: string[] = [];
            for (let i = 0; i < event.results.length; i++) {
              const res = event.results[i];
              const transcriptPiece = res?.[0]?.transcript || '';
              if (!transcriptPiece.trim()) continue;
              if (res.isFinal) {
                finals.push(transcriptPiece.trim());
              } else {
                interims.push(transcriptPiece.trim());
              }
            }
            currentSessionFinalsRef.current = finals.join(' ');
            currentSessionInterimRef.current = interims.join(' ');

            const preview = mergeSpeechTranscriptParts(
              [...completedSpeechSessionsRef.current, currentSessionFinalsRef.current],
              currentSessionInterimRef.current
            );
            setLiveSpeechPreview(preview);
            if (preview) {
              // Bila kata terbaca meskipun AudioContext ditahan kebijakan peramban, beri indikator sinyal aktif
              setMicSignalStep((prev) => (prev < 3 ? 3 : prev));
            }
          };

          recognition.onerror = () => {
            // Jangan hentikan perekaman bila Web Speech gagal (mis. jaringan/kebijakan iframe),
            // karena perekam WAV 16kHz siap mengirim ke Gemini /api/aura/transcribe!
          };

          recognition.onend = () => {
            const committedFromSession = mergeSpeechTranscriptParts(
              [currentSessionFinalsRef.current],
              isStoppingRecordingRef.current ? currentSessionInterimRef.current : ''
            );
            if (committedFromSession) {
              completedSpeechSessionsRef.current.push(committedFromSession);
              currentSessionFinalsRef.current = '';
              currentSessionInterimRef.current = '';
            }

            if (isStoppingRecordingRef.current) {
              if (speechEndResolverRef.current) {
                const resolve = speechEndResolverRef.current;
                speechEndResolverRef.current = null;
                resolve();
              }
              return;
            }

            // Mulai ulang otomatis bila peramban menghentikan sesi saat jeda napas singkat
            try {
              recognition.start();
            } catch {
              // Abaikan bila peramban menolak start ulang
            }
          };

          recognition.start();
          speechRecognitionRef.current = recognition;
        } catch {
          speechRecognitionRef.current = null;
        }
      }

      setIsRecording(true);
      setRecordingSeconds(0);
      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err: unknown) {
      cleanupRecordingResources();
      const errName = (err as { name?: string })?.name || '';
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        setInputError(
          'Izin mikrofon ditolak oleh peramban. Berikan izin akses mikrofon pada bilah alamat untuk menggunakan perintah suara.'
        );
      } else {
        setInputError(
          'Tidak dapat mengakses mikrofon perangkat. Pastikan mikrofon terhubung dan tidak sedang dikunci aplikasi lain.'
        );
      }
    }
  };

  const finishVoiceRecording = async (intent: 'send' | 'insert') => {
    if (!isRecording || isStoppingRecordingRef.current) return;
    isStoppingRecordingRef.current = true;
    setIsFinalizingVoice(true);
    setInputError(null);

    try {
      // 1. Beri waktu singkat (~220ms) agar Web Speech API menyelesaikan suku kata terakhir
      if (speechRecognitionRef.current) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finishWait = () => {
            if (settled) return;
            settled = true;
            speechEndResolverRef.current = null;
            resolve();
          };
          speechEndResolverRef.current = finishWait;
          window.setTimeout(finishWait, 220);
          try {
            speechRecognitionRef.current?.stop();
          } catch {
            finishWait();
          }
        });
      }

      // 2. Pastikan potongan terakhir MediaRecorder ikut terbaca bila diperlukan sebagai cadangan
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          const rec = mediaRecorderRef.current;
          if (!rec || rec.state === 'inactive') {
            resolve();
            return;
          }
          let done = false;
          const finishStop = () => {
            if (done) return;
            done = true;
            resolve();
          };
          rec.onstop = finishStop;
          window.setTimeout(finishStop, 200);
          try {
            rec.requestData();
            rec.stop();
          } catch {
            finishStop();
          }
        });
      }

      const rawLocalSpeech = mergeSpeechTranscriptParts(
        [...completedSpeechSessionsRef.current, currentSessionFinalsRef.current],
        currentSessionInterimRef.current
      );
      const localTranscript = cleanTranscribedText(rawLocalSpeech);

      const pcmChunks = [...pcmChunksRef.current];
      const pcmSampleRate = pcmSampleRateRef.current;
      const fallbackChunks = [...recordedChunksRef.current];
      const fallbackMime = normalizeAudioMimeType(recorderMimeRef.current);

      cleanupRecordingResources();

      // Jalur Utama Cepat: Bila pengenalan suara langsung berhasil membaca ucapan dengan jelas,
      // langsung gunakan hasilnya tanpa risiko gagal kontainer audio maupun kuota API tambahan!
      if (localTranscript) {
        if (intent === 'insert') {
          setInputText((prev) => (prev.trim() ? `${prev.trim()} ${localTranscript}` : localTranscript));
          composerRef.current?.focus();
        } else {
          await onSendMessage(localTranscript, { isVoiceCommand: true });
        }
        return;
      }

      // Jalur Cadangan Server: Konversi rekaman PCM mikrofon ke WAV 16kHz mono ter-normalisasi gain
      if (pcmChunks.length > 0) {
        const processed = downsampleAndNormalizePcm(pcmChunks, pcmSampleRate, 16000);
        if (processed.samples.length < 2400) {
          setInputError('Durasi rekaman terlalu singkat. Ucapkan perintah selama minimal 1 detik.');
          return;
        }
        if (processed.peak < 0.0012) {
          setInputError(
            'Mikrofon aktif namun tidak ada gelombang suara yang masuk (sinyal hening 0%). Pastikan tombol mute fisik pada mikrofon/headset tidak aktif, atau pilih perangkat mikrofon lain di bawah.'
          );
          return;
        }

        const wavBase64 = encodeFloat32PcmToWavBase64(processed.samples, 16000);
        if (intent === 'insert' && onTranscribeVoiceToText) {
          const text = await onTranscribeVoiceToText(wavBase64, 'audio/wav');
          if (text) {
            setInputText((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
            composerRef.current?.focus();
          }
        } else {
          await onSendVoiceCommand(wavBase64, 'audio/wav');
        }
        return;
      }

      // Jalur Cadangan Terakhir: Blob MediaRecorder bila Web Audio API tidak tersedia di perangkat
      if (fallbackChunks.length > 0) {
        const audioBlob = new Blob(fallbackChunks, { type: fallbackMime });
        if (audioBlob.size >= 256) {
          const base64Audio = await blobToBase64(audioBlob);
          if (intent === 'insert' && onTranscribeVoiceToText) {
            const text = await onTranscribeVoiceToText(base64Audio, fallbackMime);
            if (text) {
              setInputText((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
              composerRef.current?.focus();
            }
          } else {
            await onSendVoiceCommand(base64Audio, fallbackMime);
          }
          return;
        }
      }

      setInputError(
        'Suara belum berhasil ditangkap dari mikrofon. Pastikan mikrofon tidak di-mute lalu coba ucapkan kembali.'
      );
    } catch (err: unknown) {
      cleanupRecordingResources();
      setInputError(
        err instanceof Error ? err.message : 'Gagal memproses rekaman suara Anda.'
      );
    } finally {
      setIsFinalizingVoice(false);
    }
  };

  const cancelVoiceRecording = () => {
    cleanupRecordingResources();
  };

  const activeSystemInstruction =
    messages[messages.length - 1]?.injectedSystemInstruction ||
    buildAuraSystemInstruction({
      displayName: userProfile?.displayName || '{nama_pengguna}',
      routines,
      memories,
      tokenSaver: tokenSaverEnabled,
      hasImageAttachment: Boolean(pendingImage),
    });

  const lastTokenUsage = [...messages]
    .reverse()
    .find((m) => m.role === 'model' && m.tokenUsage)?.tokenUsage;

  const submitCurrentMessage = async () => {
    const trimmed = inputText.trim();
    if (!trimmed && !pendingImage) {
      setInputError(
        'Masukkan pesan, lampirkan gambar, atau rekam perintah suara untuk A.U.R.A terlebih dahulu.'
      );
      return;
    }

    const messageToSend =
      trimmed ||
      'Aura, tolong amati gambar ini secara saksama dan jelaskan poin pentingnya agar dapat kita bahas lebih lanjut.';

    const imageSnapshot = pendingImage;
    setInputError(null);
    setInputText('');
    setPendingImage(null);

    await onSendMessage(messageToSend, {
      imageAttachment: imageSnapshot?.attachment,
      imagePreviewUrl: imageSnapshot?.previewUrl,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitCurrentMessage();
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isSending && !isTranscribing && !isOptimizingImage) {
        void submitCurrentMessage();
      }
    }
  };

  const isBusy = isSending || isTranscribing || isOptimizingImage || isFinalizingVoice;

  if (needsAuth || !userProfile) {
    return (
      <div className="mx-auto max-w-5xl space-y-10 py-4">
        {/* Hero Authentication Section */}
        <section className="grid grid-cols-1 items-stretch gap-8 lg:grid-cols-12">
          <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-8 lg:col-span-7">
            <div className="space-y-4">
              <p className="text-xs font-medium text-slate-500">
                Mode Hemat Token · Diskusi Gambar Multimodal · Riset Web · Ingatan Tersinkron
              </p>
              <h1 className="max-w-xl text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance] sm:text-4xl">
                Asisten pribadi A.U.R.A yang lembut, hemat token, dan siap membahas gambar maupun kode Anda
              </h1>
              <p className="max-w-xl text-base leading-relaxed text-slate-600">
                Masuk menggunakan Akun Google agar A.U.R.A mengenali{' '}
                <span className="font-semibold text-slate-900">Display Name</span> Anda, menerima{' '}
                <span className="font-semibold text-slate-900">lampiran gambar</span> (diagram,
                dokumen, atau tangkapan layar kode) untuk dibahas berlanjut, menelusuri fakta web,
                dan menghemat pemakaian token secara cerdas.
              </p>
            </div>

            <div className="mt-8 space-y-4 border-t border-slate-100 pt-6">
              <div className="flex flex-wrap items-center gap-4">
                <GoogleSignInButton
                  onClick={onGoogleLogin}
                  isLoading={isLoggingIn}
                  label="Sign in with Google"
                />
                <button
                  type="button"
                  onClick={() => onNavigateTab('architecture')}
                  className="inline-flex h-11 items-center gap-2 rounded-lg px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 whitespace-nowrap shrink-0"
                >
                  <span>Uji Simulator Hemat Token</span>
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              {authError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
                >
                  {authError}
                </div>
              )}

              <p className="text-xs leading-relaxed text-slate-500">
                Panggil <strong className="font-semibold text-slate-700">&ldquo;Aura,...&rdquo;</strong>{' '}
                di awal kalimat kapan saja untuk mendapatkan konfirmasi sapaan yang hangat dan
                menenangkan. Gambar yang Anda lampirkan otomatis dioptimalkan hingga &le;1024px agar
                sangat hemat token.
              </p>
            </div>
          </div>

          {/* Live System Instruction Preview Panel */}
          <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-slate-900 p-7 text-slate-100 lg:col-span-5">
            <div className="space-y-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Arsitektur Hemat Token &amp; Multimodal</span>
                <span className="font-mono tabular-nums">server.ts</span>
              </div>
              <h2 className="text-lg font-semibold tracking-wide text-white">
                Optimasi Konteks &amp; Diskusi Gambar
              </h2>
              <pre className="rounded-lg bg-slate-950 p-4 text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-300">
                <code>{`Mode Hemat Token Aktif:
- ThinkingLevel.LOW pada model Gemini 3
- Seleksi memori relevan (bukan kirim semua)
- Smart Gating: Google Search hanya saat riset/URL
- Kompresi gambar <=1024px & retensi 1 gambar aktif

Persona & Aturan Sapaan "Aura":
"Ya, saya mendengarkan..." / "Ada yang bisa Aura bantu?"`}</code>
              </pre>
            </div>

            <div className="mt-6 border-t border-slate-800 pt-4 text-xs leading-relaxed text-slate-400">
              Unggah atau tempel (<code className="text-slate-200">Ctrl+V</code>) gambar apa pun di
              kolom pesan untuk dianalisis dan ditanyakan kembali pada pesan-pesan berikutnya.
            </div>
          </div>
        </section>

        {/* 4-Step Capabilities Summary */}
        <section aria-labelledby="workflow-heading" className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 id="workflow-heading" className="text-lg font-semibold text-slate-900">
              Ekosistem Kapabilitas Lintas Perangkat A.U.R.A
            </h2>
            <span className="text-xs text-slate-500">Efisien &amp; Multimodal</span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="font-mono text-xs text-slate-400 tabular-nums">01. Hemat Token</p>
              <h3 className="mt-1.5 text-sm font-semibold text-slate-900">
                Efisiensi Kuota Cerdas
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600">
                Memangkas memori tak relevan, membatasi jendela riwayat, dan memanggil pencarian web
                hanya saat dibutuhkan.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="font-mono text-xs text-slate-400 tabular-nums">02. Diskusi Gambar</p>
              <h3 className="mt-1.5 text-sm font-semibold text-slate-900">
                Unggah, Tempel &amp; Bahas
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600">
                Kirim foto, diagram, atau tangkapan layar bug lalu ajukan pertanyaan lanjutan tanpa
                perlu mengunggah ulang.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="font-mono text-xs text-slate-400 tabular-nums">03. Riset &amp; Kode</p>
              <h3 className="mt-1.5 text-sm font-semibold text-slate-900">
                Verifikasi Fakta &amp; Debugging
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600">
                Menelusuri sumber web kredibel serta memperbaiki bug pemrograman lengkap dengan blok
                kode siap salin.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="font-mono text-xs text-slate-400 tabular-nums">04. Persona Lembut</p>
              <h3 className="mt-1.5 text-sm font-semibold text-slate-900">
                Sapaan Hangat &amp; Memori
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-600">
                Tutur kata perempuan sabar &amp; menenangkan yang selalu mengingat hasil diskusi di
                Cloud Firestore.
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      {/* Authenticated Identity, Token Saver, Web Grounding, Memory & Voice Controls Header */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            {userProfile.photoUrl ? (
              <img
                src={userProfile.photoUrl}
                alt={`Foto profil ${userProfile.displayName}`}
                referrerPolicy="no-referrer"
                className="h-11 w-11 rounded-full border border-slate-200 object-cover"
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white"
              >
                {userProfile.displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold text-slate-900">
                  {userProfile.displayName}
                </h1>
                <ShieldCheck className="h-4 w-4 text-blue-600" aria-hidden="true" />
              </div>
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500">
                <span>{userProfile.email}</span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={() => onNavigateTab('memories')}
                  className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline tabular-nums"
                >
                  <Brain className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{memories.length} ingatan tersinkron</span>
                </button>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onToggleTokenSaver}
              aria-pressed={tokenSaverEnabled}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                tokenSaverEnabled
                  ? 'border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Leaf className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{tokenSaverEnabled ? 'Hemat Token: Aktif' : 'Hemat Token: Nonaktif'}</span>
            </button>

            <button
              type="button"
              onClick={onToggleWebSearch}
              aria-pressed={webSearchEnabled}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                webSearchEnabled
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{webSearchEnabled ? 'Riset Web: Aktif' : 'Riset Web: Nonaktif'}</span>
            </button>

            <button
              type="button"
              onClick={onToggleAutoVoice}
              aria-pressed={autoVoiceEnabled}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                autoVoiceEnabled
                  ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {autoVoiceEnabled ? (
                <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{autoVoiceEnabled ? 'Suara AI: Aktif' : 'Suara AI: Nonaktif'}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowSystemContext((prev) => !prev)}
              aria-expanded={showSystemContext}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 whitespace-nowrap shrink-0"
            >
              <span>Inspeksi Konteks</span>
              {showSystemContext ? (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>

            <button
              type="button"
              onClick={onResetConversation}
              disabled={isBusy}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Sesi Baru</span>
            </button>
          </div>
        </div>

        {showSystemContext && (
          <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>
                Konteks sistem aktif (~
                <strong className="font-mono text-slate-800">
                  {estimateApproximateTokens(activeSystemInstruction)}
                </strong>{' '}
                token instruksi):
              </span>
              {lastTokenUsage && (
                <span className="font-mono text-slate-700 tabular-nums">
                  Respons terakhir: {lastTokenUsage.promptTokens} in + {lastTokenUsage.outputTokens}{' '}
                  out = {lastTokenUsage.totalTokens} total token
                </span>
              )}
            </div>
            <pre className="max-h-72 overflow-y-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-100">
              <code>{activeSystemInstruction}</code>
            </pre>
          </div>
        )}
      </section>

      {/* Conversation Viewport (Supports Drag & Drop Image) */}
      <section
        aria-label="Percakapan dengan A.U.R.A"
        onDragOver={(e) => {
          e.preventDefault();
          if (!isDragOver) setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDropOnConversation}
        className={`flex min-h-[480px] flex-col justify-between rounded-xl border bg-white transition-colors ${
          isDragOver ? 'border-blue-500 bg-blue-50/20' : 'border-slate-200'
        }`}
      >
        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          {messages.length === 0 && !isBusy ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium text-slate-900">
                Aura siap mendampingi {userProfile.displayName} dengan lembut &amp; hemat token
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">
                Panggil &ldquo;Aura&rdquo;, lampirkan gambar atau tangkapan layar untuk dibahas
                lebih lanjut, minta verifikasi fakta web, atau tekan tombol Suara.
              </p>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              const isPlayingThis = playingMessageId === msg.id;
              const isLoadingAudioThis = loadingAudioMessageId === msg.id;
              const hasCitations =
                !isUser &&
                ((msg.sources && msg.sources.length > 0) ||
                  (msg.searchQueries && msg.searchQueries.length > 0));

              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                    <span className="font-medium text-slate-700">
                      {isUser ? userProfile.displayName : 'A.U.R.A'}
                    </span>
                    {isUser && msg.isVoiceCommand && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-slate-500">Perintah Suara</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {new Date(msg.timestamp).toLocaleTimeString('id-ID', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {!isUser && (
                      <>
                        <span aria-hidden="true">·</span>
                        <button
                          type="button"
                          onClick={() => onToggleMessageAudio(msg)}
                          disabled={isLoadingAudioThis}
                          aria-label={
                            isPlayingThis
                              ? `Hentikan suara balasan A.U.R.A #${idx + 1}`
                              : `Putar suara balasan A.U.R.A #${idx + 1}`
                          }
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-50 disabled:opacity-60 whitespace-nowrap shrink-0"
                        >
                          {isPlayingThis ? (
                            <>
                              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                              <span>Hentikan Suara</span>
                            </>
                          ) : (
                            <>
                              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>
                                {isLoadingAudioThis ? 'Memuat Suara...' : 'Putar Suara'}
                              </span>
                            </>
                          )}
                        </button>
                      </>
                    )}
                  </div>

                  <div
                    className={`max-w-3xl rounded-xl px-4 py-3 text-sm ${
                      isUser
                        ? 'bg-blue-600 text-white'
                        : 'border border-slate-200 bg-slate-50 text-slate-900'
                    }`}
                  >
                    {msg.imagePreviewUrl ? (
                      <div className="mb-3 space-y-1.5">
                        <img
                          src={msg.imagePreviewUrl}
                          alt={msg.attachmentLabel || 'Lampiran gambar pengguna'}
                          className="max-h-64 w-auto rounded-lg border border-blue-400/40 bg-slate-950/10 object-contain"
                        />
                        {msg.attachmentLabel && (
                          <p className="text-[11px] text-blue-100">{msg.attachmentLabel}</p>
                        )}
                      </div>
                    ) : msg.attachmentLabel ? (
                      <div
                        className={`mb-2.5 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
                          isUser
                            ? 'bg-blue-700/80 text-blue-50'
                            : 'border border-slate-200 bg-white text-slate-700'
                        }`}
                      >
                        <ImagePlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>Lampiran Gambar: {msg.attachmentLabel}</span>
                      </div>
                    ) : null}

                    <FormattedMessageContent text={msg.text} isUser={isUser} />

                    {hasCitations && (
                      <div className="mt-3 space-y-2 border-t border-slate-200/80 pt-3">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                          <Globe className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                          <span>Sumber Informasi &amp; Verifikasi Fakta</span>
                        </div>

                        {msg.sources && msg.sources.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {msg.sources.map((source) => (
                              <a
                                key={source.uri}
                                href={source.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex max-w-xs items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-50"
                              >
                                <span className="truncate">{source.title || source.domain}</span>
                                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                              </a>
                            ))}
                          </div>
                        )}

                        {msg.searchQueries && msg.searchQueries.length > 0 && (
                          <p className="text-[11px] text-slate-500">
                            Telusur: {msg.searchQueries.join(' · ')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {isTranscribing && (
            <div className="flex flex-col items-end" role="status" aria-live="polite">
              <span className="mb-1 text-xs font-medium text-slate-700">
                {userProfile.displayName} · Perintah Suara
              </span>
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                Mentranskripsikan perintah suara Anda...
              </div>
            </div>
          )}

          {isSending && (
            <div className="flex flex-col items-start" role="status" aria-live="polite">
              <span className="mb-1 text-xs font-medium text-slate-700">A.U.R.A</span>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                Aura sedang mengamati konteks &amp; menyusun jawaban lembut untuk{' '}
                {userProfile.displayName}...
              </div>
            </div>
          )}

          {chatError && (
            <div
              role="alert"
              className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
                isQuotaError
                  ? 'border-amber-300 bg-amber-50 text-amber-950'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              <div className="space-y-1">
                <p className="font-medium leading-relaxed">{chatError}</p>
                {isQuotaError && (
                  <p className="text-xs text-amber-800">
                    Tips: Anda juga dapat menonaktifkan sementara tombol Telusur Web di atas untuk
                    menghemat kuota pencarian harian pada kunci tier gratis.
                  </p>
                )}
              </div>
              {onRetryLastAction && (
                <button
                  type="button"
                  disabled={isBusy || retryCooldownSeconds > 0}
                  onClick={onRetryLastAction}
                  className={`inline-flex h-8 items-center rounded-md border bg-white px-3 text-xs font-semibold transition-colors disabled:opacity-60 whitespace-nowrap shrink-0 ${
                    isQuotaError
                      ? 'border-amber-400 text-amber-900 hover:bg-amber-100'
                      : 'border-red-300 text-red-700 hover:bg-red-100'
                  }`}
                >
                  {retryCooldownSeconds > 0
                    ? `Coba Lagi (${retryCooldownSeconds}d)`
                    : 'Coba Lagi'}
                </button>
              )}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Prompt Starters & Multimodal (Text + Image + Voice) Composer */}
        <div className="border-t border-slate-200 bg-slate-50/70 p-4">
          <div className="mb-3 flex flex-wrap gap-2">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={isBusy || isRecording}
                onClick={() => {
                  setInputError(null);
                  void onSendMessage(prompt);
                }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
              >
                {prompt}
              </button>
            ))}
          </div>

          {/* Pending Image Attachment Preview Bar */}
          {pendingImage && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50/60 p-2.5">
              <div className="flex min-w-0 items-center gap-3">
                <img
                  src={pendingImage.previewUrl}
                  alt={`Pratinjau ${pendingImage.attachment.label}`}
                  className="h-12 w-12 shrink-0 rounded-md border border-slate-200 bg-white object-cover"
                />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-slate-900">
                    {pendingImage.attachment.label}
                  </p>
                  <p className="text-[11px] text-slate-600">
                    Dioptimalkan untuk hemat token · Siap dibahas berlanjut oleh A.U.R.A
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPendingImage(null)}
                aria-label="Hapus lampiran gambar"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          )}

          {isRecording ? (
            <div
              role="region"
              aria-label="Status perekaman perintah suara"
              className="space-y-2.5 rounded-lg border border-blue-200 bg-blue-50/70 p-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3 text-sm font-medium text-slate-900">
                  <span className="inline-flex items-center gap-2 text-red-700">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600"
                    />
                    <span>Mendengarkan</span>
                  </span>
                  <span className="font-mono text-xs text-slate-600 tabular-nums">
                    {formatRecordingSeconds(recordingSeconds)}
                  </span>

                  {/* Indikator 5-bar kekuatan sinyal mikrofon real-time */}
                  <div
                    role="meter"
                    aria-label="Kekuatan sinyal mikrofon"
                    aria-valuemin={0}
                    aria-valuemax={5}
                    aria-valuenow={micSignalStep}
                    className="inline-flex items-end gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1"
                  >
                    {[1, 2, 3, 4, 5].map((barIdx) => {
                      const heightClass =
                        barIdx === 1
                          ? 'h-2'
                          : barIdx === 2
                          ? 'h-2.5'
                          : barIdx === 3
                          ? 'h-3'
                          : barIdx === 4
                          ? 'h-3.5'
                          : 'h-4';
                      const active = micSignalStep >= barIdx;
                      return (
                        <span
                          key={barIdx}
                          aria-hidden="true"
                          className={`w-1 rounded-xs transition-colors ${heightClass} ${
                            active ? 'bg-emerald-600' : 'bg-slate-200'
                          }`}
                        />
                      );
                    })}
                    <span className="ml-1.5 text-[11px] font-medium text-slate-600">
                      {micSignalStep > 0 ? 'Suara masuk' : 'Menunggu suara...'}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={isFinalizingVoice}
                    onClick={cancelVoiceRecording}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Batal</span>
                  </button>
                  <button
                    type="button"
                    disabled={isFinalizingVoice}
                    onClick={() => void finishVoiceRecording('insert')}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-3 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-50 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <span>Ke Teks</span>
                  </button>
                  <button
                    type="button"
                    disabled={isFinalizingVoice}
                    onClick={() => void finishVoiceRecording('send')}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{isFinalizingVoice ? 'Memproses...' : 'Kirim Suara'}</span>
                  </button>
                </div>
              </div>

              {/* Pratinjau Teks Ucapan Langsung & Pemilih Perangkat Mikrofon */}
              <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-relaxed text-slate-700">
                {liveSpeechPreview ? (
                  <p>
                    <span className="font-semibold text-emerald-700">Terbaca langsung: </span>
                    <span className="text-slate-900">{liveSpeechPreview}</span>
                  </p>
                ) : (
                  <p className="text-slate-500">
                    Ucapkan perintah Anda dengan jelas (misal: &ldquo;Aura, bantu saya cek rutinitas
                    hari ini&rdquo;). Audio juga direkam dalam format WAV 16kHz jernih sebagai
                    cadangan otomatis.
                  </p>
                )}
              </div>

              {availableMics.length > 1 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <label htmlFor="aura-active-mic-select" className="font-medium text-slate-700">
                    Perangkat Mikrofon:
                  </label>
                  <select
                    id="aura-active-mic-select"
                    value={selectedMicId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      handleMicSelectionChange(nextId);
                      cleanupRecordingResources();
                      window.setTimeout(() => {
                        void startVoiceRecording(nextId);
                      }, 120);
                    }}
                    className="max-w-xs rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800 focus:border-blue-600 focus:outline-none"
                  >
                    {availableMics.map((mic) => (
                      <option key={mic.deviceId} value={mic.deviceId}>
                        {mic.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-2">
              <input
                ref={imageInputRef}
                id="aura-image-upload"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => void handleAttachImageFile(e.target.files?.[0])}
                className="sr-only"
              />
              <div className="flex items-end gap-2">
                <label htmlFor="aura-message-input" className="sr-only">
                  Pesan, pertanyaan gambar, atau potongan kode untuk A.U.R.A
                </label>
                <textarea
                  ref={composerRef}
                  id="aura-message-input"
                  rows={2}
                  value={inputText}
                  onChange={(e) => {
                    setInputText(e.target.value);
                    if (inputError) setInputError(null);
                  }}
                  onKeyDown={handleComposerKeyDown}
                  onPaste={handleComposerPaste}
                  disabled={isBusy}
                  placeholder={
                    pendingImage
                      ? 'Tulis apa yang ingin dibahas dari gambar ini (atau langsung tekan Kirim)...'
                      : 'Panggil "Aura, ...", tempel/unggah gambar untuk dibahas, atau tekan Suara...'
                  }
                  className="min-h-[46px] max-h-40 min-w-0 flex-1 resize-y rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={isBusy}
                  aria-label="Lampirkan gambar untuk dibahas A.U.R.A"
                  className="inline-flex h-[46px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <ImagePlus className="h-4 w-4 text-blue-600" aria-hidden="true" />
                  <span className="hidden sm:inline">
                    {isOptimizingImage ? 'Memuat...' : 'Gambar'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void startVoiceRecording()}
                  disabled={isBusy}
                  aria-label="Rekam perintah suara untuk A.U.R.A"
                  className="inline-flex h-[46px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Mic className="h-4 w-4 text-blue-600" aria-hidden="true" />
                  <span className="hidden sm:inline">Suara</span>
                </button>
                <button
                  type="submit"
                  disabled={isBusy}
                  className="inline-flex h-[46px] items-center gap-2 rounded-lg bg-blue-600 px-4 sm:px-5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <span>Kirim</span>
                  <Send className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {availableMics.length > 1 && (
                <div className="flex flex-wrap items-center gap-2 pt-0.5 text-xs text-slate-500">
                  <label htmlFor="aura-idle-mic-select" className="font-medium text-slate-600">
                    Mikrofon aktif:
                  </label>
                  <select
                    id="aura-idle-mic-select"
                    value={selectedMicId}
                    onChange={(e) => handleMicSelectionChange(e.target.value)}
                    disabled={isBusy}
                    className="max-w-xs rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700 focus:border-blue-600 focus:outline-none"
                  >
                    {availableMics.map((mic) => (
                      <option key={mic.deviceId} value={mic.deviceId}>
                        {mic.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {inputError && (
                <p role="alert" className="text-xs font-medium text-red-600">
                  {inputError}
                </p>
              )}
            </form>
          )}
        </div>
      </section>
    </div>
  );
};
