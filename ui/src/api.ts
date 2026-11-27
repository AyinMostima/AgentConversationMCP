// Typed client for the operator API (/api/v1) and its committed-event stream.

export interface Project {
  project_id: string;
  name: string;
  root_path: string | null;
  created_at: string;
}

export interface Agent {
  agent_id: string;
  provider: string;
  client_kind: string;
  display_name: string;
  created_at: string;
}

export type SessionStatus = 'pending' | 'requested' | 'active' | 'revoked' | 'expired';

export interface Session {
  session_id: string;
  agent_id: string;
  project_id: string;
  label: string;
  status: SessionStatus;
  binding_version: number;
  pairing_expires_at: string;
  claimed_client_kind: string | null;
  claimed_cwd: string | null;
  claimed_run_id: string | null;
  external_session_id: string | null;
  created_at: string;
  requested_at: string | null;
  approved_at: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
  /** Takes part in the default interconnection (lobby and direct conversations). */
  linked: boolean;
  /** Not subject to the flood limits. */
  rate_exempt: boolean;
  /** When it last asked for bot requests; null when it never listened. */
  host_seen_at: string | null;
  /** How many tools its bridge offered when it last started; null when it has not said. */
  bridge_tools: number | null;
  /** It registered itself, which only a bridge does. */
  self_enrolled: boolean;
  /** Version of the tool contract its bridge offered when it last started; null when it has not said. */
  bridge_contract: number | null;
  /** Whether its bridge takes the tool list from the service: such a bridge follows updates without a restart. */
  bridge_relay: boolean;
  /** An urgent message may interrupt this session: continue its turn, or wake it while idle. */
  urgent_dispatch: boolean;
  /** Present only in the response that creates the pairing. */
  token?: string;
}

export interface Member {
  session_id: string;
  role: string;
  can_read: boolean;
  can_write: boolean;
  agent_id: string;
  label: string;
  session_status: SessionStatus;
  provider: string;
  display_name: string;
}

export interface Conversation {
  conversation_id: string;
  project_id: string;
  task_code: string;
  title: string;
  purpose: string | null;
  /** archived: put away by the operator; sessions do not see it and nobody can write to it. */
  status: 'open' | 'archived';
  config_version: number;
  last_seq: number;
  created_at: string;
  /** How many messages it holds, when the last one was written, and how many tasks are not finished. */
  message_count: number;
  last_message_at: string | null;
  open_tasks: number;
  goal: string | null;
  goal_updated_at: string | null;
  /** topic: opened by the operator. lobby: every linked session. direct: two sessions. */
  kind: 'topic' | 'lobby' | 'direct';
  /** What a reader that is behind gets in place of the history. */
  digest: { text: string; upto_seq: number; written_at: string; by: string } | null;
  /** How many messages compacting kept in front of readers, or took out of what is read into a context. */
  context_counts: { kept: number; dropped: number; resolved: number };
  members: Member[];
  /** Direct conversations only: sessions of the pair that are currently out, and why. */
  former_members?: { session_id: string; label: string; display_name: string; removed_reason: 'operator' | 'unlinked' }[];
}

/** One act of compacting, from the event log. */
export interface Compaction {
  at: string;
  by: string;
  upto_seq: number;
  digest_bytes: number;
  kept: number;
  dropped: number;
  resolved: number;
  restored: number;
}

/** Counts for the overview; never any text of a conversation. */
export interface Stats {
  days: number;
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  messages: number;
  urgent: number;
  active_windows: number;
  series: { at: string; messages: number; urgent: number }[];
  senders: { name: string; label: string | null; provider: string | null; messages: number }[];
  windows: { name: string; app: string; messages: number }[];
  /** `members`: who talks there (display names), which tells direct conversations apart. */
  conversations: { conversation_id: string; kind: Conversation['kind']; title: string; task_code: string; messages: number; members: string }[];
  deliveries: Record<'ok' | 'failed' | 'skipped' | 'running', number>;
  delivery_routes: Record<string, Record<'ok' | 'failed' | 'skipped' | 'running', number>>;
  tasks: Record<TaskStatus, number>;
}

/** One digest a conversation was given; `current` is the one readers get. */
export interface DigestEntry {
  digest_id: number;
  text: string;
  upto_seq: number;
  written_at: string;
  by: string;
  current: boolean;
}

export interface CompactBody {
  summary?: string;
  upto_seq?: number;
  keep?: number[];
  drop?: number[];
  resolve?: number[];
  restore?: number[];
}

export type ReceiptStatus = 'available' | 'read' | 'acknowledged';

export interface Receipt {
  session_id: string;
  status: ReceiptStatus;
  read_at: string | null;
  acknowledged_at: string | null;
}

export type MessageKind = 'message' | 'handoff' | 'decision' | 'progress' | 'artifact' | 'system';

export interface Message {
  message_id: string;
  conversation_id: string;
  sequence: number;
  kind: MessageKind;
  body: string;
  payload: Record<string, unknown> | null;
  reply_to_message_id: string | null;
  directed: boolean;
  /** Marked urgent by its sender: it interrupts its readers instead of waiting for their next turn. */
  urgent: boolean;
  /** Compacting kept it in front of readers, or took it out of what is read into a context. */
  context: 'kept' | 'dropped' | 'resolved' | null;
  /** The window that wrote it, when known, and the windows it is meant for (empty: all of them). */
  from_window: { window_id: string; name: string } | null;
  to_windows: { window_id: string; name: string }[];
  forwarded_from: string | null;
  created_at: string;
  sender: {
    kind: 'agent' | 'operator' | 'system';
    session_id: string | null;
    agent_id: string | null;
    label: string | null;
    provider: string | null;
    display_name: string | null;
    /** The model that wrote it, as far as it was known when it was written. */
    model: string | null;
  };
  recipients: Receipt[];
}

/** What one sender wrote, newest first, across conversations. */
export interface SenderHistory {
  messages: (Message & { conversation: { kind: Conversation['kind']; title: string; task_code: string; status: Conversation['status'] } })[];
  has_more: boolean;
  next_before: number | null;
  total: number;
}

export interface MessagePage {
  messages: Message[];
  next_cursor: number;
  has_more: boolean;
  last_seq: number;
}

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled';

export interface Task {
  task_id: string;
  conversation_id: string;
  number: number;
  title: string;
  detail: string | null;
  status: TaskStatus;
  assignee: { session_id: string; label: string; display_name: string } | null;
  created_by: string | null;
  updated_by: string | null;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Proposal {
  proposal_id: string;
  project_id: string;
  proposer_session_id: string;
  task_code: string;
  title: string;
  purpose: string | null;
  goal: string | null;
  member_session_ids: string[];
  status: 'pending' | 'approved' | 'rejected';
  conversation_id: string | null;
  created_at: string;
  decided_at: string | null;
  proposer: { label: string; display_name: string; provider: string };
}

export type BotRequestStatus = 'held' | 'queued' | 'taken' | 'done' | 'failed' | 'rejected';

/** Something one session asked of the session that hosts bots. */
export interface BotRequest {
  request_id: string;
  action: 'ask' | 'list_bots' | 'create_bot' | 'send_to_bot' | 'get_transcript';
  bot: string | null;
  text: string | null;
  status: BotRequestStatus;
  hold_reason: string | null;
  result: string | null;
  created_at: string;
  taken_at: string | null;
  finished_at: string | null;
  requester: { session_id: string; label: string; display_name: string };
  host: { session_id: string; label: string; display_name: string; last_listened_at: string | null };
}

/** Where a session is signalled that work waits for it. The key is write-only. */
export interface WakeHook {
  session_id: string;
  url: string;
  enabled: boolean;
  has_key: boolean;
  last_attempt_at: string | null;
  last_status: 'sending' | 'ok' | 'failed' | null;
  last_detail: string | null;
  last_ok_at: string | null;
  test_requested: boolean;
  attempts: number;
  /** The signal also carries the waiting instructions themselves. */
  include_text: boolean;
}

/** What a desktop client's own hooks reported: that they run, and what they put into its conversation. */
export interface DeliveryRecord {
  at: string;
  route: 'start' | 'prompt' | 'stop' | 'watch' | 'command';
  status: 'running' | 'ok' | 'failed';
  messages: number;
  urgent: number;
  detail: string | null;
}

/** One conversation of an application: what others address and wake. */
export interface WindowInfo {
  window_id: string;
  name: string;
  state: 'idle' | 'busy' | 'watching';
  last_active_at: string;
  cwd: string | null;
  is_you: boolean;
  /** Which model is at work there, when it is known. */
  model?: string | null;
  /** What its client shows as the title of the conversation, when known. */
  title: string | null;
  /** Known from its client's own record only; woken when a message names it. */
  imported: boolean;
}

export interface ClientHook {
  session_id: string;
  /** The conversations of this application that were used in the last day. */
  windows: WindowInfo[];
  /** Whether any of them ran a hook; tool calls alone also make a window known. */
  hooked: boolean;
  client: string;
  /** The last point of the conversation the client reported. */
  event: 'start' | 'prompt' | 'stop';
  seen_at: string;
  knows_conversation: boolean;
  cwd: string | null;
  runs: number;
  /** When a background watcher of this session last asked; null when none ever ran. */
  watch_seen_at: string | null;
  last_delivery: DeliveryRecord | null;
  last_urgent: DeliveryRecord | null;
}

/** Remote access to this console through an ngrok tunnel. The authtoken is write-only. */
export interface RemoteAccess {
  enabled: boolean;
  has_authtoken: boolean;
  /** The name the tunnel asks for when no domain is given: this installation's own. */
  default_domain: string;
  /** Online at the address ngrok assigned, because the account may not use the name asked for. */
  domain_fallback: boolean;
  domain: string | null;
  state: 'stopped' | 'starting' | 'online' | 'error';
  public_url: string | null;
  detail: string | null;
  /** The optional ngrok component: installed on request, into the data directory. */
  component: 'missing' | 'installing' | 'installed' | 'failed';
  component_detail: string | null;
}

export interface ServiceInfo {
  mcp_url?: string;
  stdio_entry?: string;
  /** The bridge entry followed by this instance's data directory and ports. */
  stdio_args?: string[];
  node_path?: string;
  version?: string;
}

export interface Bootstrap {
  projects: Project[];
  agents: Agent[];
  /** Avatars the operator replaced, as slot (a provider, or "operator") to version. */
  avatars: Record<string, string>;
  conversations: Conversation[];
  sessions: Session[];
  proposals: Proposal[];
  settings: { open_mode: boolean; message_rate_per_minute: number; message_rate_per_hour: number; duplicate_window_seconds: number; urgent_per_hour: number; shared_rules: string; shared_rules_at: string; avatars_enabled: boolean; operator_name: string; alerts_enabled: boolean; grok_bot_id: string };
  bot_requests: BotRequest[];
  wake_hooks: WakeHook[];
  client_hooks: ClientHook[];
  /** Clients the service can hand an urgent message to while they are idle. */
  dispatch_clients: string[];
  /** Clients that have used up their quota: nothing is started for them until `until`. */
  client_limits?: Record<string, { until: string; detail: string; noted_at: string }>;
  remote_access: RemoteAccess;
  /** The operator's account for signing in, when one was made. */
  account: { username: string } | null;
  /** How this page is signed in: with the account, or with the installation's credential. */
  authority: 'login' | 'credential';
  /** How many tools a current bridge offers. */
  tool_count: number;
  /** Version of the tool contract a current bridge offers. */
  tool_contract: number;
  event_watermark: number;
  schema_version: number;
  service: ServiceInfo;
}

export interface EventRecord {
  event_id: number;
  event_type: string;
  occurred_at: string;
  project_id: string | null;
  conversation_id: string | null;
  actor_id: string | null;
  correlation_id: string | null;
  entity_id: string;
  payload: Record<string, unknown>;
}

/** A business error returned by the service, with its stable code. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** What the sign-in page needs before anybody is known. */
export interface LoginStatus {
  /** Whether the operator made an account. */
  account: boolean;
  /** Whether one can be made here without signing in: only the first, only on the machine itself. */
  setup_allowed: boolean;
}

/** A login of the operator's account: presented like the credential, good for 30 days after its last use. */
export interface Login {
  token: string;
  expires_at: string;
  username: string;
}

async function plainCall<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-acm-admin-token': token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await response.json();
  if (!envelope.ok) {
    throw new ApiError(envelope.error.code, envelope.error.message, response.status, envelope.error.details ?? {});
  }
  return envelope.result as T;
}

export const loginStatus = (): Promise<LoginStatus> => plainCall('GET', '/api/v1/login');
export const signInWithAccount = (username: string, password: string): Promise<Login> => plainCall('POST', '/api/v1/login', { username, password });
/** Makes the first account. Works without signing in only on the machine the service runs on. */
export const createAccount = (username: string, password: string): Promise<Login> => plainCall('PUT', '/api/v1/account', { username, password });

export interface Api {
  bootstrap(): Promise<Bootstrap>;
  /** Changes the account. Signed in with the account, the current password is needed. */
  setAccount(body: { username?: string; password: string; current_password?: string }): Promise<Login>;
  /** Ends this login, or every login of the account. */
  signOut(all?: boolean): Promise<unknown>;
  createProject(body: { name: string; root_path?: string }): Promise<Project>;
  createAgent(body: { agent_id?: string; provider: string; client_kind: string; display_name: string }): Promise<Agent>;
  createPairing(body: { agent_id: string; project_id: string; label: string }): Promise<Session>;
  approvePairing(sessionId: string): Promise<Session>;
  revokeSession(sessionId: string): Promise<Session>;
  setOpenMode(enabled: boolean): Promise<Bootstrap['settings']>;
  setLinked(sessionId: string, linked: boolean): Promise<Session>;
  setRateExempt(sessionId: string, exempt: boolean): Promise<Session>;
  setUrgentDispatch(sessionId: string, enabled: boolean): Promise<Session>;
  renameWindow(windowId: string, name: string): Promise<{ window_id: string; name: string }>;
  setAlerts(enabled: boolean): Promise<Bootstrap['settings']>;
  setSharedRules(text: string): Promise<Bootstrap['settings']>;
  setAvatarsEnabled(enabled: boolean): Promise<Bootstrap['settings']>;
  setOperatorName(name: string): Promise<Bootstrap['settings']>;
  renameAgent(agentId: string, name: string): Promise<Agent>;
  /** The file goes up as it is: no resizing, no re-encoding. */
  uploadAvatar(slot: string, file: Blob): Promise<{ slot: string; custom: boolean; version?: string }>;
  removeAvatar(slot: string): Promise<{ slot: string; custom: boolean }>;
  createConversation(body: { project_id: string; task_code: string; title: string; purpose?: string }): Promise<Conversation>;
  updateConversation(conversationId: string, body: { title?: string; task_code?: string; purpose?: string; archived?: boolean }): Promise<Conversation>;
  /** Deletes messages for good: all of them, or those older than that many days. */
  clearConversation(conversationId: string, olderThanDays: number): Promise<Conversation & { deleted_messages: number }>;
  compactConversation(conversationId: string, body: CompactBody): Promise<{ digest: Conversation['digest']; kept_messages: number; dropped_messages: number; resolved_messages: number }>;
  compactions(conversationId: string): Promise<{ compactions: Compaction[] }>;
  digests(conversationId: string): Promise<{ digests: DigestEntry[] }>;
  stats(days: number): Promise<Stats>;
  /** Puts an earlier digest back in use in place of the current one. */
  useDigest(conversationId: string, digestId: number): Promise<{ digest: Conversation['digest']; digests: DigestEntry[] }>;
  deleteConversation(conversationId: string): Promise<{ deleted: boolean; deleted_messages: number; deleted_tasks: number }>;
  setMembers(
    conversationId: string,
    expectedVersion: number,
    members: { session_id: string; can_read: boolean; can_write: boolean }[],
  ): Promise<Conversation>;
  messages(conversationId: string, afterSeq: number, limit: number): Promise<MessagePage>;
  /** `sender` is an agent id, or "operator". */
  senderMessages(sender: string, before: number | null): Promise<SenderHistory>;
  sendMessage(
    conversationId: string,
    body: { body: string; kind: string; recipient_session_ids?: string[]; urgent?: boolean; to_windows?: string[]; idempotency_key: string },
  ): Promise<Message>;
  setGoal(conversationId: string, goal: string | null): Promise<Conversation>;
  tasks(conversationId: string): Promise<{ tasks: Task[] }>;
  createTask(conversationId: string, body: { title: string; detail?: string; assignee_session_id?: string }): Promise<Task>;
  updateTask(taskId: string, body: { status?: TaskStatus; note?: string; assignee_session_id?: string | null; expected_version?: number }): Promise<Task>;
  decideProposal(proposalId: string, approve: boolean): Promise<Proposal>;
  decideBotRequest(requestId: string, approve: boolean): Promise<BotRequest>;
  setWakeHook(sessionId: string, body: { url: string; key?: string; enabled?: boolean; include_text?: boolean }): Promise<WakeHook>;
  setGrokBotId(botId: string): Promise<Bootstrap['settings']>;
  removeWakeHook(sessionId: string): Promise<unknown>;
  testWakeHook(sessionId: string): Promise<WakeHook>;
  setRemoteAccess(body: { enabled?: boolean; authtoken?: string; domain?: string }): Promise<RemoteAccess>;
  installRemoteComponent(): Promise<RemoteAccess>;
  setLimits(body: { message_rate_per_minute: number; message_rate_per_hour: number; duplicate_window_seconds: number; urgent_per_hour: number }): Promise<Bootstrap['settings']>;
  /** Asks the gateway (another port than the one this page is served from) to restart the service. */
  restartService(mcpUrl: string): Promise<void>;
}

export function createApi(token: string): Api {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-acm-admin-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const envelope = await response.json();
    if (!envelope.ok) {
      throw new ApiError(envelope.error.code, envelope.error.message, response.status, envelope.error.details ?? {});
    }
    return envelope.result as T;
  }
  return {
    bootstrap: () => request('GET', '/api/v1/bootstrap'),
    setAccount: (body) => request('PUT', '/api/v1/account', body),
    signOut: (all = false) => request('POST', '/api/v1/logout', { all }),
    createProject: (body) => request('POST', '/api/v1/projects', body),
    createAgent: (body) => request('POST', '/api/v1/agents', body),
    createPairing: (body) => request('POST', '/api/v1/pairings', body),
    approvePairing: (id) => request('POST', `/api/v1/pairings/${id}/approve`),
    revokeSession: (id) => request('POST', `/api/v1/sessions/${id}/revoke`),
    setOpenMode: (enabled) => request('PUT', '/api/v1/settings', { open_mode: enabled }),
    setLinked: (id, linked) => request('PUT', `/api/v1/sessions/${id}`, { linked }),
    setRateExempt: (id, exempt) => request('PUT', `/api/v1/sessions/${id}`, { rate_exempt: exempt }),
    setUrgentDispatch: (id, enabled) => request('PUT', `/api/v1/sessions/${id}`, { urgent_dispatch: enabled }),
    renameWindow: (id, name) => request('PUT', `/api/v1/windows/${id}`, { name }),
    setAlerts: (enabled) => request('PUT', '/api/v1/settings', { alerts_enabled: enabled }),
    setSharedRules: (text) => request('PUT', '/api/v1/settings', { shared_rules: text }),
    setAvatarsEnabled: (enabled) => request('PUT', '/api/v1/settings', { avatars_enabled: enabled }),
    setOperatorName: (name) => request('PUT', '/api/v1/settings', { operator_name: name }),
    renameAgent: (id, name) => request('PUT', `/api/v1/agents/${id}`, { display_name: name }),
    uploadAvatar: async (slot, file) => {
      const response = await fetch(`/api/v1/avatars/${slot}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-acm-admin-token': token }, body: file });
      const envelope = await response.json();
      if (!envelope.ok) {
        throw new ApiError(envelope.error.code, envelope.error.message, response.status, envelope.error.details ?? {});
      }
      return envelope.result;
    },
    removeAvatar: (slot) => request('DELETE', `/api/v1/avatars/${slot}`),
    createConversation: (body) => request('POST', '/api/v1/conversations', body),
    setMembers: (id, expectedVersion, members) =>
      request('PUT', `/api/v1/conversations/${id}/members`, { expected_version: expectedVersion, members }),
    messages: (id, afterSeq, limit) => request('GET', `/api/v1/conversations/${id}/messages?after_seq=${afterSeq}&limit=${limit}`),
    senderMessages: (sender, before) => request('GET', `/api/v1/agents/${encodeURIComponent(sender)}/messages?limit=40${before === null ? '' : `&before=${before}`}`),
    sendMessage: (id, body) => request('POST', `/api/v1/conversations/${id}/messages`, body),
    updateConversation: (id, body) => request('PUT', `/api/v1/conversations/${id}`, body),
    clearConversation: (id, olderThanDays) => request('POST', `/api/v1/conversations/${id}/clear`, olderThanDays > 0 ? { older_than_days: olderThanDays } : {}),
    compactConversation: (id, body) => request('POST', `/api/v1/conversations/${id}/compact`, body),
    compactions: (id) => request('GET', `/api/v1/conversations/${id}/compactions`),
    digests: (id) => request('GET', `/api/v1/conversations/${id}/digests`),
    stats: (days) => request('GET', `/api/v1/stats?days=${days}`),
    useDigest: (id, digestId) => request('PUT', `/api/v1/conversations/${id}/digest`, { digest_id: digestId }),
    deleteConversation: (id) => request('DELETE', `/api/v1/conversations/${id}`),
    setGoal: (id, goal) => request('PUT', `/api/v1/conversations/${id}/goal`, goal === null ? {} : { goal }),
    tasks: (id) => request('GET', `/api/v1/conversations/${id}/tasks`),
    createTask: (id, body) => request('POST', `/api/v1/conversations/${id}/tasks`, body),
    updateTask: (id, body) => request('PUT', `/api/v1/tasks/${id}`, body),
    decideProposal: (id, approve) => request('POST', `/api/v1/proposals/${id}/${approve ? 'approve' : 'reject'}`),
    decideBotRequest: (id, approve) => request('POST', `/api/v1/bot-requests/${id}/${approve ? 'approve' : 'reject'}`),
    setWakeHook: (id, body) => request('PUT', `/api/v1/sessions/${id}/wake-hook`, body),
    removeWakeHook: (id) => request('POST', `/api/v1/sessions/${id}/wake-hook/remove`),
    setGrokBotId: (botId) => request('PUT', '/api/v1/settings', { grok_bot_id: botId }),
    testWakeHook: (id) => request('POST', `/api/v1/sessions/${id}/wake-hook/test`),
    setRemoteAccess: (body) => request('PUT', '/api/v1/remote-access', body),
    installRemoteComponent: () => request('POST', '/api/v1/remote-access/install'),
    setLimits: (body) => request('PUT', '/api/v1/settings', body),
    restartService: async (mcpUrl) => {
      // Opened through the tunnel, the page cannot reach the gateway port of the
      // machine the service runs on; the tunnel's proxy restarts it instead.
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
      const target = local ? `${new URL(mcpUrl).origin}/restart` : '/_gateway/restart';
      const response = await fetch(target, { method: 'POST', headers: { 'x-acm-admin-token': token } });
      if (!response.ok) {
        throw new ApiError(response.status === 401 ? 'ADMIN_REQUIRED' : 'RESTART_FAILED', `the service answered ${response.status}`, response.status, {});
      }
    },
  };
}

/**
 * Follows the committed-event stream, starting after `after`. Resolves when the
 * server closes the stream and rejects on a transport or authorization error;
 * the caller reconnects with the last event id it received.
 */
export async function followEvents(
  token: string,
  after: number,
  onEvent: (event: EventRecord) => void,
  onOpen: () => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/v1/events', {
    headers: { accept: 'text/event-stream', 'x-acm-admin-token': token, 'last-event-id': String(after) },
    signal,
  });
  if (!response.ok || response.body === null) {
    throw new ApiError(response.status === 401 ? 'ADMIN_REQUIRED' : 'STREAM_FAILED', `event stream returned ${response.status}`, response.status, {});
  }
  onOpen();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data !== undefined) {
        onEvent(JSON.parse(data.slice('data: '.length)) as EventRecord);
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
