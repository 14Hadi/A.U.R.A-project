/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { MessageSquare, Brain, CalendarCheck2, FileCode2, LogOut } from 'lucide-react';
import type {
  AuraImageAttachment,
  ChatMessage,
  MemoryCategory,
  MemoryItem,
  RoutineItem,
  UserProfile,
} from './types/aura.ts';
import {
  buildAuraSystemInstruction,
  buildLocalWelcomeGreeting,
  cleanTranscribedText,
  sanitizeStoredMemories,
  sanitizeStoredRoutines,
  stripMarkdownForSpeech,
} from './utils/auraContext.ts';
import { initAuth, googleSignIn, logoutGoogle } from './services/googleAuth.ts';
import { fetchGoogleUserProfile } from './services/profileService.ts';
import {
  addAuraRoutineToFirestore,
  clearAllUserMessagesInFirestore,
  deleteAuraMemoryFromFirestore,
  deleteAuraRoutineFromFirestore,
  persistChatMessageToFirestore,
  subscribeUserMemories,
  subscribeUserMessages,
  subscribeUserRoutines,
  toggleAuraRoutineInFirestore,
  upsertAuraMemoryInFirestore,
} from './services/firestoreMemory.ts';
import {
  AuraApiError,
  sendAuraMessage,
  transcribeAuraAudio,
  synthesizeAuraSpeech,
  UnauthorizedTokenError,
} from './services/auraApi.ts';
import { GoogleSignInButton } from './components/GoogleSignInButton.tsx';
import {
  AssistantWorkspace,
  type SendMessageOptions,
} from './components/AssistantWorkspace.tsx';
import { MemoryVault } from './components/MemoryVault.tsx';
import { RoutineManager } from './components/RoutineManager.tsx';
import { ArchitectureGuide } from './components/ArchitectureGuide.tsx';

type WorkspaceTab = 'assistant' | 'memories' | 'routines' | 'architecture';

type LastFailedAction =
  | { type: 'greeting' }
  | {
      type: 'message';
      text: string;
      isVoiceCommand?: boolean;
      imageAttachment?: AuraImageAttachment;
      imagePreviewUrl?: string;
    }
  | { type: 'voice_recording'; audioBase64: string; mimeType: string }
  | null;

const DEFAULT_ROUTINES: RoutineItem[] = [
  {
    id: 'rt-1',
    title: 'Hidrasi pagi & peregangan ringan 15 menit',
    time: '06:30',
    category: 'Kesehatan',
    completed: true,
    notes: 'Tanpa membuka layar ponsel',
  },
  {
    id: 'rt-2',
    title: 'Tinjau 3 prioritas utama & sinkronisasi agenda',
    time: '08:15',
    category: 'Fokus Kerja',
    completed: false,
    notes: 'Tentukan target harian terukur',
  },
  {
    id: 'rt-3',
    title: 'Sesi fokus pengembangan arsitektur A.U.R.A',
    time: '09:30',
    category: 'Fokus Kerja',
    completed: false,
    notes: 'Blok fokus 90 menit tanpa gangguan',
  },
  {
    id: 'rt-4',
    title: 'Evaluasi harian & persiapan jadwal esok hari',
    time: '20:30',
    category: 'Evaluasi',
    completed: false,
  },
];

function getInitialTab(): WorkspaceTab {
  if (typeof window === 'undefined') return 'assistant';
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (
    tab === 'memories' ||
    tab === 'routines' ||
    tab === 'architecture' ||
    tab === 'assistant'
  ) {
    return tab;
  }
  return 'assistant';
}

function loadSavedRoutines(storageKey: string): RoutineItem[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return DEFAULT_ROUTINES;
    const parsed: unknown = JSON.parse(raw);
    return sanitizeStoredRoutines(parsed, DEFAULT_ROUTINES);
  } catch {
    return DEFAULT_ROUTINES;
  }
}

function loadSavedLocalMemories(storageKey: string): MemoryItem[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    return sanitizeStoredMemories(JSON.parse(raw));
  } catch {
    return [];
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(getInitialTab);
  const [needsAuth, setNeedsAuth] = useState<boolean>(true);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [routines, setRoutines] = useState<RoutineItem[]>(() =>
    loadSavedRoutines('aura_routines_workspace')
  );
  const [memories, setMemories] = useState<MemoryItem[]>(() =>
    loadSavedLocalMemories('aura_memories_workspace')
  );
  const memoriesRef = useRef<MemoryItem[]>(memories);
  const routinesRef = useRef<RoutineItem[]>(routines);

  const [webSearchEnabled, setWebSearchEnabled] = useState<boolean>(true);
  const webSearchRef = useRef<boolean>(true);
  const [tokenSaverEnabled, setTokenSaverEnabled] = useState<boolean>(true);
  const tokenSaverRef = useRef<boolean>(true);
  const [prefilledDraft, setPrefilledDraft] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [isQuotaError, setIsQuotaError] = useState<boolean>(false);
  const [retryCooldownSeconds, setRetryCooldownSeconds] = useState<number>(0);
  const [lastFailedAction, setLastFailedAction] = useState<LastFailedAction>(null);
  const initializedUidSessionRef = useRef<string | null>(null);

  // State pemutaran respons suara A.U.R.A + proteksi kuota TTS (429 fallback ke Web Speech API)
  const [autoVoiceEnabled, setAutoVoiceEnabled] = useState<boolean>(true);
  const autoVoiceRef = useRef<boolean>(true);
  const ttsQuotaCooldownUntilRef = useRef<number>(0);
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [loadingAudioMessageId, setLoadingAudioMessageId] = useState<string | null>(null);
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    memoriesRef.current = memories;
  }, [memories]);

  useEffect(() => {
    routinesRef.current = routines;
  }, [routines]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    webSearchRef.current = webSearchEnabled;
  }, [webSearchEnabled]);

  useEffect(() => {
    tokenSaverRef.current = tokenSaverEnabled;
  }, [tokenSaverEnabled]);

  useEffect(() => {
    autoVoiceRef.current = autoVoiceEnabled;
  }, [autoVoiceEnabled]);

  const stopActiveAudio = useCallback(() => {
    if (activeAudioRef.current) {
      activeAudioRef.current.pause();
      activeAudioRef.current.onended = null;
      activeAudioRef.current.onerror = null;
      activeAudioRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setPlayingMessageId(null);
  }, []);

  useEffect(() => {
    return () => {
      stopActiveAudio();
    };
  }, [stopActiveAudio]);

  useEffect(() => {
    if (retryCooldownSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setRetryCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryCooldownSeconds]);

  const speakWithBrowserFallback = useCallback((msgId: string, rawText: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return false;
    }
    const cleanSpeech = stripMarkdownForSpeech(rawText);
    if (!cleanSpeech) return false;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleanSpeech);
    utterance.lang = 'id-ID';
    utterance.rate = 0.98;
    utterance.onend = () => {
      setPlayingMessageId((curr) => (curr === msgId ? null : curr));
    };
    utterance.onerror = () => {
      setPlayingMessageId((curr) => (curr === msgId ? null : curr));
    };
    setPlayingMessageId(msgId);
    window.speechSynthesis.speak(utterance);
    return true;
  }, []);

  const playMessageAudio = useCallback(
    async (msg: ChatMessage, options?: { silentIfAutoplayBlocked?: boolean }) => {
      stopActiveAudio();

      const playDataUrl = async (dataUrl: string) => {
        const audio = new Audio(dataUrl);
        activeAudioRef.current = audio;
        setPlayingMessageId(msg.id);

        audio.onended = () => {
          if (activeAudioRef.current === audio) {
            activeAudioRef.current = null;
          }
          setPlayingMessageId((curr) => (curr === msg.id ? null : curr));
        };
        audio.onerror = () => {
          if (activeAudioRef.current === audio) {
            activeAudioRef.current = null;
          }
          setPlayingMessageId((curr) => (curr === msg.id ? null : curr));
        };

        try {
          await audio.play();
        } catch (playErr: unknown) {
          if (activeAudioRef.current === audio) {
            activeAudioRef.current = null;
          }
          setPlayingMessageId((curr) => (curr === msg.id ? null : curr));
          const errName = (playErr as { name?: string })?.name || '';
          if (errName === 'NotAllowedError' && options?.silentIfAutoplayBlocked) {
            return;
          }
          speakWithBrowserFallback(msg.id, msg.text);
        }
      };

      if (msg.audioDataUrl) {
        await playDataUrl(msg.audioDataUrl);
        return;
      }

      if (Date.now() < ttsQuotaCooldownUntilRef.current) {
        speakWithBrowserFallback(msg.id, msg.text);
        return;
      }

      setLoadingAudioMessageId(msg.id);
      try {
        const ttsResult = await synthesizeAuraSpeech({
          text: msg.text,
          voiceName: 'Kore',
        });
        const wavDataUrl = `data:${ttsResult.mimeType};base64,${ttsResult.audioBase64}`;
        setMessages((prev) =>
          prev.map((item) => (item.id === msg.id ? { ...item, audioDataUrl: wavDataUrl } : item))
        );
        await playDataUrl(wavDataUrl);
      } catch (err: unknown) {
        if (err instanceof UnauthorizedTokenError) {
          initializedUidSessionRef.current = null;
          setNeedsAuth(true);
          setUserProfile(null);
          return;
        }
        if (err instanceof AuraApiError && (err.status === 429 || err.status === 503)) {
          ttsQuotaCooldownUntilRef.current =
            Date.now() + (err.status === 429 ? 90_000 : 25_000);
        }
        const usedFallback = speakWithBrowserFallback(msg.id, msg.text);
        if (!usedFallback && !options?.silentIfAutoplayBlocked) {
          setChatError(
            err instanceof Error
              ? err.message
              : 'Layanan suara A.U.R.A sedang sibuk sementara. Silakan klik Putar Suara kembali.'
          );
        }
      } finally {
        setLoadingAudioMessageId((curr) => (curr === msg.id ? null : curr));
      }
    },
    [speakWithBrowserFallback, stopActiveAudio]
  );

  const handleToggleMessageAudio = useCallback(
    (msg: ChatMessage) => {
      if (playingMessageId === msg.id) {
        stopActiveAudio();
        return;
      }
      void playMessageAudio(msg, { silentIfAutoplayBlocked: false });
    },
    [playMessageAudio, playingMessageId, stopActiveAudio]
  );

  const handleToggleAutoVoice = useCallback(() => {
    setAutoVoiceEnabled((prev) => {
      const next = !prev;
      if (!next) {
        stopActiveAudio();
      }
      return next;
    });
  }, [stopActiveAudio]);

  useEffect(() => {
    if (!userProfile) {
      try {
        window.localStorage.setItem('aura_routines_workspace', JSON.stringify(routines));
      } catch {
        // Abaikan jika localStorage penuh
      }
    }
  }, [routines, userProfile]);

  useEffect(() => {
    if (!userProfile) {
      try {
        window.localStorage.setItem('aura_memories_workspace', JSON.stringify(memories));
      } catch {
        // Abaikan jika localStorage penuh
      }
    }
  }, [memories, userProfile]);

  useEffect(() => {
    const unsubscribe = initAuth(
      async (firebaseUser, token) => {
        const profile = await fetchGoogleUserProfile(firebaseUser, token);
        setUserProfile(profile);
        setNeedsAuth(false);
      },
      () => {
        setUserProfile(null);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
  }, []);

  const triggerInitialGreeting = useCallback(
    (
      profile: UserProfile,
      currentRoutines: RoutineItem[],
      currentMemories: MemoryItem[]
    ) => {
      setChatError(null);
      setIsQuotaError(false);
      setRetryCooldownSeconds(0);
      setLastFailedAction(null);

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const welcomeText = buildLocalWelcomeGreeting({
        displayName: profile.displayName,
        routines: currentRoutines,
        memoriesCount: currentMemories.length,
      });
      const initialSystemContext = buildAuraSystemInstruction({
        displayName: profile.displayName,
        routines: currentRoutines,
        memories: currentMemories,
        currentTimeIso: nowIso,
        tokenSaver: tokenSaverRef.current,
      });

      const greetingMsg: ChatMessage = {
        id: `msg_${nowMs}`,
        role: 'model',
        text: welcomeText,
        timestamp: nowIso,
        sequence: nowMs,
        injectedSystemInstruction: initialSystemContext,
      };

      setMessages([greetingMsg]);
      void persistChatMessageToFirestore(profile.uid, greetingMsg, nowMs).catch(() => {});

      if (autoVoiceRef.current) {
        speakWithBrowserFallback(greetingMsg.id, greetingMsg.text);
      }
    },
    [speakWithBrowserFallback]
  );

  // Sinkronisasi real-time Cloud Firestore (Ingatan, Rutinitas & Riwayat Percakapan)
  useEffect(() => {
    if (!userProfile || needsAuth) return;

    const uid = userProfile.uid;
    let firstMessagesSnapshotHandled = false;

    const unsubMemories = subscribeUserMemories(uid, (loadedMemories) => {
      setMemories(loadedMemories);
    });

    const unsubRoutines = subscribeUserRoutines(uid, DEFAULT_ROUTINES, (loadedRoutines) => {
      setRoutines(loadedRoutines);
    });

    const unsubMessages = subscribeUserMessages(uid, (loadedMessages) => {
      if (!firstMessagesSnapshotHandled) {
        firstMessagesSnapshotHandled = true;
        if (loadedMessages.length > 0) {
          initializedUidSessionRef.current = uid;
          setMessages(loadedMessages);
          return;
        }

        if (initializedUidSessionRef.current !== uid) {
          initializedUidSessionRef.current = uid;
          void triggerInitialGreeting(userProfile, routinesRef.current, memoriesRef.current);
        }
        return;
      }

      // Pertahankan cache sesi aktif (audioDataUrl, imagePreviewUrl, imageAttachment, tokenUsage)
      setMessages((prev) => {
        const localMetaMap = new Map<
          string,
          Pick<
            ChatMessage,
            | 'audioDataUrl'
            | 'imagePreviewUrl'
            | 'imageAttachment'
            | 'injectedSystemInstruction'
            | 'tokenUsage'
          >
        >();
        for (const p of prev) {
          localMetaMap.set(p.id, {
            audioDataUrl: p.audioDataUrl,
            imagePreviewUrl: p.imagePreviewUrl,
            imageAttachment: p.imageAttachment,
            injectedSystemInstruction: p.injectedSystemInstruction,
            tokenUsage: p.tokenUsage,
          });
        }
        if (loadedMessages.length === 0 && prev.length > 0) {
          return prev;
        }
        return loadedMessages.map((m) => {
          const meta = localMetaMap.get(m.id);
          return meta ? { ...m, ...meta } : m;
        });
      });
    });

    return () => {
      unsubMemories();
      unsubRoutines();
      unsubMessages();
    };
  }, [userProfile, needsAuth, triggerInitialGreeting]);

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true);
    setAuthError(null);
    try {
      const { user, accessToken } = await googleSignIn();
      const profile = await fetchGoogleUserProfile(user, accessToken);
      setUserProfile(profile);
      setNeedsAuth(false);
      setActiveTab('assistant');
    } catch (err: unknown) {
      const errCode = (err as { code?: string })?.code || '';
      if (errCode === 'auth/popup-closed-by-user') {
        setAuthError('Jendela login Google ditutup sebelum proses selesai. Silakan coba lagi.');
      } else if (errCode === 'auth/popup-blocked') {
        setAuthError(
          'Popup login diblokir oleh peramban Anda. Izinkan popup untuk situs ini lalu klik tombol masuk kembali.'
        );
      } else {
        const msg = err instanceof Error ? err.message : 'Autentikasi Google gagal diproses.';
        setAuthError(msg);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    stopActiveAudio();
    await logoutGoogle();
    initializedUidSessionRef.current = null;
    setUserProfile(null);
    setMessages([]);
    setMemories(loadSavedLocalMemories('aura_memories_workspace'));
    setRoutines(loadSavedRoutines('aura_routines_workspace'));
    setChatError(null);
    setLastFailedAction(null);
    setNeedsAuth(true);
  };

  const handleSendMessage = async (
    messageText: string,
    options?: SendMessageOptions
  ) => {
    if (!userProfile || isSending) {
      if (!userProfile) setNeedsAuth(true);
      return;
    }

    stopActiveAudio();

    const userSeq = Date.now();
    const userMsgId = `user_${userSeq}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      text: messageText,
      timestamp: new Date(userSeq).toISOString(),
      sequence: userSeq,
      isVoiceCommand: options?.isVoiceCommand,
      imageAttachment: options?.imageAttachment,
      imagePreviewUrl: options?.imagePreviewUrl,
      attachmentLabel: options?.imageAttachment?.label,
    };

    // Sertakan imageAttachment dari sesi aktif pada riwayat agar pertanyaan lanjutan atas gambar tetap akurat
    const previousHistory = messagesRef.current.map((m) => ({
      role: m.role,
      text: m.text,
      imageAttachment: m.imageAttachment,
      attachmentLabel: m.attachmentLabel,
    }));

    setMessages((prev) => [...prev, userMsg]);
    setIsSending(true);
    setChatError(null);
    setIsQuotaError(false);
    setRetryCooldownSeconds(0);
    setLastFailedAction(null);

    try {
      const response = await sendAuraMessage({
        message: messageText,
        history: previousHistory,
        routines: routinesRef.current,
        memories: memoriesRef.current,
        enableWebSearch: webSearchRef.current,
        tokenSaver: tokenSaverRef.current,
        imageAttachment: options?.imageAttachment,
        clientDisplayName: userProfile.displayName,
      });

      const modelSeq = Date.now() + 1;
      const modelMsg: ChatMessage = {
        id: `model_${modelSeq}`,
        role: 'model',
        text: response.reply,
        timestamp: response.timestamp,
        sequence: modelSeq,
        injectedSystemInstruction: response.appliedSystemInstruction,
        sources: response.sources?.length ? response.sources : undefined,
        searchQueries: response.searchQueries?.length ? response.searchQueries : undefined,
        tokenUsage: response.tokenUsage,
      };
      setMessages((prev) => [...prev, modelMsg]);

      void persistChatMessageToFirestore(userProfile.uid, userMsg, userSeq).catch(() => {});
      void persistChatMessageToFirestore(userProfile.uid, modelMsg, modelSeq).catch(() => {});

      if (response.extractedMemory) {
        void upsertAuraMemoryInFirestore(
          userProfile.uid,
          response.extractedMemory,
          memoriesRef.current
        ).catch(() => {});
      }

      if (autoVoiceRef.current || options?.isVoiceCommand) {
        void playMessageAudio(modelMsg, { silentIfAutoplayBlocked: false });
      }
    } catch (err: unknown) {
      setMessages((prev) => prev.filter((m) => m.id !== userMsgId));

      if (err instanceof UnauthorizedTokenError) {
        initializedUidSessionRef.current = null;
        setNeedsAuth(true);
        setUserProfile(null);
        setAuthError(
          'Sesi token Google Anda telah berakhir. Silakan klik Sign in with Google untuk melanjutkan percakapan.'
        );
        return;
      }

      const message =
        err instanceof Error ? err.message : 'Terjadi kendala saat menghubungi A.U.R.A.';
      setChatError(message);
      if (err instanceof AuraApiError) {
        setIsQuotaError(err.status === 429);
        setRetryCooldownSeconds(
          err.retryAfterSeconds ?? (err.status === 429 ? 10 : err.status === 503 ? 5 : 0)
        );
      } else {
        setIsQuotaError(false);
        setRetryCooldownSeconds(0);
      }
      setLastFailedAction({
        type: 'message',
        text: messageText,
        isVoiceCommand: options?.isVoiceCommand,
        imageAttachment: options?.imageAttachment,
        imagePreviewUrl: options?.imagePreviewUrl,
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleSendVoiceCommand = async (audioBase64: string, mimeType: string) => {
    if (!userProfile || isSending || isTranscribing) {
      if (!userProfile) setNeedsAuth(true);
      return;
    }

    stopActiveAudio();
    setIsTranscribing(true);
    setChatError(null);
    setIsQuotaError(false);
    setRetryCooldownSeconds(0);
    setLastFailedAction(null);

    let transcribedText = '';
    try {
      const result = await transcribeAuraAudio({ audioBase64, mimeType });
      transcribedText = cleanTranscribedText(result.transcript);
    } catch (err: unknown) {
      if (err instanceof UnauthorizedTokenError) {
        setIsTranscribing(false);
        initializedUidSessionRef.current = null;
        setNeedsAuth(true);
        setUserProfile(null);
        setAuthError(
          'Sesi token Google Anda telah berakhir. Silakan klik Sign in with Google untuk melanjutkan.'
        );
        return;
      }

      const message =
        err instanceof Error ? err.message : 'Gagal mentranskripsikan perintah suara Anda.';
      setChatError(message);
      if (err instanceof AuraApiError) {
        setIsQuotaError(err.status === 429);
        setRetryCooldownSeconds(
          err.retryAfterSeconds ?? (err.status === 429 ? 10 : err.status === 503 ? 5 : 0)
        );
      }
      setLastFailedAction({ type: 'voice_recording', audioBase64, mimeType });
      setIsTranscribing(false);
      return;
    }

    setIsTranscribing(false);
    if (!transcribedText) {
      setChatError(
        'Suara belum terbaca dengan jelas pada rekaman tersebut. Pastikan perangkat mikrofon yang tepat dipilih lalu ucapkan kembali perintah Anda.'
      );
      return;
    }

    await handleSendMessage(transcribedText, { isVoiceCommand: true });
  };

  const handleTranscribeVoiceToText = async (
    audioBase64: string,
    mimeType: string
  ): Promise<string | null> => {
    if (!userProfile || isSending || isTranscribing) {
      if (!userProfile) setNeedsAuth(true);
      return null;
    }

    stopActiveAudio();
    setIsTranscribing(true);
    setChatError(null);
    setIsQuotaError(false);
    setRetryCooldownSeconds(0);

    try {
      const result = await transcribeAuraAudio({ audioBase64, mimeType });
      const cleaned = cleanTranscribedText(result.transcript);
      if (!cleaned) {
        setChatError(
          'Suara belum terbaca dengan jelas pada rekaman tersebut. Pastikan perangkat mikrofon yang tepat dipilih lalu coba lagi.'
        );
        return null;
      }
      return cleaned;
    } catch (err: unknown) {
      if (err instanceof UnauthorizedTokenError) {
        initializedUidSessionRef.current = null;
        setNeedsAuth(true);
        setUserProfile(null);
        setAuthError(
          'Sesi token Google Anda telah berakhir. Silakan klik Sign in with Google untuk melanjutkan.'
        );
        return null;
      }

      const message =
        err instanceof Error ? err.message : 'Gagal mentranskripsikan rekaman suara ke teks.';
      setChatError(message);
      if (err instanceof AuraApiError) {
        setIsQuotaError(err.status === 429);
        setRetryCooldownSeconds(
          err.retryAfterSeconds ?? (err.status === 429 ? 10 : err.status === 503 ? 5 : 0)
        );
      }
      return null;
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleRetryLastAction = () => {
    if (
      !userProfile ||
      isSending ||
      isTranscribing ||
      retryCooldownSeconds > 0 ||
      !lastFailedAction
    ) {
      return;
    }
    if (lastFailedAction.type === 'greeting') {
      triggerInitialGreeting(userProfile, routinesRef.current, memoriesRef.current);
    } else if (lastFailedAction.type === 'voice_recording') {
      void handleSendVoiceCommand(lastFailedAction.audioBase64, lastFailedAction.mimeType);
    } else {
      void handleSendMessage(lastFailedAction.text, {
        isVoiceCommand: lastFailedAction.isVoiceCommand,
        imageAttachment: lastFailedAction.imageAttachment,
        imagePreviewUrl: lastFailedAction.imagePreviewUrl,
      });
    }
  };

  const handleResetConversation = async () => {
    if (!userProfile || isSending || isTranscribing) return;
    stopActiveAudio();
    setMessages([]);
    try {
      await clearAllUserMessagesInFirestore(userProfile.uid);
    } catch {
      // Lanjutkan sesi baru meskipun penghapusan tertunda
    }
    triggerInitialGreeting(userProfile, routinesRef.current, memoriesRef.current);
  };

  const handleAddMemory = async (draft: {
    title: string;
    content: string;
    category: MemoryCategory;
    sourceUris: string[];
  }) => {
    if (userProfile && !needsAuth) {
      await upsertAuraMemoryInFirestore(userProfile.uid, draft, memoriesRef.current);
      return;
    }
    const localItem: MemoryItem = {
      id: `mem_${Date.now()}`,
      title: draft.title,
      content: draft.content,
      category: draft.category,
      sourceUris: draft.sourceUris,
      updatedAtIso: new Date().toISOString(),
    };
    setMemories((prev) => [localItem, ...prev]);
  };

  const handleDeleteMemory = async (id: string) => {
    if (userProfile && !needsAuth) {
      await deleteAuraMemoryFromFirestore(id);
      return;
    }
    setMemories((prev) => prev.filter((m) => m.id !== id));
  };

  const handleDiscussMemory = (memory: MemoryItem) => {
    const followUpPrompt = `Aura, mari kita bahas lebih lanjut catatan ingatan "${memory.title}" (${memory.category}) yang sudah kita simpan sebelumnya.`;
    setActiveTab('assistant');
    setPrefilledDraft(followUpPrompt);
  };

  const handleAddRoutine = (draft: Omit<RoutineItem, 'id' | 'completed'>) => {
    if (userProfile && !needsAuth) {
      void addAuraRoutineToFirestore(userProfile.uid, draft);
      return;
    }
    const newItem: RoutineItem = {
      ...draft,
      id: `rt_${Date.now()}`,
      completed: false,
    };
    setRoutines((prev) => [...prev, newItem]);
  };

  const handleToggleRoutine = (id: string) => {
    const target = routines.find((r) => r.id === id);
    if (!target) return;
    if (userProfile && !needsAuth) {
      void toggleAuraRoutineInFirestore(id, !target.completed);
      return;
    }
    setRoutines((prev) =>
      prev.map((item) => (item.id === id ? { ...item, completed: !item.completed } : item))
    );
  };

  const handleDeleteRoutine = (id: string) => {
    if (userProfile && !needsAuth) {
      void deleteAuraRoutineFromFirestore(id);
      return;
    }
    setRoutines((prev) => prev.filter((item) => item.id !== id));
  };

  const tabTitleMap: Record<WorkspaceTab, string> = {
    assistant: 'Asisten Pribadi',
    memories: 'Ingatan A.U.R.A',
    routines: 'Agenda Rutinitas',
    architecture: 'Arsitektur & Kode',
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900 lg:flex-row">
      {/* Desktop Sidebar Navigation (260px) */}
      <aside
        aria-label="Navigasi utama A.U.R.A"
        className="hidden w-[260px] shrink-0 flex-col justify-between border-r border-slate-200 bg-white p-5 lg:flex"
      >
        <div className="space-y-8">
          <div className="px-2">
            <span className="text-xl font-bold tracking-tight text-slate-900">A.U.R.A</span>
            <p className="mt-1 text-xs text-slate-500">
              Automated Universal Routine Assistant
            </p>
          </div>

          <nav className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveTab('assistant')}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === 'assistant'
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <MessageSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Asisten A.U.R.A</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('memories')}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === 'memories'
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-3">
                <Brain className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Ingatan A.U.R.A</span>
              </span>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                {memories.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('routines')}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === 'routines'
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-3">
                <CalendarCheck2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Agenda Rutinitas</span>
              </span>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                {routines.filter((r) => !r.completed).length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('architecture')}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === 'architecture'
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <FileCode2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Arsitektur &amp; Kode</span>
            </button>
          </nav>
        </div>

        <div className="space-y-1 border-t border-slate-100 px-2 pt-4 text-xs text-slate-500">
          <p className="font-medium text-slate-700">Hemat Token &amp; Diskusi Gambar</p>
          <p>
            Mendukung lampiran gambar berlanjut, riset fakta web, serta persona lembut A.U.R.A.
          </p>
        </div>
      </aside>

      {/* Main Workspace Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar Contract: 3 Clean Zones */}
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3.5 sm:gap-8 sm:px-8">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900 whitespace-nowrap">
            <span className="shrink-0">A.U.R.A</span>
            <span className="hidden text-slate-300 sm:inline" aria-hidden="true">
              /
            </span>
            <span className="hidden truncate font-medium text-slate-600 sm:inline">
              {tabTitleMap[activeTab]}
            </span>
          </div>

          <nav
            aria-label="Navigasi tampilan cepat"
            className="hidden items-center gap-4 text-sm font-medium text-slate-600 sm:flex lg:hidden"
          >
            <button
              type="button"
              onClick={() => setActiveTab('assistant')}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'assistant'
                  ? 'text-slate-900 underline underline-offset-4'
                  : 'hover:text-slate-900'
              }`}
            >
              Asisten
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('memories')}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'memories'
                  ? 'text-slate-900 underline underline-offset-4'
                  : 'hover:text-slate-900'
              }`}
            >
              Ingatan
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('routines')}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'routines'
                  ? 'text-slate-900 underline underline-offset-4'
                  : 'hover:text-slate-900'
              }`}
            >
              Rutinitas
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('architecture')}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'architecture'
                  ? 'text-slate-900 underline underline-offset-4'
                  : 'hover:text-slate-900'
              }`}
            >
              Arsitektur
            </button>
          </nav>

          <div className="flex items-center shrink-0">
            {needsAuth || !userProfile ? (
              <GoogleSignInButton
                onClick={handleGoogleLogin}
                isLoading={isLoggingIn}
                label="Sign in with Google"
              />
            ) : (
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Keluar ({userProfile.givenName || userProfile.displayName})</span>
              </button>
            )}
          </div>
        </header>

        {/* Compact Mobile Segmented Switcher (< 640px) */}
        <div className="border-b border-slate-200 bg-white px-4 py-2 sm:hidden">
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setActiveTab('assistant')}
              className={`rounded-md py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                activeTab === 'assistant'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600'
              }`}
            >
              Asisten
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('memories')}
              className={`rounded-md py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                activeTab === 'memories'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600'
              }`}
            >
              Ingatan
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('routines')}
              className={`rounded-md py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                activeTab === 'routines'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600'
              }`}
            >
              Rutinitas
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('architecture')}
              className={`rounded-md py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                activeTab === 'architecture'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600'
              }`}
            >
              Kode
            </button>
          </div>
        </div>

        {/* Main Content Viewport */}
        <main className="flex-1 px-5 py-7 sm:px-8">
          {activeTab === 'assistant' && (
            <AssistantWorkspace
              userProfile={userProfile}
              needsAuth={needsAuth}
              isLoggingIn={isLoggingIn}
              authError={authError}
              onGoogleLogin={handleGoogleLogin}
              messages={messages}
              memories={memories}
              webSearchEnabled={webSearchEnabled}
              onToggleWebSearch={() => setWebSearchEnabled((prev) => !prev)}
              tokenSaverEnabled={tokenSaverEnabled}
              onToggleTokenSaver={() => setTokenSaverEnabled((prev) => !prev)}
              isSending={isSending}
              isTranscribing={isTranscribing}
              chatError={chatError}
              isQuotaError={isQuotaError}
              retryCooldownSeconds={retryCooldownSeconds}
              onSendMessage={handleSendMessage}
              onSendVoiceCommand={handleSendVoiceCommand}
              onTranscribeVoiceToText={handleTranscribeVoiceToText}
              autoVoiceEnabled={autoVoiceEnabled}
              onToggleAutoVoice={handleToggleAutoVoice}
              playingMessageId={playingMessageId}
              loadingAudioMessageId={loadingAudioMessageId}
              onToggleMessageAudio={handleToggleMessageAudio}
              onRetryLastAction={lastFailedAction ? handleRetryLastAction : undefined}
              onResetConversation={() => void handleResetConversation()}
              routines={routines}
              prefilledDraft={prefilledDraft}
              onConsumePrefilledDraft={() => setPrefilledDraft(null)}
              onNavigateTab={setActiveTab}
            />
          )}

          {activeTab === 'memories' && (
            <MemoryVault
              memories={memories}
              isCloudSynced={Boolean(userProfile && !needsAuth)}
              displayName={userProfile?.displayName}
              onAddMemory={handleAddMemory}
              onDeleteMemory={handleDeleteMemory}
              onDiscussMemory={handleDiscussMemory}
            />
          )}

          {activeTab === 'routines' && (
            <RoutineManager
              routines={routines}
              displayName={userProfile?.displayName}
              onAddRoutine={handleAddRoutine}
              onToggleRoutine={handleToggleRoutine}
              onDeleteRoutine={handleDeleteRoutine}
            />
          )}

          {activeTab === 'architecture' && (
            <ArchitectureGuide
              userProfile={userProfile}
              routines={routines}
              memories={memories}
            />
          )}
        </main>
      </div>
    </div>
  );
}
