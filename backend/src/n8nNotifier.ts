import axios from 'axios';
import { store } from './store';
import { N8nPayload, StudentRewards } from './types';

// ─── Config ───────────────────────────────────────────────────────────────────
//
// IMPORTANT: process.env is read LAZILY (inside the function body), NOT at
// module load time.
//
// Why: TypeScript compiles to CommonJS. All static `import` statements are
// hoisted and resolved before any module body code runs — including the
// `import 'dotenv/config'` in index.ts. So if we read process.env.N8N_WEBHOOK_URL
// at the top level here, dotenv hasn't populated the env yet and we always
// get undefined, silently falling back to the mock sink.
//
// Fix: call process.env inside the function. By the time notifyN8n() is
// actually invoked (during a /sync request), dotenv has long since run.
//
// Set N8N_WEBHOOK_URL in backend/.env:
//   N8N_WEBHOOK_URL=https://your-instance.app.n8n.cloud/webhook/alcovia-session-complete

const MOCK_SINK_URL = 'http://localhost:3001/mock-n8n-sink';

function getWebhookUrl(): string {
  return process.env.N8N_WEBHOOK_URL || MOCK_SINK_URL;
}

// Logged once on first notification to confirm which URL is active
let _urlLogged = false;
function logUrlOnce(url: string): void {
  if (_urlLogged) return;
  _urlLogged = true;
  const isReal = url !== MOCK_SINK_URL;
  console.log(
    isReal
      ? `[n8n] ✅ Real n8n webhook: ${url}`
      : `[n8n] ⚠️  N8N_WEBHOOK_URL not set — using mock sink at ${MOCK_SINK_URL}`
  );
}

// ─── Notifier ─────────────────────────────────────────────────────────────────

/**
 * Fire the n8n notification for a confirmed session.
 *
 * Idempotency layers:
 *  1. store.isNotified() — server-side guard, runs before any HTTP call
 *  2. n8n workflow Code node — $getWorkflowStaticData dedup inside n8n itself
 */
export async function notifyN8n(
  sessionId: string,
  rewards: StudentRewards,
  coinsEarned: number,
  focusMinutes: number
): Promise<void> {
  // Guard: already notified this session?
  if (store.isNotified(sessionId)) {
    console.log(`[n8n] Skipping duplicate — ${sessionId.slice(0, 12)}… already notified`);
    return;
  }

  // Mark BEFORE the await — prevents two concurrent calls both firing
  store.markNotified(sessionId);

  // Read URL lazily — dotenv is guaranteed to have run by now
  const webhookUrl = getWebhookUrl();
  logUrlOnce(webhookUrl);

  const payload: N8nPayload = {
    sessionId,
    studentId: rewards.studentId,
    streak: rewards.streak,
    coinsEarned,
    totalCoins: rewards.coins,
    focusMinutes,
    timestamp: new Date().toISOString(),
  };

  console.log(`[n8n] → POST ${webhookUrl}`);
  console.log(`[n8n]   session=${sessionId.slice(0, 12)}… streak=${rewards.streak} +${coinsEarned} coins`);

  try {
    const res = await axios.post(webhookUrl, payload, {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`[n8n] ✅ HTTP ${res.status}`);
  } catch (err: any) {
    const status = err?.response?.status;
    const msg    = err?.message ?? 'unknown error';
    console.error(`[n8n] ❌ Failed (${status ?? msg})`);
    if (webhookUrl !== MOCK_SINK_URL) {
      console.error(`[n8n]   Check: is the n8n workflow set to Active? Is the URL correct?`);
    }
    // Not un-marking — intentional at-most-once. Add outbox+retry for at-least-once.
  }
}
