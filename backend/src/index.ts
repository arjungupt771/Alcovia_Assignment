import 'dotenv/config'; // must be first — loads .env before anything reads process.env
import express, { Request, Response } from 'express';
import cors from 'cors';
import { store, STUDENT_ID } from './store';
import { notifyN8n } from './n8nNotifier';
import { SyncRequest, SyncResponse, N8nPayload } from './types';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3001;

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, lamport: store.getLamport() });
});

// ─── Seed / Bootstrap ─────────────────────────────────────────────────────────

/**
 * GET /bootstrap
 * Returns initial state so a fresh client can hydrate without a prior sync.
 */
app.get('/bootstrap', (_req: Request, res: Response) => {
  res.json({
    subjects: store.subjects,
    chapters: store.chapters,
    tasks: store.getAllTasks(),
    rewards: store.getRewards(),
    sessions: store.getAllSessions(),
    serverLamport: store.getLamport(),
  });
});

// ─── Sync Endpoint ────────────────────────────────────────────────────────────

/**
 * POST /sync
 * Core sync: client pushes pending ops, server returns full authoritative state.
 *
 * Idempotency guarantees:
 *  - Sessions keyed by UUID — replayed sessions ignored
 *  - Rewards computed exactly once per session (processedSessions set)
 *  - n8n notifications sent at most once per session (notifiedSessions set)
 *  - Task ops merged with Lamport clocks — replaying same op is safe
 */
app.post('/sync', async (req: Request, res: Response) => {
  const body = req.body as SyncRequest;

  if (!body || !body.studentId || !body.deviceId) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  // Advance server lamport
  store.advanceLamport(body.clientLamport ?? 0);

  // 1. Merge sessions, compute rewards
  const newlyConfirmed = store.mergeSessions(body.sessions ?? []);

  // 2. Merge task ops
  const taskOps = (body.taskOps ?? []).map(op => op.task);
  store.mergeTasks(taskOps);

  // 3. Build response
  const rewards = store.getRewards();
  const response: SyncResponse = {
    rewards,
    tasks: store.getAllTasks(),
    sessions: store.getAllSessions(),
    serverLamport: store.getLamport(),
    newlyConfirmedSessions: newlyConfirmed,
  };

  // 4. Fire n8n notifications for newly confirmed sessions (after response is built)
  for (const sessionId of newlyConfirmed) {
    const session = store.getSession(sessionId);
    if (session) {
      notifyN8n(sessionId, rewards, 50, session.targetMinutes).catch(console.error);
    }
  }

  console.log(`[sync] device=${body.deviceId} sessions_pushed=${body.sessions?.length ?? 0} newly_confirmed=${newlyConfirmed.length} task_ops=${taskOps.length}`);

  res.json(response);
});

// ─── State Inspector (Dev Panel) ──────────────────────────────────────────────

app.get('/state', (_req: Request, res: Response) => {
  res.json({
    rewards: store.getRewards(),
    tasks: store.getAllTasks(),
    sessions: store.getAllSessions(),
    lamport: store.getLamport(),
  });
});

// ─── Mock N8N Sink ────────────────────────────────────────────────────────────
// Only used when N8N_WEBHOOK_URL is not set in .env.
// The real n8n workflow (n8n/n8n-workflow.json) should be used in production.

const notificationLog: Array<{ receivedAt: string; payload: N8nPayload }> = [];

app.post('/mock-n8n-sink', (req: Request, res: Response) => {
  const payload = req.body as N8nPayload;
  notificationLog.push({ receivedAt: new Date().toISOString(), payload });
  console.log(`[mock-n8n-sink] NOTIFICATION: Streak ${payload.streak}, +${payload.coinsEarned} coins (session: ${payload.sessionId})`);
  res.json({ ok: true, message: `Notification received for session ${payload.sessionId}` });
});

app.get('/notifications', (_req: Request, res: Response) => {
  res.json(notificationLog);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Alcovia backend running on http://localhost:${PORT}`);
  console.log(`   POST /sync          — sync client state`);
  console.log(`   GET  /bootstrap     — initial state`);
  console.log(`   GET  /state         — inspect server state`);
  console.log(`   GET  /notifications — mock n8n notification log`);
  console.log(`   POST /mock-n8n-sink — n8n webhook target`);

  // Read process.env INSIDE this callback — dotenv has run by now
  const n8nUrl = process.env.N8N_WEBHOOK_URL;
  if (n8nUrl) {
    console.log(`\n[n8n] ✅ Webhook URL loaded from .env: ${n8nUrl}`);
  } else {
    console.log(`\n[n8n] ⚠️  N8N_WEBHOOK_URL not set — notifications go to mock sink`);
    console.log(`[n8n]    Add it to backend/.env and restart to use real n8n`);
  }
  console.log('');
});

export default app;
