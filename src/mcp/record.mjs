// Which model is at work in a conversation, read from the client's own record of
// it on this machine (one JSON object per line):
//
//   claude  <~/.claude>/projects/<project>/<session id>.jsonl
//           every assistant entry names the model that wrote it;
//   codex   <CODEX_HOME or ~/.codex>/sessions/**/rollout-<time>-<thread id>.jsonl
//           every turn context names the model of that turn.
//
// Only the model name and the time of the entry are taken; nothing else of the
// conversation is kept, and nothing leaves this machine.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// How much of the end of a record is read unless the caller allows more, and in
// pieces of what size.
const RECORD_TAIL_BYTES = 4 * 1024 * 1024;
const PIECE_BYTES = 4 * 1024 * 1024;

/**
 * {model, since} for the record at `path`, read from its end backwards, at most
 * `maxBytes` of it. `since` is set only when what was read shows another model
 * before the present one: the time of the first entry of the present one.
 * Nothing is known, and nothing fails, when there is no such record: {}.
 */
export function recordedModel(path, { maxBytes = RECORD_TAIL_BYTES } = {}) {
  if (typeof path !== 'string' || path === '') {
    return {};
  }
  let file;
  let end;
  try {
    end = statSync(path).size;
    file = openSync(path, 'r');
  } catch {
    return {};
  }
  let model;
  let since;
  try {
    // The beginning of the piece read before this one: the rest of a line that starts in this one.
    let carry = Buffer.alloc(0);
    for (let read = 0; end > 0 && read < maxBytes; ) {
      const length = Math.min(end, PIECE_BYTES);
      const piece = Buffer.alloc(length);
      readSync(file, piece, 0, length, end - length);
      end -= length;
      read += length;
      let whole = Buffer.concat([piece, carry]);
      if (end > 0) {
        // Its first line began earlier: it waits for the piece before.
        const first = whole.indexOf(0x0a);
        if (first === -1) {
          carry = whole;
          continue;
        }
        carry = whole.subarray(0, first);
        whole = whole.subarray(first + 1);
      }
      const lines = whole.toString('utf8').split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        // Inside a quoted text the quotes are escaped, so this only meets a real field.
        if (!lines[index].includes('"model":"')) {
          continue;
        }
        let entry;
        try {
          entry = JSON.parse(lines[index]);
        } catch {
          continue;
        }
        const found = entry?.type === 'assistant' ? entry.message?.model : entry?.type === 'turn_context' ? entry.payload?.model : undefined;
        if (typeof found !== 'string' || found === '' || found.startsWith('<')) {
          continue;
        }
        if (model === undefined) {
          model = found.slice(0, 250);
        }
        if (found.slice(0, 250) !== model) {
          // Another model before this point: the present one began with the entry met last.
          return since === undefined ? { model } : { model, since };
        }
        since = typeof entry.timestamp === 'string' ? entry.timestamp.slice(0, 40) : undefined;
      }
    }
  } catch {
    // Unreadable half way: what was learnt so far stands, without a bound.
  } finally {
    closeSync(file);
  }
  return model === undefined ? {} : { model };
}

/**
 * Where a client keeps the record of one of its conversations, or undefined.
 * `index` is a Map the caller keeps between calls: Codex files are found by
 * walking its folders once, and again only for a thread that is not in it.
 */
export function recordPath(client, clientSession, { env = process.env, index = new Map() } = {}) {
  if (typeof clientSession !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(clientSession)) {
    return undefined;
  }
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  if (client === 'claude') {
    const projects = join(env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : join(home, '.claude'), 'projects');
    try {
      for (const entry of readdirSync(projects, { withFileTypes: true })) {
        const path = join(projects, entry.name, `${clientSession}.jsonl`);
        if (entry.isDirectory() && existsSync(path)) {
          return path;
        }
      }
    } catch {
      // No such folder: nothing is known.
    }
    return undefined;
  }
  if (client === 'codex') {
    const key = `codex:${clientSession}`;
    if (!index.has(key)) {
      const sessions = join(env.CODEX_HOME && env.CODEX_HOME !== '' ? env.CODEX_HOME : join(home, '.codex'), 'sessions');
      const walk = (directory) => {
        let entries;
        try {
          entries = readdirSync(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) {
            walk(join(directory, entry.name));
            continue;
          }
          // rollout-2026-01-02T03-04-05-<thread id>.jsonl
          const named = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(entry.name);
          if (named !== null) {
            index.set(`codex:${named[1]}`, join(directory, entry.name));
          }
        }
      };
      walk(sessions);
    }
    return index.get(key);
  }
  return undefined;
}
