import React, { useState } from 'react';
import { Copy, Check, Leaf } from 'lucide-react';
import type { MemoryItem, RoutineItem, UserProfile } from '../types/aura.ts';
import {
  buildAuraSystemInstruction,
  estimateApproximateTokens,
} from '../utils/auraContext.ts';
import { getPublicOAuthMetadata } from '../services/googleAuth.ts';

interface ArchitectureGuideProps {
  userProfile: UserProfile | null;
  routines: RoutineItem[];
  memories?: MemoryItem[];
}

type CodeTabId = 'oauth' | 'profile' | 'gemini' | 'tree';

const INSTALL_CMD = `npm install @google/genai firebase express dotenv lucide-react
npm install -D typescript tsx vite @vitejs/plugin-react tailwindcss @tailwindcss/vite @types/express @types/node`;

const CODE_SNIPPETS: Record<CodeTabId, { title: string; filename: string; code: string }> = {
  oauth: {
    title: '01. Google Sign-In (OAuth 2.0), Firestore & Cache Token In-Memory',
    filename: 'src/services/googleAuth.ts',
    code: `import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
// KONFIGURASI CLIENT ID & DATABASE:
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/userinfo.profile');
provider.addScope('https://www.googleapis.com/auth/userinfo.email');

let cachedAccessToken: string | null = null;

export const googleSignIn = async () => {
  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) throw new Error('Gagal memperoleh Access Token');
  cachedAccessToken = credential.accessToken;
  return { user: result.user, accessToken: cachedAccessToken };
};`,
  },
  profile: {
    title: '02. Kompresi Gambar Klien & Sinkronisasi Memori Ringan Firestore',
    filename: 'src/components/AssistantWorkspace.tsx',
    code: `// Mengoptimalkan dimensi gambar <= 1024px (JPEG 0.82) sebelum dikirim ke server
// agar konsumsi token multimodal minimal & respons cepat
const canvas = document.createElement('canvas');
canvas.width = targetW;
canvas.height = targetH;
canvas.getContext('2d')?.drawImage(img, 0, 0, targetW, targetH);
const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);

// Di Cloud Firestore, biner gambar TIDAK PERNAH disimpan (hanya attachmentLabel <= 120 karakter)
// sementara konteks temuan visualnya disimpan ke koleksi aura_memories untuk bahasan lanjutan.`,
  },
  gemini: {
    title: '03. Mode Hemat Token, Analisis Gambar Multimodal & Search Grounding',
    filename: 'server.ts',
    code: `import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  buildAuraSystemInstruction,
  normalizeConversationTurns,
  shouldInvokeWebSearchTool,
} from './src/utils/auraContext.ts';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/aura/chat', async (req, res) => {
  const tokenSaver = req.body.tokenSaver !== false;
  // Memilih hanya memori relevan & memadatkan systemInstruction hingga ~50%
  const systemInstruction = buildAuraSystemInstruction({
    displayName: verifiedIdentity.displayName,
    routines: req.body.routines,
    memories: req.body.memories,
    latestUserMessage: req.body.message,
    tokenSaver,
    hasImageAttachment: Boolean(req.body.imageAttachment),
  });

  // Smart Gating: hanya memanggil Google Search saat ada niat riset fakta / URL
  const useWebSearch = shouldInvokeWebSearchTool({
    message: req.body.message,
    enableWebSearch: req.body.enableWebSearch !== false,
    tokenSaver,
  });

  // Mendukung inlineData gambar saat ini maupun rujukan gambar dari giliran sebelumnya
  const contents = normalizeConversationTurns(req.body.history, req.body.message, {
    tokenSaver,
    latestImage: req.body.imageAttachment,
  });

  const resp = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents,
    config: {
      systemInstruction,
      ...(useWebSearch ? { tools: [{ googleSearch: {} }] } : {}),
      ...(tokenSaver ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
    },
  });
  res.json({ reply: resp.text, tokenUsage: resp.usageMetadata });
});`,
  },
  tree: {
    title: '04. Struktur Direktori Lengkap Full-Stack Lintas Perangkat',
    filename: 'Struktur Proyek A.U.R.A',
    code: `aura-cross-device-client/
├── .env.example                    # Dokumentasi variabel GEMINI_API_KEY (server-only)
├── firebase-applet-config.json     # Kredensial publik OAuth Client ID & Cloud Firestore ID
├── firebase-blueprint.json         # Skema entitas AuraMessage, AuraMemory, AuraRoutine
├── firestore.rules                 # Aturan keamanan ketat (owner-only, anti-image-stuffing)
├── server.ts                       # Express + Multimodal Image + Hemat Token + Search + TTS
└── src/
    ├── App.tsx                     # Shell responsif & sinkronisasi real-time Firestore
    ├── types/aura.ts               # Kontrak AuraImageAttachment, AuraTokenUsage, MemoryItem
    ├── utils/
    │   ├── auraContext.ts          # Pruning memori relevan, smart search gating & multimodal
    │   └── auraContext.test.ts     # Unit test otomatis (node:test)
    └── components/
        ├── AssistantWorkspace.tsx  # Unggah/tempel gambar, toggle Hemat Token, kode & suara
        ├── MemoryVault.tsx         # Brankas Ingatan Jangka Panjang A.U.R.A
        ├── RoutineManager.tsx      # Pengelola jadwal rutinitas harian
        └── ArchitectureGuide.tsx   # Simulator penghematan token & dokumentasi kode`,
  },
};

export const ArchitectureGuide: React.FC<ArchitectureGuideProps> = ({
  userProfile,
  routines,
  memories = [],
}) => {
  const [activeCodeTab, setActiveCodeTab] = useState<CodeTabId>('gemini');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState(
    userProfile?.displayName || 'Hadikul Jabil'
  );
  const [simTokenSaver, setSimTokenSaver] = useState<boolean>(true);

  const oauthMeta = getPublicOAuthMetadata();

  const handleCopy = async (key: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1800);
    } catch {
      // Abaikan jika clipboard dibatasi oleh iframe
    }
  };

  const fullInstruction = buildAuraSystemInstruction({
    displayName: userProfile?.displayName || previewName,
    routines,
    memories,
    latestUserMessage: 'Aura, mari kita bahas detail diagram arsitektur pada gambar ini.',
    tokenSaver: false,
    hasImageAttachment: true,
  });

  const compactInstruction = buildAuraSystemInstruction({
    displayName: userProfile?.displayName || previewName,
    routines,
    memories,
    latestUserMessage: 'Aura, mari kita bahas detail diagram arsitektur pada gambar ini.',
    tokenSaver: true,
    hasImageAttachment: true,
  });

  const activePreviewInstruction = simTokenSaver ? compactInstruction : fullInstruction;
  const fullTokens = estimateApproximateTokens(fullInstruction);
  const compactTokens = estimateApproximateTokens(compactInstruction);
  const savedPercent = Math.max(
    1,
    Math.round(((fullTokens - compactTokens) / Math.max(1, fullTokens)) * 100)
  );

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Header */}
      <div className="border-b border-slate-200 pb-5">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Arsitektur Hemat Token, Analisis Gambar &amp; Keamanan A.U.R.A
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">
          Implementasi referensi lengkap aplikasi klien lintas perangkat menggunakan{' '}
          <span className="font-semibold text-slate-900">
            React 19 + TypeScript + Express + Google OAuth 2.0 + Cloud Firestore + @google/genai
          </span>{' '}
          dengan penghematan kuota token berlapis serta diskusi gambar multimodal berkelanjutan.
        </p>
      </div>

      {/* Required Packages & Installation */}
      <section
        aria-labelledby="packages-heading"
        className="rounded-xl border border-slate-200 bg-white p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="packages-heading" className="text-base font-semibold text-slate-900">
              1. Library &amp; Strategi Penghematan Token
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Kombinasi SDK resmi dan 4 lapis optimasi token untuk menekan pemakaian kuota API.
            </p>
          </div>

          <button
            type="button"
            onClick={() => handleCopy('install', INSTALL_CMD)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 whitespace-nowrap shrink-0"
          >
            {copiedKey === 'install' ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                <span>Tersalin</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Salin Perintah Instalasi</span>
              </>
            )}
          </button>
        </div>

        <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
          <code>{INSTALL_CMD}</code>
        </pre>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2.5 pr-4 font-semibold">Lapisan Optimasi</th>
                <th className="py-2.5 pr-4 font-semibold">Mekanisme</th>
                <th className="py-2.5 font-semibold">Dampak Penghematan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              <tr>
                <td className="py-2.5 pr-4 font-mono text-slate-900">ThinkingLevel.LOW</td>
                <td className="py-2.5 pr-4">Server Gemini 3</td>
                <td className="py-2.5">
                  Memangkas token penalaran internal berlebih sehingga respons jauh lebih cepat dan
                  hemat kuota.
                </td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-mono text-slate-900">Smart Search Gating</td>
                <td className="py-2.5 pr-4">Deteksi Niat Kueri</td>
                <td className="py-2.5">
                  Hanya mengaktifkan <code className="font-mono">googleSearch</code> ketika pesan
                  memuat kata kunci riset/fakta terkini atau URL.
                </td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-mono text-slate-900">Relevant Memory Pruning</td>
                <td className="py-2.5 pr-4">Skor Kata Kunci</td>
                <td className="py-2.5">
                  Hanya menyuntikkan preferensi utama + maks 4 ingatan paling relevan ke{' '}
                  <code className="font-mono">systemInstruction</code>.
                </td>
              </tr>
              <tr>
                <td className="py-2.5 pr-4 font-mono text-slate-900">Kompresi Gambar &le;1024px</td>
                <td className="py-2.5 pr-4">HTML5 Canvas Klien</td>
                <td className="py-2.5">
                  Mengecilkan foto beresolusi besar sebelum dikirim dan hanya mempertahankan 1
                  gambar aktif untuk diskusi lanjutan.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Interactive Code Implementation Viewer */}
      <section
        aria-labelledby="code-viewer-heading"
        className="rounded-xl border border-slate-200 bg-white p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="code-viewer-heading" className="text-base font-semibold text-slate-900">
            2. Kode Implementasi Inti &amp; Penjelasan Keamanan
          </h2>

          <button
            type="button"
            onClick={() => handleCopy(activeCodeTab, CODE_SNIPPETS[activeCodeTab].code)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 whitespace-nowrap shrink-0"
          >
            {copiedKey === activeCodeTab ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                <span>Kode Tersalin</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Salin Berkas Ini</span>
              </>
            )}
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Pilih modul implementasi kode"
          className="mt-4 flex flex-wrap gap-1.5 rounded-lg bg-slate-100 p-1"
        >
          {(
            [
              { id: 'oauth', label: '01. Auth & Firestore' },
              { id: 'profile', label: '02. Kompresi Gambar' },
              { id: 'gemini', label: '03. Hemat Token & Multimodal' },
              { id: 'tree', label: '04. Struktur Direktori' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeCodeTab === tab.id}
              onClick={() => setActiveCodeTab(tab.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeCodeTab === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
            <span className="font-medium text-slate-800">
              {CODE_SNIPPETS[activeCodeTab].title}
            </span>
            <span className="font-mono">{CODE_SNIPPETS[activeCodeTab].filename}</span>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
            <code>{CODE_SNIPPETS[activeCodeTab].code}</code>
          </pre>
        </div>
      </section>

      {/* Dynamic System Instruction Simulator & Active Security Summary */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                3. Simulator Penghematan Token <code className="font-mono text-sm">systemInstruction</code>
              </h2>
              <p className="mt-1 text-xs text-slate-600">
                Bandingkan ukuran instruksi sistem saat Mode Hemat Token aktif (~{compactTokens}{' '}
                token, hemat {savedPercent}%) dibanding mode penuh (~{fullTokens} token).
              </p>
            </div>

            <button
              type="button"
              onClick={() => setSimTokenSaver((prev) => !prev)}
              aria-pressed={simTokenSaver}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                simTokenSaver
                  ? 'border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Leaf className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{simTokenSaver ? 'Mode Hemat Token: Aktif' : 'Mode Hemat Token: Nonaktif'}</span>
            </button>
          </div>

          {!userProfile && (
            <div className="mt-4">
              <label
                htmlFor="preview-display-name"
                className="mb-1.5 block text-xs font-medium text-slate-700"
              >
                Contoh Display Name (Simulasi Pratinjau Prompt)
              </label>
              <input
                id="preview-display-name"
                type="text"
                value={previewName}
                onChange={(e) => setPreviewName(e.target.value)}
                className="h-9 w-full max-w-sm rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>
          )}

          <pre className="mt-4 max-h-80 overflow-y-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-100">
            <code>{activePreviewInstruction}</code>
          </pre>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-5">
          <h2 className="text-base font-semibold text-slate-900">
            4. Postur Keamanan Kredensial &amp; Media
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Isolasi ketat antara kredensial publik klien, lampiran gambar, dan basis data.
          </p>

          <dl className="mt-4 divide-y divide-slate-100 text-xs">
            <div className="py-2.5">
              <dt className="font-medium text-slate-500">Google Cloud Project ID</dt>
              <dd className="mt-0.5 font-mono text-slate-900">{oauthMeta.projectId}</dd>
            </div>
            <div className="py-2.5">
              <dt className="font-medium text-slate-500">Cloud Firestore Database ID</dt>
              <dd className="mt-0.5 break-all font-mono text-slate-900">
                {oauthMeta.firestoreDatabaseId}
              </dd>
            </div>
            <div className="py-2.5">
              <dt className="font-medium text-slate-500">Perlindungan Penyimpanan Gambar</dt>
              <dd className="mt-0.5 text-slate-800">
                Biner gambar diproses di memori &amp; server tanpa membebani batas dokumen 1 MB
                Firestore (<code className="font-mono">attachmentLabel &le; 120</code> karakter)
              </dd>
            </div>
            <div className="py-2.5">
              <dt className="font-medium text-slate-500">Penyimpanan Access Token</dt>
              <dd className="mt-0.5 text-slate-800">
                Variabel memori tertutup (<code className="font-mono">cachedAccessToken</code>) ·
                Dihapus saat <code className="font-mono">signOut()</code>
              </dd>
            </div>
            <div className="py-2.5">
              <dt className="font-medium text-slate-500">Kunci Gemini API</dt>
              <dd className="mt-0.5 text-slate-800">
                Terkunci di server (<code className="font-mono">process.env.GEMINI_API_KEY</code>)
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
};
