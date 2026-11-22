// Manage: select many conversations, tasks or messages at once and act on all of
// them. Each tab is a list with a checkbox per row; the actions appear in a bar
// once something is selected.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Conversation, Message, Task, TaskStatus } from './api';
import { ConfirmDialog, Dialog, useConsole } from './App';
import { ActionButton, Icon, Segmented, conversationName, formatTime } from './format';
import { useI18n } from './i18n';
import { deletionSummary } from './Tidy';

type Tab = 'conversations' | 'tasks' | 'messages';

/** The rows that are selected, kept as ids; ids that disappear from the list drop out. */
function useSelection(ids: string[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const key = ids.join('|');
  useEffect(() => {
    setPicked((current) => {
      const present = new Set(ids);
      const kept = [...current].filter((id) => present.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const all = ids.length > 0 && ids.every((id) => picked.has(id));
  return {
    picked,
    all,
    some: picked.size > 0 && !all,
    toggle: (id: string) =>
      setPicked((current) => {
        const next = new Set(current);
        if (!next.delete(id)) {
          next.add(id);
        }
        return next;
      }),
    toggleAll: () => setPicked(all ? new Set() : new Set(ids)),
    clear: () => setPicked(new Set()),
  };
}

function Check({ checked, mixed = false, onChange, label }: { checked: boolean; mixed?: boolean; onChange: () => void; label: string }) {
  return (
    <label className="check" title={label}>
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        ref={(element) => {
          if (element !== null) {
            element.indeterminate = mixed;
          }
        }}
        onChange={onChange}
      />
      <span className="check-box" aria-hidden="true">
        <Icon name={mixed ? 'minus' : 'check'} size={12} />
      </span>
    </label>
  );
}

/** The bar of actions for what is selected; slides up once something is. */
function ActionBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  const { t } = useI18n();
  if (count === 0) {
    return null;
  }
  return (
    <div className="bulk-bar" role="toolbar" aria-label={t.manage.selected(count)}>
      <strong>{t.manage.selected(count)}</strong>
      <div className="bulk-actions">{children}</div>
      <button type="button" className="btn btn-quiet btn-icon" aria-label={t.common.close} onClick={onClear}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/** Runs one action per item, stops at the first failure, and says how many went through. */
function useEach() {
  const { run, notify } = useConsole();
  const { t } = useI18n();
  return async <T,>(items: T[], action: (item: T) => Promise<unknown>, verb: string) => {
    let count = 0;
    for (const item of items) {
      if ((await run(() => action(item))) === undefined) {
        break;
      }
      count += 1;
    }
    if (count > 0) {
      notify('ok', t.manage.done(verb, count));
    }
    return count;
  };
}

type Status = 'all' | 'open' | 'archived';

function ConversationsTab() {
  const { api, data, run, notify } = useConsole();
  const { t } = useI18n();
  const each = useEach();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [dialog, setDialog] = useState<'clear' | 'delete' | null>(null);
  const [older, setOlder] = useState<'0' | '7' | '30'>('0');
  const list = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
    return data.conversations
      .filter((entry) => status === 'all' || entry.status === status)
      .filter((entry) => {
        const text = [conversationName(entry, t, 'full'), entry.task_code, ...entry.members.map((member) => `${member.display_name} ${member.label}`)].join(' ').toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort((a, b) => (b.last_message_at ?? b.created_at).localeCompare(a.last_message_at ?? a.created_at));
  }, [data.conversations, query, status, t]);
  const selection = useSelection(list.map((entry) => entry.conversation_id));
  const selected = list.filter((entry) => selection.picked.has(entry.conversation_id));
  const movable = selected.filter((entry) => entry.kind !== 'lobby');
  const open = movable.filter((entry) => entry.status === 'open');
  const archived = movable.filter((entry) => entry.status === 'archived');
  return (
    <>
      <div className="bulk-filters">
        <label className="search-field">
          <Icon name="search" size={14} />
          <input type="search" value={query} placeholder={t.manage.search} aria-label={t.manage.search} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Segmented size="sm" label={t.manage.colStatus} value={status} onChange={setStatus} options={[{ id: 'all', label: t.manage.statusAll }, { id: 'open', label: t.manage.statusOpen }, { id: 'archived', label: t.manage.statusArchived }]} />
      </div>
      {list.length === 0 ? (
        <p className="muted">{t.manage.none}</p>
      ) : (
        <table className="bulk-table">
          <thead>
            <tr>
              <th className="col-check"><Check checked={selection.all} mixed={selection.some} onChange={selection.toggleAll} label={t.manage.selectAll} /></th>
              <th>{t.manage.colName}</th>
              <th className="num">{t.manage.colMessages}</th>
              <th className="num wide-only">{t.manage.colTasks}</th>
              <th className="wide-only">{t.manage.colActivity}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((entry) => (
              <tr key={entry.conversation_id} className={selection.picked.has(entry.conversation_id) ? 'is-picked' : ''} onClick={() => selection.toggle(entry.conversation_id)}>
                <td className="col-check" onClick={(event) => event.stopPropagation()}>
                  <Check checked={selection.picked.has(entry.conversation_id)} onChange={() => selection.toggle(entry.conversation_id)} label={conversationName(entry, t)} />
                </td>
                <td>
                  <span className="bulk-name">{conversationName(entry, t)}</span>
                  {entry.status === 'archived' && <span className="tag">{t.manage.archived}</span>}
                </td>
                <td className="num">{entry.message_count}</td>
                <td className="num wide-only">{entry.open_tasks}</td>
                <td className="muted small wide-only">{formatTime(entry.last_message_at ?? entry.created_at, t.dateLocale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ActionBar count={selected.length} onClear={selection.clear}>
        {open.length > 0 && (
          <ActionButton className="btn btn-sm" onAction={async () => { await each(open, (entry) => api.updateConversation(entry.conversation_id, { archived: true }), t.manage.verbArchived); selection.clear(); }}>
            <Icon name="archive" size={14} /> {t.manage.archive}
          </ActionButton>
        )}
        {archived.length > 0 && (
          <ActionButton className="btn btn-sm" onAction={async () => { await each(archived, (entry) => api.updateConversation(entry.conversation_id, { archived: false }), t.manage.verbRestored); selection.clear(); }}>
            <Icon name="restart" size={14} /> {t.manage.restore}
          </ActionButton>
        )}
        <button type="button" className="btn btn-sm" disabled={selected.every((entry) => entry.message_count === 0)} onClick={() => setDialog('clear')}>
          <Icon name="broom" size={14} /> {t.manage.clear}
        </button>
        <button type="button" className="btn btn-sm tidy-delete" disabled={movable.length === 0} onClick={() => setDialog('delete')}>
          <Icon name="trash" size={14} /> {t.manage.delete}
        </button>
      </ActionBar>
      {dialog === 'clear' && (
        <Dialog title={t.manage.clearTitle} onClose={() => setDialog(null)}>
          <div className="form">
            <p className="muted">{t.manage.clearText(selected.length, selected.reduce((sum, entry) => sum + entry.message_count, 0))}</p>
            <div className="inline-field">
              <span>{t.manage.clearOlder}</span>
              <Segmented size="sm" label={t.manage.clearOlder} value={older} onChange={setOlder} options={[{ id: '0', label: t.tidy.rangeAll }, { id: '7', label: t.tidy.range7 }, { id: '30', label: t.tidy.range30 }]} />
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-quiet" autoFocus onClick={() => setDialog(null)}>{t.common.cancel}</button>
              <ActionButton
                className="btn btn-destructive"
                onAction={async () => {
                  let deleted = 0;
                  for (const entry of selected) {
                    const cleared = await run(() => api.clearConversation(entry.conversation_id, Number(older)));
                    if (cleared === undefined) {
                      break;
                    }
                    deleted += cleared.deleted_messages;
                  }
                  notify('ok', t.tidy.clearDeleted(deleted));
                  setDialog(null);
                  selection.clear();
                }}
              >
                {t.tidy.clearConfirm}
              </ActionButton>
            </div>
          </div>
        </Dialog>
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title={t.tidy.deleteTitle}
          message={`${deletionSummary(movable, t)}${movable.length < selected.length ? ` ${t.manage.deleteSkipsLobby}` : ''}`}
          confirmLabel={t.tidy.deleteConfirmCount(movable.length)}
          onConfirm={async () => { await each(movable, (entry: Conversation) => api.deleteConversation(entry.conversation_id), t.manage.verbDeleted); selection.clear(); }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

const TASK_STATES: TaskStatus[] = ['todo', 'doing', 'blocked', 'done', 'cancelled'];

function TasksTab() {
  const { api, data, events } = useConsole();
  const { t } = useI18n();
  const each = useEach();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<TaskStatus | 'all'>('all');
  const open = data.conversations.filter((entry) => entry.status === 'open');
  const ids = open.map((entry) => entry.conversation_id).join('|');
  const stamp = events.filter((event) => event.event_type.startsWith('task.')).length;
  useEffect(() => {
    let cancelled = false;
    void Promise.all(ids.split('|').filter((id) => id !== '').map((id) => api.tasks(id).then((result) => result.tasks).catch(() => [] as Task[])))
      .then((lists) => !cancelled && setTasks(lists.flat()));
    return () => {
      cancelled = true;
    };
  }, [api, ids, stamp]);
  const names = new Map(open.map((entry) => [entry.conversation_id, conversationName(entry, t)]));
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  const list = (tasks ?? [])
    .filter((task) => state === 'all' || task.status === state)
    .filter((task) => words.every((word) => `${task.title} ${task.assignee?.label ?? ''} ${names.get(task.conversation_id) ?? ''}`.toLowerCase().includes(word)))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const selection = useSelection(list.map((task) => task.task_id));
  const selected = list.filter((task) => selection.picked.has(task.task_id));
  return (
    <>
      <div className="bulk-filters">
        <label className="search-field">
          <Icon name="search" size={14} />
          <input type="search" value={query} placeholder={t.manage.search} aria-label={t.manage.search} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Segmented size="sm" label={t.manage.colStatus} value={state} onChange={setState} options={[{ id: 'all', label: t.manage.taskStatusAll }, ...TASK_STATES.map((id) => ({ id, label: t.overview.taskStatus[id] }))]} />
      </div>
      {tasks === null ? (
        <p className="muted">{t.manage.loadingTasks}</p>
      ) : list.length === 0 ? (
        <p className="muted">{t.manage.none}</p>
      ) : (
        <table className="bulk-table">
          <thead>
            <tr>
              <th className="col-check"><Check checked={selection.all} mixed={selection.some} onChange={selection.toggleAll} label={t.manage.selectAll} /></th>
              <th>{t.manage.colTask}</th>
              <th className="wide-only">{t.manage.colWhere}</th>
              <th className="wide-only">{t.manage.colWho}</th>
              <th>{t.manage.colStatus}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((task) => (
              <tr key={task.task_id} className={selection.picked.has(task.task_id) ? 'is-picked' : ''} onClick={() => selection.toggle(task.task_id)}>
                <td className="col-check" onClick={(event) => event.stopPropagation()}>
                  <Check checked={selection.picked.has(task.task_id)} onChange={() => selection.toggle(task.task_id)} label={task.title} />
                </td>
                <td><span className="muted small">#{task.number}</span> <span className="bulk-name">{task.title}</span></td>
                <td className="muted small wide-only">{names.get(task.conversation_id)}</td>
                <td className="small wide-only">{task.assignee?.label ?? '—'}</td>
                <td><span className={`state state-${task.status}`}>{t.overview.taskStatus[task.status]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ActionBar count={selected.length} onClear={selection.clear}>
        <span className="muted small">{t.manage.setStatus}</span>
        {TASK_STATES.map((status) => (
          <ActionButton key={status} className="btn btn-sm" disabled={selected.every((task) => task.status === status)} onAction={async () => { await each(selected.filter((task) => task.status !== status), (task) => api.updateTask(task.task_id, { status }), t.manage.verbUpdated); }}>
            {t.overview.taskStatus[status]}
          </ActionButton>
        ))}
        {selected.some((task) => task.assignee !== null) && (
          <ActionButton className="btn btn-sm btn-quiet" onAction={async () => { await each(selected.filter((task) => task.assignee !== null), (task) => api.updateTask(task.task_id, { assignee_session_id: null }), t.manage.verbUpdated); }}>
            {t.manage.unassign}
          </ActionButton>
        )}
      </ActionBar>
    </>
  );
}

const PAGE = 120;

function MessagesTab() {
  const { api, data, run, notify, events } = useConsole();
  const { t } = useI18n();
  const choices = data.conversations.filter((entry) => entry.status === 'open' && entry.message_count > 0);
  const [conversationId, setConversationId] = useState(choices.find((entry) => entry.kind === 'lobby')?.conversation_id ?? choices[0]?.conversation_id ?? '');
  const conversation = data.conversations.find((entry) => entry.conversation_id === conversationId);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const stamp = events.filter((event) => event.conversation_id === conversationId).length;
  useEffect(() => {
    if (conversation === undefined) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void api
      .messages(conversation.conversation_id, Math.max(0, conversation.last_seq - PAGE), PAGE)
      .then((page) => !cancelled && setMessages([...page.messages].reverse()))
      .catch(() => !cancelled && setMessages([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, conversationId, stamp, conversation?.last_seq]);
  const list = (messages ?? []).filter((message) => message.kind !== 'system');
  const selection = useSelection(list.map((message) => message.message_id));
  const selected = list.filter((message) => selection.picked.has(message.message_id));
  const mark = (field: 'keep' | 'resolve' | 'drop' | 'restore') => async () => {
    const done = await run(() => api.compactConversation(conversationId, { [field]: selected.map((message) => message.sequence) }));
    if (done !== undefined) {
      notify('ok', t.manage.done(t.manage.verbMarked, selected.length));
      selection.clear();
    }
  };
  return (
    <>
      <div className="bulk-filters">
        <label className="field-inline">
          <span className="muted small">{t.manage.pickConversation}</span>
          <select value={conversationId} onChange={(event) => setConversationId(event.target.value)}>
            {choices.map((entry) => (
              <option key={entry.conversation_id} value={entry.conversation_id}>{conversationName(entry, t)} · {entry.message_count}</option>
            ))}
          </select>
        </label>
        {conversation !== undefined && messages !== null && <span className="muted small">{t.manage.showing(list.length, conversation.message_count)}</span>}
      </div>
      <p className="muted small">{t.manage.messagesHint}</p>
      {messages === null ? (
        <p className="muted">{t.manage.loadingMessages}</p>
      ) : list.length === 0 ? (
        <p className="muted">{t.manage.none}</p>
      ) : (
        <table className="bulk-table">
          <thead>
            <tr>
              <th className="col-check"><Check checked={selection.all} mixed={selection.some} onChange={selection.toggleAll} label={t.manage.selectAll} /></th>
              <th className="num">#</th>
              <th>{t.manage.tabMessages}</th>
              <th className="wide-only">{t.manage.colActivity}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((message) => (
              <tr key={message.message_id} className={`${selection.picked.has(message.message_id) ? 'is-picked' : ''} ${message.context === 'dropped' || message.context === 'resolved' ? 'is-out' : ''}`} onClick={() => selection.toggle(message.message_id)}>
                <td className="col-check" onClick={(event) => event.stopPropagation()}>
                  <Check checked={selection.picked.has(message.message_id)} onChange={() => selection.toggle(message.message_id)} label={`#${message.sequence}`} />
                </td>
                <td className="num muted small">{message.sequence}</td>
                <td>
                  <div className="bulk-message">
                    <span className="bulk-who">{message.sender.kind === 'operator' ? t.common.operator : message.from_window?.name ?? message.sender.label ?? message.sender.display_name}</span>
                    {message.urgent && <span className="tag">{t.overview.urgent}</span>}
                    {message.context !== null && <span className="tag">{t.workspace.contextLabel[message.context]}</span>}
                    <span className="bulk-snippet">{message.body.replace(/\s+/g, ' ').slice(0, 160)}</span>
                  </div>
                </td>
                <td className="muted small wide-only">{formatTime(message.created_at, t.dateLocale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ActionBar count={selected.length} onClear={selection.clear}>
        <ActionButton className="btn btn-sm" onAction={mark('keep')}>{t.manage.keep}</ActionButton>
        <ActionButton className="btn btn-sm" onAction={mark('resolve')}>{t.manage.resolve}</ActionButton>
        <ActionButton className="btn btn-sm" onAction={mark('drop')}>{t.manage.drop}</ActionButton>
        {selected.some((message) => message.context !== null) && <ActionButton className="btn btn-sm btn-quiet" onAction={mark('restore')}>{t.manage.putBack}</ActionButton>}
      </ActionBar>
    </>
  );
}

export function ManageView() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('conversations');
  return (
    <main className="page sheet">
      <div className="page-inner bulk">
        <header className="page-head">
          <div>
            <h1>{t.manage.title}</h1>
            <p>{t.manage.subtitle}</p>
          </div>
          <Segmented
            label={t.manage.tabsAria}
            value={tab}
            onChange={setTab}
            options={[
              { id: 'conversations', label: t.manage.tabConversations },
              { id: 'tasks', label: t.manage.tabTasks },
              { id: 'messages', label: t.manage.tabMessages },
            ]}
          />
        </header>
        <div className="bulk-body" key={tab}>
          {tab === 'conversations' && <ConversationsTab />}
          {tab === 'tasks' && <TasksTab />}
          {tab === 'messages' && <MessagesTab />}
        </div>
      </div>
    </main>
  );
}
