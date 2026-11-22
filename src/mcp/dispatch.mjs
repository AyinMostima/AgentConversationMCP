// Delivers urgent messages to a window whose client is idle and cannot be woken
// from inside its conversation, by running that client's own command line.
//
// Each client has an ordered list of routes. A route may be a step: it only
// hands the message on, and the window has to show a sign of life afterwards
// (the control service watches for that and asks for the next step when none
// comes).
//
//   codex        The turn is to run in the Codex desktop app, where its user
//                sees it.
//                step 1  codex queue --thread <id> --message <text>
//                        puts the message in the thread's queue. A thread the
//                        app has open starts on it within seconds.
//                step 2  codex://threads/<id>
//                        when nothing happened: the app is asked to open the
//                        thread (its own link scheme; this starts the app when
//                        it is not running). Opened, the thread takes the
//                        queued message and runs the turn. The app loads one
//                        thread at a time, so such requests are spaced; a
//                        thread that still does not start is asked for once
//                        more.
//                Running the turn from the command line instead
//                (codex exec resume) is off unless ACM_CODEX_CLI=on: such a
//                turn is invisible in the app and holds the thread while it
//                runs.
//                fallback  codex exec [resume <stand-in>] <text>
//                        when Codex says the thread does not exist any more
//                        (deleted, or a helper thread it did not keep): a new
//                        command-line conversation stands in for the window, in
//                        its working directory, and is continued on every later
//                        wake. Without it such a window could not be reached at all.
//
//   antigravity  agy [--conversation <id>] --print <text>
//                Antigravity's command line keeps its conversations apart from
//                the desktop app's and cannot open those. A window that is a
//                command-line conversation is resumed as itself. For a desktop
//                conversation a stand-in is started: one command-line
//                conversation per window, in that window's working directory,
//                continued on every later wake. The stand-in is told what it is;
//                the desktop conversation still gets the message with its next
//                prompt.
//
// Claude needs none: its watcher hook wakes the model inside the conversation
// (see hook.mjs).
//
// The control service decides when a delivery is due (see src/core/delivery.hpp);
// this module runs the commands and reports how it ended. The id of the
// conversation comes from that client's own hook, so a client that never ran a
// hook is never started from here.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { TOOLS } from './tools.mjs';

const QUICK_TIMEOUT_MS = 120000;
// A command that runs a whole turn counts as handed over once it has run this
// long without failing; it then goes on by itself for at most TURN_LIMIT_MS.
const GRACE_MS = 10000;
const TURN_LIMIT_MS = 30 * 60 * 1000;
// What a vendor's command says when the conversation it was given does not exist.
const GONE = /no rollout found|thread not found|unknown thread|session not found|trajectory not found/i;

// How long a window may take to show a sign of life after each step for Codex.
const QUEUE_PATIENCE_SECONDS = 20;
const OPEN_PATIENCE_SECONDS = 120;
// The app opens one thread at a time: asked for two in the same instant it only
// loads the last. So the requests are spaced, and each thread is asked for twice
// before it is given up.
const OPEN_SPACING_MS = 10000;

const STAND_IN_NOTE = (window, why = 'the Antigravity desktop conversation "%s", which is idle and cannot be started from outside') =>
  `[ACM] You were started from the command line as a stand-in for ${why.replace('%s', window)}. ` +
  'You do not have that conversation\'s history: work from this ' +
  'directory and from the request below, and say in your report that the command-line stand-in did the work.\n\n';
const CODEX_GONE = 'the Codex conversation "%s", which Codex no longer has (its thread was deleted or never kept)';
// What a command says about the conversation it used: Antigravity's conversation_id, Codex's thread_id.
const USED = /"(?:conversation_id|thread_id)"\s*:\s*"([0-9a-f-]{8,64})"/i;

/**
 * The routes per client: {name, long, standIn, step, patience, command(job,
 * memory)} where command returns {file, args, env?} or undefined when the route
 * does not apply to that job. `step` says for which step (or steps) of a handing
 * over the route is (job.attempt: how many steps went unanswered so far); a
 * route without one that only hands the message on is for the first step, one
 * that runs the turn itself is for any. `patience` is how many seconds a sign of
 * life may take; `spacingMs`, how far apart two runs of the route are kept. Clients whose command line is not installed are left
 * out. ACM_DISPATCH_BUILTIN=off leaves all of them out (tests). With
 * ACM_DISPATCH_COMMANDS (JSON) a client's routes are replaced:
 *   {"codex": ["node", "stand-in.mjs"]}                       one quick route
 *   {"codex": [["node", "a.mjs"], {"command": ["node", "b.mjs"], "long": true}]}
 *   {"codex": [["node", "a.mjs"], {"command": ["node", "b.mjs"], "step": [1, 2], "patience": 30, "spacing": 5000}]}
 *   {"codex": null}                                           none
 * The conversation id and the text are appended as two arguments.
 */
export function dispatchRoutes(env = process.env) {
  const routes = {};
  if (env.ACM_DISPATCH_BUILTIN !== 'off') {
    const codexEntry = join(env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(codexEntry)) {
      // The npm shim is a .cmd file, which cannot be started without a shell; its target can.
      const thread = (job) => (/^[0-9a-f-]{8,64}$/i.test(job.client_session) ? job.client_session : undefined);
      routes.codex = [
        {
          name: 'codex queue',
          long: false,
          step: 0,
          patience: QUEUE_PATIENCE_SECONDS,
          command: (job) => ({ file: process.execPath, args: [codexEntry, 'queue', '--thread', job.client_session, '--message', job.text] }),
        },
        {
          // The message is in the thread's queue already; the app only has to open the thread.
          name: 'open in Codex desktop',
          long: false,
          step: [1, 2],
          patience: OPEN_PATIENCE_SECONDS,
          spacingMs: OPEN_SPACING_MS,
          // The id is checked to be a plain id above, so nothing else can end up in the command.
          command: (job) => (thread(job) === undefined ? undefined : { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process 'codex://threads/${thread(job)}'`] }),
        },
      ];
      if (env.ACM_CODEX_CLI === 'on') {
        // After the app did not take it either, or when the queue itself refused.
        routes.codex.push({
          name: 'codex exec resume',
          long: true,
          command: (job) => (job.attempt === 1 || job.attempt === 2 ? undefined : { file: process.execPath, args: [codexEntry, 'exec', 'resume', '--skip-git-repo-check', job.client_session, job.text] }),
        });
      }
      // Only once Codex said the thread is gone (see deliver): a new conversation stands in for it.
      routes.codex.push({
        name: 'codex exec (new conversation)',
        long: true,
        standIn: true,
        whenGone: true,
        command: (job, memory) => {
          const known = /^[0-9a-f-]{8,64}$/i.test(memory[job.window_id] ?? '') ? memory[job.window_id] : undefined;
          const text = `${STAND_IN_NOTE(job.window, CODEX_GONE)}${job.text}`;
          // The user's own Codex settings decide what it may do; its hooks stay out of it, as for Antigravity's stand-in.
          return {
            file: process.execPath,
            args: known === undefined ? [codexEntry, 'exec', '--skip-git-repo-check', '--json', text] : [codexEntry, 'exec', 'resume', '--skip-git-repo-check', '--json', known, text],
            env: { ACM_HOOKS: 'off' },
          };
        },
      });
    }
    const agy = join(env.LOCALAPPDATA ?? '', 'agy', 'bin', 'agy.exe');
    if (existsSync(agy)) {
      const store = join(env.USERPROFILE ?? homedir(), '.gemini', 'antigravity-cli', 'conversations');
      const stored = (id) => typeof id === 'string' && /^[0-9a-f-]{8,64}$/i.test(id) && existsSync(join(store, `${id}.db`));
      const print = (conversation, text, extra = []) => [...(conversation === undefined ? [] : ['--conversation', conversation]), ...extra, '--print-timeout', `${TURN_LIMIT_MS / 60000}m`, '--output-format', 'json', '--print', text];
      routes.antigravity = [
        {
          name: 'agy (the conversation itself)',
          long: true,
          command: (job) => (stored(job.client_session) ? { file: agy, args: print(job.client_session, job.text) } : undefined),
        },
        {
          name: 'agy (stand-in)',
          long: true,
          standIn: true,
          command: (job, memory, settingsFile) => {
            const known = stored(memory[job.window_id]) ? memory[job.window_id] : undefined;
            // Nobody is there to confirm a tool call. The stand-in is allowed the acm tools,
            // so that it can read what it was asked and report; everything else stays as
            // the user's own Antigravity permissions have it. For this run only.
            const allowed = settingsFile === undefined ? [] : ['--settings', settingsFile];
            // Its hooks stay out of it: the stand-in is not a window of its own and gets only what is handed to it here.
            return { file: agy, args: print(known, `${STAND_IN_NOTE(job.window)}${job.text}`, allowed), env: { ACM_HOOKS: 'off' } };
          },
        },
      ];
    }
  }
  if (env.ACM_DISPATCH_COMMANDS) {
    const given = (entry) => {
      const words = Array.isArray(entry) ? entry : entry.command;
      return {
        name: words.slice(0, 2).join(' '),
        long: !Array.isArray(entry) && entry.long === true,
        standIn: !Array.isArray(entry) && entry.standIn === true,
        whenGone: !Array.isArray(entry) && entry.whenGone === true,
        step: !Array.isArray(entry) && (Number.isInteger(entry.step) || Array.isArray(entry.step)) ? entry.step : undefined,
        spacingMs: !Array.isArray(entry) && Number.isInteger(entry.spacing) ? entry.spacing : undefined,
        patience: !Array.isArray(entry) && Number.isInteger(entry.patience) ? entry.patience : undefined,
        command: (job) => ({ file: words[0], args: [...words.slice(1), job.client_session, job.text] }),
      };
    };
    for (const [client, value] of Object.entries(JSON.parse(env.ACM_DISPATCH_COMMANDS))) {
      if (value === null) {
        delete routes[client];
      } else {
        routes[client] = Array.isArray(value) && typeof value[0] === 'string' ? [given(value)] : value.map(given);
      }
    }
  }
  return routes;
}

/**
 * "try again at Nov 28th, 2026 12:59 PM" (the user's local time, as Codex writes it) as a Date.
 * Without a time it can read, an hour from `now`.
 */
export function retryTime(text, now = new Date()) {
  const [, when] = /try again (?:at|after) ([A-Z][a-z]{2,8} \d{1,2}(?:st|nd|rd|th)?,? \d{4},? \d{1,2}:\d{2}(?::\d{2})? ?[AP]M)/i.exec(text ?? '') ?? [];
  const parsed = when === undefined ? NaN : Date.parse(when.replace(/(\d)(st|nd|rd|th)/, '$1').replace(/,(?= \d{1,2}:)/, ''));
  return Number.isNaN(parsed) ? new Date(now.getTime() + 3600_000) : new Date(parsed);
}

// What a vendor's command or record says when its quota is used up.
const OUT_OF_QUOTA = /usage_limit_exceeded|hit your usage limit|RESOURCE_EXHAUSTED|exceeded your current quota|quota (?:has been )?exceeded/i;

/**
 * Whether Codex has used up its quota, from its own record of turns: the newest
 * rollout files under ~/.codex/sessions. A turn that ended with
 * usage_limit_exceeded and no turn that ended well after it means it has, until
 * the time it named. Returns {until, detail} or undefined.
 */
export function codexQuota(home = homedir(), now = new Date()) {
  const root = join(home, '.codex', 'sessions');
  const files = [];
  for (let back = 0; back < 14; back += 1) {
    const day = new Date(now.getTime() - back * 86_400_000);
    const dir = join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.jsonl')) {
          const file = join(dir, name);
          files.push({ file, modified: statSync(file).mtimeMs });
        }
      }
    } catch {
      // No turns that day.
    }
  }
  let latest;
  for (const { file } of files.sort((a, b) => b.modified - a.modified).slice(0, 12)) {
    let tail = '';
    try {
      const size = statSync(file).size;
      const handle = openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
        readSync(handle, buffer, 0, buffer.length, size - buffer.length);
        tail = buffer.toString('utf8');
      } finally {
        closeSync(handle);
      }
    } catch {
      continue;
    }
    for (const line of tail.split('\n')) {
      if (!line.includes('"task_complete"')) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(record.timestamp ?? '');
      if (Number.isNaN(at) || (latest !== undefined && at <= latest.at)) {
        continue;
      }
      const error = record.payload?.error;
      latest = { at, exhausted: error?.codex_error_info === 'usage_limit_exceeded' || OUT_OF_QUOTA.test(error?.message ?? ''), message: error?.message ?? '' };
    }
  }
  if (latest === undefined || !latest.exhausted) {
    return undefined;
  }
  const until = retryTime(latest.message, new Date(latest.at));
  return until > now ? { until: until.toISOString(), detail: latest.message.slice(0, 300) } : undefined;
}

/**
 * Runs one command without a shell. A quick one resolves to {ok, detail} when
 * it ends. A long one resolves as soon as it is clear how it started: failed
 * when it ends with an error within `graceMs`, handed over otherwise; it then
 * keeps running, and `ended({code, output})` is called when it is over.
 */
function run({ file, args, env }, cwd, { long, graceMs, started, ended }) {
  return new Promise((done) => {
    let head = '';
    let tail = '';
    const keep = (chunk) => {
      head = head.length < 400 ? `${head}${chunk}`.slice(0, 400) : head;
      tail = `${tail}${chunk}`.slice(-600);
    };
    let child;
    try {
      child = spawn(file, args, {
        cwd: cwd !== null && cwd !== undefined && existsSync(cwd) ? cwd : undefined,
        env: env === undefined ? process.env : { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      done({ ok: false, detail: `could not start: ${error.message}`.slice(0, 300) });
      return;
    }
    started?.(() => child.kill());
    let settled = false;
    const settle = (outcome) => {
      if (!settled) {
        settled = true;
        done(outcome);
      }
    };
    const limit = setTimeout(() => child.kill(), long ? TURN_LIMIT_MS : QUICK_TIMEOUT_MS);
    limit.unref();
    const grace = long ? setTimeout(() => settle({ ok: true, detail: 'started; the turn is running' }), graceMs) : undefined;
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.once('error', (error) => {
      clearTimeout(limit);
      clearTimeout(grace);
      settle({ ok: false, detail: `could not start: ${error.message}`.slice(0, 300) });
      ended?.({ code: null, output: '' });
    });
    child.once('exit', (code) => {
      clearTimeout(limit);
      clearTimeout(grace);
      const said = tail.replace(/\s+/g, ' ').trim();
      const failure = code === null ? `no result within ${(long ? TURN_LIMIT_MS : QUICK_TIMEOUT_MS) / 1000} seconds` : `exit code ${code}${said === '' ? '' : `: ${said.slice(-260)}`}`;
      settle(code === 0 ? { ok: true, detail: said.slice(-200) || undefined } : { ok: false, detail: failure });
      ended?.({ code, output: `${head}\n${tail}`, failure: code === 0 ? undefined : failure });
    });
  });
}

/**
 * Starts the periodic check. `adminToken()` returns the operator credential of
 * the local service; `say(line)` receives one-line diagnostics; `dataDir` is
 * where the stand-in conversations are remembered. Returns a function that
 * stops the check.
 */
/**
 * Whether Antigravity's command line is at work on this machine already, started
 * by whomever. A second one beside it has been seen to fail before its turn
 * began ("plan model not specified"), so a stand-in waits for it to finish.
 */
function agyAtWork() {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    const listed = spawnSync('tasklist', ['/FI', 'IMAGENAME eq agy.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return /"agy\.exe"/i.test(listed.stdout ?? '');
  } catch {
    return false;
  }
}

export function startDispatcher({ coreUrl, adminToken, dataDir, intervalMs = 5000, graceMs = GRACE_MS, say, routes = dispatchRoutes(), commandLineAtWork = agyAtWork, checkCodexQuota = process.env.ACM_DISPATCH_BUILTIN !== 'off' }) {
  let busy = false;
  let lastProblem = '';
  // Windows whose command-line turn is still running: nothing more is started for them
  // meanwhile. With the delivery it belongs to and how to end it.
  const running = new Map();
  // When a route that must not be run in quick succession last ran.
  const lastRun = new Map();
  // Clients of which a stand-in is at work, by window: one at a time per client.
  const standingIn = new Map();

  // Which command-line conversation stands in for which window.
  const memoryFile = dataDir === undefined ? undefined : join(dataDir, 'stand-ins.json');
  let memory = {};
  try {
    memory = memoryFile === undefined ? {} : JSON.parse(readFileSync(memoryFile, 'utf8'));
  } catch {
    memory = {};
  }
  // What a stand-in may do without anyone confirming it: call the acm tools.
  let settingsFile;
  if (dataDir !== undefined) {
    settingsFile = join(dataDir, 'stand-in-settings.json');
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(settingsFile, `${JSON.stringify({ permissions: { allow: TOOLS.map((tool) => `mcp(acm/${tool.name})`) } }, null, 2)}\n`);
    } catch {
      settingsFile = undefined;
    }
  }
  const remember = (windowId, conversation) => {
    if (conversation === undefined) {
      delete memory[windowId];
    } else {
      memory[windowId] = conversation;
    }
    if (memoryFile !== undefined) {
      try {
        mkdirSync(dirname(memoryFile), { recursive: true });
        writeFileSync(memoryFile, `${JSON.stringify(memory, null, 2)}\n`);
      } catch {
        // Kept for this run only.
      }
    }
  };

  async function local(path, body) {
    const response = await fetch(`${coreUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acm-admin-token': adminToken() },
      body: JSON.stringify(body ?? {}),
    });
    const envelope = await response.json();
    if (!envelope.ok) {
      throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    }
    return envelope.result;
  }

  /** Tries the client's routes in order; resolves to what is reported for the job. */
  async function deliver(job) {
    const attempt = Number.isInteger(job.attempt) ? job.attempt : 0;
    let outcome = { ok: false, detail: attempt > 0 ? 'the application did not start this conversation; the message is in its queue and is taken up when the conversation is opened there' : 'no command applies to this conversation' };
    // Whether the client said this conversation does not exist: then only a route meant for that is left.
    let gone = false;
    for (const route of routes[job.client] ?? []) {
      if (route.whenGone === true ? !gone : gone) {
        continue;
      }
      // Each step of a handing over has its route; one that runs the turn itself fits any step.
      const steps = route.step ?? (route.long ? attempt : 0);
      if (!(Array.isArray(steps) ? steps.includes(attempt) : steps === attempt)) {
        continue;
      }
      const command = route.command(job, memory, settingsFile);
      if (command === undefined) {
        continue;
      }
      if (route.standIn && standingIn.has(job.client)) {
        return { ok: false, postponed: true, detail: 'another stand-in of this client is still at work' };
      }
      if (route.standIn) {
        standingIn.set(job.client, job.window_id);
      }
      const resumed = route.standIn && (command.args.includes('--conversation') || command.args.includes('resume'));
      if (route.spacingMs !== undefined) {
        const wait = (lastRun.get(route.name) ?? 0) + route.spacingMs - Date.now();
        if (wait > 0) {
          await new Promise((done) => setTimeout(done, wait));
        }
        lastRun.set(route.name, Date.now());
      }
      // Whether the turn was already reported as under way when it ends.
      let handedOver = false;
      const turn = route.long ? { delivery: job.delivery_id, kill: undefined, name: route.name, window: job.window } : undefined;
      if (turn !== undefined) {
        running.set(job.window_id, turn);
      }
      const result = await run(command, job.cwd, {
        long: route.long,
        graceMs,
        started: (kill) => {
          if (turn !== undefined) {
            turn.kill = kill;
          }
        },
        ended: ({ output, failure }) => {
          if (running.get(job.window_id) === turn) {
            running.delete(job.window_id);
          }
          if (route.standIn) {
            standingIn.delete(job.client);
            // The command says which conversation it used; that one is continued next
            // time, when the turn in it went well. One that failed is not kept.
            const [, conversation] = USED.exec(output) ?? [];
            if (failure !== undefined) {
              if (resumed) {
                remember(job.window_id, undefined);
              }
            } else if (conversation !== undefined) {
              remember(job.window_id, conversation);
            }
          }
          // A turn that ended because the client's quota is used up: nothing more is started for that client.
          if (failure !== undefined) {
            noteQuota(job.client, output);
          }
          if (route.long && failure !== undefined) {
            say(`${route.name} for window ${job.window} ended with ${failure}`);
            if (handedOver) {
              // It had been reported as under way: take that back, so that it is shown and tried again.
              void local('/api/v1/delivery/report', { delivery_id: job.delivery_id, ok: false, late: true, detail: `${route.name}: ${failure}`.slice(0, 480) }).catch(() => {});
            }
          }
        },
      });
      handedOver = result.ok;
      // A quick command only hands the message over: the window still has to show that a turn started.
      outcome = { ...result, route: route.name, stand_in: result.ok && route.standIn === true, expects_turn: result.ok && !route.long, confirm_seconds: route.patience };
      if (!result.ok && noteQuota(job.client, result.detail)) {
        // Another route of the same client runs on the same quota.
        outcome.quota = true;
        break;
      }
      if (result.ok) {
        break;
      }
      if (GONE.test(result.detail ?? '') && !route.standIn) {
        // The conversation does not exist for this client: another command of it will not find it either.
        // A route meant for that may still start a new conversation in its place.
        outcome.gone = true;
        gone = true;
      }
    }
    return outcome;
  }

  // Which clients were last reported out of quota (client -> until), and when Codex's record was last read.
  const reportedLimits = new Map();
  let quotaCheckedAt = 0;
  const reportLimit = async (client, limit) => {
    const until = limit?.until;
    if (reportedLimits.get(client) === until) {
      return;
    }
    await local('/api/v1/delivery/limit', until === undefined ? { client } : { client, until, detail: limit.detail });
    if (until === undefined) {
      reportedLimits.delete(client);
      say(`${client} has quota again`);
    } else {
      reportedLimits.set(client, until);
      say(`${client} has used up its quota until ${until}: nothing is started for it before then`);
    }
  };
  // Record vendor quota exhaustion reported by a client command.
  const noteQuota = (client, text) => {
    if (OUT_OF_QUOTA.test(text ?? '')) {
      void reportLimit(client, { until: retryTime(text).toISOString(), detail: String(text).replace(/\s+/g, ' ').slice(-300) }).catch((error) => {
        say(`failed to record quota limit for ${client}: ${error.message}`);
      });
      return true;
    }
    return false;
  };

  async function round() {
    if (busy) {
      return;
    }
    busy = true;
    try {
      // Codex says in its own record of turns when its quota is used up; read once a minute.
      if (routes.codex !== undefined && checkCodexQuota && Date.now() - quotaCheckedAt > 60_000) {
        quotaCheckedAt = Date.now();
        await reportLimit('codex', codexQuota());
      }
      // Naming the clients also tells the console which ones can be started from here.
      // Nothing is started for Antigravity while its command line is at work, be it a stand-in of ours or not.
      const held = new Set(standingIn.keys());
      if (routes.antigravity?.some((route) => route.standIn) && !held.has('antigravity') && process.env.ACM_DISPATCH_BUILTIN !== 'off' && commandLineAtWork()) {
        held.add('antigravity');
      }
      const { jobs } = await local('/api/v1/delivery/claim', { clients: Object.keys(routes), busy: [...running.keys()], busy_clients: [...held] });
      for (const job of jobs) {
        const { route, ...outcome } = await deliver(job);
        await local('/api/v1/delivery/report', { delivery_id: job.delivery_id, ...outcome, detail: outcome.ok && route !== undefined ? `${route}${outcome.detail ? `: ${outcome.detail}` : ''}`.slice(0, 480) : outcome.detail });
        say(`urgent delivery to window ${job.window} of ${job.session_id} (${job.client}): ${outcome.ok ? `handed over by ${route}` : outcome.detail}`);
      }
      lastProblem = '';
    } catch (error) {
      if (error.message !== lastProblem) {
        lastProblem = error.message;
        say(`delivery check failed: ${error.message}`);
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void round(), intervalMs);
  timer.unref();
  // Stopping: a turn that is still running ends with this service. That is said, so
  // that the window is started again by the service that comes next.
  return async () => {
    clearInterval(timer);
    const open = [...running.values()];
    running.clear();
    for (const turn of open) {
      turn.kill?.();
      await local('/api/v1/delivery/report', { delivery_id: turn.delivery, ok: false, late: true, detail: `${turn.name}: the service stopped before the turn ended` }).catch(() => {});
    }
  };
}
