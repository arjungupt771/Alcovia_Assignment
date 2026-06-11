# DECISIONS.md — Alcovia Sync Architecture

## 1. Data Model

### Focus Sessions
Sessions are **immutable once created**. A session is born on the device with a stable UUID (generated client-side at start time). It carries:
- `id` — stable UUID, the deduplication key throughout the system
- `status` — `completed` or `failed` (set at end of session, never mutated after)
- `targetMinutes`, `startedAt`, `failReason`, `completedAt`
- `synced` — client-only flag: `false` until the server acknowledges

Sessions live in two places on the client: `sessions` (full list) and `pendingSessions` (not yet acknowledged by server). On sync, the server absorbs the pending list and clears it on success.

**Why immutable?** Sessions have a natural lifecycle with a definitive end state. Making them append-only means there is never a conflict to resolve — two devices can both push the same session ID, and the server simply ignores the second write (first-write-wins, guarded by a `processedSessions` Set).

### Tasks
Tasks are **mutable** and are the only place true conflicts can occur. Each task carries a **Lamport logical clock** and a `deviceId`:

```
{ id, status, lamport, deviceId, deleted, deletedLamport, deletedBy }
```

### Rewards (Coins / Streak / Today's Focus)
Rewards are owned exclusively by the **server**. The client maintains an optimistic local copy for offline display, but on every successful sync the server's authoritative values overwrite the local ones. This is safe because rewards only change as a consequence of completed sessions, and sessions are deduplicated server-side before any reward is applied.

---

## 2. Sync Protocol

The sync endpoint (`POST /sync`) follows a **push-then-pull** model:

1. Client sends everything it has that the server might not: `pendingSessions` + `pendingTaskOps` + its current `lamport`
2. Server merges sessions (idempotent), merges task ops (Lamport merge), fires n8n for newly confirmed sessions
3. Server returns **full authoritative state**: rewards, all tasks, all sessions, its lamport
4. Client replaces its local state with the server response (for rewards and sessions) and performs a client-side Lamport merge for tasks

**Why full-state response instead of delta?** For this demo, full-state is simpler and correct. The extension section of the assignment calls out efficient/delta sync as an optional improvement — I've noted this tradeoff explicitly below.

**Auto-sync interval:** 10 seconds when online. Immediate sync triggered on any action (session complete, task edit) when online.

---

## 3. Conflict Resolution

### Logical Clock (Lamport)

Device wall-clocks disagree (phone and laptop can be minutes apart). I use a **Lamport scalar clock** instead:

- Each device increments its clock on every local write
- On sync, both sides advance to `max(local, remote) + 1`
- Every task op is stamped with the clock value at write time

This gives us a **happens-before** ordering that is consistent across devices without relying on wall-clock time.

### Task Conflict: Same Task Edited on Both Devices

**Strategy: Higher Lamport wins. Tie-break: lexicographically greater `deviceId`.**

Example:
- Phone edits task T1 at lamport=5, sets status → `done`
- Laptop edits task T1 at lamport=3 (diverged offline), sets status → `in_progress`
- On sync: Phone's edit wins (5 > 3) → final status is `done`

If both have the same lamport (they diverged at exactly the same logical moment), the lexicographically greater `deviceId` wins. This is arbitrary but **deterministic** — both devices reach the same conclusion independently.

**Implementation:** `taskWins(challenger, incumbent)` in both `store.ts` and `sync.ts` — identical logic, so client and server always converge to the same state.

### Task Conflict: Edited on One Device, Deleted on the Other

**Strategy: Delete wins (tombstone beats any edit).**

Rationale: A deletion is a more deliberate action than a status change. If a teacher removes a task from the syllabus while a student marks it in-progress offline, the deletion should prevail. A deleted task can always be re-added; a ghost task that won't go away is a worse experience.

Tombstones are never garbage-collected in this demo (production would need a GC watermark).

### Same Sync Message Arriving Twice / Out of Order

- **Sessions:** Guarded by `processedSessions` Set on the server. Same session ID arriving 10 times → rewards applied once.
- **Task ops:** Lamport merge is idempotent. Replaying `(lamport=5, deviceId=A, status=done)` against an existing `(lamport=5, deviceId=A, status=done)` — `taskWins` returns false (equal lamport, equal deviceId → no overwrite). Safe.
- **Out of order:** Lamport clocks handle this. A stale op with lower lamport simply loses to the already-stored newer version.

---

## 4. Why Two Devices Always End Up Identical

After both devices sync with the server:

1. **Rewards** — server is the only writer; both clients adopt the server's value verbatim after sync.
2. **Sessions** — append-only + first-write-wins; both clients receive the same full session list from the server.
3. **Tasks** — both clients ran `taskWins()` with identical inputs (same two task versions, same lamport values, same deviceIds). Because `taskWins` is a **total deterministic order** (no randomness, no wall-clock), both clients pick the same winner independently.

The server acts as the single convergence point. Once both devices have synced, they've each adopted the server's authoritative merged state. They are identical by construction.

---

## 5. Idempotency — End to End

| Layer | Mechanism | What it prevents |
|---|---|---|
| **Client (sessions)** | UUID generated once at session start, stored in `pendingSessions`; cleared only after server ACK | Retry on network failure doesn't create duplicate sessions |
| **Server (sessions)** | `processedSessions` Set (in-memory; persistent store in production) | Rewards applied once per session ID regardless of how many times the session arrives |
| **Server (n8n fire)** | `notifiedSessions` Set checked before `notifyN8n()` is called | n8n webhook called at most once per session, even if two devices both sync the same session |
| **n8n (workflow)** | `$getWorkflowStaticData('global')` stores `notifiedSessions` dict; checked before notification is sent | Even if backend calls the webhook twice (e.g., crash + retry), WhatsApp message sent once |
| **Task ops** | Lamport comparison is idempotent (equal lamport+deviceId never overwrites itself) | Replaying the full pending op list on reconnect is safe |

---

## 6. One Tradeoff I Made

**Full-state sync vs. delta sync**

On every sync, the server sends back the complete task list and session list. For a student with 13 tasks and a handful of sessions this is negligible (~2 KB). But it would not scale to thousands of tasks or months of sessions.

The right fix is a **checkpoint + delta** scheme: the server tracks a per-device "last seen" watermark (a lamport value), and only returns ops since that watermark. I chose full-state because:

1. The assignment explicitly lists "efficient sync (exchange only what changed)" as an **optional extension**, not a core requirement.
2. Full-state makes the correctness argument trivially obvious: the client always has exactly what the server has. There's no edge case where a missed delta causes divergence.
3. It saved ~3 hours of implementation time that I used to harden the idempotency and conflict logic, which the reviewers said they weight more heavily.

If this moved to production, I'd add a `?since=<lamport>` query param to `/sync` and return only tasks/sessions modified after that clock value.

---

## 7. Where It Could Still Break

1. **Server restart loses in-memory state.** `processedSessions`, `notifiedSessions`, and all task/session data live in a `Map`/`Set` in the Node process. A crash wipes everything. Fix: persist to SQLite or Postgres with a `processed_sessions` table.

2. **Two sync calls race on the server.** If a device fires two sync requests concurrently (e.g., a retry overlapping the original), both could pass the `processedSessions` check before either marks the session as processed. Fix: use a database transaction or a per-session advisory lock.

3. **n8n webhook times out but mark-as-notified already set.** The server marks `notifiedSessions` before the HTTP call. If n8n is down, the notification is silently dropped (at-most-once, not at-least-once). Fix: persistent outbox table with exponential-backoff retry worker.

4. **n8n static data is cleared on workflow import.** Importing `n8n-workflow.json` into a fresh n8n instance resets `staticData`, so the dedup store starts empty. The backend-level dedup still holds, but the n8n layer would re-fire for any sessions that were already notified. Fix: the backend-level guard is the primary one; n8n is a defence-in-depth second layer.

5. **Client lamport clock not persisted between hard refreshes** in the current implementation (it's in localStorage, so it survives refreshes, but if `clear()` is called it resets). A reset lamport could cause stale ops to win over newer ones if the server's lamport is also reset. Fix: server-issued sequence numbers or vector clocks per device.
