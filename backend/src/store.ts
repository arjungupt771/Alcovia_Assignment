import { FocusSession, StudentRewards, Task, Subject, Chapter } from './types';

// ─── Seed Data ────────────────────────────────────────────────────────────────

const STUDENT_ID = 'student_alcovia_01';

const seedSubjects: Subject[] = [
  { id: 'sub_math', title: 'Mathematics' },
  { id: 'sub_sci', title: 'Science' },
  { id: 'sub_eng', title: 'English' },
];

const seedChapters: Chapter[] = [
  { id: 'ch_algebra', subjectId: 'sub_math', title: 'Algebra' },
  { id: 'ch_geometry', subjectId: 'sub_math', title: 'Geometry' },
  { id: 'ch_physics', subjectId: 'sub_sci', title: 'Physics Basics' },
  { id: 'ch_chem', subjectId: 'sub_sci', title: 'Chemistry Intro' },
  { id: 'ch_grammar', subjectId: 'sub_eng', title: 'Grammar' },
  { id: 'ch_writing', subjectId: 'sub_eng', title: 'Essay Writing' },
];

const seedTasks: Task[] = [
  // Algebra
  { id: 't1', subjectId: 'sub_math', chapterId: 'ch_algebra', title: 'Linear equations', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  { id: 't2', subjectId: 'sub_math', chapterId: 'ch_algebra', title: 'Quadratic equations', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  { id: 't3', subjectId: 'sub_math', chapterId: 'ch_algebra', title: 'Polynomials', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  // Geometry
  { id: 't4', subjectId: 'sub_math', chapterId: 'ch_geometry', title: 'Triangles & congruence', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  { id: 't5', subjectId: 'sub_math', chapterId: 'ch_geometry', title: 'Circles', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  // Physics
  { id: 't6', subjectId: 'sub_sci', chapterId: 'ch_physics', title: 'Newton\'s laws', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  { id: 't7', subjectId: 'sub_sci', chapterId: 'ch_physics', title: 'Work & energy', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  // Chemistry
  { id: 't8', subjectId: 'sub_sci', chapterId: 'ch_chem', title: 'Periodic table', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  { id: 't9', subjectId: 'sub_sci', chapterId: 'ch_chem', title: 'Chemical bonding', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  // Grammar
  { id: 't10', subjectId: 'sub_eng', chapterId: 'ch_grammar', title: 'Parts of speech', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  { id: 't11', subjectId: 'sub_eng', chapterId: 'ch_grammar', title: 'Tenses', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  // Writing
  { id: 't12', subjectId: 'sub_eng', chapterId: 'ch_writing', title: 'Introduction paragraphs', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
  { id: 't13', subjectId: 'sub_eng', chapterId: 'ch_writing', title: 'Argumentative essays', status: 'not_started', lamport: 0, deviceId: 'seed', deleted: false },
];

// ─── Store ────────────────────────────────────────────────────────────────────

class Store {
  // Sessions: keyed by session id — idempotent storage
  private sessions = new Map<string, FocusSession>();
  
  // Tasks: keyed by task id
  private tasks = new Map<string, Task>(seedTasks.map(t => [t.id, t]));
  
  // Subjects & chapters (static for this demo)
  readonly subjects: Subject[] = seedSubjects;
  readonly chapters: Chapter[] = seedChapters;
  
  // Rewards (single student for demo)
  private rewards: StudentRewards = {
    studentId: STUDENT_ID,
    coins: 0,
    streak: 0,
    lastStreakDate: '',
    todayFocusMinutes: 0,
    todayDate: todayUTC(),
  };
  
  // Logical clock
  private lamport = 0;
  
  // Already-notified sessions (idempotency for n8n)
  private notifiedSessions = new Set<string>();
  
  // Already-processed sessions (idempotency for rewards)
  private processedSessions = new Set<string>();

  // ── Lamport ───────────────────────────────────────────────────────────────

  advanceLamport(received: number): number {
    this.lamport = Math.max(this.lamport, received) + 1;
    return this.lamport;
  }

  getLamport(): number {
    return this.lamport;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  getSession(id: string): FocusSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): FocusSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Merge incoming sessions. Idempotent: same session id is never double-counted.
   * Returns newly confirmed successful session ids (i.e., ones we hadn't seen before).
   */
  mergeSessions(incoming: FocusSession[]): string[] {
    const newlyConfirmed: string[] = [];

    for (const session of incoming) {
      if (!this.sessions.has(session.id)) {
        // Brand new session — store it
        const stored: FocusSession = { ...session, synced: true };
        this.sessions.set(session.id, stored);

        if (session.status === 'completed' && !this.processedSessions.has(session.id)) {
          this.processedSessions.add(session.id);
          this.applyRewards(session);
          newlyConfirmed.push(session.id);
        }
      } else {
        // Already seen — idempotent: do nothing (first-write-wins for sessions)
        // Sessions are immutable once created — no conflict possible
      }
    }

    return newlyConfirmed;
  }

  /**
   * Apply rewards for a newly confirmed completed session.
   * Called exactly once per session id (processedSessions guards this).
   */
  private applyRewards(session: FocusSession): void {
    const today = todayUTC();
    
    // Reset today's total if calendar day changed
    if (this.rewards.todayDate !== today) {
      this.rewards.todayFocusMinutes = 0;
      this.rewards.todayDate = today;
    }

    this.rewards.todayFocusMinutes += session.targetMinutes;
    this.rewards.coins += 50; // flat 50 coins per completed session

    // Streak logic
    const yesterday = prevDayUTC(today);
    if (this.rewards.lastStreakDate === today) {
      // Multiple sessions same day — streak already counted
    } else if (this.rewards.lastStreakDate === yesterday || this.rewards.lastStreakDate === '') {
      // Consecutive day (or first ever)
      this.rewards.streak += 1;
      this.rewards.lastStreakDate = today;
    } else {
      // Gap — reset
      this.rewards.streak = 1;
      this.rewards.lastStreakDate = today;
    }
  }

  getRewards(): StudentRewards {
    return { ...this.rewards };
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Merge incoming task ops using Lamport clock comparison.
   * 
   * Conflict resolution:
   * 1. Both devices edit same task → higher Lamport wins (logical happens-before)
   *    Tie (same lamport) → lexicographically greater deviceId wins (stable, deterministic)
   * 2. One device edits, other deletes → delete wins (tombstone beats edit)
   *    Rationale: deletion is a more deliberate action; easier to re-add than chase ghost data
   * 3. Duplicate ops (same lamport, same deviceId) → idempotent, skip
   */
  mergeTasks(incoming: Task[]): void {
    for (const inTask of incoming) {
      const existing = this.tasks.get(inTask.id);
      
      if (!existing) {
        // New task
        this.tasks.set(inTask.id, { ...inTask });
        continue;
      }

      // Compare: who wins?
      const incomingWins = this.taskWins(inTask, existing);
      
      if (incomingWins) {
        this.tasks.set(inTask.id, { ...inTask });
      }
      // else: existing wins — keep current
    }
  }

  /**
   * Returns true if `challenger` should overwrite `incumbent`.
   * Delete-wins: if either is a tombstone, tombstone wins.
   * Otherwise: higher lamport wins; tie → lexicographically greater deviceId.
   */
  private taskWins(challenger: Task, incumbent: Task): boolean {
    // Tombstone always beats non-tombstone
    if (challenger.deleted && !incumbent.deleted) return true;
    if (!challenger.deleted && incumbent.deleted) return false;

    // Both same deletion state: compare lamport
    if (challenger.lamport > incumbent.lamport) return true;
    if (challenger.lamport < incumbent.lamport) return false;

    // Tie-break by deviceId (deterministic)
    return challenger.deviceId > incumbent.deviceId;
  }

  // ── N8N notification dedup ────────────────────────────────────────────────

  markNotified(sessionId: string): void {
    this.notifiedSessions.add(sessionId);
  }

  isNotified(sessionId: string): boolean {
    return this.notifiedSessions.has(sessionId);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function prevDayUTC(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export const store = new Store();
export { STUDENT_ID };
