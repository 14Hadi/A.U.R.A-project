import React, { useState } from 'react';
import { Plus, Trash2, Check, Search } from 'lucide-react';
import type { RoutineCategory, RoutineItem } from '../types/aura.ts';
import { validateRoutineDraft } from '../utils/auraContext.ts';

interface RoutineManagerProps {
  routines: RoutineItem[];
  displayName?: string;
  onAddRoutine: (routine: Omit<RoutineItem, 'id' | 'completed'>) => void;
  onToggleRoutine: (id: string) => void;
  onDeleteRoutine: (id: string) => void;
}

const CATEGORIES: RoutineCategory[] = ['Fokus Kerja', 'Kesehatan', 'Pribadi', 'Evaluasi'];

export const RoutineManager: React.FC<RoutineManagerProps> = ({
  routines,
  displayName,
  onAddRoutine,
  onToggleRoutine,
  onDeleteRoutine,
}) => {
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('08:00');
  const [category, setCategory] = useState<RoutineCategory>('Fokus Kerja');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<RoutineItem | null>(null);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateRoutineDraft({ title, time, category, notes });
    if (!validation.valid || !validation.normalized) {
      setFormError(validation.error || 'Input rutinitas belum valid.');
      return;
    }

    onAddRoutine(validation.normalized);
    setTitle('');
    setNotes('');
    setFormError(null);
  };

  const filteredRoutines = routines
    .filter((item) => {
      if (statusFilter === 'active' && item.completed) return false;
      if (statusFilter === 'completed' && !item.completed) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          item.title.toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q) ||
          (item.notes?.toLowerCase().includes(q) ?? false)
        );
      }
      return true;
    })
    .sort((a, b) => a.time.localeCompare(b.time));

  const completedCount = routines.filter((r) => r.completed).length;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Header & Summary */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Agenda Rutinitas Harian
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Jadwal ini disinkronkan secara otomatis ke dalam konteks{' '}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-800">
              systemInstruction
            </code>{' '}
            A.U.R.A{displayName ? ` untuk ${displayName}` : ''}.
          </p>
        </div>

        <div className="text-xs text-slate-500 tabular-nums">
          <span>{routines.length} total rutinitas</span>
          <span aria-hidden="true"> · </span>
          <span>{completedCount} selesai</span>
          <span aria-hidden="true"> · </span>
          <span>{routines.length - completedCount} terjadwal</span>
        </div>
      </div>

      {/* Add Routine Form */}
      <section
        aria-labelledby="add-routine-heading"
        className="rounded-xl border border-slate-200 bg-white p-6"
      >
        <h2 id="add-routine-heading" className="text-base font-semibold text-slate-900">
          Tambah Rutinitas Baru
        </h2>
        <form onSubmit={handleCreate} noValidate className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
            <div className="sm:col-span-6">
              <label
                htmlFor="routine-title"
                className="mb-1.5 block text-xs font-medium text-slate-700"
              >
                Nama Rutinitas
              </label>
              <input
                id="routine-title"
                type="text"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (formError) setFormError(null);
                }}
                placeholder="Contoh: Review prioritas & blok kalender pagi"
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div className="sm:col-span-3">
              <label
                htmlFor="routine-time"
                className="mb-1.5 block text-xs font-medium text-slate-700"
              >
                Waktu (24-Jam)
              </label>
              <input
                id="routine-time"
                type="time"
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                  if (formError) setFormError(null);
                }}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-mono tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div className="sm:col-span-3">
              <label
                htmlFor="routine-category"
                className="mb-1.5 block text-xs font-medium text-slate-700"
              >
                Kategori
              </label>
              <select
                id="routine-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as RoutineCategory)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label
                htmlFor="routine-notes"
                className="mb-1.5 block text-xs font-medium text-slate-700"
              >
                Catatan Konteks untuk A.U.R.A (Opsional)
              </label>
              <input
                id="routine-notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Contoh: Fokus tanpa notifikasi selama 45 menit"
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Simpan Rutinitas</span>
            </button>
          </div>

          {formError && (
            <p role="alert" className="text-xs font-medium text-red-600">
              {formError}
            </p>
          )}
        </form>
      </section>

      {/* Filter Bar & Routine Table */}
      <section aria-label="Daftar rutinitas terjadwal" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Interactive Segmented Filter Controls */}
          <div
            role="group"
            aria-label="Filter status rutinitas"
            className="inline-flex items-center gap-1 rounded-lg bg-slate-200/70 p-1"
          >
            {(
              [
                { id: 'all', label: 'Semua' },
                { id: 'active', label: 'Belum Selesai' },
                { id: 'completed', label: 'Selesai' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  statusFilter === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <label htmlFor="routine-search" className="sr-only">
              Cari rutinitas
            </label>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              id="routine-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama atau kategori..."
              className="h-9 w-full rounded-lg border border-slate-300 bg-white pr-3 pl-9 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {filteredRoutines.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-sm font-medium text-slate-900">
                Tidak ada rutinitas yang cocok dengan filter saat ini
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Tambahkan jadwal baru pada formulir di atas atau ubah kata kunci pencarian Anda.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {filteredRoutines.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-slate-50/80"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <button
                      type="button"
                      onClick={() => onToggleRoutine(item.id)}
                      aria-label={
                        item.completed
                          ? `Tandai '${item.title}' belum selesai`
                          : `Tandai '${item.title}' selesai`
                      }
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors ${
                        item.completed
                          ? 'border-emerald-600 bg-emerald-600 text-white'
                          : 'border-slate-300 bg-white text-transparent hover:border-blue-600'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>

                    <span className="w-14 shrink-0 font-mono text-sm font-medium tabular-nums text-slate-900">
                      {item.time}
                    </span>

                    <div className="min-w-0">
                      <p
                        className={`truncate text-sm font-medium ${
                          item.completed ? 'text-slate-400 line-through' : 'text-slate-900'
                        }`}
                      >
                        {item.title}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        <span>{item.category}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{item.completed ? 'Selesai' : 'Terjadwal'}</span>
                        {item.notes && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span>{item.notes}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setPendingDelete(item)}
                    aria-label={`Hapus rutinitas '${item.title}'`}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Accessible Delete Confirmation Modal (Replaces window.confirm) */}
      {pendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-routine-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
            <h3
              id="delete-routine-dialog-title"
              className="text-base font-semibold text-slate-900"
            >
              Hapus Rutinitas dari A.U.R.A?
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Anda akan menghapus rutinitas{' '}
              <span className="font-semibold text-slate-900">"{pendingDelete.title}"</span> (
              <span className="font-mono tabular-nums">{pendingDelete.time}</span>). Tindakan ini
              juga akan memperbarui konteks jadwal pada A.U.R.A.
            </p>
            <div className="mt-6 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => {
                  onDeleteRoutine(pendingDelete.id);
                  setPendingDelete(null);
                }}
                className="h-10 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-700 whitespace-nowrap shrink-0"
              >
                Hapus Rutinitas
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
