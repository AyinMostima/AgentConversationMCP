#!/usr/bin/env node
// Captures console screenshots and exercises live UI flows across light/dark
// themes, multiple viewports, and both English and Simplified Chinese locales.
// Requires a running demo service (`npm run demo -- --fresh`) and Playwright
// with the system Chrome channel.
//
//   node scripts/capture-screens.mjs [--data-dir .data/demo] [--core-port 8766] [--out test-output/screens] [--docs]
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const dataDir = resolve(option('--data-dir', join(repoRoot, '.data', 'demo')));
const base = `http://127.0.0.1:${option('--core-port', '8766')}`;
const outDir = resolve(option('--out', join(repoRoot, 'test-output', 'screens')));
const docsDir = join(repoRoot, 'docs', 'images');
const updateDocs = argv.includes('--docs');
const only = option('--only', undefined);
mkdirSync(outDir, { recursive: true });
const token = readFileSync(join(dataDir, 'admin-token.txt'), 'utf8').trim();

function loadPlaywright() {
  for (const from of [join(repoRoot, 'package.json'), join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'playwright', 'package.json')]) {
    try {
      return createRequire(from)('playwright');
    } catch {
      // Try next installation path.
    }
  }
  throw new Error('playwright is not installed; run: npm install -g playwright');
}
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ channel: 'chrome' });

function sanitizeBootstrap(payload) {
  if (!payload || typeof payload !== 'object' || !payload.result) {
    return payload;
  }
  const result = payload.result;
  if (result.service) {
    result.service.node_path = 'C:\\Program Files\\nodejs\\node.exe';
    result.service.stdio_entry = 'C:\\Tools\\AgentConversationMCP\\src\\mcp\\stdio.mjs';
    result.service.stdio_args = [
      'C:\\Tools\\AgentConversationMCP\\src\\mcp\\stdio.mjs',
      '--client',
      'codex',
    ];
  }
  if (Array.isArray(result.projects)) {
    for (const project of result.projects) {
      if (project.root_path) {
        project.root_path = 'C:\\Projects\\sensor-cleaning';
      }
    }
  }
  if (Array.isArray(result.sessions)) {
    for (const session of result.sessions) {
      if (session.claimed_cwd && session.claimed_cwd.includes('demo-project')) {
        session.claimed_cwd = 'C:\\Projects\\sensor-cleaning';
      }
    }
  }
  return payload;
}

async function open(theme, viewport, deviceScaleFactor = 1, lang = 'en') {
  const context = await browser.newContext({ viewport, deviceScaleFactor, locale: lang === 'zh-CN' ? 'zh-CN' : 'en-US' });
  await context.addInitScript(([tVal, lVal]) => {
    window.localStorage.setItem('acm.theme', tVal);
    window.localStorage.setItem('acm.lang', lVal);
  }, [theme, lang]);
  const page = await context.newPage();
  if (updateDocs) {
    // Replace local developer directory paths with generic example paths in docs screenshots.
    await page.route('**/api/v1/bootstrap', async (route) => {
      try {
        const response = await route.fetch();
        const json = sanitizeBootstrap(await response.json());
        await route.fulfill({ response, json });
      } catch (error) {
        if (!page.isClosed()) {
          throw error;
        }
      }
    });
  }
  const problems = [];
  page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto(`${base}/#token=${token}`);
  await page.waitForSelector('.thread, .blank');
  await page.waitForTimeout(600);
  return { context, page, problems };
}

const report = [];
async function shot(name, theme, viewport, steps = async () => undefined, scale = 1, expected = undefined, lang = 'en') {
  if (only !== undefined && !name.includes(only)) {
    return;
  }
  const { context, page, problems } = await open(theme, viewport, scale, lang);
  await steps(page);
  await page.waitForTimeout(350);
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  const overflow = await page.evaluate(() => {
    const sheet = document.querySelector('.thread');
    const clipped = sheet === null ? 0 : Math.max(0, ...[...sheet.querySelectorAll('.thread-head, .composer')].map((part) => part.scrollWidth - part.clientWidth));
    return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, clipped);
  });
  const unexpected = expected === undefined ? problems : problems.filter((text) => !expected.test(text));
  report.push({ name, theme, lang, viewport: `${viewport.width}x${viewport.height}@${scale}`, horizontalOverflowPx: overflow, consoleErrors: unexpected });
  console.log(`[OK] ${name}.png overflow=${overflow}px errors=${unexpected.length}`);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close();
}

const desktop = { width: 1440, height: 900 };
const toAgents = (page) => page.getByRole('button', { name: /^Agents/ }).click();
const toEvents = (page) => page.getByRole('button', { name: 'Events', exact: true }).click();
const toSettings = (page) => page.getByRole('button', { name: 'Settings', exact: true }).click();
const toBoard = (page) => page.getByRole('tab', { name: /^Task Board/ }).click();
const openConversation = (page, name) => page.locator('.conv', { hasText: name }).first().click();

// ---- static layout captures ------------------------------------------------
await shot('workspace-light-1440', 'light', desktop);
await shot('workspace-dark-1440', 'dark', desktop);
await shot('workspace-light-1280', 'light', { width: 1280, height: 720 });
await shot('workspace-light-scale125', 'light', { width: 1536, height: 864 }, undefined, 1.25);
await shot('workspace-narrow-light', 'light', { width: 420, height: 860 });
await shot('workspace-narrow-dark', 'dark', { width: 420, height: 860 });
await shot('workspace-zh-1440', 'light', desktop, async (page) => {
  await page.getByRole('button', { name: '代理与配对' }).waitFor({ timeout: 3000 });
}, 1, undefined, 'zh-CN');
await shot('workspace-top-light', 'light', desktop, async (page) => page.evaluate(() => { document.querySelector('.timeline').scrollTop = 0; }));
await shot('workspace-details-light', 'light', desktop, async (page) => {
  await page.evaluate(() => { document.querySelector('.timeline').scrollTop = 0; });
  await page.getByRole('button', { name: 'Receipts & details' }).nth(1).click();
});
await shot('workspace-members-light', 'light', desktop, async (page) => {
  await page.getByRole('button', { name: /member/ }).click();
  await page.locator('.member').first().getByRole('button', { name: /^Permissions for/ }).click();
});
await shot('board-light-1440', 'light', desktop, toBoard);
await shot('board-dark-1440', 'dark', desktop, async (page) => {
  await toBoard(page);
  await page.getByRole('button', { name: /Details for task #4/ }).click();
});
await shot('board-narrow-light', 'light', { width: 420, height: 860 }, toBoard);
await shot('agents-light-1440', 'light', desktop, toAgents);
await shot('agents-dark-1440', 'dark', desktop, toAgents);
await shot('agents-narrow-light', 'light', { width: 420, height: 860 }, toAgents);
await shot('pairing-form-light', 'light', desktop, async (page) => {
  await toAgents(page);
  await page.getByRole('button', { name: 'Issue pairing' }).click();
});
await shot('events-light-1440', 'light', desktop, toEvents);
await shot('events-dark-1440', 'dark', desktop, toEvents);
await shot('signin-light', 'light', desktop, async (page) => page.getByRole('button', { name: 'Sign out' }).click());

// ---- language switcher verification (topbar + Settings + Sign-in) ----------
await shot('flow-language-switch', 'light', desktop, async (page) => {
  await toSettings(page);
  // Switch to Simplified Chinese via the Settings segmented control.
  await page.getByRole('tab', { name: '简体中文' }).click();
  await page.getByRole('heading', { name: '设置' }).waitFor({ timeout: 3000 });
  if ((await page.evaluate(() => document.documentElement.lang)) !== 'zh-CN') {
    throw new Error('document.documentElement.lang did not switch to zh-CN');
  }
  // Switch back to English via the topbar quick toggle.
  await page.getByRole('button', { name: /切换界面语言/ }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 3000 });
  if ((await page.evaluate(() => document.documentElement.lang)) !== 'en') {
    throw new Error('document.documentElement.lang did not switch back to en');
  }
  // Verify sign-in page also supports language switching.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Operator Console Sign In' }).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: /Switch language/ }).click();
  await page.getByRole('heading', { name: '登录操作员控制台' }).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: /切换界面语言/ }).click();
  await page.getByRole('heading', { name: 'Operator Console Sign In' }).waitFor({ timeout: 3000 });
});

// ---- live interactive flows ------------------------------------------------
await shot('pairing-guide-light', 'light', desktop, async (page) => {
  await toAgents(page);
  await page.getByRole('button', { name: 'Issue pairing' }).click();
  await page.getByPlaceholder(/Review Window/).fill('Codex Desktop · Demo Check');
  await page.getByRole('button', { name: 'Issue token' }).click();
  await page.waitForSelector('.token');
  await page.getByRole('tab', { name: 'Codex Desktop' }).click();
});
await shot('flow-send-message', 'light', desktop, async (page) => {
  const text = `UI check ${Date.now()}: message posted from operator console.`;
  await page.getByLabel('Message body').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(text).waitFor({ timeout: 5000 });
});
await shot('flow-approve-pairing', 'light', desktop, async (page) => {
  await toAgents(page);
  await page.getByRole('button', { name: 'Approve instance' }).first().click();
  await page.getByText(/Approved/).waitFor({ timeout: 5000 });
});
await shot('flow-task-board', 'light', desktop, async (page) => {
  await toBoard(page);
  const title = `UI check task ${Date.now()}`;
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByPlaceholder(/Verify row count/).fill(title);
  await page.getByRole('button', { name: 'Add task' }).click();
  const row = page.locator('.task', { hasText: title });
  await row.waitFor({ timeout: 5000 });
  await row.getByRole('button', { name: /Details for task/ }).click();
  await row.getByLabel('Status').selectOption('doing');
  await row.getByText('In progress').first().waitFor({ timeout: 5000 });
});
await shot('flow-goal', 'light', desktop, async (page) => {
  const goal = `UI check goal ${Date.now()}`;
  await page.locator('.goal').click();
  await page.getByRole('dialog').getByRole('textbox').fill(goal);
  await page.getByRole('button', { name: 'Save goal' }).click();
  await page.locator('.goal-text', { hasText: goal }).waitFor({ timeout: 5000 });
});
await shot('flow-approve-proposal', 'light', desktop, async (page) => {
  await toAgents(page);
  await page.getByRole('button', { name: 'Approve & create' }).click();
  await page.getByText(/Created conversation DATA-016/).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: /Remaining July Sensor Cleaning/ }).waitFor({ timeout: 5000 });
});
await shot('flow-member-permission', 'dark', desktop, async (page) => {
  await page.getByRole('button', { name: /member/ }).click();
  const member = page.locator('.member', { hasText: 'Observer Window' });
  await member.getByRole('button', { name: /^Permissions for/ }).click();
  await member.getByRole('switch', { name: 'Write' }).click();
  await page.getByText('Permissions updated').waitFor({ timeout: 5000 });
});

await shot('lobby-light-1440', 'light', desktop, async (page) => openConversation(page, 'Lobby'));
await shot('lobby-dark-1440', 'dark', desktop, async (page) => openConversation(page, 'Lobby'));
await shot('direct-light-1440', 'light', desktop, async (page) => {
  await page.locator('.sidebar-fold > summary', { hasText: 'Direct' }).first().click();
  await openConversation(page, '↔');
  await page.getByRole('button', { name: /member/ }).click();
});
await shot('composer-options-light', 'light', desktop, async (page) => {
  await page.getByRole('button', { name: 'Message type and recipients' }).click();
  await page.locator('.composer-options').getByRole('tab', { name: 'Handoff' }).click();
  await page.locator('.pick').first().click();
});
await shot('flow-urgent-message', 'light', desktop, async (page) => {
  await openConversation(page, 'Lobby');
  const before = await page.locator('.tag-urgent').count();
  if (before < 1) {
    throw new Error('seeded urgent message carries no tag');
  }
  await page.getByRole('button', { name: 'Message type and recipients' }).click();
  const toggle = page.getByRole('switch', { name: 'Mark as urgent' });
  await toggle.click();
  await page.locator('.composer-choice', { hasText: 'Urgent' }).waitFor({ timeout: 3000 });
  const text = `UI check ${Date.now()}: urgent alert.`;
  await page.getByLabel('Message body').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.msg', { hasText: text }).locator('.tag-urgent').waitFor({ timeout: 5000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'false') {
    throw new Error('urgent switch stayed on after sending');
  }
});
await shot('flow-urgent-switch', 'light', desktop, async (page) => {
  await toAgents(page);
  await page.getByRole('button', { name: 'Details for Cleaning Window' }).click();
  const toggle = page.getByRole('switch', { name: 'Allow urgent interrupts for Cleaning Window' });
  await toggle.click();
  await page.locator('.toast', { hasText: 'Urgent interrupts disabled' }).waitFor({ timeout: 5000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'false') {
    throw new Error('urgent switch did not settle on off');
  }
  await toggle.click();
  await page.locator('.toast', { hasText: 'Urgent interrupts enabled' }).waitFor({ timeout: 5000 });
});
await shot('flow-filter-switch', 'light', desktop, async (page) => {
  await page.getByRole('tab', { name: 'Progress' }).click();
  await page.locator('.segmented-sm .segmented-thumb').waitFor({ timeout: 3000 });
  const track = await page.locator('.segmented-sm').evaluate((element) => getComputedStyle(element).display);
  if (track !== 'inline-grid' && track !== 'grid') {
    throw new Error(`segmented control is unstyled (display: ${track})`);
  }
  await page.locator('.msg .inset').first().waitFor({ timeout: 3000 });
});
await shot('flow-link-switch', 'light', desktop, async (page) => {
  await toAgents(page);
  const row = page.locator('tr', { hasText: 'Review Window' });
  const toggle = row.getByRole('switch');
  await toggle.click();
  await page.getByText(/left interconnection/).waitFor({ timeout: 5000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'false') {
    throw new Error('link switch did not settle on off');
  }
  await toggle.click();
  await page.getByText(/joined interconnection/).waitFor({ timeout: 5000 });
});
await shot('flow-open-mode-off', 'light', desktop, async (page) => {
  await toAgents(page);
  const toggle = page.getByRole('switch', { name: 'Default Interconnection', exact: true });
  await toggle.click();
  await page.locator('.toast', { hasText: 'Default interconnection disabled' }).waitFor({ timeout: 5000 });
});
await shot('flow-open-mode-on', 'dark', desktop, async (page) => {
  await toAgents(page);
  const toggle = page.getByRole('switch', { name: 'Default Interconnection', exact: true });
  await toggle.click();
  await page.locator('.toast', { hasText: 'Default interconnection enabled' }).waitFor({ timeout: 5000 });
});
await shot('flow-revoke-confirm', 'light', desktop, async (page) => {
  await toAgents(page);
  const row = page.locator('tr', { hasText: 'Cleaning Window' });
  await row.getByRole('button', { name: /^Details for/ }).click();
  await page.getByRole('button', { name: 'Revoke token' }).click();
  await page.getByRole('dialog', { name: 'Revoke Token' }).waitFor({ timeout: 3000 });
});
await shot('bot-requests-light', 'light', desktop, async (page) => {
  await toAgents(page);
  await page.locator('details.closed > summary', { hasText: 'Bot request history' }).click();
  await page.getByRole('button', { name: 'Instruction and response' }).first().click();
});
await shot('flow-release-bot-request', 'dark', desktop, async (page) => {
  await toAgents(page);
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await page.locator('.toast', { hasText: 'Released for execution' }).waitFor({ timeout: 5000 });
});
await shot('settings-light', 'light', desktop, toSettings);
// Overview charts and the manage page, with something selected.
const toOverview = async (page) => {
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.locator('.viz-plot svg').waitFor();
  await page.waitForTimeout(700);
};
await shot('overview-light-1440', 'light', desktop, toOverview);
await shot('overview-dark-1440', 'dark', desktop, toOverview);
await shot('overview-narrow-light', 'light', { width: 420, height: 860 }, toOverview);
await shot('manage-light-1440', 'light', desktop, async (page) => {
  await page.getByRole('button', { name: 'Batch', exact: true }).click();
  await page.locator('.bulk-table tbody tr').nth(1).click();
  await page.locator('.bulk-table tbody tr').nth(2).click();
  await page.locator('.bulk-bar').waitFor();
});
await shot('manage-tasks-light', 'light', desktop, async (page) => {
  await page.getByRole('button', { name: 'Batch', exact: true }).click();
  await page.getByRole('tab', { name: 'Tasks' }).click();
  await page.locator('.bulk-table tbody tr').first().click();
  await page.locator('.bulk-bar').waitFor();
});
await shot('settings-remote-light', 'light', desktop, async (page) => {
  await toSettings(page);
  await page.getByRole('button', { name: 'ngrok settings' }).click();
  await page.getByPlaceholder(/Your Authtoken/).waitFor({ timeout: 3000 });
});
await shot('settings-narrow-dark', 'dark', { width: 420, height: 860 }, async (page) => {
  await toSettings(page);
  await page.getByRole('button', { name: 'ngrok settings' }).click();
});
await shot('flow-delivery-routes', 'light', desktop, async (page) => {
  await toSettings(page);
  const rows = page.locator('.route', { hasText: 'Hooks' });
  await rows.first().waitFor({ timeout: 5000 });
  if ((await page.locator('.route').count()) !== 4) {
    throw new Error(`expected 4 routes needing attention, found ${await page.locator('.route').count()}`);
  }
  if ((await page.locator('.route', { hasText: 'Auto-Wake' }).count()) !== 2) {
    throw new Error('bot hosts without wake hooks should appear in route status');
  }
  await page.getByRole('button', { name: 'Show all routes' }).click();
  if ((await rows.count()) !== 4) {
    throw new Error(`expected 4 hook delivery routes, found ${await rows.count()}`);
  }
  await page.locator('.route', { hasText: 'Review hooks' }).first().waitFor({ timeout: 3000 });
  await page.locator('.route', { hasText: 'Last injected 1 message' }).waitFor({ timeout: 3000 });
  await page.locator('.routes').scrollIntoViewIfNeeded();
});
await shot('flow-digest-panel', 'light', desktop, async (page) => {
  // Open the conversation digest and compaction drawer beside the timeline.
  await page.getByRole('button', { name: /^Digest/ }).click();
  await page.getByRole('heading', { name: 'Digest & Compaction' }).waitFor({ timeout: 3000 });
  await page.getByText(/No digest yet/).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: 'Write digest' }).click();
  await page.getByPlaceholder(/Summarize decisions/).waitFor({ timeout: 3000 });
});
await shot('flow-flood-limits', 'light', desktop, async (page) => {
  await toSettings(page);
  await page.getByRole('button', { name: 'Adjust limits' }).click();
  await page.getByLabel('Messages / minute').fill('8');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast', { hasText: 'Limits updated' }).waitFor({ timeout: 5000 });
  await page.locator('.setting', { hasText: '8 /min' }).waitFor({ timeout: 5000 });
});
await shot('flow-grok-prefill', 'light', desktop, async (page) => {
  await page.evaluate(() => { document.querySelector('.timeline').scrollTop = 0; });
  await page.getByRole('button', { name: 'Receipts & details' }).nth(1).click();
  const link = page.getByRole('link', { name: 'Prefill in Grok' }).first();
  await link.waitFor({ timeout: 3000 });
  const href = await link.getAttribute('href');
  if (!href.startsWith('grokbot://app/v1/prompt?text=')) {
    throw new Error(`unexpected prefill link: ${href.slice(0, 60)}`);
  }
  const text = decodeURIComponent(href.slice(href.indexOf('text=') + 5));
  if (Array.from(text).length > 1000 || !text.startsWith('From ACM')) {
    throw new Error(`prefill text is ${Array.from(text).length} chars and starts with: ${text.slice(0, 20)}`);
  }
});
await shot('flow-grok-bot-id', 'light', desktop, async (page) => {
  await toSettings(page);
  await page.getByRole('button', { name: 'Grok Bot settings' }).click();
  await page.getByPlaceholder(/main bot/).fill('demo-bot_42');
  await page.locator('.setting', { hasText: 'Target Bot ID' }).getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.toast', { hasText: 'Grok Bot settings saved' }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.evaluate(() => { document.querySelector('.timeline').scrollTop = 0; });
  await page.getByRole('button', { name: 'Receipts & details' }).nth(1).click();
  const href = await page.getByRole('link', { name: 'Prefill in Grok' }).first().getAttribute('href');
  if (!href.startsWith('grokbot://app/v1/prompt?id=demo-bot_42&text=')) {
    throw new Error(`stored bot id missing from link: ${href.slice(0, 70)}`);
  }
});
await shot('flow-list-search', 'light', desktop, async (page) => {
  await page.getByLabel('Search conversations').fill('tmp');
  await page.locator('.sidebar-note', { hasText: '2 matches' }).waitFor({ timeout: 3000 });
  await page.locator('.conv-row.is-archived', { hasText: 'Schema Field Alignment' }).waitFor({ timeout: 3000 });
  if ((await page.locator('.conv').count()) !== 2) {
    throw new Error(`search should leave 2 conversations, found ${await page.locator('.conv').count()}`);
  }
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await page.locator('.conv', { hasText: 'Lobby' }).waitFor({ timeout: 3000 });
  await page.getByLabel('Filter conversations').click();
  await page.getByRole('menuitemcheckbox', { name: 'Direct conversations' }).click();
  await page.locator('.conv', { hasText: 'Lobby' }).waitFor({ state: 'detached', timeout: 3000 });
  const left = await page.locator('.conv').count();
  const inFold = await page.locator('.sidebar-fold', { hasText: 'Direct' }).locator('.conv').count();
  if (left < 1 || left !== inFold) {
    throw new Error(`kind filter left ${left} conversations, ${inFold} direct`);
  }
});
await shot('flow-list-filter-dark', 'dark', desktop, async (page) => {
  await page.getByLabel('Filter conversations').click();
  await page.getByRole('menuitemcheckbox', { name: 'Task conversations' }).waitFor({ timeout: 3000 });
});
await shot('flow-edit-conversation', 'light', desktop, async (page) => {
  await openConversation(page, 'Quick Naming Check');
  await page.getByLabel('Conversation actions').click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Conversation' });
  await dialog.getByLabel('Title').fill('Quick Naming Check: Device IDs');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Conversation updated' }).waitFor({ timeout: 5000 });
  await page.locator('.conv.is-active', { hasText: 'Quick Naming Check: Device IDs' }).waitFor({ timeout: 5000 });
  await page.getByLabel('Conversation actions').click();
});
await shot('flow-archive-restore', 'light', desktop, async (page) => {
  await openConversation(page, 'Quick Naming Check');
  await page.getByLabel('Conversation actions').click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await page.locator('.toast', { hasText: 'Archived' }).waitFor({ timeout: 5000 });
  await page.locator('.archived-bar').waitFor({ timeout: 5000 });
  if ((await page.getByLabel('Message body').count()) !== 0) {
    throw new Error('archived conversation still renders composer');
  }
  await page.locator('.sidebar-fold', { hasText: 'Archived' }).locator('.conv.is-active').waitFor({ timeout: 3000 });
});
await shot('flow-clear-messages', 'light', desktop, async (page) => {
  await page.locator('.sidebar-fold > summary', { hasText: 'Archived' }).click();
  await openConversation(page, 'Quick Naming Check');
  await page.locator('.archived-bar').getByRole('button', { name: 'Restore' }).click();
  await page.getByLabel('Message body').waitFor({ timeout: 5000 });
  await page.getByLabel('Conversation actions').click();
  await page.getByRole('menuitem', { name: 'Clear messages' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear Messages' });
  await dialog.getByText('contains 3 message(s)').waitFor({ timeout: 3000 });
  await dialog.getByRole('tab', { name: 'Older than 7d' }).click();
  await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.locator('.toast', { hasText: 'No messages matched' }).waitFor({ timeout: 5000 });
  await page.getByLabel('Conversation actions').click();
  await page.getByRole('menuitem', { name: 'Clear messages' }).click();
  await page.getByRole('dialog', { name: 'Clear Messages' }).getByRole('button', { name: 'Clear', exact: true }).click();
  await page.locator('.toast', { hasText: 'Deleted 3 message(s)' }).waitFor({ timeout: 5000 });
  await page.getByText('No messages yet').waitFor({ timeout: 5000 });
});
await shot('flow-tidy-select', 'light', desktop, async (page) => {
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByLabel('Search conversations').fill('tmp');
  await page.getByRole('button', { name: /^Select all \(2\)$/ }).click();
  await page.locator('.tidy-count', { hasText: '2 selected' }).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: 'Clear filter' }).click();
  if (!(await page.getByLabel('Select Lobby').isDisabled())) {
    throw new Error('lobby checkbox must be disabled in bulk manage mode');
  }
});
await shot('flow-tidy-delete', 'dark', desktop, async (page) => {
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByLabel('Search conversations').fill('tmp');
  await page.getByRole('button', { name: /^Select all \(2\)$/ }).click();
  await page.locator('.tidy-bar').getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Conversation' });
  await dialog.getByText(/2 selected conversations will be permanently deleted/).waitFor({ timeout: 3000 });
  await dialog.getByRole('button', { name: 'Delete 2 permanently' }).click();
  await page.locator('.toast', { hasText: 'Deleted 2 conversation(s)' }).waitFor({ timeout: 8000 });
  await page.locator('.sidebar-note', { hasText: '0 matches' }).waitFor({ timeout: 5000 });
  await page.getByText('No matching conversations.').waitFor({ timeout: 3000 });
});
await shot('wake-hook-light', 'light', desktop, async (page) => {
  await toAgents(page);
  const row = page.locator('tr', { hasText: 'Main Bot' });
  await row.getByRole('button', { name: /^Details for/ }).click();
  await page.locator('details.closed > summary', { hasText: 'Webhook' }).click();
  await page.getByPlaceholder('https://…').fill('https://example.invalid/routines/demo');
});
await shot('flow-restart', 'light', desktop, async (page) => {
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await page.getByRole('dialog', { name: 'Restart ACM' }).getByRole('button', { name: 'Restart', exact: true }).click();
  await page.locator('.toast', { hasText: 'ACM restarted' }).waitFor({ timeout: 30000 });
  await page.locator('.status-ok', { hasText: 'Connected' }).waitFor({ timeout: 5000 });
}, 1, /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_EMPTY_RESPONSE|Failed to fetch|network error/i);

await browser.close();

if (updateDocs) {
  mkdirSync(docsDir, { recursive: true });
  const docsMap = [
    ['workspace-light-1440.png', 'workspace.png'],
    ['workspace-dark-1440.png', 'workspace-dark.png'],
    ['workspace-narrow-light.png', 'workspace-narrow.png'],
    ['workspace-details-light.png', 'workspace-details.png'],
    ['workspace-members-light.png', 'workspace-members.png'],
    ['board-light-1440.png', 'board.png'],
    ['agents-light-1440.png', 'agents.png'],
    ['pairing-guide-light.png', 'pairing-guide.png'],
    ['events-light-1440.png', 'events.png'],
    ['lobby-light-1440.png', 'lobby.png'],
    ['direct-light-1440.png', 'direct.png'],
    ['composer-options-light.png', 'composer-options.png'],
    ['flow-urgent-message.png', 'urgent-message.png'],
    ['bot-requests-light.png', 'bot-requests.png'],
    ['settings-remote-light.png', 'settings.png'],
    ['settings-light.png', 'settings-routes.png'],
    ['flow-delivery-routes.png', 'delivery-routes.png'],
    ['flow-edit-conversation.png', 'conversation-menu.png'],
    ['flow-tidy-select.png', 'tidy.png'],
    ['wake-hook-light.png', 'wake-hook.png'],
    ['overview-light-1440.png', 'overview.png'],
    ['manage-light-1440.png', 'batch.png'],
  ];
  for (const [src, dst] of docsMap) {
    copyFileSync(join(outDir, src), join(docsDir, dst));
  }
  console.log(`[OK] updated ${docsMap.length} English screenshots in docs/images/`);
}

const failing = report.filter((entry) => entry.horizontalOverflowPx > 0 || entry.consoleErrors.length > 0);
console.log(JSON.stringify({ captured: report.length, withProblems: failing }, null, 2));
process.exit(failing.length === 0 ? 0 : 1);
