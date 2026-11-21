#!/usr/bin/env node
// Starts the service in the background and ends at once:
//
//   node src/mcp/launch.mjs <log file> [arguments of server.mjs ...]
//
// It exists for the bridge's Windows start (see launchService in bridge.mjs):
// created through WMI, this process is nobody's child; the service it starts
// outlives it and so belongs to no client either. The log is opened here, by
// Node, so that a later restart of the service can open the same file again -
// a shell redirection would hold it exclusively.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [logFile, ...serverArgs] = process.argv.slice(2);
if (logFile === undefined) {
  console.error('usage: launch.mjs <log file> [arguments of server.mjs ...]');
  process.exit(2);
}
mkdirSync(dirname(logFile), { recursive: true });
const log = openSync(logFile, 'a');
spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs'), ...serverArgs], {
  detached: true,
  stdio: ['ignore', log, log],
  windowsHide: true,
}).unref();
