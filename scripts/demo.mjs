#!/usr/bin/env node
// Demo runner: launches the service on an isolated data directory and seeds a
// sample multi-agent handoff workflow (DATA-014) using the real operator API
// and MCP tool calls.
//
//   npm run demo                    # English sample data (default)
//   npm run demo -- --lang zh       # Simplified Chinese sample data
//   npm run demo -- --fresh         # Recreate sample data from scratch
//
// All demo files stay under .data/demo and can be deleted at any time.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const mcpPort = option('--mcp-port', '8765');
const corePort = option('--core-port', '8766');
const lang = option('--lang', 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
const dataDir = join(repoRoot, '.data', 'demo');
const projectRoot = join(repoRoot, '.data', 'demo-project');
const coreUrl = `http://127.0.0.1:${corePort}`;
const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

if (fresh) {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}

// ---- DATA-014 CSV fixtures: 12 raw rows -> 8 clean rows --------------------
const rawCsv = [
  'device,timestamp,value_ugm3',
  'A1,2026-07-01T09:00:00+08:00,12.4',
  'A1,2026-07-01T09:00:00+08:00,12.4',
  'A1,2026-07-01T10:00:00+08:00,13.1',
  'A1,2026-07-01T11:00:00+08:00,',
  'B2,2026-07-01T09:00:00+08:00,8.7',
  'B2,2026-07-01T10:00:00+08:00,9.2',
  'B2,2026-07-01T02:00:00Z,9.2',
  'B2,2026/07/01 11:00,9.9',
  'C3,2026-07-01T09:00:00+08:00,21.0',
  'C3,2026-07-01T10:00:00+08:00,20.4',
  'C3,2026-07-01T11:00:00+08:00,19.8',
  'C3,2026-07-01T12:00:00+08:00,19.1',
].join('\n') + '\n';

const cleanCsv = [
  'device,time_utc,value_ugm3',
  'A1,2026-07-01T01:00:00Z,12.4',
  'A1,2026-07-01T02:00:00Z,13.1',
  'B2,2026-07-01T01:00:00Z,8.7',
  'B2,2026-07-01T02:00:00Z,9.2',
  'C3,2026-07-01T01:00:00Z,21.0',
  'C3,2026-07-01T02:00:00Z,20.4',
  'C3,2026-07-01T03:00:00Z,19.8',
  'C3,2026-07-01T04:00:00Z,19.1',
].join('\n') + '\n';

mkdirSync(join(projectRoot, 'raw'), { recursive: true });
mkdirSync(join(projectRoot, 'out'), { recursive: true });
writeFileSync(join(projectRoot, 'raw', 'readings.csv'), rawCsv);
writeFileSync(join(projectRoot, 'out', 'readings_clean.csv'), cleanCsv);
const sha = (text) => createHash('sha256').update(text).digest('hex');

const COPY = {
  en: {
    projectSensors: 'Sensor Data Cleaning',
    projectReport: 'Quarterly Report',
    lblClaude: 'Cleaning Window',
    lblCodex1: 'Review Window',
    lblCodex2: 'Observer Window',
    lblAgy: 'Handoff Summary',
    lblGrokPending: 'Verification Bot',
    lblClaudeReport: 'Report Drafting',
    lblOld: 'Previous Window',
    lblGrokHost: 'Main Bot',
    convTitle: 'Sensor CSV Cleaning & Handoff',
    convPurpose: 'Clean 12 raw sensor rows, normalize timestamps to UTC, verify independently, and publish a handoff summary.',
    conv2Title: 'July Anomaly Investigation',
    conv3Title: 'Q3 Draft Report',
    goal: 'Clean the 12 raw sensor rows into a verified UTC dataset and deliver a traceable handoff summary.',
    opStart: 'Task **DATA-014** started. Source file is `raw/readings.csv` (12 rows). Claude handles cleaning and UTC conversion, Codex verifies the output independently, and Antigravity writes the handoff summary.',
    rawName: 'Raw Readings',
    rawSummary: 'Registered input dataset: 12 rows including duplicates, one missing value, and one invalid timestamp format.',
    prog1Stage: 'Required field check',
    prog1Summary: 'Checked required measurement fields and dropped 1 row with a missing value.',
    prog2Stage: 'Timestamp validation and deduplication',
    prog2Summary: 'Converted timestamps to UTC and deduplicated by device and normalized timestamp.',
    cleanName: 'Cleaned Readings',
    cleanSummary: 'Cleaning complete: 12 raw rows reduced to 8 UTC rows.',
    prog3Stage: 'Cleaning',
    prog3Summary: 'Cleaning finished and output artifact registered.',
    handoffBody: [
      'Cleaning output is ready for review.',
      '',
      '**Processing Steps**',
      '1. Required fields: dropped 1 row missing `value_ugm3`.',
      '2. Timestamp parsing: dropped 1 row with an invalid format (`2026/07/01 11:00`).',
      '3. Deduplication by device and UTC timestamp: dropped 2 duplicate rows.',
      '',
      '**Summary**',
      '- Row count: 12 raw rows to 8 clean rows (4 removed across non-overlapping checks).',
      '- Timezone: standardized to UTC (`2026-07-01T09:00:00+08:00` maps to `2026-07-01T01:00:00Z`).',
      '- Unit: ug/m3 unchanged.',
      '- Sort order: device ascending, timestamp ascending.',
      '',
      '```',
      'device,time_utc,value_ugm3',
      'A1,2026-07-01T01:00:00Z,12.4',
      'A1,2026-07-01T02:00:00Z,13.1',
      '...',
      '```',
      '',
      'Artifact registered at `out/readings_clean.csv` with digest metadata above.',
    ].join('\n'),
    codexAck: 'Received. Reading the output artifact independently to verify row count, key uniqueness, and reference timestamps.',
    agyWait: 'Waiting for the review decision before drafting the handoff summary.',
    claudeNote: 'Note: `B2` at 10:00 (+08:00) and `02:00Z` represent the same instant; one row was kept after deduplication.',
    reviewStage: 'Independent review',
    reviewSummary: (ok) => `Verified artifact from disk: 8 rows, unique keys, SHA-256 ${ok ? 'matches' : 'mismatches'} recorded digest.`,
    reviewDecision: 'Review passed. Verified 8 rows, unique device-UTC keys, reference timestamp `2026-07-01T01:00:00Z`, and matching file digest. Ready for the handoff summary.',
    aside1: 'For Review Window only: `C3` at 12:00 dropped noticeably below the prior three hours. Should we flag it for inspection? This does not block the current handoff.',
    aside2: 'No flag needed; that drop stays within the normal drift range for C3.',
    agyFailStage: 'Draft handoff summary',
    agyFailSummary: 'Drafting failed because `out/readings_clean.csv` was locked during read; retrying shortly.',
    agySummary: 'Retry succeeded. Handoff summary: `raw/readings.csv` (12 rows) was cleaned into `out/readings_clean.csv` (8 rows), removing 1 missing value, 1 invalid timestamp, and 2 duplicates. All timestamps are normalized to UTC with values in ug/m3. Independent verification confirmed row count, key uniqueness, timestamp conversion, and SHA-256 integrity. Apply the same ordering when appending remaining July dates.',
    agyWaitSummary: 'Summary posted and awaiting operator confirmation before archival.',
    fwdNote: 'Worth mentioning in the handoff summary',
    t1Title: 'Clean raw readings and normalize to UTC',
    t1Detail: 'Input raw/readings.csv, output out/readings_clean.csv.',
    t1Note: 'Reduced 12 rows to 8; output artifact registered.',
    t2Title: 'Verify row count, key uniqueness, and file digest',
    t2Note: 'Verification passed.',
    t3Title: 'Write handoff summary',
    t3Note: 'Draft posted; waiting for operator sign-off.',
    t4Title: 'Process remaining July dates',
    t4Detail: 'Use identical cleaning rules to keep series comparable.',
    t4Note: 'Waiting on next batch of raw files.',
    t5Title: 'Confirm whether C3 12:00 reading needs annotation',
    lobby1: 'Cleaning Window online. DATA-014 output is handed off; ping me if you need details on raw records.',
    lobby2: 'Copy that. I am handling the handoff summary once verification completes in DATA-014.',
    lobbyOp: 'Use the lobby for project-wide updates; keep task execution inside dedicated task conversations.',
    dm1: 'If anything looks off in the `B2` deduplication during review, message me here first so I can check the raw rows.',
    dm2: 'Looks solid. Both `B2` rows map to the exact same UTC timestamp.',
    urgentLobby: 'Review flagged `C3` 12:00 as out-of-range; pause citing that row in the summary until rechecked.',
    subBotName: 'data-checker',
    botReq1: 'Check row count and UTC time range of out/readings_clean.csv and report back.',
    botResp1: 'data-checker replied: 8 rows spanning 2026-07-01T01:00:00Z through 04:00:00Z, matching the registered digest.',
    botReqHold: 'Delete the data-checker sub-bot since it is no longer needed.',
    scratchTitle: 'Quick Naming Check',
    scratchPurpose: 'Align device ID formatting',
    scratchMsgs: ['Should device IDs use `A1` or `A-1`?', 'Raw files use `A1` without hyphens everywhere.', 'Confirmed: keep `A1` without hyphens and update the docs.'],
    archTitle: 'Schema Field Alignment',
    archPurpose: 'Completed',
    archMsg: 'Field names aligned; archiving this thread.',
    propTitle: 'Remaining July Sensor Cleaning',
    propGoal: 'Apply the DATA-014 pipeline to the rest of July.',
  },
  zh: {
    projectSensors: '传感器数据清洗',
    projectReport: '季度报告',
    lblClaude: '清洗窗口',
    lblCodex1: '复核窗口',
    lblCodex2: '第二窗口（旁观）',
    lblAgy: '交接摘要',
    lblGrokPending: '校验问询',
    lblClaudeReport: '报告撰写窗口',
    lblOld: '上周的旧窗口',
    lblGrokHost: '主 Bot',
    convTitle: '传感器 CSV 清洗与交接',
    convPurpose: '清洗 12 行原始读数，统一到 UTC，经独立复核后整理交接摘要。',
    conv2Title: '七月读数异常排查',
    conv3Title: '第三季度报告初稿',
    goal: '将 12 行原始读数清洗为可复核的 UTC 数据集，经独立校验后输出交接摘要。',
    opStart: '任务 **DATA-014** 启动。原始文件为 `raw/readings.csv`（共 12 行）。请 Claude 完成清洗与时区转换，Codex 复核窗口独立校验，Antigravity 输出交接摘要。',
    rawName: '原始读数',
    rawSummary: '已登记输入文件：12 行，含重复记录、1 行缺测和 1 行非法时间戳。',
    prog1Stage: '必填字段检查',
    prog1Summary: '完成必填测量值检查，剔除 1 行缺测记录。',
    prog2Stage: '时间戳校验与去重',
    prog2Summary: '全部时间戳已转为 UTC，并按设备与标准化时间去重。',
    cleanName: '清洗后读数',
    cleanSummary: '清洗完成：12 行整理为 8 行，时间戳统一为 UTC。',
    prog3Stage: '清洗',
    prog3Summary: '清洗完成并已登记输出产物。',
    handoffBody: [
      '清洗结果已交接，请复核。',
      '',
      '**处理步骤**',
      '1. 必填字段检查：剔除 1 行缺少测量值的记录。',
      '2. 时间戳校验：剔除 1 行格式无效的时间戳（`2026/07/01 11:00`）。',
      '3. 按设备和 UTC 时间去重：剔除 2 行重复记录。',
      '',
      '**处理结果**',
      '- 行数：12 行降至 8 行，共剔除 4 行，各项计数互不重叠。',
      '- 时区：全部转换为 UTC，参照点 `2026-07-01T09:00:00+08:00` 对应 `2026-07-01T01:00:00Z`。',
      '- 单位：保持 ug/m3。',
      '- 排序：按设备升序、时间升序排列。',
      '',
      '```',
      'device,time_utc,value_ugm3',
      'A1,2026-07-01T01:00:00Z,12.4',
      'A1,2026-07-01T02:00:00Z,13.1',
      '...',
      '```',
      '',
      '产物路径为 `out/readings_clean.csv`，校验摘要见上方产物卡片。',
    ].join('\n'),
    codexAck: '收到，开始独立读取产物并核对行数、主键唯一性和参照时间点。',
    agyWait: '待复核结论确认后开始撰写交接摘要。',
    claudeNote: '补充：`B2` 的 10:00（+08:00）与 `02:00Z` 对应同一时刻，去重后保留一条。',
    reviewStage: '独立复核',
    reviewSummary: (ok) => `已读取磁盘产物并重新校验：8 行，主键唯一，SHA-256 与登记值${ok ? '一致' : '不一致'}。`,
    reviewDecision: '复核通过。已确认 8 行记录、设备与 UTC 时间组合唯一、参照时间点为 `2026-07-01T01:00:00Z`，文件摘要一致，可进入交接摘要阶段。',
    aside1: '仅发给复核窗口：`C3` 的 12:00 读数较前三小时偏低，是否需要单独标注观察？不影响当前交接。',
    aside2: '无需额外标注，该变化在设备正常波动范围内。',
    agyFailStage: '生成交接摘要',
    agyFailSummary: '读取 `out/readings_clean.csv` 时文件被占用，稍后重试。',
    agySummary: '重试完成。交接摘要：本次将 `raw/readings.csv` 中的 12 行原始读数清洗为 `out/readings_clean.csv` 中的 8 行有效记录，依次剔除缺测 1 行、非法时间戳 1 行与重复记录 2 行；全部时间已统一为 UTC，单位保持 ug/m3。复核方已独立确认行数、主键唯一性、参照时间点和文件摘要，结论为通过。后续追加七月其余日期数据时沿用相同处理顺序。',
    agyWaitSummary: '摘要已发送，等待操作员确认归档。',
    fwdNote: '撰写摘要时可顺带说明',
    t1Title: '清洗原始读数并统一为 UTC',
    t1Detail: '输入 raw/readings.csv，输出 out/readings_clean.csv。',
    t1Note: '12 行清洗为 8 行，产物已登记。',
    t2Title: '独立复核行数、主键唯一性与文件摘要',
    t2Note: '复核通过。',
    t3Title: '撰写交接摘要',
    t3Note: '初稿已发出，待操作员确认。',
    t4Title: '补充七月其余日期数据',
    t4Detail: '沿用同一清洗顺序，保持口径一致。',
    t4Note: '等待下一批原始文件。',
    t5Title: '确认 C3 设备 12:00 读数是否需要标注',
    lobby1: '清洗窗口已上线。DATA-014 清洗结果已交接，如需原始文件细节可直接联系。',
    lobby2: '收到，复核结论出来后我会在 DATA-014 里提交交接摘要。',
    lobbyOp: '公共频道用于项目内同步通知，具体任务请在对应任务对话中推进。',
    dm1: '复核 `B2` 去重结果时如有疑问请先私聊我，我核对原始行后再回公屏。',
    dm2: '已核对，`B2` 两条记录确为同一时刻。',
    urgentLobby: '复核发现 `C3` 设备 12:00 读数超出量程，摘要请暂缓引用该行。',
    subBotName: '数据核对',
    botReq1: '核对 out/readings_clean.csv 的行数和时间范围并回报结果。',
    botResp1: '数据核对回复：共 8 行，时间范围 2026-07-01T01:00:00Z 至 04:00:00Z，与登记一致。',
    botReqHold: '删除数据核对子 Bot，当前已不再使用。',
    scratchTitle: '临时讨论',
    scratchPurpose: '核对设备编号格式',
    scratchMsgs: ['设备编号统一采用 `A1` 还是 `A-1`？', '原始文件全部采用不带短横线的 `A1`。', '确认采用 `A1`，文档同步更新。'],
    archTitle: '接口字段对齐',
    archPurpose: '已完成',
    archMsg: '字段已对齐，归档此对话。',
    propTitle: '七月其余日期数据清洗',
    propGoal: '沿用 DATA-014 流程清洗七月其余日期读数。',
  },
}[lang];

// ---- service ---------------------------------------------------------------
const service = spawn(process.execPath, [join(repoRoot, 'src', 'mcp', 'server.mjs'), '--data-dir', dataDir, '--mcp-port', mcpPort, '--core-port', corePort], { stdio: 'inherit' });
service.on('exit', (code) => process.exit(code ?? 0));
for (let attempt = 0; ; attempt += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${mcpPort}/healthz`)).ok) {
      break;
    }
  } catch {
    if (attempt > 150) {
      throw new Error('service failed to start');
    }
  }
  await new Promise((done) => setTimeout(done, 100));
}
const adminToken = readFileSync(join(dataDir, 'admin-token.txt'), 'utf8').trim();

async function admin(method, path, body) {
  const response = await fetch(`${coreUrl}${path}`, { method, headers: { 'content-type': 'application/json', 'x-acm-admin-token': adminToken }, body: body === undefined ? undefined : JSON.stringify(body) });
  const envelope = await response.json();
  if (!envelope.ok) {
    throw new Error(`${method} ${path}: ${envelope.error.code} ${envelope.error.message}`);
  }
  return envelope.result;
}
async function connect(token) {
  const client = new Client({ name: 'acm-demo', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name}: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent;
}

async function seed() {
  // Lift flood limits while seeding batch demo traffic, then restore defaults below.
  await admin('PUT', '/api/v1/settings', { message_rate_per_minute: 0, message_rate_per_hour: 0 });
  await admin('POST', '/api/v1/projects', { project_id: 'prj_sensors', name: COPY.projectSensors, root_path: projectRoot });
  await admin('POST', '/api/v1/projects', { project_id: 'prj_report', name: COPY.projectReport });
  for (const agent of [
    { agent_id: 'agt_claude', provider: 'anthropic', client_kind: 'claude-desktop', display_name: 'Claude' },
    { agent_id: 'agt_codex', provider: 'openai', client_kind: 'codex-desktop', display_name: 'Codex' },
    { agent_id: 'agt_antigravity', provider: 'google', client_kind: 'antigravity', display_name: 'Antigravity' },
    { agent_id: 'agt_grok', provider: 'xai', client_kind: 'grok-bot', display_name: 'Grok Bot' },
  ]) {
    await admin('POST', '/api/v1/agents', agent);
  }

  const sessions = {};
  const clients = {};
  const tokens = {};
  const pair = async (key, agent, label, project = 'prj_sensors') => {
    const pairing = await admin('POST', '/api/v1/pairings', { agent_id: agent, project_id: project, label });
    sessions[key] = pairing.session_id;
    tokens[key] = pairing.token;
    clients[key] = await connect(pairing.token);
    return pairing;
  };
  const activate = async (key, kind, cwd) => {
    await tool(clients[key], 'request_pairing', { client_kind: kind, cwd, run_id: `pid-${1000 + Object.keys(sessions).length * 137}` });
  };
  await pair('claude', 'agt_claude', COPY.lblClaude);
  await activate('claude', 'claude-desktop', projectRoot);
  await pair('codex1', 'agt_codex', COPY.lblCodex1);
  await activate('codex1', 'codex-desktop', projectRoot);
  await pair('codex2', 'agt_codex', COPY.lblCodex2);
  await activate('codex2', 'codex-desktop', 'C:\\Projects\\other-task');
  await pair('agy', 'agt_antigravity', COPY.lblAgy);
  await activate('agy', 'antigravity', projectRoot);

  // Seed one pending approval, one issued-but-unconnected pairing, and one revoked session.
  await admin('PUT', '/api/v1/settings', { open_mode: false });
  await pair('grok', 'agt_grok', COPY.lblGrokPending);
  await tool(clients.grok, 'request_pairing', { client_kind: 'grok-bot', cwd: 'C:\\Projects\\bot-workspace', external_session_id: 'grok-thread-7f3a91' });
  await admin('PUT', '/api/v1/settings', { open_mode: true });
  await pair('claude2', 'agt_claude', COPY.lblClaudeReport, 'prj_report');
  const old = await pair('old', 'agt_codex', COPY.lblOld);
  await activate('old', 'codex-desktop', projectRoot);
  await admin('POST', `/api/v1/sessions/${old.session_id}/revoke`);

  const conversation = await admin('POST', '/api/v1/conversations', { project_id: 'prj_sensors', task_code: 'DATA-014', title: COPY.convTitle, purpose: COPY.convPurpose });
  const id = conversation.conversation_id;
  await admin('PUT', `/api/v1/conversations/${id}/members`, {
    expected_version: 1,
    members: [
      { session_id: sessions.claude },
      { session_id: sessions.codex1 },
      { session_id: sessions.codex2, can_write: false },
      { session_id: sessions.agy },
    ],
  });
  await admin('POST', '/api/v1/conversations', { project_id: 'prj_sensors', task_code: 'DATA-015', title: COPY.conv2Title });
  await admin('POST', '/api/v1/conversations', { project_id: 'prj_report', task_code: 'RPT-003', title: COPY.conv3Title });
  await admin('PUT', `/api/v1/conversations/${id}/goal`, { goal: COPY.goal });

  let n = 0;
  const key = () => `demo-${++n}`;
  const send = (who, body, extra = {}) => tool(clients[who], 'send_message', { conversation_id: id, body, idempotency_key: key(), ...extra });

  await admin('POST', `/api/v1/conversations/${id}/messages`, { body: COPY.opStart, kind: 'handoff', idempotency_key: key() });

  const rawArtifact = await tool(clients.claude, 'publish_artifact', { conversation_id: id, name: COPY.rawName, relative_path: 'raw\\readings.csv', direction: 'input', format: 'csv', row_count: 12, unit: 'ug/m3', timezone: 'Asia/Shanghai', summary: COPY.rawSummary, idempotency_key: key() });
  await tool(clients.claude, 'report_progress', { conversation_id: id, stage: COPY.prog1Stage, run_state: 'running', summary: COPY.prog1Summary, percent: 35, count_done: 4, count_total: 12, artifact_ids: [rawArtifact.payload.artifact_id], idempotency_key: key() });
  await tool(clients.claude, 'report_progress', { conversation_id: id, stage: COPY.prog2Stage, run_state: 'running', summary: COPY.prog2Summary, percent: 80, count_done: 10, count_total: 12, idempotency_key: key() });
  const cleanArtifact = await tool(clients.claude, 'publish_artifact', { conversation_id: id, name: COPY.cleanName, relative_path: 'out\\readings_clean.csv', direction: 'output', format: 'csv', sha256: sha(cleanCsv), row_count: 8, unit: 'ug/m3', timezone: 'UTC', summary: COPY.cleanSummary, idempotency_key: key() });
  await tool(clients.claude, 'report_progress', { conversation_id: id, stage: COPY.prog3Stage, run_state: 'completed', summary: COPY.prog3Summary, percent: 100, count_done: 12, count_total: 12, artifact_ids: [cleanArtifact.payload.artifact_id], idempotency_key: key() });

  const handoff = await send('claude', COPY.handoffBody, { kind: 'handoff' });

  await Promise.all([
    send('codex1', COPY.codexAck, { reply_to_message_id: handoff.message_id }),
    send('agy', COPY.agyWait),
    send('claude', COPY.claudeNote),
  ]);

  await tool(clients.codex1, 'read_messages', { conversation_id: id, after_seq: 0, limit: 200 });
  await tool(clients.codex1, 'acknowledge_message', { message_id: handoff.message_id });
  await tool(clients.agy, 'read_messages', { conversation_id: id, after_seq: 0, limit: 200 });
  const verified = await tool(clients.codex1, 'get_artifact', { artifact_id: cleanArtifact.payload.artifact_id });
  await tool(clients.codex1, 'report_progress', { conversation_id: id, stage: COPY.reviewStage, run_state: 'completed', summary: COPY.reviewSummary(verified.current.matches_recorded_sha256), percent: 100, artifact_ids: [cleanArtifact.payload.artifact_id], idempotency_key: key() });
  await send('codex1', COPY.reviewDecision, { kind: 'decision', reply_to_message_id: handoff.message_id });

  const aside = await send('claude', COPY.aside1, { recipient_session_ids: [sessions.codex1] });
  await send('codex1', COPY.aside2, { recipient_session_ids: [sessions.claude] });

  await tool(clients.agy, 'report_progress', { conversation_id: id, stage: COPY.agyFailStage, run_state: 'failed', summary: COPY.agyFailSummary, idempotency_key: key() });
  await send('agy', COPY.agySummary);
  await tool(clients.agy, 'report_progress', { conversation_id: id, stage: COPY.agyFailStage, run_state: 'waiting', summary: COPY.agyWaitSummary, idempotency_key: key() });

  await tool(clients.codex1, 'forward_message', { message_id: aside.message_id, recipient_session_ids: [sessions.agy], note: COPY.fwdNote, idempotency_key: key() });

  const cleaning = await tool(clients.claude, 'create_task', { conversation_id: id, title: COPY.t1Title, detail: COPY.t1Detail, assignee_session_id: 'me' });
  await tool(clients.claude, 'update_task', { task_id: cleaning.task_id, status: 'done', note: COPY.t1Note });
  const review = await tool(clients.codex1, 'create_task', { conversation_id: id, title: COPY.t2Title, assignee_session_id: 'me' });
  await tool(clients.codex1, 'update_task', { task_id: review.task_id, status: 'done', note: COPY.t2Note });
  const summary = await tool(clients.agy, 'create_task', { conversation_id: id, title: COPY.t3Title, assignee_session_id: 'me' });
  await tool(clients.agy, 'update_task', { task_id: summary.task_id, note: COPY.t3Note });
  const more = await tool(clients.codex1, 'create_task', { conversation_id: id, title: COPY.t4Title, detail: COPY.t4Detail, assignee_session_id: 'me' });
  await tool(clients.codex1, 'update_task', { task_id: more.task_id, status: 'blocked', note: COPY.t4Note });
  await tool(clients.claude, 'create_task', { conversation_id: id, title: COPY.t5Title });

  const lobby = (await tool(clients.claude, 'list_conversations', {})).conversations.find((entry) => entry.kind === 'lobby');
  await tool(clients.claude, 'send_message', { conversation_id: lobby.conversation_id, body: COPY.lobby1, idempotency_key: key() });
  await tool(clients.agy, 'send_message', { conversation_id: lobby.conversation_id, body: COPY.lobby2, idempotency_key: key() });
  await admin('POST', `/api/v1/conversations/${lobby.conversation_id}/messages`, { body: COPY.lobbyOp, idempotency_key: key() });
  await tool(clients.claude, 'direct_message', { to_session_id: sessions.codex1, body: COPY.dm1, idempotency_key: key() });
  await tool(clients.codex1, 'direct_message', { to_session_id: sessions.claude, body: COPY.dm2, idempotency_key: key() });

  const hook = async (who, body) => {
    const response = await fetch(`${coreUrl}/internal/v1/hook`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` }, body: JSON.stringify(body) });
    if (!response.ok) {
      throw new Error(`hook ${body.event} for ${who}: HTTP ${response.status}`);
    }
  };
  // The Claude conversation is open before the urgent message arrives: a window is
  // only interrupted by what was sent while it existed.
  await hook('claude', { event: 'start', client: 'claude', client_session: 'demo-claude-conversation', cwd: projectRoot });
  // Urgent interrupts whom it names: here the Claude session, whose conversation is then continued.
  await tool(clients.codex1, 'send_message', { conversation_id: lobby.conversation_id, body: COPY.urgentLobby, urgent: true, recipient_session_ids: [sessions.claude], idempotency_key: key() });
  await hook('claude', { event: 'stop', client: 'claude', client_session: 'demo-claude-conversation', cwd: projectRoot });
  await hook('claude', { event: 'watch', client: 'claude', client_session: 'demo-claude-conversation', watch_id: 'demo-watcher', fresh: true });
  await hook('agy', { event: 'prompt', client: 'antigravity', client_session: 'demo-antigravity-conversation' });
  await admin('PUT', `/api/v1/sessions/${sessions.codex2}`, { linked: false });

  await pair('grokhost', 'agt_grok', COPY.lblGrokHost);
  await activate('grokhost', 'grok-bot', projectRoot);
  await tool(clients.grokhost, 'bot_pull', {});
  const asked = await tool(clients.codex1, 'bot_request', { action: 'send_to_bot', bot: COPY.subBotName, text: COPY.botReq1, idempotency_key: key() });
  await tool(clients.grokhost, 'bot_pull', {});
  await tool(clients.grokhost, 'bot_respond', { request_id: asked.request_id, result: COPY.botResp1 });
  await tool(clients.claude, 'bot_request', { action: 'ask', text: COPY.botReqHold, idempotency_key: key() });

  const scratch = await admin('POST', '/api/v1/conversations', { project_id: 'prj_sensors', task_code: 'TMP-01', title: COPY.scratchTitle, purpose: COPY.scratchPurpose });
  for (const body of COPY.scratchMsgs) {
    await admin('POST', `/api/v1/conversations/${scratch.conversation_id}/messages`, { body, idempotency_key: key() });
  }
  const finished = await admin('POST', '/api/v1/conversations', { project_id: 'prj_sensors', task_code: 'TMP-02', title: COPY.archTitle, purpose: COPY.archPurpose });
  await admin('POST', `/api/v1/conversations/${finished.conversation_id}/messages`, { body: COPY.archMsg, idempotency_key: key() });
  await admin('PUT', `/api/v1/conversations/${finished.conversation_id}`, { archived: true });

  await tool(clients.codex1, 'propose_conversation', { task_code: 'DATA-016', title: COPY.propTitle, goal: COPY.propGoal, member_session_ids: [sessions.claude] });

  for (const client of Object.values(clients)) {
    await client.close().catch(() => undefined);
  }
  await admin('PUT', '/api/v1/settings', { message_rate_per_minute: 12, message_rate_per_hour: 120 });
  console.log(`[OK] demo data created (lang=${lang}): DATA-014, lobby, direct thread, tasks, bot requests, and pending approvals`);
}

const state = await admin('GET', '/api/v1/bootstrap');
if (state.projects.length === 0) {
  await seed();
} else {
  console.log('[OK] demo data already present; run with --fresh to recreate it');
}
console.log(`[OK] open the console: ${coreUrl}/#token=${adminToken}`);
console.log('[OK] stop it from another terminal with: node scripts/acm-admin.mjs stop --data-dir .data/demo');

async function shutdown() {
  await fetch(`http://127.0.0.1:${mcpPort}/shutdown`, { method: 'POST', headers: { 'x-acm-admin-token': adminToken } }).catch(() => service.kill());
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
