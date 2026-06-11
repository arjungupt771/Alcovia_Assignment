import {
  AppState,
  FocusSession,
  TaskOp,
  Task,
  SyncRequest,
  SyncResponse,
} from './types';

const BACKEND_URL = 'http://localhost:3001';

// ─── Conflict resolution (mirrors server logic) ───────────────────────────────

/**
 * Client-side task merge: same Lamport + delete-wins strategy.
 * When the server returns authoritative tasks, we merge them with local,
 * giving precedence to the server's version for the same task.
 *
 * (The server already ran this logic, so we just adopt the server state.
 * This function is used when applying the sync response.)
 */
export function mergeTaskLists(local: Task[], remote: Task[]): Task[] {
  const merged = new Map<string, Task>(local.map(t => [t.id, t]));

  for (const remoteTask of remote) {
    const existing = merged.get(remoteTask.id);
    if (!existing) {
      merged.set(remoteTask.id, remoteTask);
      continue;
    }

    // Delete wins
    if (remoteTask.deleted && !existing.deleted) {
      merged.set(remoteTask.id, remoteTask);
      continue;
    }
    if (!remoteTask.deleted && existing.deleted) {
      continue; // keep tombstone
    }

    // Higher Lamport wins
    if (remoteTask.lamport > existing.lamport) {
      merged.set(remoteTask.id, remoteTask);
    } else if (remoteTask.lamport === existing.lamport) {
      // Tie-break: lexicographically greater deviceId
      if (remoteTask.deviceId > existing.deviceId) {
        merged.set(remoteTask.id, remoteTask);
      }
    }
  }

  return Array.from(merged.values());
}

// ─── Local rewards update (optimistic, for offline) ───────────────────────────

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function prevDayUTC(d: string): string {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * Optimistically update rewards on-device for a completed session.
 * The server is the source of truth; this just keeps the UI responsive offline.
 */
export function applyLocalRewards(state: AppState, session: FocusSession): AppState {
  const today = todayUTC();
  let { coins, streak, lastStreakDate, todayFocusMinutes, todayDate } = state.rewards;

  if (todayDate !== today) {
    todayFocusMinutes = 0;
    todayDate = today;
  }

  todayFocusMinutes += session.targetMinutes;
  coins += 50;

  const yesterday = prevDayUTC(today);
  if (lastStreakDate === today) {
    // already bumped today
  } else if (lastStreakDate === yesterday || lastStreakDate === '') {
    streak += 1;
    lastStreakDate = today;
  } else {
    streak = 1;
    lastStreakDate = today;
  }

  return {
    ...state,
    rewards: { ...state.rewards, coins, streak, lastStreakDate, todayFocusMinutes, todayDate },
  };
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  newlyConfirmedSessions: string[];
  error?: string;
  state?: Partial<AppState>;
}

/**
 * Push pending ops to the server and receive authoritative state.
 * After a successful sync, the server state is adopted wholesale for rewards
 * (server is authoritative). Tasks are merged client-side post-sync.
 */
export async function syncWithServer(state: AppState): Promise<SyncResult> {
  const payload: SyncRequest = {
    studentId: 'student_alcovia_01',
    deviceId: state.deviceId,
    sessions: state.pendingSessions,
    taskOps: state.pendingTaskOps,
    clientLamport: state.lamport,
  };

  try {
    const res = await fetch(`${BACKEND_URL}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data: SyncResponse = await res.json();

    // Merge server tasks with local (server wins by default after merge)
    const mergedTasks = mergeTaskLists(state.tasks, data.tasks);

    // Mark all pushed sessions as synced
    const syncedIds = new Set(state.pendingSessions.map(s => s.id));
    const updatedSessions = [
      ...state.sessions.filter(s => !syncedIds.has(s.id)),
      ...data.sessions.map(s => ({ ...s, synced: true })),
    ];

    // Deduplicate sessions by id
    const sessionsById = new Map(updatedSessions.map(s => [s.id, s]));

    return {
      success: true,
      newlyConfirmedSessions: data.newlyConfirmedSessions,
      state: {
        rewards: data.rewards,              // Server is authoritative for rewards
        tasks: mergedTasks,
        sessions: Array.from(sessionsById.values()),
        lamport: Math.max(state.lamport, data.serverLamport) + 1,
        pendingSessions: [],                 // Cleared after successful sync
        pendingTaskOps: [],                  // Cleared after successful sync
        subjects: state.subjects,
        chapters: state.chapters,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      newlyConfirmedSessions: [],
      error: err?.message ?? 'Unknown error',
    };
  }
}

/**
 * Bootstrap from server on first load.
 */
export async function bootstrapFromServer(state: AppState): Promise<Partial<AppState> | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/bootstrap`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      tasks: data.tasks,
      rewards: data.rewards,
      sessions: data.sessions,
      subjects: data.subjects,
      chapters: data.chapters,
      lamport: data.serverLamport + 1,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch current notification log from backend (for dev panel)
 */
export async function fetchNotifications(): Promise<any[]> {
  try {
    const res = await fetch(`${BACKEND_URL}/notifications`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Fetch server state (for dev panel)
 */
export async function fetchServerState(): Promise<any | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/state`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
