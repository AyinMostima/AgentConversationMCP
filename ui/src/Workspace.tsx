// Workspace view: project/conversation sidebar, message timeline, task board
// toggle, operator composer, and member permissions inspector.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Compaction, Conversation, DigestEntry, Member, Message, SenderHistory, Session } from './api';
import { Dialog, useConsole } from './App';
import { BoardView, GoalLine, useTasks } from './Board';
import { GrokPrefillButton } from './Grok';
import { ArchivedBar, ConversationMenu, ListSearch, NO_FILTER, TidyBar, isFiltering, lastActivity, matchesFilter } from './Tidy';
import type { ListFilter } from './Tidy';
import { ActionButton, CopyButton, Icon, Markdown, MoreButton, Pill, ProviderMark, RECEIPT_TONE, RUN_TONE, Segmented, SubmitButton, Switch, conversationName, formatBytes, formatFullTime, formatTime, providerInfo, shortId, useBusy } from './format';
import { useI18n, type Messages } from './i18n';

const WINDOW = 200;
const SELECTED_KEY = 'acm.selectedConversation';

type Filter = 'all' | 'talk' | 'handoff' | 'progress' | 'artifact';

function matches(filter: Filter, message: Message): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'talk':
      return message.kind === 'message' || message.kind === 'decision';
    default:
      return message.kind === filter;
  }
}

/** Loads the recent window of messages and refreshes on committed conversation events. */
function useMessages(conversation: Conversation | undefined) {
  const { api, events, notify } = useConsole();
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const id = conversation?.conversation_id;
  const [messages, setMessages] = useState<Message[]>([]);
  const [start, setStart] = useState(0);
  const [loading, setLoading] = useState(false);
  const lastSeq = useRef(0);
  lastSeq.current = conversation?.last_seq ?? 0;

  const load = useCallback(
    async (conversationId: string, from: number): Promise<Message[]> => {
      const collected: Message[] = [];
      let cursor = from;
      for (let page = 0; page < 10; page += 1) {
        const result = await api.messages(conversationId, cursor, WINDOW);
        collected.push(...result.messages);
        if (!result.has_more) {
          break;
        }
        cursor = result.next_cursor;
      }
      return collected;
    },
    [api],
  );

  useEffect(() => {
    if (id === undefined) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const from = Math.max(0, lastSeq.current - WINDOW);
    setStart(from);
    setLoading(true);
    load(id, from)
      .then((loaded) => !cancelled && setMessages(loaded))
      .catch((failure: Error) => notify('danger', tRef.current.workspace.readMessagesFailed(failure.message)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, load, notify]);

  const relevant = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].conversation_id === id) {
        return events[index].event_id;
      }
    }
    return 0;
  }, [events, id]);
  useEffect(() => {
    if (id === undefined || relevant === 0) {
      return;
    }
    let cancelled = false;
    void load(id, start).then((loaded) => !cancelled && setMessages(loaded));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relevant, id, load]);

  const loadEarlier = useCallback(async () => {
    if (id === undefined || start === 0) {
      return;
    }
    const from = Math.max(0, start - WINDOW);
    const loaded = await load(id, from);
    setStart(from);
    setMessages(loaded);
  }, [id, start, load]);

  return { messages, loading, hasEarlier: start > 0, loadEarlier };
}

function senderName(message: Message, t: Messages): string {
  if (message.sender.kind === 'operator') {
    return t.common.operator;
  }
  return message.sender.display_name ?? providerInfo(message.sender.provider, t).name;
}

function receiptSummary(message: Message, t: Messages): string {
  const total = message.recipients.length;
  const acknowledged = message.recipients.filter((receipt) => receipt.status === 'acknowledged').length;
  const seen = message.recipients.filter((receipt) => receipt.status !== 'available').length;
  return t.workspace.receiptSummary(total, seen, acknowledged);
}

function ProgressLine({ payload }: { payload: Record<string, unknown> }) {
  const { t } = useI18n();
  const stateKey = String(payload.run_state);
  const label = t.runState[stateKey] ?? stateKey;
  const tone = RUN_TONE[stateKey] ?? 'muted';
  const percent = typeof payload.percent === 'number' ? payload.percent : null;
  return (
    <div className="inset">
      <div className="inset-row">
        <span className="inset-title">{String(payload.stage)}</span>
        <Pill tone={tone}>{label}</Pill>
        {percent !== null && <span className="inset-meta">{percent}%</span>}
      </div>
      {percent !== null && (
        <div className="progress-track" role="progressbar" aria-label={t.workspace.progressAria} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-bar" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

function ArtifactLine({ payload }: { payload: Record<string, unknown> }) {
  const { t } = useI18n();
  return (
    <div className="inset">
      <div className="inset-row">
        <Icon name="file" />
        <span className="inset-title">{String(payload.name)}</span>
        <span className="mono path">{String(payload.relative_path)}</span>
        <span className="inset-meta">{payload.direction === 'input' ? t.workspace.artifactInput : t.workspace.artifactOutput}</span>
      </div>
    </div>
  );
}

function MessageDetails({ message, nameOf }: { message: Message; nameOf: (sessionId: string) => string }) {
  const { t } = useI18n();
  const payload = message.payload ?? {};
  const facts: [string, string][] = [];
  if (message.kind === 'artifact') {
    facts.push(['SHA-256', String(payload.sha256 ?? '')]);
    if (typeof payload.size_bytes === 'number') facts.push([t.workspace.factSize, formatBytes(payload.size_bytes)]);
    if (typeof payload.row_count === 'number') facts.push([t.workspace.factRows, t.workspace.factRowsValue(payload.row_count)]);
    if (typeof payload.format === 'string') facts.push([t.workspace.factFormat, payload.format.toUpperCase()]);
    if (typeof payload.timezone === 'string') facts.push([t.workspace.factTimezone, payload.timezone]);
    if (typeof payload.unit === 'string') facts.push([t.workspace.factUnit, payload.unit]);
  }
  if (message.kind === 'progress') {
    if (typeof payload.count_done === 'number') {
      facts.push([t.workspace.factCount, t.workspace.factCountValue(payload.count_done, typeof payload.count_total === 'number' ? payload.count_total : null)]);
    }
    facts.push([t.workspace.factSource, t.workspace.factSourceValue]);
  }
  return (
    <div className="details">
      {message.recipients.length > 0 && (
        <ul className="detail-list">
          {message.recipients.map((receipt) => (
            <li key={receipt.session_id}>
              <span>{nameOf(receipt.session_id)}</span>
              <Pill tone={RECEIPT_TONE[receipt.status]}>{t.receiptStatus[receipt.status]}</Pill>
              <span className="detail-time">{receipt.acknowledged_at !== null ? formatFullTime(receipt.acknowledged_at, t.dateLocale) : receipt.read_at !== null ? formatFullTime(receipt.read_at, t.dateLocale) : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="facts facts-stack">
        {facts.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd className={label === 'SHA-256' ? 'mono wrap' : undefined}>{value}</dd></div>
        ))}
        <div><dt>{t.workspace.factSequence}</dt><dd>{t.workspace.factSequenceValue(message.sequence, formatFullTime(message.created_at, t.dateLocale))}</dd></div>
        <div><dt>{t.workspace.factMessageId}</dt><dd className="mono wrap">{message.message_id}</dd></div>
      </dl>
      <div className="row-actions">
        <GrokPrefillButton text={t.workspace.grokPrefillText(senderName(message, t), message.sender.label, message.body)} />
      </div>
      <ContextActions message={message} />
    </div>
  );
}

/** What of this message is read into a session's context: the operator keeps it, takes it out, or puts it back. */
function ContextActions({ message }: { message: Message }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const set = (field: 'keep' | 'drop' | 'resolve' | 'restore') => run(() => api.compactConversation(message.conversation_id, { [field]: [message.sequence] }), t.workspace.contextChanged[field]);
  return (
    <div className="context-actions" title={t.workspace.contextActionsHint}>
      <span className="muted small">{t.workspace.contextActionsLabel}</span>
      {message.context !== 'kept' && <ActionButton className="btn btn-quiet btn-small" onAction={() => set('keep')}>{t.workspace.contextDo.keep}</ActionButton>}
      {message.context !== 'resolved' && <ActionButton className="btn btn-quiet btn-small" onAction={() => set('resolve')}>{t.workspace.contextDo.resolve}</ActionButton>}
      {message.context !== 'dropped' && <ActionButton className="btn btn-quiet btn-small" onAction={() => set('drop')}>{t.workspace.contextDo.drop}</ActionButton>}
      {message.context !== null && <ActionButton className="btn btn-quiet btn-small" onAction={() => set('restore')}>{t.workspace.contextDo.restore}</ActionButton>}
    </div>
  );
}

/** The digest of a conversation and what compacting did to it; the operator can rewrite the digest here. */
function DigestPanel({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const { api, events, run } = useConsole();
  const { t } = useI18n();
  const digest = conversation.digest;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(digest?.text ?? '');
  const [upto, setUpto] = useState(String(conversation.last_seq));
  const [busy, track] = useBusy();
  const [log, setLog] = useState<Compaction[]>([]);
  // The log is read again whenever something happened in this conversation.
  const stamp = useMemo(() => events.filter((event) => event.conversation_id === conversation.conversation_id).length, [events, conversation.conversation_id]);
  useEffect(() => {
    let cancelled = false;
    void api.compactions(conversation.conversation_id).then((result) => !cancelled && setLog(result.compactions)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, conversation.conversation_id, stamp]);
  const counts = conversation.context_counts;
  const uptoNumber = Number(upto);
  const valid = text.trim() !== '' && Number.isInteger(uptoNumber) && uptoNumber >= (digest?.upto_seq ?? 1) && uptoNumber <= conversation.last_seq;
  return (
    <aside className="panel sheet" aria-label={t.workspace.digestTitle}>
      <header className="panel-head">
        <h2>{t.workspace.digestTitle}</h2>
        <button type="button" className="btn btn-quiet btn-icon" aria-label={t.common.close} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <section className="panel-section">
        <p className="muted">{t.workspace.digestIntro}</p>
        {digest === null && !editing && <p>{t.workspace.digestNone(conversation.message_count)}</p>}
        {digest !== null && !editing && (
          <>
            <p className="muted small">{t.workspace.digestMeta(digest.upto_seq, digest.by, formatTime(digest.written_at, t.dateLocale))}</p>
            <div className="digest-text"><Markdown text={digest.text} /></div>
          </>
        )}
        {editing ? (
          <form
            className="hook-form"
            onSubmit={(event) => {
              event.preventDefault();
              void track(run(() => api.compactConversation(conversation.conversation_id, { summary: text.trim(), upto_seq: uptoNumber }), t.workspace.digestSaved)).then((saved) => saved !== undefined && setEditing(false));
            }}
          >
            <textarea className="rules-text" rows={10} maxLength={6000} value={text} aria-label={t.workspace.digestTitle} placeholder={t.workspace.digestPlaceholder} onChange={(event) => setText(event.target.value)} />
            <label className="field">
              <span>{t.workspace.digestUpto(conversation.last_seq)}</span>
              <input inputMode="numeric" value={upto} onChange={(event) => setUpto(event.target.value)} />
            </label>
            <div className="row-actions">
              <button type="button" className="btn btn-quiet" onClick={() => setEditing(false)}>{t.common.cancel}</button>
              <SubmitButton busy={busy} disabled={!valid}>{t.common.save}</SubmitButton>
            </div>
          </form>
        ) : (
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setText(digest?.text ?? '');
                setUpto(String(digest !== null && conversation.last_seq - digest.upto_seq < 20 ? digest.upto_seq : conversation.last_seq));
                setEditing(true);
              }}
            >
              <Icon name="edit" /> {digest === null ? t.workspace.digestWrite : t.workspace.digestEdit}
            </button>
          </div>
        )}
      </section>
      <DigestHistory conversation={conversation} stamp={stamp} />
      <section className="panel-section">
        <h3 className="panel-sub">{t.workspace.contextCountsTitle}</h3>
        <p>{t.workspace.contextCounts(counts.kept, counts.dropped, counts.resolved)}</p>
        <p className="muted small">{t.workspace.contextCountsHint}</p>
      </section>
      <section className="panel-section">
        <h3 className="panel-sub">{t.workspace.compactionsTitle}</h3>
        {log.length === 0 && <p className="muted">{t.workspace.compactionsNone}</p>}
        <ul className="detail-list">
          {log.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <span>{entry.by}</span>
              <span className="muted small">{t.workspace.compactionLine(entry)}</span>
              <span className="detail-time">{formatTime(entry.at, t.dateLocale)}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

/** Every digest the conversation was given: closed by default; each opens to its text and can be put back in use. */
function DigestHistory({ conversation, stamp }: { conversation: Conversation; stamp: number }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const [list, setList] = useState<DigestEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<number | null>(null);
  const digestKey = `${conversation.digest?.upto_seq ?? 0}-${conversation.digest?.written_at ?? ''}`;
  useEffect(() => {
    let cancelled = false;
    void api.digests(conversation.conversation_id).then((result) => !cancelled && setList(result.digests)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, conversation.conversation_id, stamp, digestKey]);
  if (list.length < 2) {
    return null;
  }
  return (
    <section className="panel-section">
      <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'minus' : 'plus'} /> {t.workspace.digestHistoryTitle(list.length)}
      </button>
      {open && (
        <div className="digest-history">
          <p className="muted small">{t.workspace.digestHistoryHint}</p>
          <ol className="digest-list">
            {list.map((entry) => (
              <li key={entry.digest_id} className={entry.current ? 'is-current' : ''}>
                <div className="digest-row">
                  <button type="button" className="digest-pick" aria-expanded={shown === entry.digest_id} onClick={() => setShown(shown === entry.digest_id ? null : entry.digest_id)}>
                    <span className="digest-range">{t.workspace.digestRange(entry.upto_seq)}</span>
                    <span className="muted small">{entry.by} · {formatTime(entry.written_at, t.dateLocale)}</span>
                  </button>
                  {entry.current ? (
                    <span className="tag tag-ok">{t.workspace.digestInUse}</span>
                  ) : (
                    <ActionButton className="btn btn-quiet btn-small" onAction={() => run(async () => setList((await api.useDigest(conversation.conversation_id, entry.digest_id)).digests), t.workspace.digestUsed)}>
                      {t.workspace.digestUse}
                    </ActionButton>
                  )}
                </div>
                {shown === entry.digest_id && <div className="digest-text"><Markdown text={entry.text} /></div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/** Whose words to list: an application (by its agent) or the operator. */
interface Sender {
  key: string;
  name: string;
  provider: string | null;
}

/** Everything one sender wrote, newest first, across conversations. Opened from its face in a timeline. */
function HistoryPanel({ sender, onOpen, onClose }: { sender: Sender; onOpen: (conversationId: string) => void; onClose: () => void }) {
  const { api, data, notify } = useConsole();
  const { t } = useI18n();
  const [history, setHistory] = useState<SenderHistory | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, track] = useBusy();
  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    api.senderMessages(sender.key, null)
      .then((page) => !cancelled && setHistory(page))
      .catch((failure: Error) => notify('danger', failure.message));
    return () => {
      cancelled = true;
    };
  }, [api, notify, sender.key]);
  const more = () =>
    history !== null && history.next_before !== null
      ? track(api.senderMessages(sender.key, history.next_before).then((page) => setHistory({ ...page, messages: [...history.messages, ...page.messages] })))
      : undefined;
  const place = (entry: SenderHistory['messages'][number]) => {
    const known = data.conversations.find((conversation) => conversation.conversation_id === entry.conversation_id);
    return known !== undefined ? conversationName(known, t) : entry.conversation.kind === 'lobby' ? t.conversation.lobby : entry.conversation.title;
  };
  return (
    <aside className="panel sheet" aria-label={t.workspace.historyTitle(sender.name)}>
      <header className="panel-head">
        <h2 className="history-head">
          <ProviderMark provider={sender.provider} size="sm" /> {t.workspace.historyTitle(sender.name)}
        </h2>
        <button type="button" className="btn btn-quiet btn-icon" aria-label={t.common.close} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <section className="panel-section">
        {history === null && <p className="muted">{t.workspace.loadingMessages}</p>}
        {history !== null && <p className="muted small">{t.workspace.historyCount(history.total)}</p>}
        {history !== null && history.messages.length === 0 && <p className="muted">{t.workspace.historyNone}</p>}
        <ul className="history-list">
          {(history?.messages ?? []).map((entry) => (
            <li key={entry.message_id} className={`history-item ${open === entry.message_id ? 'is-open' : ''}`}>
              <div className="history-meta">
                <button type="button" className="history-place" title={t.workspace.historyOpen} disabled={entry.conversation.status !== 'open'} onClick={() => onOpen(entry.conversation_id)}>
                  {place(entry)}
                </button>
                {entry.from_window !== null && <span className="muted small">{entry.from_window.name}</span>}
                {entry.sender.model !== null && <span className="msg-model" title={t.workspace.modelTitle}>{entry.sender.model}</span>}
                <span className="detail-time" title={formatFullTime(entry.created_at, t.dateLocale)}>{formatTime(entry.created_at, t.dateLocale)}</span>
              </div>
              {open === entry.message_id ? (
                <>
                  <div className="history-full"><Markdown text={entry.body} /></div>
                  <button type="button" className="history-less" aria-expanded onClick={() => setOpen(null)}>{t.workspace.historyLess}</button>
                </>
              ) : (
                <button type="button" className="history-body" aria-expanded={false} onClick={() => setOpen(entry.message_id)}>
                  {entry.body}
                </button>
              )}
            </li>
          ))}
        </ul>
        {history !== null && history.has_more && (
          <ActionButton className="btn btn-quiet" disabled={busy} onAction={() => more()}>{t.workspace.historyMore}</ActionButton>
        )}
      </section>
    </aside>
  );
}

function MessageItem({ message, members, parent, onSender }: { message: Message; members: Map<string, Member>; parent: Message | undefined; onSender: (sender: Sender) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const nameOf = (sessionId: string) => {
    const member = members.get(sessionId);
    return member === undefined ? shortId(sessionId) : `${member.display_name} · ${member.label}`;
  };
  const showTag = message.kind === 'handoff' || message.kind === 'decision';
  const forwarded = message.payload?.forwarded as Record<string, unknown> | undefined;
  return (
    <article className="msg" id={message.message_id}>
      {message.sender.kind === 'operator' || message.sender.agent_id !== null ? (
        <button
          type="button"
          className="msg-face"
          title={t.workspace.historyOf(senderName(message, t))}
          aria-label={t.workspace.historyOf(senderName(message, t))}
          onClick={() => onSender({ key: message.sender.kind === 'operator' ? 'operator' : message.sender.agent_id!, name: senderName(message, t), provider: message.sender.kind === 'operator' ? null : message.sender.provider })}
        >
          <ProviderMark provider={message.sender.kind === 'operator' ? null : message.sender.provider} />
        </button>
      ) : (
        <ProviderMark provider={message.sender.provider} />
      )}
      <div className="msg-main">
        <header className="msg-head">
          <span className="msg-author">{senderName(message, t)}</span>
          {message.sender.label !== null && <span className="msg-label">{message.sender.label}{message.from_window !== null && ` · ${message.from_window.name}`}</span>}
          {message.sender.model !== null && message.sender.model !== undefined && <span className="msg-model" title={t.workspace.modelTitle}>{message.sender.model}</span>}
          {message.context !== null && (
            <span className="tag" title={t.workspace.contextTitle[message.context]}>{t.workspace.contextLabel[message.context]}</span>
          )}
          {message.to_windows.length > 0 && (
            <span className="tag" title={t.workspace.toWindowsTitle}>{t.workspace.toWindows(message.to_windows.map((entry) => entry.name).join(t.common.sep))}</span>
          )}
          {showTag && <span className="tag">{t.messageKind[message.kind]}</span>}
          {message.urgent && <span className="tag tag-urgent" title={t.workspace.urgentTagTitle}>{t.workspace.urgentTag}</span>}
          {message.directed && (
            <span className="tag" title={t.workspace.directedTitle}>
              <Icon name="lock" size={12} /> {t.workspace.directedOnly(message.recipients.map((receipt) => members.get(receipt.session_id)?.label ?? shortId(receipt.session_id)).join(t.common.sep))}
            </span>
          )}
          <span className="msg-meta" title={t.workspace.seqTooltip(message.sequence, formatFullTime(message.created_at, t.dateLocale))}>{formatTime(message.created_at, t.dateLocale)}</span>
        </header>
        {message.reply_to_message_id !== null && (
          <a className="msg-reply" href={`#${message.reply_to_message_id}`}>
            {parent !== undefined ? t.workspace.replyTo(senderName(parent, t), `${parent.body.slice(0, 60)}${parent.body.length > 60 ? '…' : ''}`) : t.workspace.replyEarlier}
          </a>
        )}
        {forwarded !== undefined && (
          <p className="msg-reply">
            {t.workspace.forwarded(
              String(forwarded.sender_display_name ?? t.common.operator),
              forwarded.sender_label ? String(forwarded.sender_label) : null,
              String(forwarded.task_code),
              forwarded.note ? String(forwarded.note) : null,
            )}
          </p>
        )}
        {message.kind === 'progress' && message.payload !== null && <ProgressLine payload={message.payload} />}
        {message.kind === 'artifact' && message.payload !== null && <ArtifactLine payload={message.payload} />}
        <Markdown text={message.body} />
        <footer className="msg-foot">
          {message.recipients.length > 0 && <span className={message.recipients.every((receipt) => receipt.status === 'acknowledged') ? 'receipt receipt-ok' : 'receipt'}>{receiptSummary(message, t)}</span>}
          <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={open ? t.workspace.collapseDetails : t.workspace.receiptsAndDetails} />
        </footer>
        {open && <MessageDetails message={message} nameOf={nameOf} />}
      </div>
    </article>
  );
}

function Composer({ conversation }: { conversation: Conversation }) {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('message');
  const [recipients, setRecipients] = useState<string[]>([]);
  // Windows the message is meant for, by id; empty means every window of the readers.
  const [toWindows, setToWindows] = useState<string[]>([]);
  const [urgent, setUrgent] = useState(false);
  const [options, setOptions] = useState(false);
  const [sending, setSending] = useState(false);
  const draft = useRef({ signature: '', key: '' });
  const readers = conversation.members.filter((member) => member.can_read);
  // The windows of the sessions that can read here: a message can be meant for some of them only.
  const windows = readers.flatMap((member) => (data.client_hooks.find((entry) => entry.session_id === member.session_id)?.windows ?? []).map((entry) => ({ ...entry, owner: member.display_name })));
  useEffect(() => {
    setRecipients([]);
    setToWindows([]);
    setKind('message');
    setUrgent(false);
    setOptions(false);
  }, [conversation.conversation_id]);

  const send = async () => {
    const text = body.trim();
    if (text === '' || sending) {
      return;
    }
    const signature = JSON.stringify([conversation.conversation_id, text, kind, recipients, urgent, toWindows]);
    if (draft.current.signature !== signature) {
      draft.current = { signature, key: crypto.randomUUID() };
    }
    setSending(true);
    const sent = await run(() => api.sendMessage(conversation.conversation_id, { body: text, kind, recipient_session_ids: recipients.length > 0 ? recipients : undefined, urgent: urgent || undefined, to_windows: toWindows.length > 0 ? toWindows : undefined, idempotency_key: draft.current.key }));
    setSending(false);
    if (sent !== undefined) {
      setBody('');
      setUrgent(false);
      setToWindows([]);
    }
  };
  const choices: string[] = [];
  if (kind !== 'message') choices.push(t.messageKind[kind]);
  if (recipients.length > 0) choices.push(t.workspace.composerOnlyN(recipients.length));
  if (toWindows.length > 0) choices.push(t.workspace.composerWindowsN(toWindows.length));
  if (urgent) choices.push(t.workspace.urgentTag);

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          rows={2}
          value={body}
          placeholder={t.workspace.composerPlaceholder}
          aria-label={t.workspace.composerBodyAria}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {options && (
          <div className="composer-options">
            <div className="inline-field">
              <span>{t.workspace.composerKind}</span>
              <Segmented
                size="sm"
                label={t.workspace.composerKindAria}
                value={kind}
                onChange={setKind}
                options={[
                  { id: 'message', label: t.messageKind.message },
                  { id: 'handoff', label: t.messageKind.handoff },
                  { id: 'decision', label: t.messageKind.decision },
                ]}
              />
            </div>
            <div className="inline-field" title={t.workspace.composerUrgentTitle}>
              <span>{t.workspace.composerUrgent}</span>
              <Switch checked={urgent} label={t.workspace.composerUrgentAria} onChange={setUrgent} />
              <span className="muted small">{t.workspace.composerUrgentHint}</span>
            </div>
            <fieldset className="recipients">
              <legend>{t.workspace.composerRecipientsLegend}</legend>
              {readers.length === 0 && <span className="muted">{t.workspace.composerNoReaders}</span>}
              {readers.map((member) => {
                const picked = recipients.includes(member.session_id);
                return (
                  <button key={member.session_id} type="button" className={`pick ${picked ? 'is-on' : ''}`} aria-pressed={picked} onClick={() => setRecipients((current) => (picked ? current.filter((id) => id !== member.session_id) : [...current, member.session_id]))}>
                    {picked && <Icon name="check" size={12} />}
                    {member.display_name} · {member.label}
                  </button>
                );
              })}
            </fieldset>
            {windows.length > 0 && (
              <fieldset className="recipients">
                <legend>{t.workspace.composerWindowsLegend}</legend>
                {windows.map((entry) => {
                  const picked = toWindows.includes(entry.window_id);
                  return (
                    <button key={entry.window_id} type="button" className={`pick ${picked ? 'is-on' : ''}`} aria-pressed={picked} title={entry.cwd ?? undefined} onClick={() => setToWindows((current) => (picked ? current.filter((id) => id !== entry.window_id) : [...current, entry.window_id]))}>
                      {picked && <Icon name="check" size={12} />}
                      {entry.owner} · {entry.name}
                    </button>
                  );
                })}
              </fieldset>
            )}
          </div>
        )}
        <div className="composer-bar">
          <button type="button" className={`btn btn-quiet btn-icon ${options ? 'is-open' : ''}`} aria-expanded={options} aria-label={t.workspace.composerOptionsAria} title={t.workspace.composerOptionsAria} onClick={() => setOptions((value) => !value)}>
            <Icon name="plus" />
          </button>
          {choices.length > 0 && <span className="composer-choice">{choices.join(' · ')}</span>}
          <span className="composer-hint">{t.workspace.composerSendHint}</span>
          <button type="button" className={`btn btn-primary ${sending ? 'is-busy' : ''}`} disabled={body.trim() === '' || sending} aria-busy={sending} onClick={() => void send()}>
            {t.workspace.composerSend}
          </button>
        </div>
      </div>
    </div>
  );
}

function accessLabel(member: { can_read: boolean; can_write: boolean }, t: Messages): string {
  if (member.can_read && member.can_write) return t.workspace.accessReadWrite;
  if (member.can_read) return t.workspace.accessReadOnly;
  if (member.can_write) return t.workspace.accessWriteOnly;
  return t.workspace.accessNone;
}

function MemberRow({ member, onChange, onRemove }: { member: Member; onChange: (patch: { can_read?: boolean; can_write?: boolean }) => unknown; onRemove: () => unknown }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const status = t.sessionStatus[member.session_status];
  return (
    <li className="member">
      <div className="member-head">
        <ProviderMark provider={member.provider} size="sm" />
        <div className="member-name">
          <span className="member-title">{member.display_name} · {member.label}</span>
          <span className="member-sub">{accessLabel(member, t)}{member.session_status !== 'active' ? `${t.common.sep}${status.label}` : ''}</span>
        </div>
        <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.workspace.memberPermAria(member.label)} />
      </div>
      {open && (
        <div className="member-controls">
          <div className="switch-row">
            <span>{t.workspace.canRead}</span>
            <Switch checked={member.can_read} label={t.workspace.canRead} onChange={(next) => onChange({ can_read: next })} />
          </div>
          <div className="switch-row">
            <span>{t.workspace.canWrite}</span>
            <Switch checked={member.can_write} label={t.workspace.canWrite} onChange={(next) => onChange({ can_write: next })} />
          </div>
          <div className="member-actions">
            <ActionButton className="btn btn-quiet btn-sm" onAction={onRemove}>{t.workspace.removeFromConv}</ActionButton>
            <CopyButton text={member.session_id} label={t.workspace.copySessionId} />
          </div>
        </div>
      )}
    </li>
  );
}

function MembersPanel({ conversation, onOpenAgents, onClose }: { conversation: Conversation; onOpenAgents: () => void; onClose: () => void }) {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const [adding, setAdding] = useState('');
  const memberIds = new Set(conversation.members.map((member) => member.session_id));
  const formerIds = new Set((conversation.former_members ?? []).map((member) => member.session_id));
  const candidates = data.sessions.filter(
    (session: Session) =>
      session.project_id === conversation.project_id &&
      !memberIds.has(session.session_id) &&
      session.status !== 'revoked' &&
      session.status !== 'expired' &&
      (conversation.kind === 'topic' || session.linked) &&
      (conversation.kind !== 'direct' || formerIds.has(session.session_id)),
  );
  const agentName = (agentId: string) => data.agents.find((agent) => agent.agent_id === agentId)?.display_name ?? agentId;
  const current = conversation.members.map(({ session_id, can_read, can_write }) => ({ session_id, can_read, can_write }));
  const apply = (members: typeof current, success: string) => run(() => api.setMembers(conversation.conversation_id, conversation.config_version, members), success);

  return (
    <aside className="panel sheet" aria-label={t.workspace.membersPanelAria}>
      <header className="panel-head">
        <h2>{t.workspace.membersTitle}</h2>
        <button type="button" className="btn btn-quiet btn-icon" aria-label={t.common.close} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <section className="panel-section">
        {conversation.kind === 'lobby' && <p className="muted">{t.workspace.lobbyMembersHint}</p>}
        {conversation.kind === 'direct' && <p className="muted">{t.workspace.directMembersHint}</p>}
        {conversation.members.length === 0 && <p className="muted">{t.workspace.emptyMembersHint}</p>}
        <ul className="members">
          {conversation.members.map((member) => (
            <MemberRow
              key={member.session_id}
              member={member}
              onChange={(patch) => apply(current.map((entry) => (entry.session_id === member.session_id ? { ...entry, ...patch } : entry)), t.workspace.permUpdated)}
              onRemove={() => apply(current.filter((entry) => entry.session_id !== member.session_id), t.workspace.removedMember(member.label))}
            />
          ))}
        </ul>
        {candidates.length > 0 ? (
          <div className="add-row">
            <select value={adding} onChange={(event) => setAdding(event.target.value)} aria-label={t.workspace.selectSessionAria}>
              <option value="">{t.workspace.addSessionPlaceholder}</option>
              {candidates.map((session) => (
                <option key={session.session_id} value={session.session_id}>
                  {agentName(session.agent_id)} · {session.label}
                </option>
              ))}
            </select>
            <ActionButton className="btn" disabled={adding === ''} onAction={() => apply([...current, { session_id: adding, can_read: true, can_write: true }], t.workspace.addedMember).then(() => setAdding(''))}>
              {t.workspace.addBtn}
            </ActionButton>
          </div>
        ) : conversation.kind === 'topic' ? (
          <button type="button" className="btn" onClick={onOpenAgents}>{t.workspace.issueNewPairing}</button>
        ) : null}
        {conversation.kind === 'direct' && (conversation.former_members ?? []).length > 0 && (
          <p className="muted small">
            {t.workspace.formerNote(
              (conversation.former_members ?? []).map((member) => (member.removed_reason === 'unlinked' ? t.workspace.formerUnlinked(member.label) : t.workspace.formerRemoved(member.label))).join(t.common.sep),
            )}
          </p>
        )}
      </section>
      <details className="panel-fold">
        <summary>{t.workspace.accessHelpTitle}</summary>
        <ul className="plain">
          {t.workspace.accessHelpItems.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </details>
      <details className="panel-fold">
        <summary>{t.workspace.deliveryHelpTitle}</summary>
        <p className="muted">{t.workspace.deliveryHelpText}</p>
      </details>
      <details className="panel-fold">
        <summary>{t.workspace.convInfoTitle}</summary>
        <dl className="facts facts-stack">
          <div><dt>{t.workspace.projectLabel}</dt><dd>{data.projects.find((project) => project.project_id === conversation.project_id)?.name ?? conversation.project_id}</dd></div>
          <div><dt>{t.workspace.createdAtLabel}</dt><dd>{formatFullTime(conversation.created_at, t.dateLocale)}</dd></div>
          <div><dt>{t.workspace.configVersionLabel}</dt><dd>{t.workspace.configVersionValue(conversation.config_version)}</dd></div>
          <div><dt>{t.workspace.convIdLabel}</dt><dd className="mono wrap">{conversation.conversation_id}</dd></div>
        </dl>
        <CopyButton text={conversation.conversation_id} label={t.workspace.copyConvId} />
      </details>
    </aside>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [busy, track] = useBusy();
  return (
    <Dialog title={t.workspace.newProjectTitle} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void track(run(() => api.createProject({ name: name.trim(), root_path: root.trim() === '' ? undefined : root.trim() }), t.workspace.projectCreated)).then((created) => created !== undefined && onClose());
        }}
      >
        <label className="field">
          <span>{t.workspace.projectNameLabel}</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t.workspace.projectNamePlaceholder} />
        </label>
        <label className="field">
          <span>{t.workspace.projectRootLabel}</span>
          <input value={root} onChange={(event) => setRoot(event.target.value)} placeholder={t.workspace.projectRootPlaceholder} spellCheck={false} />
          <small>{t.workspace.projectRootHint}</small>
        </label>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>{t.common.cancel}</button>
          <SubmitButton busy={busy} disabled={name.trim() === ''}>{t.workspace.createProjectBtn}</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

function NewConversationDialog({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const [project, setProject] = useState(projectId);
  const [taskCode, setTaskCode] = useState('');
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, track] = useBusy();
  return (
    <Dialog title={t.workspace.newConvTitle} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void track(run(() => api.createConversation({ project_id: project, task_code: taskCode.trim(), title: title.trim(), purpose: purpose.trim() === '' ? undefined : purpose.trim() }), t.workspace.convCreated)).then((created) => {
            if (created !== undefined) {
              onCreated(created.conversation_id);
              onClose();
            }
          });
        }}
      >
        <label className="field">
          <span>{t.workspace.belongsToProject}</span>
          <select value={project} onChange={(event) => setProject(event.target.value)}>
            {data.projects.map((entry) => (
              <option key={entry.project_id} value={entry.project_id}>{entry.name}</option>
            ))}
          </select>
        </label>
        <div className="field-row">
          <label className="field field-narrow">
            <span>{t.workspace.taskCodeLabel}</span>
            <input autoFocus value={taskCode} onChange={(event) => setTaskCode(event.target.value)} placeholder="DATA-014" spellCheck={false} />
          </label>
          <label className="field">
            <span>{t.workspace.convTitleLabel}</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t.workspace.convTitlePlaceholder} />
          </label>
        </div>
        <label className="field">
          <span>{t.workspace.purposeLabel}</span>
          <textarea rows={2} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder={t.workspace.purposePlaceholder} />
        </label>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>{t.common.cancel}</button>
          <SubmitButton busy={busy} disabled={taskCode.trim() === '' || title.trim() === '' || project === ''}>{t.workspace.createConvBtn}</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function WorkspaceView({ onOpenAgents }: { onOpenAgents: () => void }) {
  const { data } = useConsole();
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState(() => window.localStorage.getItem(SELECTED_KEY) ?? '');
  const [filter, setFilter] = useState<Filter>('all');
  const [panelOpen, setPanelOpen] = useState(false);
  // The digest panel takes the same place as the members panel; one of them at a time.
  const [digestOpen, setDigestOpen] = useState(false);
  // Whose history is open, in that same place.
  const [historyOf, setHistoryOf] = useState<Sender | null>(null);
  const [dialog, setDialog] = useState<'project' | 'conversation' | null>(null);
  const [listFilter, setListFilter] = useState<ListFilter>(NO_FILTER);
  const [tidying, setTidying] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [unseen, setUnseen] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  // The timeline as it is on the page now: it is mounted anew when a conversation
  // is opened, when the view comes back from the board, and when this tab is shown again.
  const [timeline, setTimeline] = useState<HTMLDivElement | null>(null);
  const attachTimeline = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element;
    if (element !== null) {
      // Opened: at the newest message.
      atBottom.current = true;
      element.scrollTop = element.scrollHeight;
    }
    setTimeline(element);
  }, []);
  const seenCount = useRef(0);

  const filters: { id: Filter; label: string }[] = useMemo(
    () => [
      { id: 'all', label: t.workspace.filters.all },
      { id: 'talk', label: t.workspace.filters.talk },
      { id: 'handoff', label: t.workspace.filters.handoff },
      { id: 'progress', label: t.workspace.filters.progress },
      { id: 'artifact', label: t.workspace.filters.artifact },
    ],
    [t],
  );

  const conversation =
    data.conversations.find((entry) => entry.conversation_id === selectedId) ??
    data.conversations.find((entry) => entry.kind === 'topic' && entry.status === 'open') ??
    data.conversations.find((entry) => entry.status === 'open') ??
    data.conversations[0];
  const filtering = isFiltering(listFilter);
  const shownList = data.conversations.filter((entry) => matchesFilter(entry, listFilter, t));
  const pickedList = data.conversations.filter((entry) => picked.includes(entry.conversation_id));
  const { messages, loading, hasEarlier, loadEarlier } = useMessages(conversation);
  const { tasks, reload: reloadTasks } = useTasks(conversation);
  const [view, setView] = useState<'talk' | 'board'>('talk');
  const openTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled').length;
  const members = useMemo(() => new Map((conversation?.members ?? []).map((member) => [member.session_id, member])), [conversation]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.message_id, message])), [messages]);
  const visible = messages.filter((message) => matches(filter, message));

  useEffect(() => {
    if (conversation !== undefined) {
      window.localStorage.setItem(SELECTED_KEY, conversation.conversation_id);
    }
    atBottom.current = true;
    seenCount.current = 0;
    setUnseen(0);
  }, [conversation?.conversation_id, filter]);

  useEffect(() => {
    const element = scroller.current;
    if (element === null) {
      return;
    }
    if (atBottom.current) {
      element.scrollTop = element.scrollHeight;
      seenCount.current = messages.length;
      setUnseen(0);
    } else {
      setUnseen(Math.max(0, messages.length - seenCount.current));
    }
  }, [messages]);

  // While the reader is at the end, the timeline stays there whatever grows above it
  // afterwards: messages that are still being laid out, pictures, a filter that changes.
  useEffect(() => {
    if (timeline === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const keep = () => {
      if (atBottom.current) {
        timeline.scrollTop = timeline.scrollHeight;
      }
    };
    const observer = new ResizeObserver(keep);
    observer.observe(timeline);
    if (timeline.firstElementChild !== null) {
      observer.observe(timeline.firstElementChild);
    }
    keep();
    return () => observer.disconnect();
  }, [timeline]);

  const jumpToEnd = () => {
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  };

  if (data.projects.length === 0) {
    return (
      <main className="blank sheet">
        <div className="blank-card">
          <h2>{t.workspace.noProjectTitle}</h2>
          <p>{t.workspace.noProjectDesc}</p>
          <button type="button" className="btn btn-primary" onClick={() => setDialog('project')}>{t.workspace.noProjectBtn}</button>
        </div>
        {dialog === 'project' && <NewProjectDialog onClose={() => setDialog(null)} />}
      </main>
    );
  }

  return (
    <div className={`workspace ${panelOpen || digestOpen || historyOf !== null ? 'has-panel' : ''}`}>
      <nav className="sidebar" aria-label={t.workspace.sidebarAria}>
        <div className="sidebar-actions">
          <details className="menu">
            <summary className="btn btn-sm" aria-label={t.workspace.newBtn}>
              <Icon name="plus" /> {t.workspace.newBtn}
            </summary>
            <div className="menu-pop menu-pop-down">
              <button type="button" className="menu-item" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); setDialog('conversation'); }}>{t.workspace.newConvItem}</button>
              <button type="button" className="menu-item" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); setDialog('project'); }}>{t.workspace.newProjectItem}</button>
            </div>
          </details>
          <button
            type="button"
            className={`btn btn-sm btn-quiet ${tidying ? 'is-open' : ''}`}
            aria-pressed={tidying}
            title={t.workspace.tidyTitle}
            onClick={() => {
              setTidying((on) => !on);
              setPicked([]);
            }}
          >
            <Icon name="checks" size={14} /> {t.workspace.tidyBtn}
          </button>
        </div>
        <ListSearch filter={listFilter} onChange={setListFilter} />
        {filtering && (
          <p className="sidebar-note">
            {t.workspace.foundCount(shownList.length)}
            <button type="button" className="link" onClick={() => setListFilter(NO_FILTER)}>{t.workspace.clearFilter}</button>
          </p>
        )}
        {data.projects.map((project) => {
          const all = data.conversations.filter((entry) => entry.project_id === project.project_id);
          const list = shownList.filter((entry) => entry.project_id === project.project_id);
          if (filtering && list.length === 0) {
            return null;
          }
          const inUse = list.filter((entry) => entry.status === 'open');
          const main = [...inUse.filter((entry) => entry.kind === 'lobby'), ...inUse.filter((entry) => entry.kind === 'topic')];
          const direct = inUse.filter((entry) => entry.kind === 'direct');
          const archived = list.filter((entry) => entry.status === 'archived');
          const holds = (group: Conversation[]) => group.some((entry) => entry.conversation_id === conversation?.conversation_id);
          const item = (entry: Conversation) => {
            const active = entry.conversation_id === conversation?.conversation_id;
            const ticked = picked.includes(entry.conversation_id);
            const name = conversationName(entry, t);
            const about = t.workspace.convTooltip(entry.kind === 'topic' ? entry.task_code : null, entry.members.length, entry.message_count, formatTime(lastActivity(entry), t.dateLocale));
            return (
              <div key={entry.conversation_id} className={`conv-row ${entry.status === 'archived' ? 'is-archived' : ''}`}>
                {tidying && (
                  <input
                    type="checkbox"
                    className="conv-tick"
                    aria-label={t.workspace.selectConvAria(name)}
                    checked={ticked}
                    disabled={entry.kind === 'lobby'}
                    title={entry.kind === 'lobby' ? t.workspace.lobbyLockedTitle : undefined}
                    onChange={() => setPicked((current) => (ticked ? current.filter((id) => id !== entry.conversation_id) : [...current, entry.conversation_id]))}
                  />
                )}
                <button type="button" className={`conv ${active ? 'is-active' : ''}`} aria-current={active ? 'true' : undefined} title={about} onClick={() => setSelectedId(entry.conversation_id)}>
                  {entry.kind === 'lobby' && <Icon name="hash" size={14} />}
                  <span className="conv-title">{name}</span>
                  <span className="conv-meta">{entry.message_count > 0 ? entry.message_count : ''}</span>
                </button>
              </div>
            );
          };
          return (
            <section key={project.project_id} className="sidebar-group">
              <h4 title={project.root_path ?? t.workspace.noRootTooltip}>{project.name}</h4>
              {all.length === 0 && <p className="small sidebar-empty">{t.workspace.noConvs}</p>}
              {main.map(item)}
              {direct.length > 0 && (
                <details className="sidebar-fold" open={filtering || tidying || holds(direct) || undefined}>
                  <summary>{t.workspace.directGroup} <span className="count">{direct.length}</span></summary>
                  {direct.map(item)}
                </details>
              )}
              {archived.length > 0 && (
                <details className="sidebar-fold" open={filtering || holds(archived) || undefined}>
                  <summary>{t.workspace.archivedGroup} <span className="count">{archived.length}</span></summary>
                  {archived.map(item)}
                </details>
              )}
            </section>
          );
        })}
        {filtering && shownList.length === 0 && <p className="small sidebar-empty">{t.workspace.noFilteredConvs}</p>}
        {tidying && (
          <TidyBar
            selected={pickedList}
            visible={shownList}
            onSelect={setPicked}
            onDone={() => {
              setTidying(false);
              setPicked([]);
            }}
          />
        )}
      </nav>

      {conversation === undefined ? (
        <main className="blank sheet">
          <div className="blank-card">
            <h2>{t.workspace.noConvTitle}</h2>
            <p>{t.workspace.noConvDesc}</p>
            <button type="button" className="btn btn-primary" onClick={() => setDialog('conversation')}>{t.workspace.noConvBtn}</button>
          </div>
        </main>
      ) : (
        <main className="thread sheet">
          <header className="thread-head">
            <div className="thread-title">
              <h1>{conversationName(conversation, t, 'full')}</h1>
              {conversation.kind === 'topic' ? (
                <p title={conversation.purpose ?? undefined}>
                  <span className="mono">{conversation.task_code}</span>
                  {conversation.purpose !== null && ` · ${conversation.purpose}`}
                </p>
              ) : (
                <p>{conversation.kind === 'lobby' ? t.workspace.lobbySubtitle : t.workspace.directSubtitle}</p>
              )}
              <GoalLine conversation={conversation} />
            </div>
            <div className="thread-actions">
              {conversation.status === 'archived' && <Pill tone="muted">{t.workspace.archivedPill}</Pill>}
              <button
                type="button"
                className={`btn btn-quiet ${digestOpen ? 'is-open' : ''}`}
                aria-pressed={digestOpen}
                title={t.workspace.digestBtnTitle}
                onClick={() => {
                  setPanelOpen(false);
                  setHistoryOf(null);
                  setDigestOpen((open) => !open);
                }}
              >
                <Icon name="broom" /> {conversation.digest === null ? t.workspace.digestBtn : t.workspace.digestBtnUpto(conversation.digest.upto_seq)}
              </button>
              <button
                type="button"
                className={`btn btn-quiet ${panelOpen ? 'is-open' : ''}`}
                aria-pressed={panelOpen}
                onClick={() => {
                  setDigestOpen(false);
                  setHistoryOf(null);
                  setPanelOpen((open) => !open);
                }}
              >
                <Icon name="agents" /> {t.workspace.membersBtn(conversation.members.length)}
              </button>
              <ConversationMenu conversation={conversation} />
            </div>
          </header>
          <div className="toolbar">
            <Segmented
              label={t.workspace.viewAria}
              value={view}
              onChange={setView}
              options={[
                { id: 'talk', label: t.workspace.tabTalk },
                { id: 'board', label: <>{t.workspace.tabBoard}{openTasks > 0 && <span className="segmented-count">{openTasks}</span>}</> },
              ]}
            />
            {view === 'talk' && <Segmented size="sm" label={t.workspace.filterAria} value={filter} onChange={setFilter} options={filters} />}
          </div>
          {view === 'board' ? (
            <BoardView conversation={conversation} tasks={tasks} reload={() => void reloadTasks()} />
          ) : (
            <>
              <div
                className="timeline"
                ref={attachTimeline}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
                  if (atBottom.current) {
                    seenCount.current = messages.length;
                    setUnseen(0);
                  }
                }}
              >
                <div className="timeline-inner">
                  {hasEarlier && (
                    <button type="button" className="btn btn-quiet btn-sm load-earlier" onClick={() => void loadEarlier()}>
                      {t.workspace.loadEarlier}
                    </button>
                  )}
                  {loading && messages.length === 0 && <p className="muted center">{t.workspace.loadingMessages}</p>}
                  {!loading && messages.length === 0 && (
                    <div className="empty">
                      <h3>{t.workspace.emptyMessagesTitle}</h3>
                      <p className="muted">{conversation.members.length === 0 ? t.workspace.emptyMessagesNoMembers : t.workspace.emptyMessagesHasMembers}</p>
                    </div>
                  )}
                  {messages.length > 0 && visible.length === 0 && <p className="muted center">{t.workspace.emptyFilterMessages}</p>}
                  {visible.map((message) => (
                    <MessageItem
                      key={message.message_id}
                      message={message}
                      members={members}
                      parent={message.reply_to_message_id === null ? undefined : byId.get(message.reply_to_message_id)}
                      onSender={(sender) => {
                        setPanelOpen(false);
                        setDigestOpen(false);
                        setHistoryOf(sender);
                      }}
                    />
                  ))}
                </div>
              </div>
              {unseen > 0 && (
                <button type="button" className="jump" onClick={jumpToEnd}>
                  <Icon name="down" size={14} /> {t.workspace.newMessagesJump(unseen)}
                </button>
              )}
              {conversation.status === 'archived' ? <ArchivedBar conversation={conversation} /> : <Composer conversation={conversation} />}
            </>
          )}
        </main>
      )}

      {conversation !== undefined && panelOpen && <MembersPanel conversation={conversation} onOpenAgents={onOpenAgents} onClose={() => setPanelOpen(false)} />}
      {conversation !== undefined && digestOpen && !panelOpen && <DigestPanel key={conversation.conversation_id} conversation={conversation} onClose={() => setDigestOpen(false)} />}
      {historyOf !== null && !panelOpen && !digestOpen && <HistoryPanel key={historyOf.key} sender={historyOf} onOpen={setSelectedId} onClose={() => setHistoryOf(null)} />}
      {dialog === 'project' && <NewProjectDialog onClose={() => setDialog(null)} />}
      {dialog === 'conversation' && <NewConversationDialog projectId={conversation?.project_id ?? data.projects[0].project_id} onClose={() => setDialog(null)} onCreated={setSelectedId} />}
    </div>
  );
}
