# Security Specification — A.U.R.A Firestore Rules

## 1. Data Invariants
1. **Verified Ownership Only**: Every read (`get`, `list`) and write (`create`, `update`, `delete`) across `/aura_messages/{messageId}`, `/aura_memories/{memoryId}`, and `/aura_routines/{routineId}` requires `request.auth != null` AND `request.auth.token.email_verified == true`.
2. **Strict Owner Isolation**: `ownerId` must strictly equal `request.auth.uid` on creation, remain immutable on updates (`incoming().ownerId == existing().ownerId`), and match `resource.data.ownerId == request.auth.uid` on `get`, `list`, `update`, and `delete`.
3. **Zero PII Storage**: No email addresses, phone numbers, or physical addresses are stored in Firestore documents.
4. **Immutable Chat History**: Documents in `/aura_messages/{messageId}` are append-only (`allow update: if false;`) and may only be created, read, or deleted by their verified `ownerId`.
5. **Strict Schema, Key Allowlists & Size Bounds**: Every string, number, boolean, and bounded array (`searchQueries <= 6`, `sourceTitles <= 8`, `sourceUris <= 8`) enforces strict `.keys().hasAll(...)`, `.keys().hasOnly(...)`, `.size()` limits, and `isValidId()` regex guards (`^[a-zA-Z0-9_\-]+$`).
6. **Temporal Integrity**: `createdAt == request.time` on creation, `createdAt` immutable on updates, and `updatedAt == request.time` on updates.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Identity Spoofing (`ownerId` mismatch)**: Creating `/aura_memories/mem_1` with `ownerId: "victim_uid"` while authenticated as `"attacker_uid"`.
2. **Unverified Email Spoof**: Writing to `/aura_routines/rt_1` with `request.auth.token.email_verified == false`.
3. **Shadow Field Injection**: Creating `/aura_memories/mem_2` with all required fields plus `isAdmin: true`.
4. **ID Poisoning Attack**: Creating `/aura_messages/bad$id!with/slashes` or a 500-char ID violating `isValidId()`.
5. **Denial-of-Wallet Oversized String**: Creating `/aura_messages/msg_1` with a 50,000-char `text` exceeding `16000`.
6. **Unbounded Array Exhaustion**: Creating `/aura_messages/msg_2` with 25 items in `sourceUris` (max 8).
7. **Array Element Type Poisoning**: Creating `/aura_memories/mem_3` with `sourceUris: [12345]` (non-string first element).
8. **Message History Tampering**: Attempting `update` on `/aura_messages/msg_1` to alter past AI responses.
9. **Immortal Field Mutation (`createdAt` / `ownerId`)**: Updating `/aura_memories/mem_1` with a modified `createdAt` or `ownerId`.
10. **Forged Client Timestamp**: Creating `/aura_routines/rt_2` with a backdated `createdAt` (`!= request.time`).
11. **Invalid Enum / Time Regex**: Creating `/aura_routines/rt_3` with `time: "99:99"` or `category: "Hacked"`.
12. **Cross-Tenant Query Scraping (`list`)**: Listing `/aura_memories` without constraining `resource.data.ownerId == request.auth.uid`.

## 3. Automated Test Runner
Verified deterministically in `firestore.rules.test.ts` via `npx --yes tsx --test firestore.rules.test.ts` and statically audited via `@firebase/eslint-plugin-security-rules`.
