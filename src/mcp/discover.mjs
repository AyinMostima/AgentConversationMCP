// Makes the conversations a client keeps on disk known as windows, so that one
// that has not done anything since the service runs can still be addressed and
// woken by name. Without this a window only exists once its conversation ran a
// hook or called a tool.
//
//   codex   <CODEX_HOME or ~/.codex>/sessions/**/rollout-*.jsonl
//           one file per thread; its first line says which thread it is, where
//           it works and whether it is a sub-agent or a command-line run.
//           session_index.jsonl holds the titles the app shows.
//
// Only what is needed to address a thread is read: its id, title, directory and
// when it was last written. Nothing of a conversation's content is read, and
// nothing leaves this machine. Threads of the app itself count; its sub-agents
// and "codex exec" runs do not.
//
//   antigravity  <~/.gemini>/antigravity/conversation_summaries.db
//           the app's own list of conversations: id, title, workspaces and when
//           each was last changed. Read with node:sqlite where this Node has it.
//
// The title a client shows goes along as the window's title, also for windows
// that are known already: with it a coordinating session can tell by itself
// which window a request is for.
//
// Claude needs none of this: its conversations become windows through its hooks.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY_MS = 24 * 3600 * 1000;
const FIRST_LINE_LIMIT = 4 * 1024 * 1024;

/** The first line of a file, without reading the rest; undefined when there is none within the limit. */
function firstLine(file) {
  const handle = openSync(file, 'r');
  try {
    const chunks = [];
    const buffer = Buffer.alloc(65536);
    let total = 0;
    while (total < FIRST_LINE_LIMIT) {
      const read = readSync(handle, buffer, 0, buffer.length, total);
      if (read === 0) {
        break;
      }
      const end = buffer.subarray(0, read).indexOf(0x0a);
      if (end !== -1) {
        chunks.push(Buffer.from(buffer.subarray(0, end)));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      total += read;
    }
    return undefined;
  } finally {
    closeSync(handle);
  }
}

/**
 * The threads of the Codex app that were written to since `sinceMs`, as
 * {windows: [{client_session, name, cwd, seen_at}], notWindows: [id]}: its own
 * conversations, and the ids of those that are none (sub-agents, command-line
 * runs). `known` remembers what a file said about its thread (that never
 * changes), so a later call only looks at times.
 */
export function codexThreads({ env = process.env, sinceMs = Date.now() - DAY_MS, now = Date.now(), known = new Map() } = {}) {
  const home = env.CODEX_HOME && env.CODEX_HOME !== '' ? env.CODEX_HOME : join(env.USERPROFILE ?? homedir(), '.codex');
  const titles = new Map();
  try {
    for (const line of readFileSync(join(home, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (typeof entry.id === 'string' && typeof entry.thread_name === 'string') {
          // Later lines replace earlier ones: a thread can be renamed.
          titles.set(entry.id, entry.thread_name);
        }
      } catch {
        // A line that is being written this moment.
      }
    }
  } catch {
    // No index: the threads are still found, without titles.
  }

  const found = [];
  const others = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/^rollout-.*\.jsonl$/.test(entry.name)) {
        continue;
      }
      let written;
      try {
        written = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (written < sinceMs) {
        continue;
      }
      if (!known.has(path)) {
        let meta;
        try {
          meta = JSON.parse(firstLine(path) ?? 'null')?.payload;
        } catch {
          meta = undefined;
        }
        // A sub-agent names its parent and has a structured source; a command-line run says "exec".
        const own = meta !== undefined && meta !== null && typeof meta.id === 'string' && typeof meta.source === 'string' && meta.source !== 'exec' && !meta.parent_thread_id && meta.originator !== 'codex_exec';
        known.set(path, { own, id: typeof meta?.id === 'string' ? meta.id : undefined, cwd: typeof meta?.cwd === 'string' ? meta.cwd : undefined });
      }
      const thread = known.get(path);
      if (thread.own) {
        found.push({ client_session: thread.id, title: titles.get(thread.id), cwd: thread.cwd, seen_at: new Date(Math.min(written, now)).toISOString() });
      } else if (thread.id !== undefined) {
        others.push(thread.id);
      }
    }
  };
  walk(join(home, 'sessions'));
  return { windows: found, notWindows: others };
}

/**
 * The conversations of the Antigravity app that changed since `sinceMs`, as
 * {windows, notWindows} like codexThreads: its own conversations, and the ids of
 * those that belong to another one (sub-agents). Conversations of its command
 * line are left out. Empty when the app's list is
 * not there or this Node cannot read it.
 */
export async function antigravityConversations({ env = process.env, sinceMs = Date.now() - DAY_MS, now = Date.now() } = {}) {
  const file = join(env.ACM_ANTIGRAVITY_HOME ?? join(env.USERPROFILE ?? homedir(), '.gemini', 'antigravity'), 'conversation_summaries.db');
  const windows = [];
  const notWindows = [];
  let database;
  try {
    statSync(file);
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(file, { readOnly: true });
    const rows = database.prepare('SELECT conversation_id, title, last_modified_time, workspace_uris, parent_conversation_id, source FROM conversation_summaries').all();
    for (const row of rows) {
      // "2026-11-20 19:04:45.8128012+00:00"
      const changed = Date.parse(String(row.last_modified_time ?? '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
      if (!Number.isFinite(changed) || changed < sinceMs || typeof row.conversation_id !== 'string') {
        continue;
      }
      // Conversations of its command line are listed here too: runs from a shell, and the
      // stand-ins this service starts. Neither is a conversation of the desktop app.
      if (typeof row.source === 'string' && row.source.includes('CLI')) {
        continue;
      }
      if (typeof row.parent_conversation_id === 'string' && row.parent_conversation_id !== '') {
        notWindows.push(row.conversation_id);
        continue;
      }
      let cwd;
      try {
        const first = JSON.parse(row.workspace_uris ?? '[]')[0];
        // "file:///f%3A/work/dir" -> "f:\work\dir"
        cwd = typeof first === 'string' && first.startsWith('file:///') ? decodeURIComponent(first.slice('file:///'.length)).replaceAll('/', '\\') : undefined;
      } catch {
        cwd = undefined;
      }
      const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : undefined;
      windows.push({ client_session: row.conversation_id, title, cwd, seen_at: new Date(Math.min(changed, now)).toISOString() });
    }
  } catch {
    // No such list, or no sqlite in this Node: Antigravity's windows still come from its hooks.
  } finally {
    try {
      database?.close();
    } catch {
      // Already closed.
    }
  }
  return { windows, notWindows };
}

/**
 * Starts the periodic look. `adminToken()` returns the operator credential of
 * the local service; `say(line)` receives one-line diagnostics. Returns a
 * function that stops it.
 */
export function startDiscovery({ coreUrl, adminToken, intervalMs = 60000, say, env = process.env }) {
  const known = new Map();
  let busy = false;
  let lastProblem = '';

  async function round() {
    if (busy) {
      return;
    }
    busy = true;
    try {
      const records = { codex: codexThreads({ env, known }), antigravity: await antigravityConversations({ env }) };
      for (const [client, { windows, notWindows }] of Object.entries(records)) {
        if (windows.length === 0 && notWindows.length === 0) {
          continue;
        }
        const response = await fetch(`${coreUrl}/api/v1/windows/import`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-acm-admin-token': adminToken() },
          body: JSON.stringify({ client, windows, not_windows: notWindows }),
        });
        const envelope = await response.json();
        if (!envelope.ok) {
          throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
        }
        if (envelope.result.added > 0) {
          say(`${envelope.result.added} ${client} conversation(s) from its own record are now windows`);
        }
        if (envelope.result.retired > 0) {
          say(`${envelope.result.retired} ${client} sub-agent conversation(s) are no longer listed as windows`);
        }
      }
      lastProblem = '';
    } catch (error) {
      if (error.message !== lastProblem) {
        lastProblem = error.message;
        say(`looking for conversations on the clients' records failed: ${error.message}`);
      }
    } finally {
      busy = false;
    }
  }

  const first = setTimeout(() => void round(), Math.min(5000, intervalMs));
  first.unref();
  const timer = setInterval(() => void round(), intervalMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
