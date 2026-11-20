#!/usr/bin/env node
// acm-cli: the agent tools as a local command, for a client whose agent can
// run commands on this machine but cannot load a local MCP server (Grok Bot:
// its MCP servers run on a remote computer, its command execution runs here).
// It is the same session mechanics as the stdio bridge: the identity is kept in
// the data directory, the service is started when it is not running, and every
// call goes to the one local control service. Nothing is exposed to a network.
//
//   node src/mcp/cli.mjs --client grok tools
//   node src/mcp/cli.mjs --client grok call <tool> [arguments]
//   node src/mcp/cli.mjs --client grok listen [--timeout 50] [--interval 2]
//   node src/mcp/cli.mjs --client grok respond <request_id> [--failed] (--text TEXT | --file PATH)
//   node src/mcp/cli.mjs --client grok wake set --url URL (--key KEY | --key-file PATH) [--with-text]
//   node src/mcp/cli.mjs --client grok wake test [--wait 150] | status | remove
//
// `wake` is for a client that is triggered from outside (Grok Bot: a routine with
// a webhook trigger): it registers the address and key of that trigger for its
// own session, so the service can start it whenever work waits. `wake test`
// sends one signal and then waits until a run that it started asks for work on
// this machine, which proves the whole way round.
//
// Arguments of `call`, combined in this order:
//   --json '{"k":"v"}'      a JSON object
//   --json-file PATH        a JSON object read from a UTF-8 file
//   --json-b64 BASE64       a JSON object, base64 of its UTF-8 text
//   --arg key=value         one field; the value is read as JSON when it is JSON, else as text
//   --str key=value         one field, always text
//   --file key=PATH         one field whose text is the content of a UTF-8 file
// A file is the reliable way to pass long or non-ASCII text through a shell.
//
// Output is one JSON document on stdout: {"ok":true,"result":...} or
// {"ok":false,"error":{code,message,details}}. With --ascii every non-ASCII
// character is written as \uXXXX. Exit code 0 on success, 1 when the service
// refused the call, 2 for a usage error. Diagnostics go to stderr.
//
// Shared options (see bridge.mjs): --client --label --project --identity-file
// --data-dir --core-port --mcp-port --no-autostart
import { readFileSync } from 'node:fs';
import { createBridge, takeBridgeOptions } from './bridge.mjs';
import { TOOLS } from './tools.mjs';

const argv = process.argv.slice(2);

function usage(message) {
  console.error(`[acm] ${message}`);
  console.error('usage: cli.mjs [--client NAME] tools | call <tool> [--json J | --json-file F | --json-b64 B] [--arg k=v] [--str k=v] [--file k=PATH] | listen [--timeout S] | respond <request_id> [--failed] (--text T | --file PATH) | wake set --url URL (--key K | --key-file PATH) [--with-text] | wake test [--wait S] | wake status | wake remove');
  process.exit(2);
}

let options;
try {
  options = takeBridgeOptions(argv);
} catch (error) {
  usage(error.message);
}
const ascii = argv.includes('--ascii') && argv.splice(argv.indexOf('--ascii'), 1).length === 1;
const [command, ...rest] = argv;

function print(document) {
  const text = JSON.stringify(document, null, 2);
  process.stdout.write(`${ascii ? text.replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) : text}\n`);
}
const readText = (path) => readFileSync(path, 'utf8').replace(/^﻿/, '');

/** Reads repeated `--name value` pairs out of `list`, leaving what it does not know. */
function take(list, name) {
  const values = [];
  for (let index = list.indexOf(name); index !== -1; index = list.indexOf(name)) {
    const [, value] = list.splice(index, 2);
    if (value === undefined) {
      usage(`${name} needs a value`);
    }
    values.push(value);
  }
  return values;
}

function field(pair, name) {
  const cut = pair.indexOf('=');
  if (cut < 1) {
    usage(`${name} expects key=value, got: ${pair}`);
  }
  return [pair.slice(0, cut), pair.slice(cut + 1)];
}

function callArguments(list) {
  const args = {};
  const merge = (text, origin) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      usage(`${origin} is not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      usage(`${origin} must be a JSON object`);
    }
    Object.assign(args, parsed);
  };
  take(list, '--json').forEach((text) => merge(text, '--json'));
  take(list, '--json-file').forEach((path) => merge(readText(path), `--json-file ${path}`));
  take(list, '--json-b64').forEach((text) => merge(Buffer.from(text, 'base64').toString('utf8'), '--json-b64'));
  for (const pair of take(list, '--arg')) {
    const [key, value] = field(pair, '--arg');
    try {
      args[key] = JSON.parse(value);
    } catch {
      // Not JSON, so it is plain text; --str exists for text that happens to look like JSON.
      args[key] = value;
    }
  }
  for (const pair of take(list, '--str')) {
    const [key, value] = field(pair, '--str');
    args[key] = value;
  }
  for (const pair of take(list, '--file')) {
    const [key, path] = field(pair, '--file');
    args[key] = readText(path);
  }
  if (list.length > 0) {
    usage(`unknown argument ${list[0]}`);
  }
  return args;
}

if (command === 'tools') {
  // What exists and which fields each tool takes, so an agent can discover it without MCP.
  print({
    ok: true,
    result: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      fields: Object.entries(tool.input).map(([name, schema]) => ({ name, required: !schema.isOptional(), description: schema.description ?? '' })),
    })),
  });
  process.exit(0);
}
if (!['call', 'listen', 'respond', 'wake'].includes(command)) {
  usage(command === undefined ? 'a command is required' : `unknown command ${command}`);
}

const bridge = createBridge(options, (line) => console.error(`[acm] ${line}`));
await bridge.start();

/** Thrown after a refusal was printed, to end the command with exit code 1. */
class Refused extends Error {}

/** Runs one tool; on refusal prints the error and ends the command. */
async function run(tool, args) {
  const answer = await bridge.invoke(tool, args);
  if (!answer.ok) {
    print({ ok: false, error: answer.error });
    throw new Refused(answer.error.code);
  }
  return answer.result;
}

// The process ends by itself once the work is done. Calling process.exit while
// connections to the service are still closing aborts Node on Windows, so a
// refusal only sets the exit code.
try {
  await main();
} catch (error) {
  if (!(error instanceof Refused)) {
    throw error;
  }
  process.exitCode = 1;
}

async function main() {
if (command === 'call') {
  const [tool, ...list] = rest;
  if (tool === undefined || !TOOLS.some((entry) => entry.name === tool)) {
    usage(tool === undefined ? 'call needs a tool name; see: cli.mjs tools' : `unknown tool ${tool}; see: cli.mjs tools`);
  }
  print({ ok: true, result: await run(tool, callArguments(list)) });
} else if (command === 'respond') {
  const [requestId, ...list] = rest;
  if (requestId === undefined || requestId.startsWith('--')) {
    usage('respond needs the request id');
  }
  const failed = list.includes('--failed') && list.splice(list.indexOf('--failed'), 1).length === 1;
  const texts = [...take(list, '--text'), ...take(list, '--file').map(readText)];
  if (texts.length !== 1 || list.length > 0) {
    usage('respond needs exactly one of --text TEXT or --file PATH');
  }
  print({ ok: true, result: await run('bot_respond', { request_id: requestId, ok: !failed, result: texts[0] }) });
} else if (command === 'wake') {
  const [action, ...list] = rest;
  const own = (body) => run('own_wake_hook', body);
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  if (action === 'set') {
    const [url] = take(list, '--url');
    const keys = [...take(list, '--key'), ...take(list, '--key-file').map((path) => readText(path).trim())];
    const withText = list.includes('--with-text') && list.splice(list.indexOf('--with-text'), 1).length === 1;
    if (url === undefined || keys.length > 1 || list.length > 0) {
      usage('wake set needs --url URL and at most one of --key KEY or --key-file PATH');
    }
    print({ ok: true, result: await own({ op: 'set', url, key: keys[0], include_text: withText }) });
  } else if (action === 'status' || action === 'remove') {
    if (list.length > 0) {
      usage(`unknown argument ${list[0]}`);
    }
    print({ ok: true, result: await own({ op: action }) });
  } else if (action === 'test') {
    const [given] = take(list, '--wait');
    const wait = given === undefined ? 150 : Number(given);
    if (!Number.isFinite(wait) || wait < 0 || list.length > 0) {
      usage('wake test takes --wait SECONDS');
    }
    const before = await own({ op: 'status' });
    if (before.hook === null) {
      print({ ok: false, error: { code: 'NO_WAKE_HOOK', message: 'no trigger is registered for this session; run: wake set --url URL --key KEY', details: {} } });
      throw new Refused('NO_WAKE_HOOK');
    }
    await own({ op: 'test' });
    // First the signal itself: the service sends it within a few seconds.
    let now = before;
    for (const deadline = Date.now() + 40000; Date.now() < deadline; ) {
      await sleep(1000);
      now = await own({ op: 'status' });
      if (!now.hook.test_requested && now.hook.last_status !== 'sending' && now.hook.last_attempt_at !== before.hook.last_attempt_at) {
        break;
      }
    }
    if (now.hook.last_attempt_at === before.hook.last_attempt_at || now.hook.last_status === 'sending') {
      print({ ok: true, result: { signal: 'not_sent', working: false, verdict: 'the service did not send the signal within 40 seconds; is the service running?' } });
    } else if (now.hook.last_status !== 'ok') {
      print({ ok: true, result: { signal: 'refused', detail: now.hook.last_detail, working: false, verdict: 'the other side refused the signal: check the address and the key, then run wake set again' } });
    } else {
      // Then the way back: a run started by the signal asks for work on this machine.
      let reached = false;
      const started = Date.now();
      while (!reached && Date.now() - started < wait * 1000) {
        await sleep(2000);
        reached = (await own({ op: 'status' })).host_seen_at !== before.host_seen_at;
      }
      print({
        ok: true,
        result: {
          signal: 'accepted',
          run_reached_this_machine: reached,
          waited_seconds: Math.round((Date.now() - started) / 1000),
          working: reached,
          verdict: reached
            ? 'working: the signal started a run and that run asked for work on this machine'
            : `the signal was accepted, but no run asked for work on this machine within ${wait} seconds: the routine's instruction must run "listen", and the run must be able to execute commands on this computer`,
        },
      });
    }
  } else {
    usage('wake needs one of: set, test, status, remove');
  }
} else {
  // listen: wait until there is something for this session, then say what.
  const seconds = (name, fallback) => {
    const [value] = take(rest, name);
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      usage(`${name} must be a positive number of seconds`);
    }
    return parsed;
  };
  const timeout = seconds('--timeout', 50);
  const interval = seconds('--interval', 2);
  if (rest.length > 0) {
    usage(`unknown argument ${rest[0]}`);
  }
  const deadline = Date.now() + timeout * 1000;
  let unfinished = [];
  for (;;) {
    // Taking requests is also what tells the others that this session hosts bots.
    const pulled = await run('bot_pull', { limit: 5 });
    unfinished = pulled.unfinished;
    const caught = await run('check_in', {});
    const conversations = caught.conversations.filter((entry) => (entry.new_messages ?? []).length > 0).map((entry) => ({
      conversation_id: entry.conversation_id,
      kind: entry.kind,
      title: entry.title,
      with: entry.with,
      new_messages: entry.new_messages.map((message) => ({
        message_id: message.message_id,
        from: `${message.sender.display_name ?? 'operator'}${message.sender.label ? ` (${message.sender.label})` : ''}`,
        sender_session_id: message.sender.session_id,
        addressed_to_you_only: message.directed,
        body: message.body,
      })),
    }));
    if (pulled.requests.length > 0 || conversations.length > 0 || caught.bot_results.length > 0) {
      print({ ok: true, result: { event: 'work', requests: pulled.requests, unanswered_requests: unfinished, conversations, bot_results: caught.bot_results, you: { session_id: caught.session_id, label: caught.label } } });
      break;
    }
    if (Date.now() + interval * 1000 > deadline) {
      print({ ok: true, result: { event: 'idle', waited_seconds: timeout, unanswered_requests: unfinished } });
      break;
    }
    await new Promise((done) => setTimeout(done, interval * 1000));
  }
}
}
