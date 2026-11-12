export type RoutineCategory = 'Fokus Kerja' | 'Kesehatan' | 'Pribadi' | 'Evaluasi';

export type MemoryCategory =
  | 'Riset & Fakta'
  | 'Pemrograman & Tugas'
  | 'Preferensi & Konteks';

export interface RoutineItem {
  id: string;
  title: string;
  time: string; // HH:MM (24-jam)
  category: RoutineCategory;
  completed: boolean;
  notes?: string;
}

export interface AuraSourceCitation {
  title: string;
  uri: string;
  domain: string;
}

export interface AuraImageAttachment {
  base64Data: string; // Base64 tanpa prefix data:...
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  label: string; // Contoh: "diagram.jpg (960×720 · 142 KB)"
}

export interface AuraTokenUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenSaverActive: boolean;
  webSearchInvoked: boolean;
}

export interface MemoryItem {
  id: string;
  title: string;
  content: string;
  category: MemoryCategory;
  sourceUris: string[];
  updatedAtIso: string;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  givenName?: string;
  email: string;
  photoUrl?: string;
  source: 'google_people_api' | 'firebase_auth_profile';
  verifiedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: string;
  sequence?: number;
  injectedSystemInstruction?: string;
  audioDataUrl?: string;
  isVoiceCommand?: boolean;
  imagePreviewUrl?: string; // Disimpan di memori sesi aktif untuk tampilan pratinjau
  imageAttachment?: AuraImageAttachment; // Disimpan di memori sesi untuk diskusi lanjutan atas gambar
  attachmentLabel?: string; // Metadata teks ringan yang disinkronkan ke Cloud Firestore
  sources?: AuraSourceCitation[];
  searchQueries?: string[];
  tokenUsage?: AuraTokenUsage;
}

export interface AuraChatRequest {
  message: string;
  history: Array<{
    role: 'user' | 'model';
    text: string;
    imageAttachment?: AuraImageAttachment;
    attachmentLabel?: string;
  }>;
  routines: RoutineItem[];
  memories?: MemoryItem[];
  enableWebSearch?: boolean;
  tokenSaver?: boolean;
  imageAttachment?: AuraImageAttachment;
  clientDisplayName?: string;
  clientLocalTime?: string;
}

export interface AuraChatResponse {
  reply: string;
  verifiedDisplayName: string;
  appliedSystemInstruction: string;
  model: string;
  timestamp: string;
  sources: AuraSourceCitation[];
  searchQueries: string[];
  tokenUsage?: AuraTokenUsage;
  extractedMemory?: {
    title: string;
    content: string;
    category: MemoryCategory;
    sourceUris: string[];
  } | null;
}

export interface AuraTranscribeRequest {
  audioBase64: string;
  mimeType: string;
}

export interface AuraTranscribeResponse {
  transcript: string;
}

export interface AuraTtsRequest {
  text: string;
  voiceName?: 'Kore' | 'Puck' | 'Zephyr' | 'Charon' | 'Fenrir';
}

export interface AuraTtsResponse {
  audioBase64: string;
  mimeType: 'audio/wav';
}
