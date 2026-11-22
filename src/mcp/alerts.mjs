// Tells the person at this machine when something stopped working, so that the
// routes between the AI sessions need no attention as long as nothing is said.
//
// What counts as a problem (see findProblems):
//   - the signal that triggers a session from outside (its wake hook) was
//     refused, or never arrived at the other side;
//   - the signal was accepted, yet the session did not come for the work that
//     waits for it;
//   - work waits for a session that hosts bots, it is not listening, and
//     nothing is set up to trigger it;
//   - handing an urgent message to a client's own command failed.
//
// A signal that the network swallowed is not a problem yet: it is retried by
// itself (see src/core/wake.hpp), so it is announced only when nothing has got
// through for LOST_FOR_MS. A refusal by the other side is announced at once.
//
// Each problem is announced once when it appears and again after
// REMIND_AFTER_MS while it lasts. A problem that went away and comes back is
// announced again. The announcement is a notification of the operating system
// plus one line in <data>/logs/alerts.log. The operator can switch the
// notifications off in the console (settings.alerts_enabled); the log is kept.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REMIND_AFTER_MS = 3 * 60 * 60 * 1000;
const LOST_FOR_MS = 5 * 60 * 1000;
const SILENT_AFTER_MS = 3 * 60 * 1000;
const UNATTENDED_AFTER_MS = 5 * 60 * 1000;
const LISTENING_MS = 2 * 60 * 1000;

/** The status code of a refusal, or undefined when the signal never got an answer. */
const statusOf = (detail) => /^HTTP (\d+)/.exec(detail ?? '')?.[1];

/** Maps a webhook HTTP status or network error to a concise diagnostic message. */
function refusal(detail) {
  const code = statusOf(detail);
  if (code === '401' || code === '403') return 'Invalid or rotated webhook key. Re-register the auto-trigger key.';
  if (code === '404' || code === '410') return 'Webhook URL is invalid or expired. Recreate or re-copy the routine URL.';
  if (code === '429') return 'Webhook endpoint is rate-limited. Retrying automatically.';
  if (code !== undefined) return `Webhook endpoint returned HTTP ${code}.`;
  return `Unreachable for ${LOST_FOR_MS / 60000} minutes; retrying automatically (${(detail ?? 'unknown error').slice(0, 80)}). Check network or proxy settings.`;
}

/**
 * Finds active route problems from a bootstrap snapshot.
 * Each problem carries a stable key for deduplication across polling rounds.
 */
export function findProblems(state, now = Date.now()) {
  const problems = [];
  const age = (iso) => (iso === null || iso === undefined ? Number.POSITIVE_INFINITY : now - new Date(iso).getTime());
  const name = (session) => {
    const agent = state.agents.find((entry) => entry.agent_id === session.agent_id);
    return `${agent?.display_name ?? session.agent_id} (${session.label})`;
  };
  for (const session of state.sessions.filter((entry) => entry.status === 'active')) {
    const waiting = state.bot_requests.filter((entry) => entry.host.session_id === session.session_id && entry.status === 'queued');
    const hook = state.wake_hooks.find((entry) => entry.session_id === session.session_id && entry.enabled);
    if (hook !== undefined && hook.last_status === 'failed') {
      // Key by failure class so varying network error strings stay deduplicated.
      const code = statusOf(hook.last_detail);
      if (code !== undefined) {
        problems.push({ key: `wake-failed:${session.session_id}:${code}`, title: `AGORA: Wake trigger refused for ${name(session)}`, text: refusal(hook.last_detail) });
      } else if (age(hook.last_ok_at) > LOST_FOR_MS && age(hook.last_attempt_at) < 2 * LOST_FOR_MS) {
        problems.push({ key: `wake-lost:${session.session_id}`, title: `AGORA: Wake trigger unreachable for ${name(session)}`, text: refusal(hook.last_detail) });
      }
    } else if (hook !== undefined && hook.last_status === 'ok' && waiting.length > 0 && age(hook.last_ok_at) > SILENT_AFTER_MS && (session.host_seen_at === null || session.host_seen_at < hook.last_ok_at)) {
      problems.push({ key: `wake-silent:${session.session_id}`, title: `AGORA: ${name(session)} did not pull queued work`, text: `The wake signal succeeded, while ${waiting.length} request(s) remain queued. Check that the client app is running and connected to this machine.` });
    } else if (hook === undefined && waiting.length > 0 && age(session.host_seen_at) > LISTENING_MS && Math.max(...waiting.map((entry) => age(entry.created_at))) > UNATTENDED_AFTER_MS) {
      problems.push({ key: `no-trigger:${session.session_id}`, title: `AGORA: ${waiting.length} queued bot request(s) waiting`, text: `${name(session)} is offline with no wake hook configured. Run the auto-trigger setup prompt once.` });
    }
    const delivery = (state.client_hooks ?? []).find((entry) => entry.session_id === session.session_id)?.last_urgent;
    if (session.urgent_dispatch && delivery?.route === 'command' && delivery.status === 'failed') {
      problems.push({ key: `dispatch-failed:${session.session_id}:${delivery.at}`, title: `AGORA: Urgent delivery failed for ${name(session)}`, text: `${delivery.detail ?? 'Unknown error'}. The message stays unread for the next turn.` });
    }
  }
  for (const [client, mark] of Object.entries(state.client_limits ?? {})) {
    if (mark && typeof mark.until === 'string' && Date.parse(mark.until) > now) {
      const detail = mark.detail ? ` Vendor message: ${String(mark.detail).slice(0, 140)}` : '';
      problems.push({
        key: `client-quota:${client}:${mark.until}`,
        title: `AGORA: Usage quota exhausted for ${client}`,
        text: `Idle dispatch paused until ${mark.until}. Messages remain unread.${detail}`,
      });
    }
  }
  return problems;
}

/** A notification of the operating system. On Windows: a balloon from the notification area. */
export function systemNotification({ title, text }) {
  if (process.platform !== 'win32') {
    return;
  }
  const quoted = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$icon = New-Object System.Windows.Forms.NotifyIcon',
    '$icon.Icon = [System.Drawing.SystemIcons]::Warning',
    '$icon.Visible = $true',
    `$icon.ShowBalloonTip(20000, ${quoted(title)}, ${quoted(text)}, 'Warning')`,
    'Start-Sleep -Seconds 21',
    '$icon.Dispose()',
  ].join('; ');
  // The script travels as UTF-16 so that no code page touches the text.
  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Starts the periodic check. `adminToken()` returns the operator credential of
 * the local service; `say(line)` receives one-line diagnostics. ACM_ALERT_COMMAND
 * (JSON array, e.g. ["node","stand-in.mjs"]) replaces the system notification;
 * title and text are appended as two arguments. Returns a function that stops it.
 */
export function startAlerts({ coreUrl, adminToken, dataDir, intervalMs = 30000, say, env = process.env }) {
  const announced = new Map();
  let busy = false;
  const standIn = env.ACM_ALERT_COMMAND ? JSON.parse(env.ACM_ALERT_COMMAND) : undefined;
  const notify = (problem) => {
    if (standIn === undefined) {
      systemNotification(problem);
      return;
    }
    const child = spawn(standIn[0], [...standIn.slice(1), problem.title, problem.text], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
  };

  async function round() {
    if (busy) {
      return;
    }
    busy = true;
    try {
      const response = await fetch(`${coreUrl}/api/v1/bootstrap`, { headers: { 'x-acm-admin-token': adminToken() } });
      const envelope = await response.json();
      if (!envelope.ok) {
        return;
      }
      const problems = findProblems(envelope.result);
      const present = new Set(problems.map((problem) => problem.key));
      for (const key of [...announced.keys()]) {
        if (!present.has(key)) {
          announced.delete(key);
        }
      }
      for (const problem of problems) {
        const last = announced.get(problem.key);
        if (last !== undefined && Date.now() - last < REMIND_AFTER_MS) {
          continue;
        }
        announced.set(problem.key, Date.now());
        try {
          mkdirSync(join(dataDir, 'logs'), { recursive: true });
          appendFileSync(join(dataDir, 'logs', 'alerts.log'), `${new Date().toISOString()} ${problem.title}: ${problem.text}\n`);
        } catch {
          // The log is a convenience.
        }
        say(`alert: ${problem.key}`);
        if (envelope.result.settings.alerts_enabled !== false) {
          notify(problem);
        }
      }
    } catch {
      // The service is restarting or stopping; the next round sees it.
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void round(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
