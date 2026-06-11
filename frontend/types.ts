// ─── Shared Types (mirrored from backend) ─────────────────────────────────────

export type TaskStatus = 'not_started' | 'in_progress' | 'done';
export type FailReason = 'give_up' | 'app_switch';
export type SessionStatus = 'completed' | 'failed';

export interface FocusSession {
  id: string;
  studentId: string;
  targetMinutes: number;
  startedAt: number;
  status: SessionStatus;
  failReason?: FailReason;
  completedAt?: number;
  synced: boolean;
}

export interface StudentRewards {
  studentId: string;
  coins: number;
  streak: number;
  lastStreakDate: string;
  todayFocusMinutes: number;
  todayDate: string;
}

export interface Task {
  id: string;
  subjectId: string;
  chapterId: string;
  title: string;
  status: TaskStatus;
  lamport: number;
  deviceId: string;
  deleted: boolean;
  deletedBy?: string;
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

export interface TaskOp {
  type: 'upsert' | 'delete';
  task: Task;
}

export interface SyncRequest {
  studentId: string;
  deviceId: string;
  sessions: FocusSession[];
  taskOps: TaskOp[];
  clientLamport: number;
}

export interface SyncResponse {
  rewards: StudentRewards;
  tasks: Task[];
  sessions: FocusSession[];
  serverLamport: number;
  newlyConfirmedSessions: string[];
}

export interface AppState {
  deviceId: string;
  lamport: number;
  sessions: FocusSession[];
  tasks: Task[];
  rewards: StudentRewards;
  pendingTaskOps: TaskOp[];
  pendingSessions: FocusSession[];
  subjects: Subject[];
  chapters: Chapter[];
}
