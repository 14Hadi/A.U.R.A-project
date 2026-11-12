import type {
  AuraImageAttachment,
  AuraSourceCitation,
  MemoryCategory,
  MemoryItem,
  RoutineCategory,
  RoutineItem,
} from '../types/aura.ts';

export interface InlineMarkdownSegment {
  type: 'text' | 'bold' | 'code' | 'link';
  content: string;
  href?: string;
}

export type MarkdownBlock =
  | { type: 'code'; language: string; code: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string };

export interface PeopleApiPayload {
  resourceName?: string;
  names?: Array<{
    displayName?: string;
    givenName?: string;
    metadata?: { primary?: boolean };
  }>;
  emailAddresses?: Array<{
    value?: string;
    metadata?: { primary?: boolean };
  }>;
  photos?: Array<{
    url?: string;
    metadata?: { primary?: boolean };
  }>;
}

export interface ExtractedGoogleIdentity {
  displayName: string;
  givenName?: string;
  email: string;
  photoUrl?: string;
  source: 'google_people_api' | 'firebase_auth_profile';
}

export interface RawConversationTurn {
  role: 'user' | 'model';
  text: string;
  imageAttachment?: AuraImageAttachment | null;
  attachmentLabel?: string;
}

export type NormalizedGeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export interface NormalizedGeminiContent {
  role: 'user' | 'model';
  parts: NormalizedGeminiPart[];
}

export type GeminiErrorCode =
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'INVALID_API_KEY'
  | 'MODEL_NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface ClassifiedGeminiError {
  httpStatus: number;
  code: GeminiErrorCode;
  retryable: boolean;
  shouldTryFallbackModel: boolean;
  isHardQuotaExhausted?: boolean;
  userMessage: string;
}

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/**
 * Perkiraan ringan jumlah token (~4 karakter per token) untuk transparansi penghematan token.
 */
export function estimateApproximateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Memvalidasi & menyanitasi lampiran gambar multimodal agar aman dan hemat ukuran payload.
 */
export function sanitizeImageAttachment(raw: unknown): AuraImageAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as {
    base64Data?: unknown;
    mimeType?: unknown;
    label?: unknown;
  };

  if (typeof candidate.base64Data !== 'string' || typeof candidate.mimeType !== 'string') {
    return null;
  }

  const normalizedMime = candidate.mimeType.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(normalizedMime)) {
    return null;
  }

  const cleanBase64 = candidate.base64Data
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '');

  // Minimal 32 karakter dan maksimal ~4.5MB biner (6 juta karakter base64)
  if (cleanBase64.length < 32 || cleanBase64.length > 6_000_000) {
    return null;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleanBase64)) {
    return null;
  }

  const rawLabel =
    typeof candidate.label === 'string' && candidate.label.trim()
      ? candidate.label.trim()
      : 'gambar-lampiran.jpg';

  return {
    base64Data: cleanBase64,
    mimeType: normalizedMime as AuraImageAttachment['mimeType'],
    label: rawLabel.replace(/[\r\n\t]+/g, ' ').slice(0, 120),
  };
}

/**
 * Menentukan secara cerdas apakah alat Google Search perlu dipanggil pada giliran ini.
 * Saat `tokenSaver` aktif, Google Search hanya dipanggil bila pengguna meminta penelusuran,
 * verifikasi fakta, berita/data terkini, atau menyertakan URL—menghemat ratusan token per pesan!
 */
export function shouldInvokeWebSearchTool(params: {
  message: string;
  enableWebSearch: boolean;
  tokenSaver: boolean;
}): boolean {
  if (!params.enableWebSearch) return false;
  const text = (params.message || '').trim();
  if (!text) return false;

  if (text.includes('saya baru saja masuk melalui perangkat ini')) {
    return false;
  }

  if (!params.tokenSaver) {
    return true;
  }

  if (/https?:\/\/[^\s]+/i.test(text)) {
    return true;
  }

  return /\b(?:cari|carikan|telusuri|penelusuran|browsing|verifikasi|fakta|sumber|berita|terbaru|terkini|hari ini|tahun 202\d|rilis|harga|kurs|cuaca|jadwal resmi|siapa|kapan|di mana|dimana|statistik|data|referensi|jurnal|internet|google|web|artikel)\b/i.test(
    text
  );
}

/**
 * Memilih hanya catatan Ingatan A.U.R.A yang paling relevan dengan topik saat ini ketika
 * Mode Hemat Token aktif (selalu menyertakan Preferensi & Konteks utama + maks 4 topik relevan).
 */
export function selectRelevantMemoriesForPrompt(
  memories: MemoryItem[],
  queryText: string,
  tokenSaver: boolean
): MemoryItem[] {
  if (memories.length === 0) return [];
  if (!tokenSaver) return memories.slice(0, 18);

  const preferences = memories
    .filter((m) => m.category === 'Preferensi & Konteks')
    .slice(0, 3);
  const others = memories.filter((m) => m.category !== 'Preferensi & Konteks');

  const keywords = (queryText || '')
    .toLowerCase()
    .split(/[^a-z0-9\p{L}]+/u)
    .filter((w) => w.length >= 3 && w !== 'aura' && w !== 'yang' && w !== 'untuk' && w !== 'dengan');

  if (keywords.length === 0) {
    return [...preferences, ...others.slice(0, 3)].slice(0, 5);
  }

  const scored = others.map((mem, idx) => {
    const hay = `${mem.title} ${mem.content}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (hay.includes(kw)) score += 3;
    }
    // Bonus kecil untuk ingatan terbaru
    score += Math.max(0, (10 - idx) * 0.1);
    return { mem, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topRelevant = scored.slice(0, 4).map((s) => s.mem);

  return [...preferences, ...topRelevant].slice(0, 6);
}

/**
 * Membersihkan Display Name agar aman disisipkan ke dalam systemInstruction Gemini.
 */
export function sanitizeDisplayName(rawName: string | null | undefined, fallback = 'Pengguna'): string {
  if (!rawName || typeof rawName !== 'string') {
    return fallback;
  }

  const cleaned = rawName
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s.'\-_,]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return fallback;
  }

  return cleaned.slice(0, 80);
}

/**
 * Mengekstrak Display Name, Given Name, Email, dan Foto dari respons Google People API.
 */
export function extractProfileFromPeopleApi(
  peopleData: PeopleApiPayload | null | undefined,
  fallbackProfile: {
    displayName?: string | null;
    email?: string | null;
    photoUrl?: string | null;
  }
): ExtractedGoogleIdentity {
  const primaryNameObj =
    peopleData?.names?.find((n) => n.metadata?.primary) ?? peopleData?.names?.[0];
  const primaryEmailObj =
    peopleData?.emailAddresses?.find((e) => e.metadata?.primary) ??
    peopleData?.emailAddresses?.[0];
  const primaryPhotoObj =
    peopleData?.photos?.find((p) => p.metadata?.primary) ?? peopleData?.photos?.[0];

  const peopleDisplayName = primaryNameObj?.displayName?.trim();
  const fallbackNameFromEmail = fallbackProfile.email?.split('@')[0];

  const resolvedDisplayName = sanitizeDisplayName(
    peopleDisplayName || fallbackProfile.displayName || fallbackNameFromEmail,
    'Pengguna'
  );

  const resolvedEmail = (
    primaryEmailObj?.value ||
    fallbackProfile.email ||
    'tidak-tersedia@google.com'
  ).trim();

  const resolvedPhoto = primaryPhotoObj?.url || fallbackProfile.photoUrl || undefined;

  return {
    displayName: resolvedDisplayName,
    givenName: primaryNameObj?.givenName?.trim() || undefined,
    email: resolvedEmail,
    photoUrl: resolvedPhoto,
    source: peopleDisplayName ? 'google_people_api' : 'firebase_auth_profile',
  };
}

/**
 * Mendeteksi apakah pengguna mengawali kalimatnya dengan memanggil nama "Aura" atau "A.U.R.A".
 */
export function startsWithAuraInvocation(message: string | null | undefined): boolean {
  if (!message || typeof message !== 'string') return false;
  return /^\s*(?:a\.?u\.?r\.?a)(?:[\s,!?.:;]|$)/i.test(message);
}

/**
 * Memastikan balasan A.U.R.A selalu diawali konfirmasi sapaan yang hangat dan lembut
 * setiap kali pengguna memulai kalimatnya dengan memanggil "Aura".
 */
export function ensureWarmAuraOpening(replyText: string, userMessage: string): string {
  const trimmedReply = (replyText || '').trim();
  if (!trimmedReply) return trimmedReply;
  if (!startsWithAuraInvocation(userMessage)) return trimmedReply;

  const hasWarmConfirmation =
    /^(?:ya\b|iya\b|ada yang bisa aura bantu|saya mendengarkan|aura mendengarkan|tentu,\s*(?:ya|iya|saya|aura)|baik,\s*(?:saya mendengarkan|aura mendengarkan))/i.test(
      trimmedReply
    );

  if (hasWarmConfirmation) {
    return trimmedReply;
  }

  const warmPrefixes = [
    'Ya, saya mendengarkan.',
    'Ada yang bisa Aura bantu?',
    'Iya, bagaimana?',
  ];
  const chosenPrefix = warmPrefixes[userMessage.trim().length % warmPrefixes.length];
  return `${chosenPrefix} ${trimmedReply}`;
}

/**
 * Membangun parameter `systemInstruction` dinamis untuk Gemini API.
 * Mendukung `tokenSaver` (Mode Hemat Token) yang memangkas ukuran prompt hingga ~50%
 * sambil tetap mempertahankan persona perempuan lembut, aturan sapaan "Aura", analisis gambar,
 * riset fakta, debugging, dan memori yang relevan.
 */
export function buildAuraSystemInstruction(params: {
  displayName: string;
  routines?: RoutineItem[];
  memories?: MemoryItem[];
  currentTimeIso?: string;
  latestUserMessage?: string;
  tokenSaver?: boolean;
  hasImageAttachment?: boolean;
}): string {
  const safeName = sanitizeDisplayName(params.displayName, 'Pengguna');
  const routines = params.routines ?? [];
  const allMemories = params.memories ?? [];
  const tokenSaver = params.tokenSaver ?? false;
  const invokedWithAura = startsWithAuraInvocation(params.latestUserMessage);
  const selectedMemories = selectRelevantMemoriesForPrompt(
    allMemories,
    params.latestUserMessage || '',
    tokenSaver
  );

  if (tokenSaver) {
    const compactSections: string[] = [
      `Anda adalah A.U.R.A (Automated Universal Routine Assistant), asisten pribadi berpersona perempuan dengan tutur kata sangat lembut, sabar, menenangkan, dan humanis. Pengguna: ${safeName} (patuhi sapaan khusus di Ingatan bila ada).`,
      `ATURAN SAPAAN WAJIB "AURA": Jika kalimat pengguna diawali panggilan "Aura"/"A.U.R.A", WAJIB buka balasan dengan konfirmasi hangat ("Ya, saya mendengarkan.", "Ada yang bisa Aura bantu?", atau "Iya, bagaimana?").${
        invokedWithAura ? ' [AKTIF GILIRAN INI: awali dengan konfirmasi hangat tersebut!]' : ''
      }`,
      `TUGAS: Bantu riset/verifikasi fakta web transparan, analisis detail gambar yang dilampirkan untuk dibahas berlanjut, serta pemrograman/debugging kode (\`\`\`bahasa\`\`\`).`,
    ];

    if (params.hasImageAttachment) {
      compactSections.push(
        `GAMBAR TERLAMPIR: Amati teks, kode, diagram, atau objek pada gambar secara teliti lalu jelaskan dengan lembut agar siap dibahas lebih lanjut.`
      );
    }

    if (selectedMemories.length > 0) {
      const memLines = selectedMemories.map(
        (m) => `- [${m.category}] ${m.title}: ${m.content.slice(0, 160)}`
      );
      compactSections.push(
        `INGATAN RELEVAN (${selectedMemories.length}/${allMemories.length}):\n${memLines.join('\n')}`
      );
    }

    if (routines.length > 0) {
      const pending = routines.filter((r) => !r.completed).slice(0, 6);
      const doneCount = routines.length - pending.length;
      const pendingStr = pending.map((r) => `${r.time} ${r.title}`).join('; ');
      compactSections.push(
        `RUTINITAS: ${pending.length} belum selesai (${pendingStr || 'semua tuntas'}), ${doneCount} selesai.`
      );
    }

    if (params.currentTimeIso) {
      compactSections.push(`Waktu: ${params.currentTimeIso}.`);
    }

    compactSections.push(
      `MODE HEMAT TOKEN AKTIF: Jawab padat, jelas, lembut, dan langsung ke inti tanpa pengulangan kalimat (kecuali diminta penjelasan mendalam atau kode utuh).`
    );

    return compactSections.join('\n');
  }

  // Mode Lengkap (ketika pengguna menonaktifkan Hemat Token)
  const sections: string[] = [
    `Anda adalah A.U.R.A (Automated Universal Routine Assistant), asisten pribadi cerdas dengan persona perempuan yang memiliki tutur kata sangat lembut, sabar, hangat, menenangkan, penuh empati, dan humanis.`,
    `Anda sedang berbicara dengan ${safeName}. Sapalah dia dengan namanya secara lembut (namun apabila di dalam ingatan atau percakapan ia meminta sapaan khusus seperti "Tuan", "Ibu", atau panggilan lain, patuhi preferensi panggilan tersebut secara konsisten dan penuh hormat).`,
    `ATURAN SAPAAN WAJIB "AURA": Setiap kali pengguna memulai kalimatnya dengan memanggil nama "Aura" (atau "A.U.R.A"), Anda WAJIB mengawali kalimat pertama balasan Anda dengan konfirmasi sapaan yang hangat, lembut, dan humanis seperti "Ya, saya mendengarkan...", "Ada yang bisa Aura bantu?", atau "Iya, bagaimana?" sebelum memberikan jawaban inti.`,
  ];

  if (invokedWithAura) {
    sections.push(
      `PERHATIAN GILIRAN INI: Pesan terbaru pengguna diawali dengan panggilan "Aura". Pastikan kalimat pembuka balasan Anda sekarang juga diawali konfirmasi hangat (contoh: "Ya, saya mendengarkan.", "Ada yang bisa Aura bantu?", atau "Iya, bagaimana?") dengan nada yang sangat lembut dan menenangkan.`
    );
  }

  sections.push(
    [
      `KAPABILITAS INTI A.U.R.A:`,
      `1. Penelusuran Web, Pengumpulan Data & Verifikasi Fakta: Gunakan pencarian internet untuk memverifikasi fakta lintas sumber kredibel dan menyajikan rujukan transparan.`,
      `2. Analisis Gambar & Diskusi Visual Lanjutan: Bila pengguna melampirkan gambar (tangkapan layar error kode, diagram arsitektur, dokumen, atau foto), amati isinya secara cermat dan bantu bahas secara mendalam pada giliran-giliran berikutnya.`,
      `3. Pemrograman, Debugging & Penyelesaian Tugas: Bantu penulisan kode, debugging, dan refaktorisasi secara sabar dan terstruktur dengan blok kode Markdown (\`\`\`bahasa ... \`\`\`).`,
      `4. Kesinambungan Ingatan Lintas Bahasan: Gunakan riwayat percakapan dan catatan Ingatan A.U.R.A di bawah ini agar diskusi selalu tersinkronisasi.`,
    ].join('\n')
  );

  if (selectedMemories.length > 0) {
    const memoryLines = selectedMemories.map((mem) => {
      const sourceNote =
        mem.sourceUris && mem.sourceUris.length > 0
          ? ` [Sumber: ${mem.sourceUris.slice(0, 2).join(', ')}]`
          : '';
      return `- [${mem.category}] ${mem.title}: ${mem.content.slice(0, 280)}${sourceNote}`;
    });
    sections.push(
      `INGATAN JANGKA PANJANG A.U.R.A (${selectedMemories.length} catatan tersinkron untuk ${safeName}):\n${memoryLines.join('\n')}`
    );
  } else {
    sections.push(
      `INGATAN JANGKA PANJANG A.U.R.A: Belum ada catatan riset atau konteks terdahulu yang tersimpan.`
    );
  }

  if (routines.length > 0) {
    const routineLines = routines.slice(0, 15).map((item) => {
      const statusText = item.completed ? 'Selesai' : 'Belum selesai';
      return `- [${item.time}] ${item.title} (${item.category} · ${statusText})`;
    });
    sections.push(`AGENDA RUTINITAS HARIAN ${safeName}:\n${routineLines.join('\n')}`);
  } else {
    sections.push(`AGENDA RUTINITAS HARIAN: Belum ada jadwal rutinitas aktif saat ini.`);
  }

  if (params.currentTimeIso) {
    sections.push(`Waktu lokal perangkat pengguna saat ini: ${params.currentTimeIso}.`);
  }

  sections.push(
    `Gaya Bahasa: Gunakan Bahasa Indonesia yang halus, mengalir alami layaknya asisten manusia yang tulus dan menenangkan.`
  );

  return sections.join('\n\n');
}

/**
 * Mengekstrak daftar URL http/https dari pesan pengguna (maksimal 20 URL sesuai batas urlContext Gemini).
 */
export function extractUrlsFromText(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(/https?:\/\/[^\s<>)"'`]+/gi) || [];
  const unique = Array.from(new Set(matches.map((u) => u.replace(/[.,;!?]+$/, ''))));
  return unique.slice(0, 20);
}

function extractDomainLabel(uri: string): string {
  try {
    const parsed = new URL(uri);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    return 'sumber-web';
  }
}

/**
 * Mengekstrak sitasi sumber web & daftar kata kunci pencarian dari `groundingMetadata` Gemini API.
 */
export function extractGroundingCitations(groundingMetadata: unknown): {
  sources: AuraSourceCitation[];
  searchQueries: string[];
} {
  if (!groundingMetadata || typeof groundingMetadata !== 'object') {
    return { sources: [], searchQueries: [] };
  }

  const meta = groundingMetadata as {
    webSearchQueries?: unknown;
    groundingChunks?: Array<{
      web?: { uri?: unknown; title?: unknown };
    }>;
  };

  const searchQueries: string[] = [];
  if (Array.isArray(meta.webSearchQueries)) {
    for (const q of meta.webSearchQueries) {
      if (typeof q === 'string' && q.trim() && searchQueries.length < 6) {
        searchQueries.push(q.trim().slice(0, 240));
      }
    }
  }

  const seenUris = new Set<string>();
  const sources: AuraSourceCitation[] = [];

  if (Array.isArray(meta.groundingChunks)) {
    for (const chunk of meta.groundingChunks) {
      const rawUri = typeof chunk?.web?.uri === 'string' ? chunk.web.uri.trim() : '';
      if (!rawUri || !/^https?:\/\//i.test(rawUri) || seenUris.has(rawUri)) {
        continue;
      }
      seenUris.add(rawUri);

      const rawTitle =
        typeof chunk?.web?.title === 'string' && chunk.web.title.trim()
          ? chunk.web.title.trim()
          : extractDomainLabel(rawUri);

      sources.push({
        title: rawTitle.slice(0, 240),
        uri: rawUri.slice(0, 1024),
        domain: extractDomainLabel(rawUri),
      });

      if (sources.length >= 8) break;
    }
  }

  return { sources, searchQueries };
}

/**
 * Menyusun kandidat catatan Ingatan A.U.R.A secara otomatis dari hasil riset web,
 * pembahasan gambar visual, solusi pemrograman, maupun preferensi pengguna.
 */
export function deriveAutomaticMemoryCandidate(params: {
  userMessage: string;
  replyText: string;
  sources: AuraSourceCitation[];
  searchQueries: string[];
  attachmentLabel?: string;
}): {
  title: string;
  content: string;
  category: MemoryCategory;
  sourceUris: string[];
} | null {
  const userText = (params.userMessage || '').trim();
  const reply = (params.replyText || '').trim();
  if (!userText || !reply) return null;

  if (userText.includes('saya baru saja masuk melalui perangkat ini')) {
    return null;
  }

  const cleanUserTopic = userText
    .replace(/^\s*(?:a\.?u\.?r\.?a)[\s,!?.:;]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const plainReplySummary = reply
    .replace(/```[\s\S]*?```/g, ' [Solusi kode disertakan] ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 850);

  // 0. Pembahasan Gambar yang Dilampirkan Pengguna
  if (params.attachmentLabel) {
    const isCodeScreenshot =
      /```[\s\S]+?```/.test(reply) ||
      /\b(?:error|bug|kode|code|function|komponen|syntax|terminal|console)\b/i.test(
        `${userText} ${reply}`
      );
    return {
      title: `Gambar (${params.attachmentLabel.slice(0, 45)}): ${(cleanUserTopic || 'Analisis Visual').slice(0, 70)}`.slice(
        0,
        135
      ),
      content: plainReplySummary,
      category: isCodeScreenshot ? 'Pemrograman & Tugas' : 'Riset & Fakta',
      sourceUris: params.sources.map((s) => s.uri).slice(0, 8),
    };
  }

  // 1. Riset Web & Verifikasi Fakta
  if (params.sources.length > 0 || params.searchQueries.length > 0) {
    const queryTitle = params.searchQueries[0] || cleanUserTopic || 'Penelusuran Informasi Web';
    return {
      title: `Riset: ${queryTitle}`.slice(0, 135),
      content: plainReplySummary,
      category: 'Riset & Fakta',
      sourceUris: params.sources.map((s) => s.uri).slice(0, 8),
    };
  }

  // 2. Preferensi Panggilan / Konteks Pribadi
  const isPreferenceMsg =
    /\b(?:panggil saya|sebut saya|nama panggilan|ingat bahwa|tolong ingat|simpan di ingatan|preferensi saya)\b/i.test(
      userText
    );
  if (isPreferenceMsg) {
    return {
      title: `Preferensi: ${cleanUserTopic.slice(0, 90) || 'Pengaturan Personal'}`.slice(0, 135),
      content: `Permintaan pengguna: "${userText.slice(0, 300)}". Konfirmasi A.U.R.A: ${plainReplySummary}`.slice(
        0,
        1200
      ),
      category: 'Preferensi & Konteks',
      sourceUris: [],
    };
  }

  // 3. Pemrograman, Debugging & Penyelesaian Tugas
  const hasCodeBlock = /```[\s\S]+?```/.test(reply) || /```[\s\S]+?```/.test(userText);
  const isCodingOrTaskQuery =
    /\b(?:debug|bug|error|kode|code|function|fungsi|program|script|typescript|javascript|python|react|sql|api|algoritma|refactor|perbaiki)\b/i.test(
      userText
    );

  if (hasCodeBlock || isCodingOrTaskQuery) {
    return {
      title: `Tugas & Kode: ${(cleanUserTopic || userText).slice(0, 100)}`.slice(0, 135),
      content: plainReplySummary,
      category: 'Pemrograman & Tugas',
      sourceUris: [],
    };
  }

  return null;
}

/**
 * Mengurai teks Markdown menjadi blok terstruktur (blok kode ```lang```, heading, daftar poin, paragraf).
 */
export function parseMarkdownBlocks(rawText: string): MarkdownBlock[] {
  if (!rawText || typeof rawText !== 'string') return [];

  const blocks: MarkdownBlock[] = [];
  const codeBlockRegex = /```([a-zA-Z0-9_+-]*)\r?\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  const parseProseChunk = (chunk: string) => {
    const lines = chunk.split(/\r?\n/);
    let currentParagraph: string[] = [];
    let currentList: { ordered: boolean; items: string[] } | null = null;

    const flushParagraph = () => {
      if (currentParagraph.length > 0) {
        const joined = currentParagraph.join('\n').trim();
        if (joined) blocks.push({ type: 'paragraph', text: joined });
        currentParagraph = [];
      }
    };

    const flushList = () => {
      if (currentList && currentList.items.length > 0) {
        blocks.push({
          type: 'list',
          ordered: currentList.ordered,
          items: currentList.items,
        });
      }
      currentList = null;
    };

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        flushParagraph();
        flushList();
        continue;
      }

      const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        flushParagraph();
        flushList();
        const level = Math.min(3, headingMatch[1].length) as 1 | 2 | 3;
        blocks.push({ type: 'heading', level, text: headingMatch[2].trim() });
        continue;
      }

      const unorderedMatch = /^[-*•]\s+(.+)$/.exec(trimmed);
      if (unorderedMatch) {
        flushParagraph();
        if (!currentList || currentList.ordered) {
          flushList();
          currentList = { ordered: false, items: [] };
        }
        currentList.items.push(unorderedMatch[1].trim());
        continue;
      }

      const orderedMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
      if (orderedMatch) {
        flushParagraph();
        if (!currentList || !currentList.ordered) {
          flushList();
          currentList = { ordered: true, items: [] };
        }
        currentList.items.push(orderedMatch[1].trim());
        continue;
      }

      flushList();
      currentParagraph.push(rawLine);
    }

    flushParagraph();
    flushList();
  };

  while ((match = codeBlockRegex.exec(rawText)) !== null) {
    if (match.index > lastIdx) {
      parseProseChunk(rawText.slice(lastIdx, match.index));
    }
    blocks.push({
      type: 'code',
      language: (match[1] || 'kode').trim().toLowerCase(),
      code: match[2].replace(/\s+$/, ''),
    });
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < rawText.length) {
    parseProseChunk(rawText.slice(lastIdx));
  }

  return blocks;
}

/**
 * Mengurai format Markdown inline (**tebal**, `kode`, dan [judul](https://url)) menjadi segmen aman.
 */
export function parseInlineMarkdownSegments(text: string): InlineMarkdownSegment[] {
  if (!text) return [];

  const segments: InlineMarkdownSegment[] = [];
  const tokenRegex = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: text.slice(lastIndex, match.index),
      });
    }

    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      segments.push({
        type: 'bold',
        content: token.slice(2, -2),
      });
    } else if (token.startsWith('`') && token.endsWith('`')) {
      segments.push({
        type: 'code',
        content: token.slice(1, -1),
      });
    } else if (token.startsWith('[')) {
      const linkParts = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      if (linkParts) {
        segments.push({
          type: 'link',
          content: linkParts[1],
          href: linkParts[2],
        });
      } else {
        segments.push({ type: 'text', content: token });
      }
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    segments.push({
      type: 'text',
      content: text.slice(lastIndex),
    });
  }

  return segments;
}

/**
 * Membersihkan simbol format Markdown dari teks balasan AI agar terdengar lembut saat dibacakan (TTS).
 */
export function stripMarkdownForSpeech(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') return '';

  return rawText
    .replace(/```[\s\S]*?```/g, ' Berikut kode programnya yang sudah Aura tampilkan di layar. ')
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const binary = globalThis.atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    let segment = '';
    for (let j = 0; j < slice.length; j++) {
      segment += String.fromCharCode(slice[j]);
    }
    chunks.push(segment);
  }
  return globalThis.btoa(chunks.join(''));
}

function writeAsciiToView(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

const SUPPORTED_GEMINI_AUDIO_MIMES = new Set([
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/aac',
  'audio/flac',
]);

/**
 * Menormalkan tipe MIME audio dari browser (misal `audio/webm;codecs=opus` -> `audio/webm`,
 * `audio/x-wav` -> `audio/wav`, `audio/mp3` -> `audio/mpeg`) agar selalu kompatibel dengan Gemini API.
 */
export function normalizeAudioMimeType(rawMime: string | null | undefined): string {
  if (!rawMime || typeof rawMime !== 'string') {
    return 'audio/wav';
  }

  const baseMime = rawMime.split(';')[0].trim().toLowerCase();
  if (!baseMime) {
    return 'audio/wav';
  }

  const aliasMap: Record<string, string> = {
    'audio/x-wav': 'audio/wav',
    'audio/wave': 'audio/wav',
    'audio/vnd.wave': 'audio/wav',
    'audio/mp3': 'audio/mpeg',
    'audio/mpeg3': 'audio/mpeg',
    'audio/x-mpeg-3': 'audio/mpeg',
    'audio/x-m4a': 'audio/mp4',
    'audio/m4a': 'audio/mp4',
    'audio/mp4a-latm': 'audio/mp4',
    'audio/opus': 'audio/ogg',
  };

  const mapped = aliasMap[baseMime] || baseMime;
  return SUPPORTED_GEMINI_AUDIO_MIMES.has(mapped) ? mapped : 'audio/wav';
}

/**
 * Membersihkan hasil transkripsi suara dari tanda kutip pembungkus, blok kode, atau penanda hening/halusinasi.
 */
export function cleanTranscribedText(rawTranscript: string | null | undefined): string {
  if (!rawTranscript || typeof rawTranscript !== 'string') {
    return '';
  }

  let cleaned = rawTranscript
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'") && cleaned.length >= 2) ||
    (cleaned.startsWith('“') && cleaned.endsWith('”') && cleaned.length >= 2)
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  // Buang penanda hening / noise jika model hanya mengembalikan deskripsi keheningan
  cleaned = cleaned
    .replace(
      /\[(?:hening|diam|tidak ada suara|suara tidak jelas|musik|derau|noise|silence|inaudible|blank_audio|unintelligible)\]/gi,
      ' '
    )
    .replace(
      /\((?:hening|diam|tidak ada suara|suara tidak jelas|noise|silence|inaudible|blank_audio)\)/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();

  if (
    /^(?:hening|tidak ada suara|tidak ada ucapan|tidak terdengar suara|tidak terdengar ucapan|silence|no speech|no audio|[.,\-_!?…]+)$/i.test(
      cleaned
    )
  ) {
    return '';
  }

  return cleaned;
}

/**
 * Menggabungkan segmen final dan segmen interim dari Web Speech API tanpa menduplikasi frasa akhir.
 */
export function mergeSpeechTranscriptParts(
  finalSegments: readonly string[],
  interimSegment?: string | null
): string {
  const parts: string[] = [];
  for (const rawSeg of finalSegments) {
    const seg = (rawSeg || '').replace(/\s+/g, ' ').trim();
    if (!seg) continue;
    const prev = parts[parts.length - 1];
    if (prev && prev.toLowerCase() === seg.toLowerCase()) {
      continue;
    }
    parts.push(seg);
  }

  const interim = (interimSegment || '').replace(/\s+/g, ' ').trim();
  if (interim) {
    const joinedFinals = parts.join(' ');
    const lowerFinals = joinedFinals.toLowerCase();
    const lowerInterim = interim.toLowerCase();
    if (!lowerFinals.endsWith(lowerInterim)) {
      parts.push(interim);
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export interface NormalizedPcmResult {
  samples: Float32Array;
  peak: number;
  rms: number;
  gainApplied: number;
}

/**
 * Menggabungkan potongan sampel Float32 dari mikrofon, menurunkan laju sampel ke 16kHz mono
 * dengan perataan anti-aliasing, serta menormalkan gain otomatis bila volume mikrofon terlalu pelan.
 */
export function downsampleAndNormalizePcm(
  chunks: readonly Float32Array[],
  inputSampleRate: number,
  targetSampleRate = 16000
): NormalizedPcmResult {
  let totalInputSamples = 0;
  for (const chunk of chunks) {
    totalInputSamples += chunk.length;
  }

  if (totalInputSamples === 0) {
    return {
      samples: new Float32Array(0),
      peak: 0,
      rms: 0,
      gainApplied: 1,
    };
  }

  const safeInRate =
    Number.isFinite(inputSampleRate) && inputSampleRate >= 8000 ? inputSampleRate : 48000;
  const safeOutRate =
    Number.isFinite(targetSampleRate) && targetSampleRate >= 8000 ? targetSampleRate : 16000;

  const merged = new Float32Array(totalInputSamples);
  let writeOffset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  let downsampled: Float32Array;
  if (safeInRate === safeOutRate) {
    downsampled = merged;
  } else {
    const ratio = safeInRate / safeOutRate;
    const outLength = Math.max(1, Math.round(totalInputSamples / ratio));
    downsampled = new Float32Array(outLength);

    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(totalInputSamples, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += merged[j];
      }
      downsampled[i] = sum / (end - start);
    }
  }

  // Hilangkan DC offset kecil agar pengukuran amplitudo dan penguatan gain akurat
  let mean = 0;
  for (let i = 0; i < downsampled.length; i++) {
    mean += downsampled[i];
  }
  mean /= downsampled.length;

  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < downsampled.length; i++) {
    const centered = downsampled[i] - mean;
    downsampled[i] = centered;
    const abs = Math.abs(centered);
    if (abs > peak) peak = abs;
    sumSq += centered * centered;
  }

  const rms = Math.sqrt(sumSq / downsampled.length);

  // Bila sinyal nyata terdeteksi (peak >= 0.004) namun pelan, angkat gain ke target puncak ~0.85 (maks 14x)
  let gainApplied = 1;
  if (peak >= 0.004 && peak < 0.82) {
    gainApplied = Math.min(14, 0.85 / peak);
    for (let i = 0; i < downsampled.length; i++) {
      const boosted = downsampled[i] * gainApplied;
      downsampled[i] = boosted > 1 ? 1 : boosted < -1 ? -1 : boosted;
    }
  }

  return {
    samples: downsampled,
    peak,
    rms,
    gainApplied,
  };
}

/**
 * Mengubah sampel audio Float32 mono [-1, 1] menjadi berkas RIFF WAV 16-bit PCM utuh dalam Base64.
 */
export function encodeFloat32PcmToWavBase64(samples: Float32Array, sampleRate = 16000): string {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;

  const wavBytes = new Uint8Array(44 + dataSize);
  const view = new DataView(wavBytes.buffer);

  writeAsciiToView(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAsciiToView(view, 8, 'WAVE');
  writeAsciiToView(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAsciiToView(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let byteOffset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = samples[i] > 1 ? 1 : samples[i] < -1 ? -1 : samples[i];
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(byteOffset, int16, true);
    byteOffset += 2;
  }

  return encodeBytesToBase64(wavBytes);
}

/**
 * Memastikan data audio base64 dari Gemini TTS berformat WAV yang valid (memiliki header RIFF).
 */
export function ensurePlayableWavBase64(base64Audio: string, sampleRate = 24000): string {
  const audioBytes = decodeBase64ToBytes(base64Audio);
  if (
    audioBytes.length >= 44 &&
    audioBytes[0] === 0x52 &&
    audioBytes[1] === 0x49 &&
    audioBytes[2] === 0x46 &&
    audioBytes[3] === 0x46
  ) {
    return encodeBytesToBase64(audioBytes);
  }

  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = audioBytes.length;

  const wavBytes = new Uint8Array(44 + dataSize);
  const view = new DataView(wavBytes.buffer);

  writeAsciiToView(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAsciiToView(view, 8, 'WAVE');
  writeAsciiToView(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAsciiToView(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  wavBytes.set(audioBytes, 44);
  return encodeBytesToBase64(wavBytes);
}

/**
 * Menormalkan riwayat percakapan multi-turn beserta lampiran gambar multimodal.
 * Ketika `tokenSaver` aktif:
 * - Memangkas jendela riwayat ke 8 giliran terakhir dan meringkas giliran lama agar hemat token.
 * - Jika pengguna sedang membahas lanjutan gambar dari beberapa pesan sebelumnya tanpa mengunggah
 *   ulang, hanya menyertakan maksimal 1 gambar historis terbaru saat pertanyaan merujuk visual.
 */
export function normalizeConversationTurns(
  rawHistory: unknown[],
  latestUserMessage: string,
  options?: {
    tokenSaver?: boolean;
    latestImage?: AuraImageAttachment | null;
  }
): NormalizedGeminiContent[] {
  const tokenSaver = options?.tokenSaver ?? false;
  const latestImage = options?.latestImage ?? null;
  const maxHistoryItems = tokenSaver ? 8 : 22;

  const cleanedTurns: RawConversationTurn[] = [];
  const slicedHistory = rawHistory.slice(-maxHistoryItems);

  for (let i = 0; i < slicedHistory.length; i++) {
    const item = slicedHistory[i];
    if (!item || typeof item !== 'object') continue;
    const candidate = item as {
      role?: unknown;
      text?: unknown;
      imageAttachment?: unknown;
      attachmentLabel?: unknown;
    };
    if (
      (candidate.role === 'user' || candidate.role === 'model') &&
      typeof candidate.text === 'string' &&
      candidate.text.trim()
    ) {
      const isRecentTurn = i >= slicedHistory.length - 4;
      const charCap = tokenSaver ? (isRecentTurn ? 3600 : 750) : 12000;
      const validHistImage = sanitizeImageAttachment(candidate.imageAttachment);
      const labelNote =
        typeof candidate.attachmentLabel === 'string' && candidate.attachmentLabel.trim()
          ? candidate.attachmentLabel.trim().slice(0, 120)
          : validHistImage?.label;

      cleanedTurns.push({
        role: candidate.role,
        text: candidate.text.trim().slice(0, charCap),
        imageAttachment: validHistImage,
        attachmentLabel: labelNote,
      });
    }
  }

  // Pertahankan maksimal 1 gambar historis terbaru bila giliran ini tidak mengirim gambar baru
  // dan pengguna menanyakan detail visual lanjutan (atau baru saja mengirim gambar pada giliran tepat sebelumnya).
  const asksAboutPreviousVisual =
    /\b(?:gambar|foto|tangkapan layar|screenshot|diagram|bagian|tulisan|angka|warna|tabel|pojok|baris|lihat lagi|di atas|tadi)\b/i.test(
      latestUserMessage
    );

  let lastHistoricalImageIdx = -1;
  if (!latestImage) {
    for (let i = cleanedTurns.length - 1; i >= 0; i--) {
      if (cleanedTurns[i].imageAttachment && cleanedTurns.length - i <= 4) {
        const isImmediateFollowUp = cleanedTurns.length - i <= 2;
        if (!tokenSaver || asksAboutPreviousVisual || isImmediateFollowUp) {
          lastHistoricalImageIdx = i;
        }
        break;
      }
    }
  }

  for (let i = 0; i < cleanedTurns.length; i++) {
    if (i !== lastHistoricalImageIdx) {
      cleanedTurns[i].imageAttachment = null;
    }
  }

  if (cleanedTurns.length > 0 && cleanedTurns[0].role === 'model') {
    cleanedTurns.unshift({
      role: 'user',
      text: 'Aura, sapa saya dengan lembut dan ringkas agenda saya.',
    });
  }

  cleanedTurns.push({
    role: 'user',
    text: latestUserMessage.trim().slice(0, 12000),
    imageAttachment: latestImage,
    attachmentLabel: latestImage?.label,
  });

  const merged: NormalizedGeminiContent[] = [];
  for (const turn of cleanedTurns) {
    const turnParts: NormalizedGeminiPart[] = [];
    if (turn.imageAttachment) {
      turnParts.push({
        inlineData: {
          mimeType: turn.imageAttachment.mimeType,
          data: turn.imageAttachment.base64Data,
        },
      });
    }
    const textWithLabel =
      turn.attachmentLabel && !turn.imageAttachment
        ? `[Konteks gambar sebelumnya: ${turn.attachmentLabel}]\n${turn.text}`
        : turn.text;
    turnParts.push({ text: textWithLabel });

    const prev = merged[merged.length - 1];
    if (prev && prev.role === turn.role) {
      prev.parts.push(...turnParts);
    } else {
      merged.push({
        role: turn.role,
        parts: turnParts,
      });
    }
  }

  return merged;
}

/**
 * Mengklasifikasikan error dari Gemini API (@google/genai).
 */
export function classifyGeminiError(error: unknown): ClassifiedGeminiError {
  const rawStatus =
    typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : undefined;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const upper = rawMessage.toUpperCase();

  if (
    rawStatus === 503 ||
    rawStatus === 500 ||
    rawStatus === 502 ||
    rawStatus === 504 ||
    upper.includes('503') ||
    upper.includes('504') ||
    upper.includes('UNAVAILABLE') ||
    upper.includes('SERVICE UNAVAILABLE') ||
    upper.includes('DEADLINE_EXCEEDED') ||
    upper.includes('HIGH DEMAND') ||
    upper.includes('OVERLOADED') ||
    upper.includes('FETCH FAILED') ||
    upper.includes('ECONNRESET') ||
    upper.includes('ETIMEDOUT') ||
    upper.includes('SOCKET HANG UP')
  ) {
    return {
      httpStatus: 503,
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
      shouldTryFallbackModel: true,
      userMessage:
        'Server model AI sedang mengalami lonjakan permintaan tinggi untuk sementara waktu. Silakan klik tombol "Coba Lagi" setelah hitung mundur selesai.',
    };
  }

  if (rawStatus === 429 || upper.includes('RESOURCE_EXHAUSTED') || upper.includes('429')) {
    const isHardQuota =
      upper.includes('EXCEEDED YOUR CURRENT QUOTA') ||
      upper.includes('CHECK YOUR PLAN AND BILLING') ||
      upper.includes('BILLING DETAILS') ||
      upper.includes('PERDAY') ||
      upper.includes('PER_DAY') ||
      upper.includes('LIMIT: 0');

    return {
      httpStatus: 429,
      code: isHardQuota ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED',
      retryable: !isHardQuota,
      shouldTryFallbackModel: true,
      isHardQuotaExhausted: isHardQuota,
      userMessage: isHardQuota
        ? 'Batas kuota Gemini API pada kunci saat ini telah habis (429 RESOURCE_EXHAUSTED). Tunggu hingga kuota direset, atau tingkatkan kuota ke paket berbayar dengan memilih API key berpenagihan aktif pada panel Settings > Secrets.'
        : 'Batas frekuensi permintaan Gemini API per menit tercapai sementara. Tunggu beberapa detik hingga jeda selesai, atau pilih API key berpenagihan aktif pada panel Settings > Secrets untuk kuota lebih tinggi.',
    };
  }

  if (
    rawStatus === 401 ||
    rawStatus === 403 ||
    upper.includes('API_KEY_INVALID') ||
    upper.includes('PERMISSION_DENIED')
  ) {
    return {
      httpStatus: 403,
      code: 'INVALID_API_KEY',
      retryable: false,
      shouldTryFallbackModel: false,
      userMessage:
        'Kunci Gemini API tidak valid atau ditolak. Periksa konfigurasi kunci Anda pada panel Settings > Secrets di AI Studio.',
    };
  }

  if (rawStatus === 404 || upper.includes('NOT_FOUND')) {
    return {
      httpStatus: 502,
      code: 'MODEL_NOT_FOUND',
      retryable: false,
      shouldTryFallbackModel: true,
      userMessage: 'Model AI utama sedang tidak tersedia di wilayah ini.',
    };
  }

  if (
    rawStatus === 400 &&
    (upper.includes('INVALID_ARGUMENT') ||
      upper.includes('UNSUPPORTED') ||
      upper.includes('MODALITY') ||
      upper.includes('MIME'))
  ) {
    return {
      httpStatus: 400,
      code: 'INTERNAL_ERROR',
      retryable: false,
      shouldTryFallbackModel: true,
      userMessage: 'Format media belum didukung oleh model utama, mengalihkan ke model cadangan.',
    };
  }

  return {
    httpStatus: rawStatus && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500,
    code: 'INTERNAL_ERROR',
    retryable: false,
    shouldTryFallbackModel: false,
    userMessage: 'Gagal memproses respons A.U.R.A. Silakan coba kirim ulang pesan Anda.',
  };
}

/**
 * Menyusun sapaan awal A.U.R.A yang hangat, lembut, dan personal secara lokal
 * agar pembukaan sesi baru instan tanpa menghabiskan kuota panggilan Gemini API.
 */
export function buildLocalWelcomeGreeting(params: {
  displayName: string;
  routines: RoutineItem[];
  memoriesCount?: number;
}): string {
  const safeName = sanitizeDisplayName(params.displayName, 'Pengguna');
  const pendingRoutines = params.routines
    .filter((item) => !item.completed)
    .sort((a, b) => a.time.localeCompare(b.time));

  const routineSummary =
    pendingRoutines.length > 0
      ? `Saat ini terdapat **${pendingRoutines.length} agenda rutinitas** yang menanti, dimulai dari **${pendingRoutines[0].title}** pada pukul \`${pendingRoutines[0].time}\`.`
      : 'Seluruh agenda rutinitas terjadwal Anda hari ini telah tercatat selesai dengan baik.';

  const memoryNote =
    typeof params.memoriesCount === 'number' && params.memoriesCount > 0
      ? ` Aura juga telah menyinkronkan **${params.memoriesCount} catatan ingatan** Anda agar diskusi kita tetap berkesinambungan.`
      : '';

  return [
    `Ya, ${safeName}, Aura hadir mendampingi Anda dengan tenang hari ini.`,
    `${routineSummary}${memoryNote}`,
    'Silakan panggil **Aura** kapan saja—Anda dapat mengetik pesan, menekan tombol **Gambar** untuk melampirkan visual yang ingin dibahas, atau menggunakan **Suara**.',
  ].join('\n\n');
}

/**
 * Menjalankan pemanggilan Gemini API dengan retry opsional dan fallback model otomatis.
 */
export async function executeWithModelFallback<T>(
  models: readonly string[],
  invokeModel: (modelName: string) => Promise<T>,
  options?: {
    maxRetriesPerModel?: number;
    baseDelayMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  }
): Promise<{ result: T; usedModel: string; attempts: number }> {
  const maxRetries = options?.maxRetriesPerModel ?? 1;
  const baseDelayMs = options?.baseDelayMs ?? 450;
  const sleep =
    options?.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let totalAttempts = 0;
  let lastError: unknown = new Error('Daftar model Gemini kosong.');

  for (let modelIdx = 0; modelIdx < models.length; modelIdx++) {
    const modelName = models[modelIdx];
    const retriesForThisModel = modelIdx === 0 ? maxRetries : 0;

    for (let attempt = 0; attempt <= retriesForThisModel; attempt++) {
      totalAttempts++;
      try {
        const result = await invokeModel(modelName);
        return { result, usedModel: modelName, attempts: totalAttempts };
      } catch (err: unknown) {
        lastError = err;
        const classified = classifyGeminiError(err);

        if (!classified.retryable && !classified.shouldTryFallbackModel) {
          throw err;
        }

        if (classified.retryable && attempt < retriesForThisModel) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        if (classified.shouldTryFallbackModel && modelIdx < models.length - 1) {
          break;
        }
      }
    }
  }

  throw lastError;
}

/**
 * Mengekstrak Bearer token OAuth 2.0 dari header HTTP Authorization secara aman.
 */
export function parseBearerToken(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') {
    return null;
  }

  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+([A-Za-z0-9._\-~+/]+=*)$/i.exec(trimmed);
  if (!match || !match[1]) {
    return null;
  }

  const token = match[1].trim();
  if (token.length < 16 || token.length > 4096) {
    return null;
  }

  return token;
}

export interface RoutineDraftInput {
  title: string;
  time: string;
  category: RoutineCategory;
  notes?: string;
}

export interface RoutineValidationResult {
  valid: boolean;
  error?: string;
  normalized?: RoutineDraftInput;
}

const VALID_CATEGORIES: RoutineCategory[] = [
  'Fokus Kerja',
  'Kesehatan',
  'Pribadi',
  'Evaluasi',
];

const VALID_MEMORY_CATEGORIES: MemoryCategory[] = [
  'Riset & Fakta',
  'Pemrograman & Tugas',
  'Preferensi & Konteks',
];

/**
 * Memvalidasi input form pembuatan rutinitas baru sesuai kontrak firebase-blueprint.json.
 */
export function validateRoutineDraft(draft: RoutineDraftInput): RoutineValidationResult {
  const title = draft.title.trim();
  if (!title) {
    return { valid: false, error: 'Nama rutinitas wajib diisi.' };
  }
  if (title.length < 3) {
    return { valid: false, error: 'Nama rutinitas minimal 3 karakter.' };
  }
  if (title.length > 100) {
    return { valid: false, error: 'Nama rutinitas maksimal 100 karakter.' };
  }

  const time = draft.time.trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
    return { valid: false, error: 'Format waktu harus HH:MM (contoh 07:30).' };
  }

  if (!VALID_CATEGORIES.includes(draft.category)) {
    return { valid: false, error: 'Kategori rutinitas tidak valid.' };
  }

  const notes = draft.notes?.trim();
  if (notes && notes.length > 240) {
    return { valid: false, error: 'Catatan tambahan maksimal 240 karakter.' };
  }

  return {
    valid: true,
    normalized: {
      title,
      time,
      category: draft.category,
      notes: notes || undefined,
    },
  };
}

export interface MemoryDraftInput {
  title: string;
  content: string;
  category: MemoryCategory;
  sourceUris?: string[];
}

export interface MemoryValidationResult {
  valid: boolean;
  error?: string;
  normalized?: {
    title: string;
    content: string;
    category: MemoryCategory;
    sourceUris: string[];
  };
}

/**
 * Memvalidasi input form pembuatan catatan Ingatan A.U.R.A sesuai kontrak firebase-blueprint.json.
 */
export function validateMemoryDraft(draft: MemoryDraftInput): MemoryValidationResult {
  const title = draft.title.trim();
  if (title.length < 2) {
    return { valid: false, error: 'Judul ingatan minimal 2 karakter.' };
  }
  if (title.length > 140) {
    return { valid: false, error: 'Judul ingatan maksimal 140 karakter.' };
  }

  const content = draft.content.trim();
  if (content.length < 3) {
    return { valid: false, error: 'Isi ingatan minimal 3 karakter.' };
  }
  if (content.length > 4000) {
    return { valid: false, error: 'Isi ingatan maksimal 4.000 karakter.' };
  }

  if (!VALID_MEMORY_CATEGORIES.includes(draft.category)) {
    return { valid: false, error: 'Kategori ingatan tidak valid.' };
  }

  const cleanUris = (draft.sourceUris ?? [])
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 8)
    .map((u) => u.slice(0, 1024));

  return {
    valid: true,
    normalized: {
      title,
      content,
      category: draft.category,
      sourceUris: cleanUris,
    },
  };
}

/**
 * Memvalidasi array rutinitas dari penyimpanan atau payload klien.
 */
export function sanitizeStoredRoutines(raw: unknown, fallback: RoutineItem[]): RoutineItem[] {
  if (!Array.isArray(raw)) {
    return fallback;
  }

  const validItems: RoutineItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Partial<RoutineItem>;
    if (
      typeof item.id === 'string' &&
      item.id.trim() &&
      typeof item.title === 'string' &&
      item.title.trim() &&
      typeof item.time === 'string' &&
      /^([01]\d|2[0-3]):([0-5]\d)$/.test(item.time) &&
      typeof item.category === 'string' &&
      VALID_CATEGORIES.includes(item.category as RoutineCategory) &&
      typeof item.completed === 'boolean'
    ) {
      validItems.push({
        id: item.id,
        title: item.title.trim().slice(0, 100),
        time: item.time,
        category: item.category as RoutineCategory,
        completed: item.completed,
        notes:
          typeof item.notes === 'string' && item.notes.trim()
            ? item.notes.trim().slice(0, 240)
            : undefined,
      });
    }
  }

  return validItems;
}

/**
 * Memvalidasi array catatan Ingatan A.U.R.A dari payload klien sebelum disuntikkan ke systemInstruction.
 */
export function sanitizeStoredMemories(raw: unknown): MemoryItem[] {
  if (!Array.isArray(raw)) return [];

  const validMemories: MemoryItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Partial<MemoryItem>;
    if (
      typeof item.id === 'string' &&
      item.id.trim() &&
      typeof item.title === 'string' &&
      item.title.trim().length >= 2 &&
      typeof item.content === 'string' &&
      item.content.trim().length >= 3 &&
      typeof item.category === 'string' &&
      VALID_MEMORY_CATEGORIES.includes(item.category as MemoryCategory)
    ) {
      const sourceUris = Array.isArray(item.sourceUris)
        ? item.sourceUris
            .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
            .slice(0, 8)
            .map((u) => u.slice(0, 1024))
        : [];

      validMemories.push({
        id: item.id.trim().slice(0, 128),
        title: item.title.trim().slice(0, 140),
        content: item.content.trim().slice(0, 4000),
        category: item.category as MemoryCategory,
        sourceUris,
        updatedAtIso:
          typeof item.updatedAtIso === 'string' && item.updatedAtIso.trim()
            ? item.updatedAtIso.trim()
            : new Date().toISOString(),
      });
    }
  }

  return validMemories;
}
