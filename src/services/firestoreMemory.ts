import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type {
  AuraSourceCitation,
  ChatMessage,
  MemoryCategory,
  MemoryItem,
  RoutineCategory,
  RoutineItem,
} from '../types/aura.ts';
import { auth, db } from './googleAuth.ts';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: Array<{
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function makeSafeDocId(prefix: string): string {
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${randomSuffix}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

function normalizeDocId(rawId: string, fallbackPrefix: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return cleaned.length >= 1 ? cleaned : makeSafeDocId(fallbackPrefix);
}

function extractDomainFromUri(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./i, '');
  } catch {
    return 'sumber-web';
  }
}

function timestampToIso(value: unknown, fallbackIso?: string): string {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toDate?: () => Date }).toDate === 'function'
  ) {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      // Fallback di bawah
    }
  }
  return fallbackIso || new Date().toISOString();
}

/**
 * Berlangganan riwayat percakapan & hasil penelusuran pengguna (`aura_messages`) secara real-time.
 */
export function subscribeUserMessages(
  uid: string,
  onMessagesLoaded: (messages: ChatMessage[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const colPath = 'aura_messages';
  const q = query(collection(db, colPath), where('ownerId', '==', uid));

  return onSnapshot(
    q,
    (snapshot) => {
      const loaded: ChatMessage[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const role = data.role === 'user' || data.role === 'model' ? data.role : 'model';
        const text = typeof data.text === 'string' ? data.text : '';
        if (!text) return;

        const sourceTitles: string[] = Array.isArray(data.sourceTitles)
          ? data.sourceTitles.filter((t: unknown): t is string => typeof t === 'string')
          : [];
        const sourceUris: string[] = Array.isArray(data.sourceUris)
          ? data.sourceUris.filter((u: unknown): u is string => typeof u === 'string')
          : [];

        const sources: AuraSourceCitation[] = sourceUris.map((uri, idx) => ({
          title: sourceTitles[idx] || extractDomainFromUri(uri),
          uri,
          domain: extractDomainFromUri(uri),
        }));

        const searchQueries: string[] = Array.isArray(data.searchQueries)
          ? data.searchQueries.filter((sq: unknown): sq is string => typeof sq === 'string')
          : [];

        const attachmentLabel =
          typeof data.attachmentLabel === 'string' && data.attachmentLabel.trim()
            ? data.attachmentLabel.trim()
            : undefined;

        loaded.push({
          id: docSnap.id,
          role,
          text,
          timestamp:
            typeof data.clientTimestamp === 'string'
              ? data.clientTimestamp
              : timestampToIso(data.createdAt),
          sequence: typeof data.sequence === 'number' ? data.sequence : 0,
          isVoiceCommand: Boolean(data.isVoiceCommand),
          attachmentLabel,
          sources: sources.length > 0 ? sources : undefined,
          searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
        });
      });

      loaded.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      onMessagesLoaded(loaded);
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, colPath);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

/**
 * Menyimpan satu pesan percakapan ke koleksi `aura_messages` sesuai kontrak `firestore.rules`.
 * Biner gambar TIDAK PERNAH disimpan ke Firestore; hanya `attachmentLabel` ringan (<= 120 karakter).
 */
export async function persistChatMessageToFirestore(
  uid: string,
  msg: ChatMessage,
  sequence: number
): Promise<void> {
  const safeId = normalizeDocId(msg.id, 'msg');
  const docPath = `aura_messages/${safeId}`;

  const sources = (msg.sources ?? []).slice(0, 8);
  const sourceTitles = sources.map((s) => (s.title || s.domain || 'Sumber').slice(0, 240));
  const sourceUris = sources.map((s) => s.uri.slice(0, 1024));
  const searchQueries = (msg.searchQueries ?? []).slice(0, 6).map((q) => q.slice(0, 240));
  const attachmentLabel = (msg.attachmentLabel || msg.imageAttachment?.label || '')
    .trim()
    .slice(0, 120);
  const clientTimestamp =
    msg.timestamp && msg.timestamp.length >= 10
      ? msg.timestamp.slice(0, 64)
      : new Date().toISOString();

  try {
    await setDoc(doc(db, 'aura_messages', safeId), {
      ownerId: uid,
      role: msg.role,
      text: msg.text.slice(0, 16000),
      clientTimestamp,
      sequence,
      isVoiceCommand: Boolean(msg.isVoiceCommand),
      attachmentLabel,
      searchQueries,
      sourceTitles,
      sourceUris,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, docPath);
  }
}

/**
 * Menghapus percakapan sesi aktif pada `aura_messages` (tanpa menghapus `aura_memories` jangka panjang).
 */
export async function clearAllUserMessagesInFirestore(uid: string): Promise<void> {
  const colPath = 'aura_messages';
  try {
    const snap = await getDocs(query(collection(db, colPath), where('ownerId', '==', uid)));
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, colPath);
  }
}

/**
 * Berlangganan catatan Ingatan Jangka Panjang A.U.R.A (`aura_memories`) secara real-time.
 */
export function subscribeUserMemories(
  uid: string,
  onMemoriesLoaded: (memories: MemoryItem[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const colPath = 'aura_memories';
  const q = query(collection(db, colPath), where('ownerId', '==', uid));

  return onSnapshot(
    q,
    (snapshot) => {
      const items: MemoryItem[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const title = typeof data.title === 'string' ? data.title : '';
        const content = typeof data.content === 'string' ? data.content : '';
        const category = data.category as MemoryCategory;
        if (!title || !content) return;

        const sourceUris = Array.isArray(data.sourceUris)
          ? data.sourceUris.filter((u: unknown): u is string => typeof u === 'string')
          : [];

        items.push({
          id: docSnap.id,
          title,
          content,
          category:
            category === 'Riset & Fakta' ||
            category === 'Pemrograman & Tugas' ||
            category === 'Preferensi & Konteks'
              ? category
              : 'Preferensi & Konteks',
          sourceUris,
          updatedAtIso: timestampToIso(data.updatedAt),
        });
      });

      items.sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso));
      onMemoriesLoaded(items);
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, colPath);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

/**
 * Menyimpan atau memperbarui catatan Ingatan A.U.R.A di Cloud Firestore.
 */
export async function upsertAuraMemoryInFirestore(
  uid: string,
  draft: {
    title: string;
    content: string;
    category: MemoryCategory;
    sourceUris: string[];
  },
  existingMemories: MemoryItem[]
): Promise<void> {
  const cleanTitle = draft.title.trim().slice(0, 140);
  const cleanContent = draft.content.trim().slice(0, 4000);
  if (cleanTitle.length < 2 || cleanContent.length < 3) return;

  const cleanSources = draft.sourceUris
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 8)
    .map((u) => u.slice(0, 1024));

  const matchedExisting = existingMemories.find(
    (m) => m.title.trim().toLowerCase() === cleanTitle.toLowerCase()
  );

  if (matchedExisting) {
    const docPath = `aura_memories/${matchedExisting.id}`;
    try {
      await updateDoc(doc(db, 'aura_memories', matchedExisting.id), {
        title: cleanTitle,
        content: cleanContent,
        category: draft.category,
        sourceUris: cleanSources,
        updatedAt: serverTimestamp(),
      });
      return;
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, docPath);
    }
  }

  const memoryId = makeSafeDocId('mem');
  const docPath = `aura_memories/${memoryId}`;
  try {
    await setDoc(doc(db, 'aura_memories', memoryId), {
      ownerId: uid,
      title: cleanTitle,
      content: cleanContent,
      category: draft.category,
      sourceUris: cleanSources,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, docPath);
  }
}

export async function deleteAuraMemoryFromFirestore(memoryId: string): Promise<void> {
  const docPath = `aura_memories/${memoryId}`;
  try {
    await deleteDoc(doc(db, 'aura_memories', memoryId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, docPath);
  }
}

export function subscribeUserRoutines(
  uid: string,
  defaultRoutines: RoutineItem[],
  onRoutinesLoaded: (routines: RoutineItem[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const colPath = 'aura_routines';
  const q = query(collection(db, colPath), where('ownerId', '==', uid));
  let seededOnce = false;

  return onSnapshot(
    q,
    (snapshot) => {
      if (snapshot.empty && !seededOnce && defaultRoutines.length > 0) {
        seededOnce = true;
        void seedInitialRoutinesToFirestore(uid, defaultRoutines);
        return;
      }

      const routines: RoutineItem[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (typeof data.title !== 'string' || typeof data.time !== 'string') return;
        routines.push({
          id: docSnap.id,
          title: data.title,
          time: data.time,
          category: data.category as RoutineCategory,
          completed: Boolean(data.completed),
          notes:
            typeof data.notes === 'string' && data.notes.trim() ? data.notes.trim() : undefined,
        });
      });

      routines.sort((a, b) => a.time.localeCompare(b.time));
      onRoutinesLoaded(routines);
    },
    (err) => {
      try {
        handleFirestoreError(err, OperationType.LIST, colPath);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) onError(wrapped);
      }
    }
  );
}

async function seedInitialRoutinesToFirestore(
  uid: string,
  defaults: RoutineItem[]
): Promise<void> {
  const colPath = 'aura_routines';
  try {
    const batch = writeBatch(db);
    defaults.slice(0, 10).forEach((item, idx) => {
      const routineId = normalizeDocId(`${uid.slice(0, 12)}_rt_${idx + 1}`, 'rt');
      batch.set(doc(db, colPath, routineId), {
        ownerId: uid,
        title: item.title.slice(0, 100),
        time: item.time,
        category: item.category,
        completed: Boolean(item.completed),
        notes: (item.notes || '').slice(0, 240),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, colPath);
  }
}

export async function addAuraRoutineToFirestore(
  uid: string,
  draft: Omit<RoutineItem, 'id' | 'completed'>
): Promise<void> {
  const routineId = makeSafeDocId('rt');
  const docPath = `aura_routines/${routineId}`;
  try {
    await setDoc(doc(db, 'aura_routines', routineId), {
      ownerId: uid,
      title: draft.title.trim().slice(0, 100),
      time: draft.time.trim(),
      category: draft.category,
      completed: false,
      notes: (draft.notes || '').trim().slice(0, 240),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, docPath);
  }
}

export async function toggleAuraRoutineInFirestore(
  routineId: string,
  nextCompleted: boolean
): Promise<void> {
  const docPath = `aura_routines/${routineId}`;
  try {
    await updateDoc(doc(db, 'aura_routines', routineId), {
      completed: nextCompleted,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, docPath);
  }
}

export async function deleteAuraRoutineFromFirestore(routineId: string): Promise<void> {
  const docPath = `aura_routines/${routineId}`;
  try {
    await deleteDoc(doc(db, 'aura_routines', routineId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, docPath);
  }
}
