// Where an installation keeps its data when no --data-dir is given.
//
// The default is a folder in the user's home directory. Desktop clients start
// the bridge from inside their own process environment, and some of them
// redirect or restrict the per-user application data folders; the home
// directory is the one place every client and every shell sees the same way.
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The data directory: `explicit` when given, otherwise ~/.acm. An installation
 * that still has its data in the earlier default (%LOCALAPPDATA%) is moved
 * over once; when that is not possible because the service is running on it,
 * the earlier location keeps being used until the service is stopped.
 */
export function resolveDataDir(explicit) {
  if (explicit !== undefined) {
    return resolve(explicit);
  }
  const home = join(homedir(), '.acm');
  const earlier = process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'AgentConversationMCP');
  if (existsSync(home) || earlier === undefined || !existsSync(join(earlier, 'acm.db'))) {
    return home;
  }
  try {
    renameSync(earlier, home);
    console.error(`[acm] moved the data directory from ${earlier} to ${home}`);
    return home;
  } catch (error) {
    console.error(`[acm] the data directory stays at ${earlier} for now (${error.code ?? error.message}); it moves to ${home} once the service is stopped`);
    return earlier;
  }
}
