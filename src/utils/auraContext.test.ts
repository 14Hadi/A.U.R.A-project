import { Buffer } from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeDisplayName,
  extractProfileFromPeopleApi,
  startsWithAuraInvocation,
  ensureWarmAuraOpening,
  buildAuraSystemInstruction,
  shouldInvokeWebSearchTool,
  selectRelevantMemoriesForPrompt,
  sanitizeImageAttachment,
  estimateApproximateTokens,
  extractUrlsFromText,
  extractGroundingCitations,
  deriveAutomaticMemoryCandidate,
  parseMarkdownBlocks,
  parseInlineMarkdownSegments,
  stripMarkdownForSpeech,
  normalizeAudioMimeType,
  cleanTranscribedText,
  mergeSpeechTranscriptParts,
  downsampleAndNormalizePcm,
  encodeFloat32PcmToWavBase64,
  ensurePlayableWavBase64,
  parseBearerToken,
  validateRoutineDraft,
  validateMemoryDraft,
  normalizeConversationTurns,
  classifyGeminiError,
  buildLocalWelcomeGreeting,
  executeWithModelFallback,
  sanitizeStoredRoutines,
  sanitizeStoredMemories,
} from './auraContext';

test('sanitizeDisplayName strips control characters and injection symbols', () => {
  assert.equal(sanitizeDisplayName('  Hadikul\nJabil\t '), 'Hadikul Jabil');
  assert.equal(
    sanitizeDisplayName('Budi <script>alert(1)</script> Santoso'),
    'Budi scriptalert1script Santoso'
  );
  assert.equal(sanitizeDisplayName('   ', 'Tamu'), 'Tamu');
  assert.equal(sanitizeDisplayName(null, 'Pengguna'), 'Pengguna');
});

test('extractProfileFromPeopleApi prioritizes primary Google People Display Name', () => {
  const result = extractProfileFromPeopleApi(
    {
      names: [
        { displayName: 'Nama Sekunder', metadata: { primary: false } },
        { displayName: 'Hadikul Jabil', givenName: 'Hadikul', metadata: { primary: true } },
      ],
      emailAddresses: [{ value: 'hadikuljabil@gmail.com', metadata: { primary: true } }],
      photos: [{ url: 'https://lh3.googleusercontent.com/a/photo', metadata: { primary: true } }],
    },
    { displayName: 'Fallback User', email: 'fallback@example.com' }
  );

  assert.equal(result.displayName, 'Hadikul Jabil');
  assert.equal(result.givenName, 'Hadikul');
  assert.equal(result.email, 'hadikuljabil@gmail.com');
  assert.equal(result.source, 'google_people_api');
});

test('startsWithAuraInvocation and ensureWarmAuraOpening enforce warm confirmation', () => {
  assert.equal(startsWithAuraInvocation('Aura, tolong cari fakta tentang TypeScript 5.8'), true);
  assert.equal(startsWithAuraInvocation('  A.U.R.A bantu debug kode ini'), true);
  assert.equal(startsWithAuraInvocation('Tolong perbaiki fungsi AuraService ini'), false);

  const enforced = ensureWarmAuraOpening(
    'Berikut hasil verifikasi faktanya untuk Anda.',
    'Aura, cek berita rilis Node.js terbaru'
  );
  assert.match(
    enforced,
    /^(Ya, saya mendengarkan\.|Ada yang bisa Aura bantu\?|Iya, bagaimana\?) Berikut hasil verifikasi faktanya/
  );
});

test('Token Saver mode reduces systemInstruction tokens significantly while preserving Aura persona & preferences', () => {
  const manyMemories = Array.from({ length: 12 }, (_, idx) => ({
    id: `m-${idx}`,
    title: idx === 0 ? 'Preferensi: Panggilan Tuan' : `Riset Topik Ke-${idx}`,
    content:
      idx === 0
        ? 'Pengguna meminta selalu dipanggil Tuan.'
        : 'Ringkasan panjang hasil riset teknis sebelumnya yang memakan ruang konteks apabila semuanya dikirim terus menerus.',
    category: idx === 0 ? ('Preferensi & Konteks' as const) : ('Riset & Fakta' as const),
    sourceUris: ['https://example.com/doc'],
    updatedAtIso: '2026-11-04T08:00:00.000Z',
  }));

  const fullInstruction = buildAuraSystemInstruction({
    displayName: 'Hadikul Jabil',
    memories: manyMemories,
    latestUserMessage: 'Aura, apa kabar pagi ini?',
    tokenSaver: false,
  });

  const compactInstruction = buildAuraSystemInstruction({
    displayName: 'Hadikul Jabil',
    memories: manyMemories,
    latestUserMessage: 'Aura, apa kabar pagi ini?',
    tokenSaver: true,
    hasImageAttachment: true,
  });

  assert.ok(
    estimateApproximateTokens(compactInstruction) <
      estimateApproximateTokens(fullInstruction) * 0.65,
    'Expected Token Saver mode to cut systemInstruction size by >35%'
  );
  assert.match(compactInstruction, /ATURAN SAPAAN WAJIB "AURA"/);
  assert.match(compactInstruction, /Preferensi: Panggilan Tuan/);
  assert.match(compactInstruction, /GAMBAR TERLAMPIR/);
  assert.match(compactInstruction, /MODE HEMAT TOKEN AKTIF/);
});

test('shouldInvokeWebSearchTool skips costly search grounding on casual/coding chats when tokenSaver is active', () => {
  assert.equal(
    shouldInvokeWebSearchTool({
      message: 'Aura, tolong rapikan fungsi rekursif Python ini',
      enableWebSearch: true,
      tokenSaver: true,
    }),
    false
  );
  assert.equal(
    shouldInvokeWebSearchTool({
      message: 'Aura, tolong telusuri berita rilis terbaru Node.js LTS hari ini',
      enableWebSearch: true,
      tokenSaver: true,
    }),
    true
  );
  assert.equal(
    shouldInvokeWebSearchTool({
      message: 'Analisis artikel https://react.dev/blog',
      enableWebSearch: true,
      tokenSaver: true,
    }),
    true
  );
});

test('selectRelevantMemoriesForPrompt keeps preferences and top matching topic memories', () => {
  const sample = [
    {
      id: '1',
      title: 'Preferensi: Panggilan Tuan',
      content: 'Panggil pengguna Tuan.',
      category: 'Preferensi & Konteks' as const,
      sourceUris: [],
      updatedAtIso: '2026-11-04T01:00:00.000Z',
    },
    {
      id: '2',
      title: 'Riset: Cuaca Tokyo',
      content: 'Suhu rata-rata musim gugur.',
      category: 'Riset & Fakta' as const,
      sourceUris: [],
      updatedAtIso: '2026-11-04T02:00:00.000Z',
    },
    {
      id: '3',
      title: 'Tugas & Kode: Perbaikan Docker PostgreSQL',
      content: 'Gunakan healthcheck pg_isready pada docker-compose.',
      category: 'Pemrograman & Tugas' as const,
      sourceUris: [],
      updatedAtIso: '2026-11-04T03:00:00.000Z',
    },
  ];

  const selected = selectRelevantMemoriesForPrompt(
    sample,
    'Bagaimana konfigurasi docker PostgreSQL kita kemarin?',
    true
  );
  assert.equal(selected[0].title, 'Preferensi: Panggilan Tuan');
  assert.equal(selected[1].title, 'Tugas & Kode: Perbaikan Docker PostgreSQL');
});

test('sanitizeImageAttachment validates MIME types and base64 payloads, and normalizeConversationTurns supports multimodal follow-ups', () => {
  const fakePngBase64 = Buffer.alloc(48, 0x42).toString('base64');
  const validImg = sanitizeImageAttachment({
    base64Data: `data:image/png;base64,${fakePngBase64}`,
    mimeType: 'image/png',
    label: 'error-console.png (800×600)',
  });
  assert.ok(validImg);
  assert.equal(validImg.mimeType, 'image/png');
  assert.equal(validImg.base64Data, fakePngBase64);

  assert.equal(
    sanitizeImageAttachment({
      base64Data: fakePngBase64,
      mimeType: 'application/pdf',
      label: 'doc.pdf',
    }),
    null
  );

  // Follow-up turn referencing previous image retains single historical inlineData
  const turns = normalizeConversationTurns(
    [
      {
        role: 'user',
        text: 'Aura, lihat gambar arsitektur ini.',
        imageAttachment: validImg,
      },
      {
        role: 'model',
        text: 'Ya, saya mendengarkan. Pada gambar tersebut terlihat tiga layanan mikro.',
      },
    ],
    'Aura, coba jelaskan tulisan pada bagian kanan gambar tadi.',
    { tokenSaver: true, latestImage: null }
  );

  assert.equal(turns.length, 3);
  const firstTurnHasInline = turns[0].parts.some((p) => 'inlineData' in p);
  assert.equal(firstTurnHasInline, true);
});

test('extractUrlsFromText, extractGroundingCitations, and deriveAutomaticMemoryCandidate handle web & image memories', () => {
  const urls = extractUrlsFromText('Cek https://nodejs.org/en/blog.');
  assert.deepEqual(urls, ['https://nodejs.org/en/blog']);

  const citations = extractGroundingCitations({
    webSearchQueries: ['nodejs lts'],
    groundingChunks: [{ web: { uri: 'https://nodejs.org', title: 'Node.js' } }],
  });
  assert.equal(citations.sources.length, 1);

  const imgMem = deriveAutomaticMemoryCandidate({
    userMessage: 'Aura, periksa error di screenshot ini',
    replyText: 'Ya, saya mendengarkan. Terlihat TypeError pada baris 42.',
    sources: [],
    searchQueries: [],
    attachmentLabel: 'screenshot-bug.jpg',
  });
  assert.equal(imgMem?.category, 'Pemrograman & Tugas');
  assert.match(imgMem?.title || '', /^Gambar \(screenshot-bug\.jpg\)/);
});

test('parseMarkdownBlocks and parseInlineMarkdownSegments parse code blocks and links cleanly', () => {
  const blocks = parseMarkdownBlocks('```js\nconst x = 1;\n```');
  assert.deepEqual(blocks, [{ type: 'code', language: 'js', code: 'const x = 1;' }]);

  const segments = parseInlineMarkdownSegments('Lihat **dokumen** [React](https://react.dev)');
  assert.equal(segments[1].type, 'bold');
  assert.equal(segments[3].type, 'link');
});

test('parseBearerToken, validateRoutineDraft, validateMemoryDraft, and WAV helper pass checks', () => {
  const validToken = 'ya29.a0AfH6SMBx9_valid_google_oauth_token_123456';
  assert.equal(parseBearerToken(`Bearer ${validToken}`), validToken);
  assert.equal(
    validateRoutineDraft({ title: 'Olahraga', time: '06:30', category: 'Kesehatan' }).valid,
    true
  );
  assert.equal(
    validateMemoryDraft({
      title: 'Catatan',
      content: 'Isi catatan valid',
      category: 'Riset & Fakta',
    }).valid,
    true
  );

  const rawPcm = Buffer.alloc(60, 0x10).toString('base64');
  const wav = ensurePlayableWavBase64(rawPcm, 24000);
  assert.equal(Buffer.from(wav, 'base64').subarray(0, 4).toString('ascii'), 'RIFF');
  assert.match(
    stripMarkdownForSpeech('```ts\nx();\n```'),
    /Berikut kode programnya yang sudah Aura tampilkan di layar/
  );
});

test('classifyGeminiError, executeWithModelFallback, and sanitizers handle edge cases', async () => {
  const err = Object.assign(new Error('503 UNAVAILABLE'), { status: 503 });
  assert.equal(classifyGeminiError(err).httpStatus, 503);
  assert.equal(classifyGeminiError(err).code, 'SERVICE_UNAVAILABLE');

  const hardQuotaErr = Object.assign(
    new Error(
      '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}'
    ),
    { status: 429 }
  );
  const classifiedHardQuota = classifyGeminiError(hardQuotaErr);
  assert.equal(classifiedHardQuota.httpStatus, 429);
  assert.equal(classifiedHardQuota.code, 'QUOTA_EXCEEDED');
  assert.equal(classifiedHardQuota.isHardQuotaExhausted, true);
  assert.equal(classifiedHardQuota.retryable, false);
  assert.equal(classifiedHardQuota.shouldTryFallbackModel, true);
  assert.match(classifiedHardQuota.userMessage, /Settings > Secrets/);

  const rpmRateErr = Object.assign(
    new Error('{"error":{"code":429,"message":"Too many requests per minute","status":"RESOURCE_EXHAUSTED"}}'),
    { status: 429 }
  );
  const classifiedRpm = classifyGeminiError(rpmRateErr);
  assert.equal(classifiedRpm.httpStatus, 429);
  assert.equal(classifiedRpm.code, 'RATE_LIMITED');
  assert.equal(classifiedRpm.isHardQuotaExhausted, false);
  assert.equal(classifiedRpm.retryable, true);

  const greeting = buildLocalWelcomeGreeting({
    displayName: 'Tuan Hadikul',
    routines: [
      {
        id: 'r1',
        title: 'Evaluasi malam',
        time: '20:30',
        category: 'Evaluasi',
        completed: false,
      },
      {
        id: 'r2',
        title: 'Sesi fokus pagi',
        time: '08:15',
        category: 'Fokus Kerja',
        completed: false,
      },
    ],
    memoriesCount: 3,
  });
  assert.match(greeting, /Ya, Tuan Hadikul, Aura hadir/);
  assert.match(greeting, /2 agenda rutinitas/);
  assert.match(greeting, /Sesi fokus pagi/);
  assert.match(greeting, /3 catatan ingatan/);

  const res = await executeWithModelFallback(
    ['m1', 'm2'],
    async (m) => {
      if (m === 'm1') throw err;
      return m;
    },
    { maxRetriesPerModel: 0, baseDelayMs: 1, sleepFn: async () => {} }
  );
  assert.equal(res.usedModel, 'm2');
  assert.deepEqual(sanitizeStoredRoutines([], []), []);
  assert.deepEqual(sanitizeStoredMemories('bad'), []);
});

test('normalizeAudioMimeType, cleanTranscribedText, and mergeSpeechTranscriptParts handle real-world voice edge cases', () => {
  assert.equal(normalizeAudioMimeType('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(normalizeAudioMimeType('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(normalizeAudioMimeType('audio/mp4;codecs=mp4a.40.2'), 'audio/mp4');
  assert.equal(normalizeAudioMimeType('audio/x-wav'), 'audio/wav');
  assert.equal(normalizeAudioMimeType('audio/mp3'), 'audio/mpeg');
  assert.equal(normalizeAudioMimeType(''), 'audio/wav');

  assert.equal(cleanTranscribedText('"Aura, tolong cek jadwal fokus saya hari ini."'), 'Aura, tolong cek jadwal fokus saya hari ini.');
  assert.equal(cleanTranscribedText('[Hening]'), '');
  assert.equal(cleanTranscribedText('(tidak ada suara)'), '');
  assert.equal(cleanTranscribedText('Tidak ada ucapan'), '');
  assert.equal(
    cleanTranscribedText('[noise] Aura bantu debug fungsi async ini'),
    'Aura bantu debug fungsi async ini'
  );

  assert.equal(
    mergeSpeechTranscriptParts(
      ['Aura, bantu saya perbaiki bug ini', 'Aura, bantu saya perbaiki bug ini'],
      'pada komponen login'
    ),
    'Aura, bantu saya perbaiki bug ini pada komponen login'
  );
  assert.equal(
    mergeSpeechTranscriptParts(['Aura, cek jadwal hari ini'], 'cek jadwal hari ini'),
    'Aura, cek jadwal hari ini'
  );
});

test('downsampleAndNormalizePcm and encodeFloat32PcmToWavBase64 normalize quiet clear speech into 16kHz RIFF WAV', () => {
  // Simulasikan 0.25 detik sinyal suara jernih namun pelan (peak ~0.06) pada 48kHz
  const inRate = 48000;
  const totalIn = inRate / 4;
  const quietSine = new Float32Array(totalIn);
  for (let i = 0; i < totalIn; i++) {
    quietSine[i] = 0.06 * Math.sin((2 * Math.PI * 440 * i) / inRate);
  }

  const processed = downsampleAndNormalizePcm([quietSine], inRate, 16000);
  assert.equal(processed.samples.length, 4000);
  assert.ok(processed.peak > 0.04 && processed.peak < 0.07);
  assert.ok(processed.gainApplied > 10, 'Quiet speech should receive automatic gain boost');

  let boostedMax = 0;
  for (let i = 0; i < processed.samples.length; i++) {
    boostedMax = Math.max(boostedMax, Math.abs(processed.samples[i]));
  }
  assert.ok(boostedMax > 0.75 && boostedMax <= 1.0);

  const wavBase64 = encodeFloat32PcmToWavBase64(processed.samples, 16000);
  const wavBuf = Buffer.from(wavBase64, 'base64');
  assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wavBuf.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wavBuf.readUInt32LE(24), 16000);
  assert.equal(wavBuf.length, 44 + 4000 * 2);

  // Pastikan keheningan digital murni (peak < 0.001) tidak diperkuat menjadi derau
  const silentChunk = new Float32Array(1600);
  const silentProcessed = downsampleAndNormalizePcm([silentChunk], 16000, 16000);
  assert.equal(silentProcessed.gainApplied, 1);
  assert.equal(silentProcessed.peak, 0);
});

