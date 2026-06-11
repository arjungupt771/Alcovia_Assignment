import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  StyleSheet,
  Platform,
  Alert,
} from 'react-native';
import { v4 as uuidv4 } from 'uuid';
import {
  AppState as AlcoviaState,
  FocusSession,
  Task,
  TaskStatus,
  TaskOp,
  FailReason,
} from './types';
import { DeviceStorage, ActiveSessionState } from './storage';
import {
  syncWithServer,
  bootstrapFromServer,
  applyLocalRewards,
  fetchNotifications,
  fetchServerState,
} from './sync';

// ─── Constants ────────────────────────────────────────────────────────────────

const STUDENT_ID = 'student_alcovia_01';
const APP_SWITCH_GRACE_MS = 5000;

// Read deviceId from URL (?device=A or ?device=B), default to A
function getDeviceId(): string {
  if (Platform.OS === 'web') {
    const params = new URLSearchParams(window.location.search);
    return params.get('device') || 'DeviceA';
  }
  return 'DeviceA';
}

// ─── Theme ────────────────────────────────────────────────────────────────────

const COLORS = {
  bg: '#0F1117',
  surface: '#1A1D27',
  card: '#22263A',
  accent: '#6C63FF',
  accentLight: '#8B84FF',
  success: '#4ADE80',
  danger: '#F87171',
  warn: '#FBBF24',
  text: '#E8E9F0',
  textMuted: '#8B8FA8',
  border: '#2E3251',
  online: '#4ADE80',
  offline: '#F87171',
};

// ─── Progress helpers ─────────────────────────────────────────────────────────

function calcProgress(tasks: Task[], chapterId: string): number {
  const t = tasks.filter(t => t.chapterId === chapterId && !t.deleted);
  if (t.length === 0) return 0;
  return t.filter(t => t.status === 'done').length / t.length;
}

function calcSubjectProgress(tasks: Task[], subjectId: string, chapters: any[]): number {
  const chaps = chapters.filter(c => c.subjectId === subjectId);
  if (chaps.length === 0) return 0;
  const total = chaps.reduce((acc, c) => acc + calcProgress(tasks, c.id), 0);
  return total / chaps.length;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

// ─── Timer display ────────────────────────────────────────────────────────────

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const deviceId = getDeviceId();
  const storageRef = useRef<DeviceStorage>(new DeviceStorage(deviceId));

  // ── State ──────────────────────────────────────────────────────────────────

  const [appState, setAppStateRaw] = useState<AlcoviaState>(() =>
    storageRef.current.loadState(deviceId)
  );
  const [isOnline, setIsOnline] = useState(true);
  const [activeTab, setActiveTab] = useState<'focus' | 'syllabus' | 'dev'>('focus');

  // Focus session state
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionId, setSessionId] = useState<string>('');
  const [targetMinutes, setTargetMinutes] = useState(25);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sessionStartTime, setSessionStartTime] = useState(0);

  // Dev panel
  const [notifications, setNotifications] = useState<any[]>([]);
  const [serverState, setServerState] = useState<any>(null);
  const [syncLog, setSyncLog] = useState<string[]>([]);
  const [lastSyncResult, setLastSyncResult] = useState<string>('');

  // Refs for timers
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const backgroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBackgroundedRef = useRef(false);

  // ── Persist state ──────────────────────────────────────────────────────────

  const setAppState = useCallback((updater: AlcoviaState | ((prev: AlcoviaState) => AlcoviaState)) => {
    setAppStateRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      storageRef.current.saveState(next);
      return next;
    });
  }, []);

  // ── Lamport clock helper ───────────────────────────────────────────────────

  const nextLamport = useCallback((state: AlcoviaState): [number, AlcoviaState] => {
    const l = state.lamport + 1;
    return [l, { ...state, lamport: l }];
  }, []);

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  // Crash/refresh recovery: restore active session if one was in progress
  useEffect(() => {
    const saved = storageRef.current.loadActiveSession();
    if (saved) {
      const wallDrift = Math.floor((Date.now() - saved.savedAt) / 1000);
      const restoredElapsed = saved.elapsedSeconds + wallDrift;
      const totalSeconds = saved.targetMinutes * 60;

      if (restoredElapsed >= totalSeconds) {
        // Session already expired while app was closed — count as completed
        storageRef.current.clearActiveSession();
        setSessionId(saved.sessionId);
        setTargetMinutes(saved.targetMinutes);
        setSessionStartTime(saved.startedAt);
        setElapsedSeconds(totalSeconds);
        addLog(`🔄 Restored crashed session — marking complete`);
        // Trigger complete after mount
        setTimeout(() => handleSessionComplete(), 100);
      } else {
        // Resume in-progress session
        setSessionId(saved.sessionId);
        setTargetMinutes(saved.targetMinutes);
        setSessionStartTime(saved.startedAt);
        setElapsedSeconds(restoredElapsed);
        setSessionActive(true);
        addLog(`🔄 Resumed session after refresh (${restoredElapsed}s elapsed)`);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const hasTasks = appState.tasks.length > 0;
    if (!hasTasks && isOnline) {
      bootstrapFromServer(appState).then(partial => {
        if (partial) {
          setAppState(s => ({ ...s, ...partial }));
          addLog('Bootstrapped from server');
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-sync when online ──────────────────────────────────────────────────

  useEffect(() => {
    if (isOnline) {
      // Immediate sync on coming online
      doSync();
    }
    if (syncTimerRef.current) clearInterval(syncTimerRef.current);
    if (isOnline) {
      syncTimerRef.current = setInterval(doSync, 10000);
    }
    return () => {
      if (syncTimerRef.current) clearInterval(syncTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // ── App visibility (background detection) ─────────────────────────────────

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleVisibility = () => {
      if (document.hidden) {
        // App went to background
        if (sessionActive) {
          isBackgroundedRef.current = true;
          backgroundTimerRef.current = setTimeout(() => {
            // Grace period exceeded — fail the session
            if (isBackgroundedRef.current && sessionActive) {
              handleSessionFail('app_switch');
            }
          }, APP_SWITCH_GRACE_MS);
        }
      } else {
        // App came back to foreground
        if (backgroundTimerRef.current) {
          clearTimeout(backgroundTimerRef.current);
        }
        isBackgroundedRef.current = false;
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [sessionActive]);

  // ── Persist active session on every tick (crash recovery) ─────────────────

  useEffect(() => {
    if (sessionActive && sessionId) {
      const snapshot: ActiveSessionState = {
        sessionId,
        targetMinutes,
        startedAt: sessionStartTime,
        elapsedSeconds,
        savedAt: Date.now(),
      };
      storageRef.current.saveActiveSession(snapshot);
    }
  }, [elapsedSeconds, sessionActive, sessionId, targetMinutes, sessionStartTime]);

  // ── Focus timer ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (sessionActive) {
      timerRef.current = setInterval(() => {
        setElapsedSeconds(prev => {
          const next = prev + 1;
          if (next >= targetMinutes * 60) {
            // Session completed!
            clearInterval(timerRef.current!);
            handleSessionComplete();
          }
          return next;
        });
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionActive, targetMinutes]);

  // ── Sync logic ────────────────────────────────────────────────────────────

  const addLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setSyncLog(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 50));
  };

  const doSync = useCallback(async () => {
    const currentState = storageRef.current.loadState(deviceId);
    addLog(`Syncing: ${currentState.pendingSessions.length} sessions, ${currentState.pendingTaskOps.length} task ops`);
    const result = await syncWithServer(currentState);

    if (result.success && result.state) {
      setAppState(s => ({ ...s, ...result.state }));
      const confirmed = result.newlyConfirmedSessions.length;
      const msg = confirmed > 0
        ? `✅ Synced! ${confirmed} session(s) confirmed`
        : `✅ Synced`;
      setLastSyncResult(msg);
      addLog(msg);
      if (result.newlyConfirmedSessions.length > 0) {
        refreshNotifications();
      }
    } else {
      setLastSyncResult(`❌ Sync failed: ${result.error}`);
      addLog(`Sync failed: ${result.error}`);
    }
  }, [deviceId, setAppState]);

  const refreshNotifications = async () => {
    const notifs = await fetchNotifications();
    setNotifications(notifs);
    const srv = await fetchServerState();
    setServerState(srv);
  };

  // ── Focus Session actions ─────────────────────────────────────────────────

  const handleStartSession = () => {
    const id = uuidv4();
    setSessionId(id);
    setElapsedSeconds(0);
    setSessionStartTime(Date.now());
    setSessionActive(true);
    addLog(`Started session ${id.slice(0, 8)}… (${targetMinutes}m)`);
  };

  const handleSessionComplete = useCallback(() => {
    setSessionActive(false);
    storageRef.current.clearActiveSession();
    setAppState(s => {
      const session: FocusSession = {
        id: sessionId || uuidv4(),
        studentId: STUDENT_ID,
        targetMinutes,
        startedAt: sessionStartTime,
        status: 'completed',
        completedAt: Date.now(),
        synced: false,
      };
      const withRewards = applyLocalRewards(s, session);
      const newState: AlcoviaState = {
        ...withRewards,
        sessions: [...s.sessions.filter(x => x.id !== session.id), session],
        pendingSessions: [...s.pendingSessions.filter(x => x.id !== session.id), session],
      };
      return newState;
    });
    addLog(`🎉 Session completed! +50 coins`);
    if (isOnline) setTimeout(doSync, 500);
  }, [sessionId, targetMinutes, sessionStartTime, isOnline, doSync, setAppState]);

  const handleSessionFail = useCallback((reason: FailReason) => {
    setSessionActive(false);
    storageRef.current.clearActiveSession();
    if (timerRef.current) clearInterval(timerRef.current);
    setAppState(s => {
      const session: FocusSession = {
        id: sessionId || uuidv4(),
        studentId: STUDENT_ID,
        targetMinutes,
        startedAt: sessionStartTime,
        status: 'failed',
        failReason: reason,
        synced: false,
      };
      return {
        ...s,
        sessions: [...s.sessions.filter(x => x.id !== session.id), session],
        pendingSessions: [...s.pendingSessions.filter(x => x.id !== session.id), session],
      };
    });
    addLog(`Session failed: ${reason}`);
    if (isOnline) setTimeout(doSync, 500);
  }, [sessionId, targetMinutes, sessionStartTime, isOnline, doSync, setAppState]);

  // ── Task actions ──────────────────────────────────────────────────────────

  const updateTaskStatus = (taskId: string, status: TaskStatus) => {
    setAppState(s => {
      const [lamport, newS] = nextLamport(s);
      const existing = s.tasks.find(t => t.id === taskId);
      if (!existing) return s;

      const updated: Task = { ...existing, status, lamport, deviceId };
      const op: TaskOp = { type: 'upsert', task: updated };

      return {
        ...newS,
        tasks: s.tasks.map(t => t.id === taskId ? updated : t),
        pendingTaskOps: [...s.pendingTaskOps, op],
      };
    });
    if (isOnline) setTimeout(doSync, 1000);
  };

  const deleteTask = (taskId: string) => {
    setAppState(s => {
      const [lamport, newS] = nextLamport(s);
      const existing = s.tasks.find(t => t.id === taskId);
      if (!existing) return s;

      const deleted: Task = {
        ...existing,
        deleted: true,
        deletedBy: deviceId,
        deletedLamport: lamport,
        lamport,
        deviceId,
      };
      const op: TaskOp = { type: 'delete', task: deleted };

      return {
        ...newS,
        tasks: s.tasks.map(t => t.id === taskId ? deleted : t),
        pendingTaskOps: [...s.pendingTaskOps, op],
      };
    });
    if (isOnline) setTimeout(doSync, 1000);
  };

  // ── Render helpers ────────────────────────────────────────────────────────

  const progressColor = (p: number) => {
    if (p >= 0.8) return COLORS.success;
    if (p >= 0.4) return COLORS.warn;
    return COLORS.accentLight;
  };

  const statusCycle: TaskStatus[] = ['not_started', 'in_progress', 'done'];
  const statusLabel: Record<TaskStatus, string> = {
    not_started: 'Not Started',
    in_progress: 'In Progress',
    done: '✓ Done',
  };
  const statusColor: Record<TaskStatus, string> = {
    not_started: COLORS.textMuted,
    in_progress: COLORS.warn,
    done: COLORS.success,
  };

  const cycleStatus = (current: TaskStatus): TaskStatus => {
    const idx = statusCycle.indexOf(current);
    return statusCycle[(idx + 1) % statusCycle.length];
  };

  // ── Progress bar ──────────────────────────────────────────────────────────

  const ProgressBar = ({ value }: { value: number }) => (
    <View style={styles.progressBg}>
      <View style={[styles.progressFill, { width: `${Math.round(value * 100)}%` as any, backgroundColor: progressColor(value) }]} />
    </View>
  );

  // ── Focus Tab ─────────────────────────────────────────────────────────────

  const renderFocusTab = () => {
    const remaining = targetMinutes * 60 - elapsedSeconds;
    const progress = sessionActive ? elapsedSeconds / (targetMinutes * 60) : 0;
    const recentSessions = [...appState.sessions].reverse().slice(0, 5);

    return (
      <ScrollView style={styles.tabContent}>
        {/* Rewards banner */}
        <View style={styles.rewardsBanner}>
          <View style={styles.rewardItem}>
            <Text style={styles.rewardValue}>{appState.rewards.streak}</Text>
            <Text style={styles.rewardLabel}>🔥 Day Streak</Text>
          </View>
          <View style={styles.rewardItem}>
            <Text style={styles.rewardValue}>{appState.rewards.coins}</Text>
            <Text style={styles.rewardLabel}>🪙 Coins</Text>
          </View>
          <View style={styles.rewardItem}>
            <Text style={styles.rewardValue}>{appState.rewards.todayFocusMinutes}m</Text>
            <Text style={styles.rewardLabel}>⏱ Today</Text>
          </View>
        </View>

        {/* Timer card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Focus Session</Text>

          {!sessionActive ? (
            <>
              <Text style={styles.label}>Target duration (minutes)</Text>
              <View style={styles.durationRow}>
                {[1, 15, 25, 45, 60, 90].map(m => (
                  <TouchableOpacity
                    key={m}
                    onPress={() => setTargetMinutes(m)}
                    style={[styles.durationBtn, targetMinutes === m && styles.durationBtnActive]}
                  >
                    <Text style={[styles.durationBtnText, targetMinutes === m && styles.durationBtnTextActive]}>
                      {m}m
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={styles.primaryBtn} onPress={handleStartSession}>
                <Text style={styles.primaryBtnText}>▶ Start Session</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.timerDisplay}>{fmtTime(remaining)}</Text>
              <Text style={styles.timerSub}>remaining of {targetMinutes}m</Text>
              <ProgressBar value={progress} />
              <TouchableOpacity
                style={styles.dangerBtn}
                onPress={() => handleSessionFail('give_up')}
              >
                <Text style={styles.dangerBtnText}>Give Up</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Recent sessions */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recent Sessions</Text>
          {recentSessions.length === 0 && (
            <Text style={styles.emptyText}>No sessions yet — start one above!</Text>
          )}
          {recentSessions.map(s => (
            <View key={s.id} style={styles.sessionRow}>
              <View style={[styles.sessionDot, { backgroundColor: s.status === 'completed' ? COLORS.success : COLORS.danger }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.sessionLabel}>
                  {s.targetMinutes}m · {s.status === 'completed' ? 'Completed' : `Failed (${s.failReason})`}
                </Text>
                <Text style={styles.sessionMeta}>
                  {new Date(s.startedAt).toLocaleString()} {s.synced ? '✓ synced' : '⏳ pending sync'}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    );
  };

  // ── Syllabus Tab ──────────────────────────────────────────────────────────

  const renderSyllabusTab = () => {
    return (
      <ScrollView style={styles.tabContent}>
        {appState.subjects.map(subject => {
          const subProgress = calcSubjectProgress(appState.tasks, subject.id, appState.chapters);
          const subChapters = appState.chapters.filter(c => c.subjectId === subject.id);

          return (
            <View key={subject.id} style={styles.card}>
              <View style={styles.subjectHeader}>
                <Text style={styles.cardTitle}>{subject.title}</Text>
                <Text style={[styles.pctLabel, { color: progressColor(subProgress) }]}>{pct(subProgress)}</Text>
              </View>
              <ProgressBar value={subProgress} />

              {subChapters.map(chapter => {
                const chProgress = calcProgress(appState.tasks, chapter.id);
                const chapterTasks = appState.tasks.filter(
                  t => t.chapterId === chapter.id && !t.deleted
                );

                return (
                  <View key={chapter.id} style={styles.chapterBlock}>
                    <View style={styles.chapterHeader}>
                      <Text style={styles.chapterTitle}>{chapter.title}</Text>
                      <Text style={[styles.pctLabel, { color: progressColor(chProgress), fontSize: 12 }]}>
                        {pct(chProgress)}
                      </Text>
                    </View>
                    <ProgressBar value={chProgress} />

                    {chapterTasks.map(task => (
                      <View key={task.id} style={styles.taskRow}>
                        <TouchableOpacity
                          style={[styles.taskStatus, { borderColor: statusColor[task.status] }]}
                          onPress={() => updateTaskStatus(task.id, cycleStatus(task.status))}
                        >
                          <Text style={[styles.taskStatusText, { color: statusColor[task.status] }]}>
                            {statusLabel[task.status]}
                          </Text>
                        </TouchableOpacity>
                        <Text style={styles.taskTitle}>{task.title}</Text>
                        <TouchableOpacity
                          style={styles.deleteBtn}
                          onPress={() => deleteTask(task.id)}
                        >
                          <Text style={styles.deleteBtnText}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    ))}

                    {chapterTasks.length === 0 && (
                      <Text style={styles.emptyText}>All tasks removed</Text>
                    )}
                  </View>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
    );
  };

  // ── Dev Panel ─────────────────────────────────────────────────────────────

  const renderDevPanel = () => (
    <ScrollView style={styles.tabContent}>
      {/* Network Toggle */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🔧 Dev Controls</Text>

        <View style={styles.devRow}>
          <Text style={styles.label}>Network:</Text>
          <TouchableOpacity
            style={[styles.toggleBtn, { backgroundColor: isOnline ? COLORS.success : COLORS.danger }]}
            onPress={() => setIsOnline(!isOnline)}
          >
            <Text style={styles.toggleBtnText}>{isOnline ? '🟢 Online' : '🔴 Offline'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={doSync} disabled={!isOnline}>
          <Text style={styles.primaryBtnText}>⟳ Force Sync Now</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryBtn} onPress={refreshNotifications}>
          <Text style={styles.secondaryBtnText}>⟳ Refresh Notifications</Text>
        </TouchableOpacity>

        <Text style={styles.lastSync}>{lastSyncResult}</Text>
      </View>

      {/* Local State */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>📱 This Device ({deviceId})</Text>
        <Text style={styles.devInfo}>Lamport Clock: {appState.lamport}</Text>
        <Text style={styles.devInfo}>Pending Sessions: {appState.pendingSessions.length}</Text>
        <Text style={styles.devInfo}>Pending Task Ops: {appState.pendingTaskOps.length}</Text>
        <Text style={styles.devInfo}>Total Sessions: {appState.sessions.length}</Text>
        <Text style={styles.devInfo}>Total Tasks (active): {appState.tasks.filter(t => !t.deleted).length}</Text>
        <Text style={styles.devInfo}>Coins: {appState.rewards.coins} | Streak: {appState.rewards.streak} | Today: {appState.rewards.todayFocusMinutes}m</Text>
      </View>

      {/* Server State */}
      {serverState && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🖥 Server State</Text>
          <Text style={styles.devInfo}>Lamport: {serverState.lamport}</Text>
          <Text style={styles.devInfo}>Sessions: {serverState.sessions?.length ?? 0}</Text>
          <Text style={styles.devInfo}>Tasks (active): {serverState.tasks?.filter((t: Task) => !t.deleted).length ?? 0}</Text>
          <Text style={styles.devInfo}>
            Coins: {serverState.rewards?.coins} | Streak: {serverState.rewards?.streak} | Today: {serverState.rewards?.todayFocusMinutes}m
          </Text>
        </View>
      )}

      {/* N8N Notifications */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>📲 N8N Notifications ({notifications.length})</Text>
        {notifications.length === 0 && (
          <Text style={styles.emptyText}>No notifications fired yet</Text>
        )}
        {[...notifications].reverse().map((n, i) => (
          <View key={i} style={styles.notifRow}>
            <Text style={styles.notifText}>
              🔔 {n.receivedAt?.slice(11, 19)} — Session {n.payload?.sessionId?.slice(0, 8)}… | Streak {n.payload?.streak} | +{n.payload?.coinsEarned} coins
            </Text>
          </View>
        ))}
      </View>

      {/* Sync Log */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>📋 Sync Log</Text>
        {syncLog.slice(0, 20).map((entry, i) => (
          <Text key={i} style={styles.logEntry}>{entry}</Text>
        ))}
      </View>

      {/* Conflict Scenarios - One Click Triggers */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>⚡ Conflict Scenario Triggers</Text>
        <Text style={styles.devInfo}>
          These buttons simulate offline conflict scenarios on THIS device. Run both devices offline, trigger on each, then sync.
        </Text>

        <TouchableOpacity
          style={styles.scenarioBtn}
          onPress={() => {
            // Set task t1 → done on this device (offline conflict trigger)
            updateTaskStatus('t1', 'done');
            addLog(`[SCENARIO] Set t1=done on ${deviceId} (lamport ${appState.lamport + 1})`);
          }}
        >
          <Text style={styles.scenarioBtnText}>📝 Set "Linear equations" → Done</Text>
          <Text style={styles.scenarioBtnSub}>Use on Device A for conflict with Device B</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.scenarioBtn}
          onPress={() => {
            updateTaskStatus('t1', 'in_progress');
            addLog(`[SCENARIO] Set t1=in_progress on ${deviceId} (lamport ${appState.lamport + 1})`);
          }}
        >
          <Text style={styles.scenarioBtnText}>📝 Set "Linear equations" → In Progress</Text>
          <Text style={styles.scenarioBtnSub}>Use on Device B for conflict with Device A</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.scenarioBtn}
          onPress={() => {
            deleteTask('t2');
            addLog(`[SCENARIO] Deleted t2 on ${deviceId}`);
          }}
        >
          <Text style={styles.scenarioBtnText}>🗑 Delete "Quadratic equations"</Text>
          <Text style={styles.scenarioBtnSub}>While other device edits it → delete wins</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.scenarioBtn, { borderColor: COLORS.accent }]}
          onPress={() => {
            // Inject a completed session directly (simulates completing one offline)
            const id = `offline-session-${deviceId}-${Date.now()}`;
            const now = Date.now();
            setAppState(s => {
              const session: FocusSession = {
                id,
                studentId: STUDENT_ID,
                targetMinutes: 1,
                startedAt: now - 60000,
                status: 'completed',
                completedAt: now,
                synced: false,
              };
              const withRewards = applyLocalRewards(s, session);
              return {
                ...withRewards,
                sessions: [...s.sessions, session],
                pendingSessions: [...s.pendingSessions, session],
              };
            });
            addLog(`[SCENARIO] Injected offline session ${id.slice(0, 20)}…`);
          }}
        >
          <Text style={[styles.scenarioBtnText, { color: COLORS.accentLight }]}>⏱ Inject Offline Session (1m)</Text>
          <Text style={styles.scenarioBtnSub}>Adds a completed session to pending queue</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.scenarioBtn, { borderColor: COLORS.danger }]}
          onPress={() => {
            storageRef.current.clear();
            if (Platform.OS === 'web') window.location.reload();
          }}
        >
          <Text style={[styles.scenarioBtnText, { color: COLORS.danger }]}>🔄 Reset This Device</Text>
          <Text style={styles.scenarioBtnSub}>Clears localStorage and reloads</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.logo}>Alcovia</Text>
          <Text style={styles.deviceTag}>{deviceId}</Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: isOnline ? COLORS.online : COLORS.offline }]} />
        <Text style={[styles.statusText, { color: isOnline ? COLORS.online : COLORS.offline }]}>
          {isOnline ? 'Online' : 'Offline'}
        </Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {(['focus', 'syllabus', 'dev'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'focus' ? '⏱ Focus' : tab === 'syllabus' ? '📚 Syllabus' : '🔧 Dev'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      {activeTab === 'focus' && renderFocusTab()}
      {activeTab === 'syllabus' && renderSyllabusTab()}
      {activeTab === 'dev' && renderDevPanel()}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg, minHeight: '100vh' as any },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { fontSize: 20, fontWeight: '800', color: COLORS.accentLight, letterSpacing: 0.5 },
  deviceTag: {
    fontSize: 11, color: COLORS.textMuted, backgroundColor: COLORS.card,
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusText: { fontSize: 12, fontWeight: '600' },

  tabs: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: COLORS.accent },
  tabText: { fontSize: 13, color: COLORS.textMuted, fontWeight: '500' },
  tabTextActive: { color: COLORS.accentLight, fontWeight: '700' },

  tabContent: { flex: 1, padding: 16 },

  card: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text, marginBottom: 14 },

  rewardsBanner: {
    flexDirection: 'row',
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    justifyContent: 'space-around',
  },
  rewardItem: { alignItems: 'center' },
  rewardValue: { fontSize: 26, fontWeight: '800', color: COLORS.accentLight },
  rewardLabel: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },

  label: { fontSize: 13, color: COLORS.textMuted, marginBottom: 10 },
  durationRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 18 },
  durationBtn: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 8, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  durationBtnActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  durationBtnText: { fontSize: 13, color: COLORS.textMuted },
  durationBtnTextActive: { color: '#fff', fontWeight: '700' },

  primaryBtn: {
    backgroundColor: COLORS.accent, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', marginTop: 4,
  },
  primaryBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },

  dangerBtn: {
    backgroundColor: COLORS.danger, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', marginTop: 18,
  },
  dangerBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },

  secondaryBtn: {
    backgroundColor: COLORS.surface, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', marginTop: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  secondaryBtnText: { fontSize: 14, color: COLORS.textMuted },

  timerDisplay: {
    fontSize: 64, fontWeight: '800', color: COLORS.text,
    textAlign: 'center', fontVariant: ['tabular-nums'] as any,
    letterSpacing: 2, marginTop: 8,
  },
  timerSub: { fontSize: 13, color: COLORS.textMuted, textAlign: 'center', marginBottom: 14 },

  progressBg: { height: 6, backgroundColor: COLORS.surface, borderRadius: 3, marginBottom: 8, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },

  sessionRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
  sessionDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  sessionLabel: { fontSize: 13, color: COLORS.text },
  sessionMeta: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },

  // Syllabus
  subjectHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  pctLabel: { fontSize: 14, fontWeight: '700' },
  chapterBlock: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: COLORS.border },
  chapterHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  chapterTitle: { fontSize: 13, color: COLORS.text, fontWeight: '600' },

  taskRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 },
  taskStatus: {
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
    minWidth: 100,
  },
  taskStatusText: { fontSize: 11, fontWeight: '600' },
  taskTitle: { flex: 1, fontSize: 13, color: COLORS.text },
  deleteBtn: { padding: 4 },
  deleteBtnText: { fontSize: 13, color: COLORS.textMuted },

  emptyText: { fontSize: 13, color: COLORS.textMuted, fontStyle: 'italic', textAlign: 'center', padding: 8 },

  // Dev
  devRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  toggleBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  toggleBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  lastSync: { fontSize: 12, color: COLORS.textMuted, marginTop: 10 },
  devInfo: { fontSize: 12, color: COLORS.textMuted, marginBottom: 6, lineHeight: 20 },
  notifRow: {
    backgroundColor: COLORS.surface, borderRadius: 8, padding: 10, marginBottom: 6,
    borderLeftWidth: 3, borderLeftColor: COLORS.success,
  },
  notifText: { fontSize: 12, color: COLORS.text },
  logEntry: { fontSize: 11, color: COLORS.textMuted, marginBottom: 3, fontFamily: 'monospace' as any },

  // Scenario buttons
  scenarioBtn: {
    backgroundColor: COLORS.surface, borderRadius: 10,
    padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  scenarioBtnText: { fontSize: 13, color: COLORS.text, fontWeight: '600' },
  scenarioBtnSub: { fontSize: 11, color: COLORS.textMuted, marginTop: 3 },
});
