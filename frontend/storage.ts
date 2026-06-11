import { AppState, Subject, Chapter } from './types';

// ─── Active Session State (persisted separately for crash recovery) ───────────

export interface ActiveSessionState {
  sessionId: string;
  targetMinutes: number;
  startedAt: number;
  elapsedSeconds: number;
  savedAt: number; // wall clock when we last wrote this, to compute drift on restore
}

// ─── Default Rewards ──────────────────────────────────────────────────────────

const defaultRewards = {
  studentId: 'student_alcovia_01',
  coins: 0,
  streak: 0,
  lastStreakDate: '',
  todayFocusMinutes: 0,
  todayDate: new Date().toISOString().slice(0, 10),
};

const defaultSubjects: Subject[] = [
  { id: 'sub_math', title: 'Mathematics' },
  { id: 'sub_sci', title: 'Science' },
  { id: 'sub_eng', title: 'English' },
];

const defaultChapters: Chapter[] = [
  { id: 'ch_algebra', subjectId: 'sub_math', title: 'Algebra' },
  { id: 'ch_geometry', subjectId: 'sub_math', title: 'Geometry' },
  { id: 'ch_physics', subjectId: 'sub_sci', title: 'Physics Basics' },
  { id: 'ch_chem', subjectId: 'sub_sci', title: 'Chemistry Intro' },
  { id: 'ch_grammar', subjectId: 'sub_eng', title: 'Grammar' },
  { id: 'ch_writing', subjectId: 'sub_eng', title: 'Essay Writing' },
];

// ─── Storage Class ────────────────────────────────────────────────────────────

/**
 * Durable on-device storage using localStorage, namespaced per deviceId
 * so two browser tabs can act as independent devices.
 *
 * In a native app you'd swap this for AsyncStorage or SQLite.
 */
export class DeviceStorage {
  private prefix: string;

  constructor(deviceId: string) {
    this.prefix = `alcovia_${deviceId}_`;
  }

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  private get<T>(k: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(this.key(k));
      if (raw == null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private set<T>(k: string, value: T): void {
    try {
      localStorage.setItem(this.key(k), JSON.stringify(value));
    } catch (e) {
      console.error('Storage write failed', e);
    }
  }

  loadState(deviceId: string): AppState {
    return {
      deviceId,
      lamport: this.get('lamport', 0),
      sessions: this.get('sessions', []),
      tasks: this.get('tasks', []),
      rewards: this.get('rewards', defaultRewards),
      pendingTaskOps: this.get('pendingTaskOps', []),
      pendingSessions: this.get('pendingSessions', []),
      subjects: this.get('subjects', defaultSubjects),
      chapters: this.get('chapters', defaultChapters),
    };
  }

  saveState(state: AppState): void {
    this.set('lamport', state.lamport);
    this.set('sessions', state.sessions);
    this.set('tasks', state.tasks);
    this.set('rewards', state.rewards);
    this.set('pendingTaskOps', state.pendingTaskOps);
    this.set('pendingSessions', state.pendingSessions);
    this.set('subjects', state.subjects);
    this.set('chapters', state.chapters);
  }

  // ── Active session (crash recovery) ────────────────────────────────────────

  saveActiveSession(s: ActiveSessionState): void {
    this.set('activeSession', s);
  }

  loadActiveSession(): ActiveSessionState | null {
    return this.get<ActiveSessionState | null>('activeSession', null);
  }

  clearActiveSession(): void {
    localStorage.removeItem(this.key('activeSession'));
  }

  clear(): void {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(this.prefix));
    keys.forEach(k => localStorage.removeItem(k));
  }
}
