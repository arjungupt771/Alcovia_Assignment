# Alcovia — Offline-First Study App

An offline-first React Native (Expo Web) + Express implementation of Alcovia's Focus Sessions and Syllabus Progress features, with two-device sync, Lamport-clock conflict resolution, idempotent rewards, and n8n automation.


Note: The live link is not working due to some cache errors, so please ignore that

---

## Quick Start (< 5 minutes)

### Prerequisites
- Node.js 18+
- npm 8+
- n8n (Cloud free tier **or** `npx n8n` for local)

---

### 1. Backend

```bash
cd backend

# 1. Copy the env template and fill in your n8n webhook URL
cp .env.example .env
# Edit .env:  N8N_WEBHOOK_URL=https://your-instance.app.n8n.cloud/webhook/alcovia-session-complete

npm install
npm run dev
# → Listening on http://localhost:3001
```

On startup you will see one of these lines confirming which sink is active:
```
[n8n] ✅ Real n8n webhook configured: https://...
[n8n] ⚠️  N8N_WEBHOOK_URL not set — using mock sink at http://localhost:3001/mock-n8n-sink
```

Verify: `curl http://localhost:3001/health` → `{"ok":true}`

---

### 2. Frontend

```bash
cd frontend
npm install
npx expo start --web
# → Opens http://localhost:8081
```

**Two-device simulation:**

Open two browser tabs (or two separate browser profiles to ensure truly independent `localStorage`):

| Device | URL |
|--------|-----|
| Device A | `http://localhost:8081?device=DeviceA` |
| Device B | `http://localhost:8081?device=DeviceB` |

Each tab gets its own namespaced `localStorage` key prefix (`alcovia_DeviceA_*` vs `alcovia_DeviceB_*`), so they behave like independent devices even in the same browser.

> **Note:** For true storage isolation (recommended for the conflict demo), use a normal window for Device A and an Incognito window for Device B.

---

### 3. n8n Workflow

#### Option A — n8n Cloud (recommended for demo)

1. Sign up at [n8n.io](https://n8n.io) (free tier)
2. Go to **Workflows → Import** → paste/upload `n8n/n8n-workflow.json`
3. Activate the workflow
4. Copy the webhook URL (shown in the "Webhook - Session Complete" node)
5. Set `N8N_WEBHOOK_URL=<your-webhook-url>` in the backend environment and restart

#### Option B — Self-hosted (local)

```bash
npx n8n
# → Opens http://localhost:5678
```

1. Import `n8n/n8n-workflow.json` via the UI
2. Activate the workflow
3. The webhook URL will be `http://localhost:5678/webhook/alcovia-session-complete`
4. Set `N8N_WEBHOOK_URL=http://localhost:5678/webhook/alcovia-session-complete`

---

## Conflict Scenarios — How to Demo

### Scenario 1: Task edited on both devices offline (status conflict)

1. Open Device A and Device B tabs
2. Both bootstrap from server (tasks appear)
3. Go to **Dev** tab on both → toggle **Offline** on both
4. On Device A: go to Syllabus → tap "Linear equations" → cycle to `In Progress`
5. On Device B: go to Syllabus → tap "Linear equations" → cycle to `Done`
6. Toggle both back **Online**
7. **Expected result:** "Linear equations" = `Done` on both devices
   - Device B's edit had a higher Lamport clock (it incremented its clock separately)
   - If both are at the same Lamport, `DeviceB > DeviceA` lexicographically → B wins

### Scenario 2: Task deleted on one device, edited on the other

1. Both devices offline
2. Device A: change "Quadratic equations" → `Done`
3. Device B: delete "Quadratic equations" (✕ button)
4. Both come online
5. **Expected result:** Task is deleted on both devices (tombstone beats any status edit)

### Scenario 3: Focus sessions from both devices — rewards counted once

1. Both devices offline
2. Device A: start a 15m session → wait for it to complete (or set `targetMinutes=1` via the UI)
3. Device B: start a separate 15m session → complete it
4. Both come online → sync
5. **Expected result:**
   - Server has 2 sessions, each counted once
   - Coins = 100 (50 per session), streak = 1 (both on same day)
   - n8n notification fired **twice** (once per unique session ID), not three or four times

### Scenario 4: Same session replayed — notification fires once

1. Complete a session on Device A while offline
2. Come online — session syncs, notification fires
3. Go offline on Device A, toggle online again (forces another sync attempt with same pending data)
4. **Expected result:** notification log shows the session ID only **once**
   - Backend `notifiedSessions` Set guards the first replay
   - n8n `$getWorkflowStaticData` guards any webhook-level replay

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Liveness check |
| `GET` | `/bootstrap` | Full initial state (subjects, chapters, tasks, rewards) |
| `POST` | `/sync` | Push pending ops, receive authoritative state |
| `GET` | `/state` | Inspect current server state (dev) |
| `GET` | `/notifications` | Mock notification log (dev) |
| `POST` | `/mock-n8n-sink` | Receives n8n webhook payload (dev/fallback) |

### Sync Request Body

```json
{
  "studentId": "student_alcovia_01",
  "deviceId": "DeviceA",
  "sessions": [ /* FocusSession[] */ ],
  "taskOps": [ /* TaskOp[] */ ],
  "clientLamport": 12
}
```

---

## Architecture Overview

```
┌──────────────────┐     ┌──────────────────┐
│   Device A       │     │   Device B       │
│  (browser tab)   │     │  (browser tab)   │
│                  │     │                  │
│  localStorage    │     │  localStorage    │
│  (namespaced)    │     │  (namespaced)    │
└────────┬─────────┘     └────────┬─────────┘
         │  POST /sync             │  POST /sync
         └──────────┬──────────────┘
                    ▼
         ┌──────────────────┐
         │  Express Backend │
         │  (port 3001)     │
         │                  │
         │  In-memory store │
         │  • sessions Map  │
         │  • tasks Map     │
         │  • rewards obj   │
         │  • dedup Sets    │
         └────────┬─────────┘
                  │  POST webhook (once per session)
                  ▼
         ┌──────────────────┐
         │  n8n Workflow    │
         │                  │
         │  1. Receive      │
         │  2. Dedup check  │
         │  3. Send notif   │
         └──────────────────┘
```

---

## Conflict Resolution Summary

| Conflict | Resolution | Rationale |
|----------|-----------|-----------|
| Same task edited on both devices | Higher Lamport clock wins; equal lamport → lexicographically greater `deviceId` | Logical happens-before; deterministic tie-break |
| Task edited on one device, deleted on other | Delete (tombstone) wins | Deletions are more deliberate; ghost tasks worse than false deletions |
| Same session synced from two devices | First write wins (UUID dedup); rewards counted once | Sessions are immutable; stable UUID is the key |
| Same session triggers n8n twice | Backend `notifiedSessions` Set; n8n static data dedup | Two independent guards; belt and braces |
| Sync message out of order | Lamport comparison handles it — stale ops have lower clocks | Logical ordering is clock-based, not arrival-time-based |

---

## What's Left Out / What I'd Do Next

1. **Persistent storage** — replace in-memory Maps with SQLite/Postgres so the server survives restarts
2. **Delta sync** — `?since=<lamport>` to avoid sending full task list on every sync
3. **Vector clocks** — scale to N devices more precisely than scalar Lamport (no false conflicts)
4. **Offline session timer persistence** — store `sessionStartTime + elapsedSeconds` to `localStorage` so a page refresh mid-session can resume
5. **Real WhatsApp delivery** — swap the mock HTTP node in n8n for an AiSensy/Twilio node
6. **Conflict surfacing UI** — when two tasks have the same Lamport from different devices, show the user a merge dialog instead of silently resolving
7. **Auth** — replace hardcoded `studentId` with JWT-based device registration

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Frontend | React Native (Expo Web), TypeScript |
| On-device storage | `localStorage` (namespaced per device) |
| Backend | Express, TypeScript |
| Server storage | In-memory `Map`/`Set` (SQLite-ready) |
| Sync algorithm | Custom push-then-pull with Lamport clocks |
| Automation | n8n (webhook + Code node + HTTP Request) |
| Conflict resolution | Lamport + delete-wins, no CRDT library |
