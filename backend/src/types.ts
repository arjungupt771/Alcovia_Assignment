// ─── Shared Types ────────────────────────────────────────────────────────────

export type TaskStatus = 'not_started' | 'in_progress' | 'done';
export type FailReason = 'give_up' | 'app_switch';
export type SessionStatus = 'completed' | 'failed';

// ─── Focus Session ────────────────────────────────────────────────────────────

export interface FocusSession {
  id: string;              // stable uuid created on device
  studentId: string;
  targetMinutes: number;
  startedAt: number;       // epoch ms (device clock — only used for ordering, not dedup)
  status: SessionStatus;
  failReason?: FailReason;
  completedAt?: number;    // epoch ms
  synced: boolean;         // server-side: always true; client: whether pushed
}

// ─── Rewards (server-of-record) ───────────────────────────────────────────────

export interface StudentRewards {
  studentId: string;
  coins: number;
  streak: number;          // consecutive days with ≥1 completed session
  lastStreakDate: string;  // YYYY-MM-DD in UTC
  todayFocusMinutes: number;
  todayDate: string;       // YYYY-MM-DD in UTC — resets todayFocusMinutes when date changes
}

// ─── Syllabus / Tasks ─────────────────────────────────────────────────────────

export interface Task {
  id: string;
  subjectId: string;
  chapterId: string;
  title: string;
  status: TaskStatus;
  // Logical clock: (lamportClock, deviceId) — used instead of wall-clock for conflict resolution
  lamport: number;
  deviceId: string;
  // Tombstone support
  deleted: boolean;
  deletedBy?: string;      // deviceId that deleted
  deletedLamport?: number;
}

export interface Chapter {
  id: string;
  subjectId: string;
  title: string;
}

export interface Subject {
  id: string;
  title: string;
}

// ─── Sync Protocol ────────────────────────────────────────────────────────────

export interface SyncRequest {
  studentId: string;
  deviceId: string;
  // Sessions the client wants to push
  sessions: FocusSession[];
  // Task operations the client wants to push
  taskOps: TaskOp[];
  // The client's current lamport clock value (so server can advance its own)
  clientLamport: number;
}

export interface TaskOp {
  type: 'upsert' | 'delete';
  task: Task;
}

export interface SyncResponse {
  // Merged authoritative state the client should adopt
  rewards: StudentRewards;
  tasks: Task[];
  sessions: FocusSession[];
  // Server's current lamport (client advances to max(client, server) + 1)
  serverLamport: number;
  // Sessions that were newly confirmed successful on this sync (for logging)
  newlyConfirmedSessions: string[];
}

// ─── N8N Webhook Payload ──────────────────────────────────────────────────────

export interface N8nPayload {
  sessionId: string;
  studentId: string;
  streak: number;
  coinsEarned: number;
  totalCoins: number;
  focusMinutes: number;
  timestamp: string;
}
