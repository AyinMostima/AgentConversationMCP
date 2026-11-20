#!/usr/bin/env node
// Creates a desktop shortcut that opens the operator console with one click.
// The shortcut runs `acm-admin.mjs console --notify`: it starts the service in
// the background when it is not running, then opens the console signed in.
//
//   node scripts/install-shortcut.mjs [--name TEXT] [--data-dir DIR] [--core-port N] [--mcp-port N] [--remove]
//
// Options other than --remove and --name are passed through to the console
// command, allowing shortcuts to target non-default service instances.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const remove = argv.includes('--remove');
const nameIndex = argv.indexOf('--name');
const name = nameIndex === -1 ? 'AGORA' : argv[nameIndex + 1];
if (nameIndex !== -1 && (name === undefined || name.trim() === '')) {
  console.error('[ERROR] --name requires a non-empty value');
  process.exit(2);
}
const passThrough = argv.filter((value, index) => value !== '--remove' && index !== nameIndex && (nameIndex === -1 || index !== nameIndex + 1));
// Its own file name: Windows caches a shortcut's picture by the path of the icon file.
const icon = join(repoRoot, 'ui', 'public', 'agora.ico');
const entry = join(repoRoot, 'scripts', 'acm-admin.mjs');

if (!remove && !existsSync(icon)) {
  console.error(`[ERROR] icon not found: ${icon}`);
  process.exit(1);
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const argument = (value) => (/[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);
const commandLine = [entry, 'console', '--notify', ...passThrough].map(argument).join(' ');

// The desktop folder is asked from Windows, so a redirected desktop (OneDrive) works too.
// WScript.Shell cannot save a shortcut whose name is outside the system ANSI
// code page, so it is written under an ASCII name and renamed afterwards; the
// rename is Unicode-safe. Any failing step stops the script with a non-zero exit.
const script = remove
  ? `$ErrorActionPreference = 'Stop'
     $link = Join-Path ([Environment]::GetFolderPath('Desktop')) (${quote(name)} + '.lnk')
     if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force; Write-Output 'removed' } else { Write-Output 'absent' }`
  : `$ErrorActionPreference = 'Stop'
     $desktop = [Environment]::GetFolderPath('Desktop')
     $link = Join-Path $desktop (${quote(name)} + '.lnk')
     $draft = Join-Path $desktop 'acm-console-shortcut.lnk'
     $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($draft)
     $shortcut.TargetPath = ${quote(process.execPath)}
     $shortcut.Arguments = ${quote(commandLine)}
     $shortcut.WorkingDirectory = ${quote(repoRoot)}
     $shortcut.IconLocation = ${quote(`${icon},0`)}
     $shortcut.WindowStyle = 7
     $shortcut.Description = 'AGORA - AgentConversationMCP operator console'
     $shortcut.Save()
     Move-Item -LiteralPath $draft -Destination $link -Force
     if (-not (Test-Path -LiteralPath $link)) { throw 'the shortcut file is missing after it was saved' }
     Write-Output 'created'`;

// An encoded command keeps non-ASCII text intact whatever the console code page is.
let outcome;
try {
  outcome = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
} catch (failure) {
  // PowerShell reports the reason on stderr as CLIXML; keep the readable part.
  const reason = String(failure.stderr ?? failure.message).replace(/<[^>]+>/g, ' ').replace(/_x000D__x000A_/g, ' ').replace(/\s+/g, ' ').trim();
  console.error(`[ERROR] the desktop shortcut was not ${remove ? 'removed' : 'created'}: ${reason.slice(-400)}`);
  process.exit(1);
}
if (outcome === 'created') {
  console.log('[OK] desktop shortcut created; double-click it to open the operator console');
} else if (outcome === 'removed') {
  console.log('[OK] desktop shortcut removed');
} else if (outcome === 'absent') {
  console.log('[OK] no desktop shortcut to remove');
} else {
  console.error(`[ERROR] unexpected result: ${outcome}`);
  process.exit(1);
}
