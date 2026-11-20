// Conversation organization controls: search, type/inactivity filters,
// single-conversation editing, archiving, clearing, deletion, and bulk actions.
import { useState, type MouseEvent } from 'react';
import type { Conversation } from './api';
import { ConfirmDialog, Dialog, useConsole } from './App';
import { ActionButton, Icon, Segmented, SubmitButton, conversationName, formatTime, useBusy } from './format';
import { useI18n, type Messages } from './i18n';

export type Scope = 'all' | 'topic' | 'direct';
export interface ListFilter {
  query: string;
  scope: Scope;
  idle: boolean;
}
export const NO_FILTER: ListFilter = { query: '', scope: 'all', idle: false };
export const isFiltering = (filter: ListFilter) => filter.query.trim() !== '' || filter.scope !== 'all' || filter.idle;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const lastActivity = (conversation: Conversation) => conversation.last_message_at ?? conversation.created_at;

export function matchesFilter(conversation: Conversation, filter: ListFilter, t: Messages): boolean {
  if (filter.scope !== 'all' && conversation.kind !== filter.scope) {
    return false;
  }
  if (filter.idle && Date.now() - new Date(lastActivity(conversation)).getTime() < WEEK_MS) {
    return false;
  }
  const query = filter.query.trim().toLowerCase();
  if (query === '') {
    return true;
  }
  const text = [
    conversationName(conversation, t, 'full'),
    conversation.task_code,
    conversation.purpose ?? '',
    ...conversation.members.map((member) => `${member.display_name} ${member.label}`),
  ].join(' ').toLowerCase();
  return query.split(/\s+/).every((word) => text.includes(word));
}

/** Search input paired with a scope/inactivity filter menu. */
export function ListSearch({ filter, onChange }: { filter: ListFilter; onChange: (next: ListFilter) => void }) {
  const { t } = useI18n();
  const narrowed = filter.scope !== 'all' || filter.idle;
  const choice = (label: string, on: boolean, next: Partial<ListFilter>) => (
    <button type="button" className="menu-item menu-check" role="menuitemcheckbox" aria-checked={on} onClick={() => onChange({ ...filter, ...next })}>
      <span className="menu-mark">{on && <Icon name="check" size={13} />}</span>
      {label}
    </button>
  );
  return (
    <div className="sidebar-search">
      <label className="search-field">
        <Icon name="search" size={14} />
        <input type="search" value={filter.query} placeholder={t.tidy.searchPlaceholder} aria-label={t.tidy.searchAria} onChange={(event) => onChange({ ...filter, query: event.target.value })} />
      </label>
      <details className="menu">
        <summary className={`btn btn-quiet btn-icon ${narrowed ? 'is-on' : ''}`} aria-label={t.tidy.filterAria} title={t.tidy.filterAria}>
          <Icon name="filter" />
        </summary>
        <div className="menu-pop menu-pop-end" role="menu">
          {choice(t.tidy.scopeAll, filter.scope === 'all', { scope: 'all' })}
          {choice(t.tidy.scopeTopic, filter.scope === 'topic', { scope: 'topic' })}
          {choice(t.tidy.scopeDirect, filter.scope === 'direct', { scope: 'direct' })}
          <div className="menu-rule" />
          {choice(t.tidy.idleWeek, filter.idle, { idle: !filter.idle })}
        </div>
      </details>
    </div>
  );
}

function EditDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const [title, setTitle] = useState(conversation.title);
  const [taskCode, setTaskCode] = useState(conversation.task_code);
  const [purpose, setPurpose] = useState(conversation.purpose ?? '');
  const [busy, track] = useBusy();
  return (
    <Dialog title={t.tidy.editTitle} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void track(run(() => api.updateConversation(conversation.conversation_id, { title: title.trim(), task_code: taskCode.trim(), purpose: purpose.trim() }), t.tidy.editUpdated)).then((saved) => saved !== undefined && onClose());
        }}
      >
        <label className="field">
          <span>{t.tidy.titleLabel}</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field">
          <span>{t.tidy.taskCodeLabel}</span>
          <input value={taskCode} onChange={(event) => setTaskCode(event.target.value)} spellCheck={false} />
          <small>{t.tidy.taskCodeHint}</small>
        </label>
        <label className="field">
          <span>{t.tidy.purposeLabel}</span>
          <textarea rows={2} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder={t.tidy.purposePlaceholder} />
        </label>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>{t.common.cancel}</button>
          <SubmitButton busy={busy} disabled={title.trim() === '' || taskCode.trim() === ''}>{t.common.save}</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

type Range = 'all' | '7' | '30';

function ClearDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const { api, run, notify } = useConsole();
  const { t } = useI18n();
  const [range, setRange] = useState<Range>('all');
  return (
    <Dialog title={t.tidy.clearTitle} onClose={onClose}>
      <div className="form">
        <p className="muted">{t.tidy.clearDescription(conversationName(conversation, t), conversation.message_count)}</p>
        <div className="inline-field">
          <span>{t.tidy.rangeLabel}</span>
          <Segmented
            size="sm"
            label={t.tidy.rangeAria}
            value={range}
            onChange={setRange}
            options={[
              { id: 'all', label: t.tidy.rangeAll },
              { id: '7', label: t.tidy.range7 },
              { id: '30', label: t.tidy.range30 },
            ]}
          />
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" autoFocus onClick={onClose}>{t.common.cancel}</button>
          <ActionButton
            className="btn btn-destructive"
            onAction={async () => {
              const cleared = await run(() => api.clearConversation(conversation.conversation_id, range === 'all' ? 0 : Number(range)));
              if (cleared !== undefined) {
                notify('ok', cleared.deleted_messages === 0 ? t.tidy.clearNone : t.tidy.clearDeleted(cleared.deleted_messages));
                onClose();
              }
            }}
          >
            {t.tidy.clearConfirm}
          </ActionButton>
        </div>
      </div>
    </Dialog>
  );
}

export function deletionSummary(list: Conversation[], t: Messages): string {
  const messages = list.reduce((sum, entry) => sum + entry.message_count, 0);
  const tasks = list.reduce((sum, entry) => sum + entry.open_tasks, 0);
  const singleName = list.length === 1 ? conversationName(list[0], t) : '';
  return t.tidy.deletionSummary(list.length, singleName, messages, tasks);
}

/** Conversation header action menu: edit, archive/restore, clear, delete. */
export function ConversationMenu({ conversation }: { conversation: Conversation }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const [dialog, setDialog] = useState<'edit' | 'clear' | 'delete' | null>(null);
  const archived = conversation.status === 'archived';
  const fixed = conversation.kind === 'lobby';
  const pick = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest('details')?.removeAttribute('open');
    action();
  };
  const name = conversationName(conversation, t);
  return (
    <>
      <details className="menu">
        <summary className="btn btn-quiet btn-icon" aria-label={t.tidy.menuAria} title={t.tidy.menuAria}>
          <Icon name="more" />
        </summary>
        <div className="menu-pop menu-pop-end" role="menu">
          {conversation.kind === 'topic' && (
            <button type="button" className="menu-item" role="menuitem" onClick={pick(() => setDialog('edit'))}>
              <Icon name="edit" size={14} /> {t.tidy.edit}
            </button>
          )}
          {!fixed && (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={pick(() => void run(() => api.updateConversation(conversation.conversation_id, { archived: !archived }), archived ? t.tidy.restoredToast(name) : t.tidy.archivedToast(name)))}
            >
              <Icon name={archived ? 'restart' : 'archive'} size={14} /> {archived ? t.tidy.restore : t.tidy.archive}
            </button>
          )}
          <button type="button" className="menu-item" role="menuitem" disabled={conversation.message_count === 0} onClick={pick(() => setDialog('clear'))}>
            <Icon name="broom" size={14} /> {t.tidy.clearMessages}
          </button>
          {!fixed && (
            <>
              <div className="menu-rule" />
              <button type="button" className="menu-item menu-item-danger" role="menuitem" onClick={pick(() => setDialog('delete'))}>
                <Icon name="trash" size={14} /> {t.common.delete}
              </button>
            </>
          )}
        </div>
      </details>
      {dialog === 'edit' && <EditDialog conversation={conversation} onClose={() => setDialog(null)} />}
      {dialog === 'clear' && <ClearDialog conversation={conversation} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <ConfirmDialog title={t.tidy.deleteTitle} message={deletionSummary([conversation], t)} confirmLabel={t.tidy.deleteConfirm} onConfirm={() => run(() => api.deleteConversation(conversation.conversation_id), t.tidy.deletedToast(name))} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

/** Banner rendered in place of the composer when viewing an archived thread. */
export function ArchivedBar({ conversation }: { conversation: Conversation }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  return (
    <div className="archived-bar">
      <Icon name="archive" size={15} />
      <span>{t.tidy.archivedBarText(conversation.last_message_at !== null ? formatTime(conversation.last_message_at, t.dateLocale) : null)}</span>
      <ActionButton className="btn btn-sm" onAction={() => run(() => api.updateConversation(conversation.conversation_id, { archived: false }), t.tidy.archivedRestored)}>
        {t.tidy.restore}
      </ActionButton>
    </div>
  );
}

/** Bulk selection action bar in management mode. */
export function TidyBar({ selected, visible, onSelect, onDone }: { selected: Conversation[]; visible: Conversation[]; onSelect: (ids: string[]) => void; onDone: () => void }) {
  const { api, run, notify } = useConsole();
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const pickable = visible.filter((entry) => entry.kind !== 'lobby');
  const open = selected.filter((entry) => entry.status !== 'archived');
  const archived = selected.filter((entry) => entry.status === 'archived');
  const all = pickable.length > 0 && pickable.every((entry) => selected.some((picked) => picked.conversation_id === entry.conversation_id));
  const each = async (list: Conversation[], action: (entry: Conversation) => Promise<unknown>, verb: string) => {
    let count = 0;
    for (const entry of list) {
      if ((await run(() => action(entry))) === undefined) {
        break;
      }
      count += 1;
    }
    if (count > 0) {
      notify('ok', t.tidy.batchResult(verb, count));
    }
    onSelect([]);
  };
  return (
    <div className="tidy-bar" role="toolbar" aria-label={t.tidy.tidyBarAria}>
      <div className="tidy-count">
        <strong>{selected.length === 0 ? t.tidy.selectHint : t.tidy.selectedCount(selected.length)}</strong>
        <button type="button" className="link" onClick={() => onSelect(all ? [] : pickable.map((entry) => entry.conversation_id))}>
          {all ? t.tidy.deselectAll : t.tidy.selectAll(pickable.length)}
        </button>
      </div>
      <div className="tidy-actions">
        {open.length > 0 && (
          <ActionButton className="btn btn-sm" onAction={() => each(open, (entry) => api.updateConversation(entry.conversation_id, { archived: true }), t.tidy.batchArchived)}>
            <Icon name="archive" size={14} /> {t.tidy.archive}
          </ActionButton>
        )}
        {archived.length > 0 && (
          <ActionButton className="btn btn-sm" onAction={() => each(archived, (entry) => api.updateConversation(entry.conversation_id, { archived: false }), t.tidy.batchRestored)}>
            <Icon name="restart" size={14} /> {t.tidy.restore}
          </ActionButton>
        )}
        <button type="button" className="btn btn-sm btn-quiet tidy-delete" disabled={selected.length === 0} onClick={() => setConfirming(true)}>
          <Icon name="trash" size={14} /> {t.common.delete}
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onDone}>{t.common.done}</button>
      </div>
      {confirming && (
        <ConfirmDialog title={t.tidy.deleteTitle} message={deletionSummary(selected, t)} confirmLabel={t.tidy.deleteConfirmCount(selected.length)} onConfirm={() => each(selected, (entry) => api.deleteConversation(entry.conversation_id), t.tidy.batchDeleted)} onClose={() => setConfirming(false)} />
      )}
    </div>
  );
}
