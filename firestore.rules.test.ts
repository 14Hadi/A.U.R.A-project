import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const rulesPath = path.resolve(import.meta.dirname, 'firestore.rules');
const blueprintPath = path.resolve(import.meta.dirname, 'firebase-blueprint.json');
const rulesSource = fs.readFileSync(rulesPath, 'utf-8');
const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf-8'));

type AuthCtx = { uid: string; emailVerified: boolean } | null;

const SERVER_TIME = '2026-11-04T09:20:00.000Z';
const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidId(id: unknown): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && ID_REGEX.test(id);
}

function isVerifiedUser(auth: AuthCtx): auth is { uid: string; emailVerified: true } {
  return Boolean(auth && auth.uid && auth.emailVerified === true);
}

function hasExactKeys(obj: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(obj);
  return (
    allowed.every((k) => Object.prototype.hasOwnProperty.call(obj, k)) &&
    keys.every((k) => allowed.includes(k))
  );
}

function isBoundedStringList(arr: unknown, maxItems: number, maxItemLen: number): boolean {
  if (!Array.isArray(arr) || arr.length > maxItems) return false;
  if (arr.length === 0) return true;
  return typeof arr[0] === 'string' && arr[0].length <= maxItemLen;
}

function evaluateCreateAuraMessage(auth: AuthCtx, docId: string, data: Record<string, unknown>): boolean {
  const allowed = [
    'ownerId',
    'role',
    'text',
    'clientTimestamp',
    'sequence',
    'isVoiceCommand',
    'attachmentLabel',
    'searchQueries',
    'sourceTitles',
    'sourceUris',
    'createdAt',
  ];
  return (
    isVerifiedUser(auth) &&
    isValidId(docId) &&
    hasExactKeys(data, allowed) &&
    isValidId(data.ownerId) &&
    data.ownerId === auth.uid &&
    (data.role === 'user' || data.role === 'model') &&
    typeof data.text === 'string' &&
    data.text.length >= 1 &&
    data.text.length <= 16000 &&
    typeof data.clientTimestamp === 'string' &&
    data.clientTimestamp.length >= 10 &&
    data.clientTimestamp.length <= 64 &&
    typeof data.sequence === 'number' &&
    data.sequence >= 0 &&
    typeof data.isVoiceCommand === 'boolean' &&
    typeof data.attachmentLabel === 'string' &&
    data.attachmentLabel.length <= 120 &&
    isBoundedStringList(data.searchQueries, 6, 240) &&
    isBoundedStringList(data.sourceTitles, 8, 240) &&
    isBoundedStringList(data.sourceUris, 8, 1024) &&
    data.createdAt === SERVER_TIME
  );
}

function evaluateCreateAuraMemory(auth: AuthCtx, docId: string, data: Record<string, unknown>): boolean {
  const allowed = [
    'ownerId',
    'title',
    'content',
    'category',
    'sourceUris',
    'createdAt',
    'updatedAt',
  ];
  return (
    isVerifiedUser(auth) &&
    isValidId(docId) &&
    hasExactKeys(data, allowed) &&
    isValidId(data.ownerId) &&
    data.ownerId === auth.uid &&
    typeof data.title === 'string' &&
    data.title.length >= 2 &&
    data.title.length <= 140 &&
    typeof data.content === 'string' &&
    data.content.length >= 3 &&
    data.content.length <= 4000 &&
    (data.category === 'Riset & Fakta' ||
      data.category === 'Pemrograman & Tugas' ||
      data.category === 'Preferensi & Konteks') &&
    isBoundedStringList(data.sourceUris, 8, 1024) &&
    data.createdAt === SERVER_TIME &&
    data.updatedAt === SERVER_TIME
  );
}

function evaluateUpdateAuraMemory(
  auth: AuthCtx,
  docId: string,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): boolean {
  const allowed = [
    'ownerId',
    'title',
    'content',
    'category',
    'sourceUris',
    'createdAt',
    'updatedAt',
  ];
  const editable = ['title', 'content', 'category', 'sourceUris', 'updatedAt'];
  const changed = Object.keys(incoming).filter((k) => incoming[k] !== existing[k]);

  return (
    isVerifiedUser(auth) &&
    isValidId(docId) &&
    hasExactKeys(incoming, allowed) &&
    existing.ownerId === auth.uid &&
    incoming.ownerId === existing.ownerId &&
    incoming.createdAt === existing.createdAt &&
    incoming.updatedAt === SERVER_TIME &&
    typeof incoming.title === 'string' &&
    incoming.title.length >= 2 &&
    incoming.title.length <= 140 &&
    typeof incoming.content === 'string' &&
    incoming.content.length >= 3 &&
    incoming.content.length <= 4000 &&
    (incoming.category === 'Riset & Fakta' ||
      incoming.category === 'Pemrograman & Tugas' ||
      incoming.category === 'Preferensi & Konteks') &&
    isBoundedStringList(incoming.sourceUris, 8, 1024) &&
    changed.every((k) => editable.includes(k))
  );
}

function evaluateCreateAuraRoutine(auth: AuthCtx, docId: string, data: Record<string, unknown>): boolean {
  const allowed = [
    'ownerId',
    'title',
    'time',
    'category',
    'completed',
    'notes',
    'createdAt',
    'updatedAt',
  ];
  return (
    isVerifiedUser(auth) &&
    isValidId(docId) &&
    hasExactKeys(data, allowed) &&
    isValidId(data.ownerId) &&
    data.ownerId === auth.uid &&
    typeof data.title === 'string' &&
    data.title.length >= 3 &&
    data.title.length <= 100 &&
    typeof data.time === 'string' &&
    data.time.length === 5 &&
    TIME_REGEX.test(data.time) &&
    (data.category === 'Fokus Kerja' ||
      data.category === 'Kesehatan' ||
      data.category === 'Pribadi' ||
      data.category === 'Evaluasi') &&
    typeof data.completed === 'boolean' &&
    typeof data.notes === 'string' &&
    data.notes.length <= 240 &&
    data.createdAt === SERVER_TIME &&
    data.updatedAt === SERVER_TIME
  );
}

function evaluateListByOwner(auth: AuthCtx, resourceOwnerId: string): boolean {
  return isVerifiedUser(auth) && resourceOwnerId === auth.uid;
}

test('firestore.rules enforces global default-deny catch-all and covers all blueprint collections', () => {
  assert.match(rulesSource, /rules_version = '2';/);
  assert.match(rulesSource, /match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);

  for (const collectionPath of Object.keys(blueprint.firestore)) {
    assert.ok(
      rulesSource.includes(`match ${collectionPath}`),
      `Missing match block for ${collectionPath}`
    );
  }
});

test('Dirty Dozen #1-#12 adversarial payloads (plus binary image stuffing) all evaluate to PERMISSION_DENIED', () => {
  const attacker: AuthCtx = { uid: 'attacker_uid', emailVerified: true };
  const unverified: AuthCtx = { uid: 'attacker_uid', emailVerified: false };

  const validMemory = {
    ownerId: 'attacker_uid',
    title: 'Riset TypeScript 7',
    content: 'Fakta rilis kompilator terbaru yang terverifikasi.',
    category: 'Riset & Fakta',
    sourceUris: ['https://www.typescriptlang.org'],
    createdAt: SERVER_TIME,
    updatedAt: SERVER_TIME,
  };

  const validMessage = {
    ownerId: 'attacker_uid',
    role: 'model',
    text: 'Ya, saya mendengarkan. Berikut hasil analisis gambar dan risetnya.',
    clientTimestamp: '2026-11-04T09:20:00.000Z',
    sequence: 1,
    isVoiceCommand: false,
    attachmentLabel: 'diagram-arsitektur.jpg (960x720)',
    searchQueries: ['typescript release notes'],
    sourceTitles: ['TypeScript Official'],
    sourceUris: ['https://www.typescriptlang.org'],
    createdAt: SERVER_TIME,
  };

  const validRoutine = {
    ownerId: 'attacker_uid',
    title: 'Review arsitektur pagi',
    time: '08:15',
    category: 'Fokus Kerja',
    completed: false,
    notes: '',
    createdAt: SERVER_TIME,
    updatedAt: SERVER_TIME,
  };

  // Sanity: valid owner payloads pass
  assert.equal(evaluateCreateAuraMemory(attacker, 'mem_valid_1', validMemory), true);
  assert.equal(evaluateCreateAuraMessage(attacker, 'msg_valid_1', validMessage), true);
  assert.equal(evaluateCreateAuraRoutine(attacker, 'rt_valid_1', validRoutine), true);

  // 1. Identity Spoofing (ownerId mismatch)
  assert.equal(
    evaluateCreateAuraMemory(attacker, 'mem_1', { ...validMemory, ownerId: 'victim_uid' }),
    false
  );

  // 2. Unverified Email Spoof
  assert.equal(evaluateCreateAuraRoutine(unverified, 'rt_1', validRoutine), false);

  // 3. Shadow Field Injection (e.g. raw imageBase64 field)
  assert.equal(
    evaluateCreateAuraMessage(attacker, 'msg_shadow', { ...validMessage, imageBase64: 'data:image/png;base64,...' }),
    false
  );

  // 4. ID Poisoning Attack
  assert.equal(evaluateCreateAuraMessage(attacker, 'bad$id!slash', validMessage), false);
  assert.equal(evaluateCreateAuraMessage(attacker, 'x'.repeat(200), validMessage), false);

  // 5. Denial-of-Wallet Oversized String / Base64 Stuffed into attachmentLabel
  assert.equal(
    evaluateCreateAuraMessage(attacker, 'msg_1', { ...validMessage, text: 'a'.repeat(16001) }),
    false
  );
  assert.equal(
    evaluateCreateAuraMessage(attacker, 'msg_img_stuff', {
      ...validMessage,
      attachmentLabel: 'x'.repeat(500),
    }),
    false
  );

  // 6. Unbounded Array Exhaustion
  assert.equal(
    evaluateCreateAuraMessage(attacker, 'msg_2', {
      ...validMessage,
      sourceUris: Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`),
    }),
    false
  );

  // 7. Array Element Type Poisoning
  assert.equal(
    evaluateCreateAuraMemory(attacker, 'mem_3', {
      ...validMemory,
      sourceUris: [12345 as unknown as string],
    }),
    false
  );

  // 8. Message History Tampering (update strictly false in rules)
  assert.match(rulesSource, /match \/aura_messages\/\{messageId\}[\s\S]*?allow update: if false;/);

  // 9. Immortal Field Mutation (createdAt / ownerId changed during update)
  assert.equal(
    evaluateUpdateAuraMemory(
      attacker,
      'mem_valid_1',
      { ...validMemory, createdAt: '2026-11-01T00:00:00.000Z' },
      { ...validMemory, createdAt: SERVER_TIME, updatedAt: SERVER_TIME }
    ),
    false
  );

  // 10. Forged Client Timestamp on Create
  assert.equal(
    evaluateCreateAuraRoutine(attacker, 'rt_2', {
      ...validRoutine,
      createdAt: '2020-01-01T00:00:00.000Z',
    }),
    false
  );

  // 11. Invalid Enum / Time Regex
  assert.equal(
    evaluateCreateAuraRoutine(attacker, 'rt_3', { ...validRoutine, time: '99:99' }),
    false
  );
  assert.equal(
    evaluateCreateAuraRoutine(attacker, 'rt_4', { ...validRoutine, category: 'Hacked' }),
    false
  );

  // 12. Cross-Tenant Query Scraping (list on another user's resource)
  assert.equal(evaluateListByOwner(attacker, 'victim_uid'), false);
});
