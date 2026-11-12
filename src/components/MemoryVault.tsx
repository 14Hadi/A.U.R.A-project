import React, { useState } from 'react';
import {
  Brain,
  ExternalLink,
  MessageSquarePlus,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type { MemoryCategory, MemoryItem } from '../types/aura.ts';
import { validateMemoryDraft } from '../utils/auraContext.ts';

interface MemoryVaultProps {
  memories: MemoryItem[];
  isCloudSynced: boolean;
  displayName?: string;
  onAddMemory: (draft: {
    title: string;
    content: string;
    category: MemoryCategory;
    sourceUris: string[];
  }) => Promise<void> | void;
  onDeleteMemory: (id: string) => Promise<void> | void;
  onDiscussMemory: (memory: MemoryItem) => void;
}

const MEMORY_CATEGORIES: MemoryCategory[] = [
  'Riset & Fakta',
  'Pemrograman & Tugas',
  'Preferensi & Konteks',
];

function formatDomainFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return rawUrl;
  }
}

export const MemoryVault: React.FC<MemoryVaultProps> = ({
  memories,
  isCloudSynced,
  displayName,
  onAddMemory,
  onDeleteMemory,
  onDiscussMemory,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<'Semua' | MemoryCategory>('Semua');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('Riset & Fakta');
  const [content, setContent] = useState('');
  const [sourceUrlInput, setSourceUrlInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredMemories = memories.filter((item) => {
    const matchesCategory =
      selectedCategory === 'Semua' || item.category === selectedCategory;
    if (!matchesCategory) return false;
    if (!normalizedQuery) return true;
    return (
      item.title.toLowerCase().includes(normalizedQuery) ||
      item.content.toLowerCase().includes(normalizedQuery) ||
      item.sourceUris.some((u) => u.toLowerCase().includes(normalizedQuery))
    );
  });

  const handleCreateMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    const rawUrls = sourceUrlInput
      .split(/[\n,\s]+/)
      .map((u) => u.trim())
      .filter(Boolean);

    const validation = validateMemoryDraft({
      title,
      content,
      category,
      sourceUris: rawUrls,
    });

    if (!validation.valid || !validation.normalized) {
      setFormError(validation.error || 'Periksa kembali catatan ingatan Anda.');
      return;
    }

    setFormError(null);
    setIsSaving(true);
    try {
      await onAddMemory(validation.normalized);
      setTitle('');
      setContent('');
      setSourceUrlInput('');
      setShowAddForm(false);
    } catch (err: unknown) {
      setFormError(
        err instanceof Error ? err.message : 'Gagal menyimpan catatan ke Ingatan A.U.R.A.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Ingatan Jangka Panjang A.U.R.A
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {displayName
              ? `Seluruh hasil penelusuran web, verifikasi fakta, dan solusi pemrograman untuk ${displayName} disinkronkan otomatis ke dalam konteks A.U.R.A.`
              : 'Simpan fakta hasil penelusuran, catatan debugging kode, atau preferensi personal agar selalu diingat A.U.R.A.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="text-right text-xs text-slate-500">
            <p className="font-mono font-semibold text-slate-900 tabular-nums">
              {memories.length} catatan tersimpan
            </p>
            <p>{isCloudSynced ? 'Tersinkron ke Cloud Firestore' : 'Pratinjau Perangkat Lokal'}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowAddForm((prev) => !prev);
              setFormError(null);
            }}
            aria-expanded={showAddForm}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>{showAddForm ? 'Tutup Form' : 'Tambah Ingatan'}</span>
          </button>
        </div>
      </div>

      {/* Add Manual Memory Form */}
      {showAddForm && (
        <section
          aria-labelledby="add-memory-heading"
          className="rounded-xl border border-slate-200 bg-white p-6"
        >
          <h2 id="add-memory-heading" className="text-base font-semibold text-slate-900">
            Simpan Catatan Baru ke Ingatan A.U.R.A
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Catatan ini akan otomatis disuntikkan ke dalam <code className="font-mono">systemInstruction</code> pada percakapan berikutnya.
          </p>

          <form onSubmit={handleCreateMemory} noValidate className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
              <div className="sm:col-span-8">
                <label
                  htmlFor="memory-title"
                  className="mb-1.5 block text-xs font-medium text-slate-700"
                >
                  Judul Topik / Fakta / Proyek
                </label>
                <input
                  id="memory-title"
                  type="text"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    if (formError) setFormError(null);
                  }}
                  placeholder="Contoh: Arsitektur API Otentikasi Proyek X"
                  className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-4">
                <label
                  htmlFor="memory-category"
                  className="mb-1.5 block text-xs font-medium text-slate-700"
                >
                  Kategori Catatan
                </label>
                <select
                  id="memory-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as MemoryCategory)}
                  className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  {MEMORY_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label
                htmlFor="memory-content"
                className="mb-1.5 block text-xs font-medium text-slate-700"
              >
                Ringkasan Informasi, Solusi Kode, atau Preferensi
              </label>
              <textarea
                id="memory-content"
                rows={3}
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  if (formError) setFormError(null);
                }}
                placeholder="Tuliskan temuan fakta, solusi bug yang sudah teruji, atau instruksi khusus yang perlu selalu diingat A.U.R.A..."
                className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label
                  htmlFor="memory-sources"
                  className="mb-1.5 block text-xs font-medium text-slate-700"
                >
                  Tautan Sumber Referensi (Opsional, pisahkan dengan spasi atau koma)
                </label>
                <input
                  id="memory-sources"
                  type="url"
                  value={sourceUrlInput}
                  onChange={(e) => setSourceUrlInput(e.target.value)}
                  placeholder="https://react.dev/reference/react"
                  className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-slate-900 px-5 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <span>{isSaving ? 'Menyimpan...' : 'Simpan ke Ingatan'}</span>
              </button>
            </div>

            {formError && (
              <p role="alert" className="text-xs font-medium text-red-600">
                {formError}
              </p>
            )}
          </form>
        </section>
      )}

      {/* Search & Category Filter Bar */}
      <section aria-label="Filter dan pencarian ingatan" className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter kategori ingatan">
            {(['Semua', ...MEMORY_CATEGORIES] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={selectedCategory === cat}
                onClick={() => setSelectedCategory(cat)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  selectedCategory === cat
                    ? 'border-blue-200 bg-blue-50 text-blue-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <label htmlFor="memory-search-input" className="sr-only">
              Cari dalam ingatan A.U.R.A
            </label>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              id="memory-search-input"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari topik, kode, sumber..."
              className="h-9 w-full rounded-lg border border-slate-300 bg-white pr-3 pl-9 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>
        </div>
      </section>

      {/* Memory List */}
      <section aria-label="Daftar catatan ingatan A.U.R.A">
        {filteredMemories.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
            <Brain className="mx-auto h-7 w-7 text-slate-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-slate-900">
              {memories.length === 0
                ? 'Belum ada catatan di Ingatan A.U.R.A'
                : 'Tidak ada catatan yang cocok dengan filter pencarian'}
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">
              {memories.length === 0
                ? 'Setiap kali A.U.R.A menelusuri fakta di internet, memverifikasi sumber, atau menyelesaikan tugas pemrograman bersama Anda, ringkasannya otomatis tersimpan di sini.'
                : 'Coba ubah kata kunci pencarian atau pilih kategori Semua.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {filteredMemories.map((item) => {
              const isConfirmingDelete = confirmDeleteId === item.id;
              return (
                <li
                  key={item.id}
                  className="rounded-xl border border-slate-200 bg-white p-5 transition-colors hover:border-slate-300"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                          {item.category}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {new Date(item.updatedAtIso).toLocaleString('id-ID', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </span>
                      </div>
                      <h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onDiscussMemory(item)}
                        aria-label={`Bahas lagi topik "${item.title}" bersama A.U.R.A`}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 whitespace-nowrap shrink-0"
                      >
                        <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Bahas Lagi</span>
                      </button>

                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              void onDeleteMemory(item.id);
                            }}
                            className="inline-flex h-8 items-center rounded-lg bg-red-600 px-2.5 text-xs font-semibold text-white hover:bg-red-700 whitespace-nowrap shrink-0"
                          >
                            Hapus
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap shrink-0"
                          >
                            Batal
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(item.id)}
                          aria-label={`Hapus ingatan "${item.title}"`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 shrink-0"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="mt-2.5 text-xs leading-relaxed whitespace-pre-wrap text-slate-700">
                    {item.content}
                  </p>

                  {item.sourceUris.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                      <span className="text-xs font-medium text-slate-500">Sumber terverifikasi:</span>
                      {item.sourceUris.map((uri) => (
                        <a
                          key={uri}
                          href={uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-blue-700 transition-colors hover:border-blue-200 hover:bg-blue-50"
                        >
                          <span>{formatDomainFromUrl(uri)}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                        </a>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
