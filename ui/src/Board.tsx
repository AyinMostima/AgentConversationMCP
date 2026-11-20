// Conversation goal editor and shared task board. Agents read and update the
// same task board through MCP tools; this view gives the operator direct control.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Conversation, Task, TaskStatus } from './api';
import { Dialog, useConsole } from './App';
import { MoreButton, Pill, SubmitButton, formatFullTime, useBusy } from './format';
import { useI18n } from './i18n';

const TASK_TONE: Record<TaskStatus, string> = {
  doing: 'proposed',
  blocked: 'warn',
  todo: 'muted',
  done: 'ok',
  cancelled: 'muted',
};
const TASK_ORDER: TaskStatus[] = ['doing', 'blocked', 'todo', 'done', 'cancelled'];
const OPEN_ORDER: TaskStatus[] = ['doing', 'blocked', 'todo'];

/** Loads tasks for a conversation and refreshes on committed task events. */
export function useTasks(conversation: Conversation | undefined) {
  const { api, events } = useConsole();
  const id = conversation?.conversation_id;
  const [tasks, setTasks] = useState<Task[]>([]);
  const reload = useCallback(async () => {
    if (id !== undefined) {
      setTasks((await api.tasks(id)).tasks);
    }
  }, [api, id]);
  const relevant = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].conversation_id === id && events[index].event_type.startsWith('task.')) {
        return events[index].event_id;
      }
    }
    return 0;
  }, [events, id]);
  useEffect(() => setTasks([]), [id]);
  useEffect(() => {
    void reload();
  }, [reload, relevant]);
  return { tasks, reload };
}

export function GoalLine({ conversation }: { conversation: Conversation }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, track] = useBusy();
  const open = () => {
    setDraft(conversation.goal ?? '');
    setEditing(true);
  };
  return (
    <>
      {conversation.goal === null ? (
        <button type="button" className="goal goal-empty" onClick={open}>{t.board.setGoal}</button>
      ) : (
        <button type="button" className="goal" title={t.board.editGoalTitle} onClick={open}>
          <span className="goal-label">{t.board.goalLabel}</span>
          <span className="goal-text">{conversation.goal}</span>
        </button>
      )}
      {editing && (
        <Dialog title={t.board.goalDialogTitle} onClose={() => setEditing(false)}>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void track(run(() => api.setGoal(conversation.conversation_id, draft.trim() === '' ? null : draft.trim()), t.board.goalUpdated)).then((saved) => saved !== undefined && setEditing(false));
            }}
          >
            <label className="field">
              <span>{t.board.goalFieldLabel}</span>
              <textarea autoFocus rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t.board.goalPlaceholder} />
              <small>{t.board.goalHint}</small>
            </label>
            <div className="form-actions">
              <button type="button" className="btn btn-quiet" onClick={() => setEditing(false)}>{t.common.cancel}</button>
              <SubmitButton busy={busy}>{t.board.saveGoal}</SubmitButton>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

function NewTaskDialog({ conversation, onClose, onCreated }: { conversation: Conversation; onClose: () => void; onCreated: () => void }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [assignee, setAssignee] = useState('');
  const [busy, track] = useBusy();
  return (
    <Dialog title={t.board.newTaskTitle} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void track(run(() => api.createTask(conversation.conversation_id, { title: title.trim(), detail: detail.trim() === '' ? undefined : detail.trim(), assignee_session_id: assignee === '' ? undefined : assignee }), t.board.taskCreated)).then((created) => {
            if (created !== undefined) {
              onCreated();
              onClose();
            }
          });
        }}
      >
        <label className="field">
          <span>{t.board.taskTitleLabel}</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t.board.taskTitlePlaceholder} />
        </label>
        <label className="field">
          <span>{t.board.taskDetailLabel}</span>
          <textarea rows={3} value={detail} onChange={(event) => setDetail(event.target.value)} placeholder={t.board.taskDetailPlaceholder} />
        </label>
        <label className="field">
          <span>{t.board.assigneeLabel}</span>
          <select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="">{t.board.unassignedOption}</option>
            {conversation.members.map((member) => (
              <option key={member.session_id} value={member.session_id}>{member.display_name} · {member.label}</option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>{t.common.cancel}</button>
          <SubmitButton busy={busy} disabled={title.trim() === ''}>{t.board.addTaskBtn}</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

function TaskRow({ task, conversation, onChanged }: { task: Task; conversation: Conversation; onChanged: () => void }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const change = (body: Parameters<typeof api.updateTask>[1], message: string) =>
    run(() => api.updateTask(task.task_id, { ...body, expected_version: task.version }), message).then(onChanged);
  return (
    <li className="task">
      <div className="task-row">
        <span className="task-num">#{task.number}</span>
        <span className="task-title">{task.title}</span>
        <span className="task-who">{task.assignee === null ? t.board.unclaimed : task.assignee.label}</span>
        <Pill tone={TASK_TONE[task.status]}>{t.board.status[task.status]}</Pill>
        <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.board.taskDetailsAria(task.number)} />
      </div>
      {open && (
        <div className="details">
          {task.detail !== null && <p>{task.detail}</p>}
          {task.note !== null && <p className="muted">{t.board.latestNote(task.note)}</p>}
          <div className="task-controls">
            <label className="inline-field">
              <span>{t.board.statusLabel}</span>
              <select value={task.status} onChange={(event) => void change({ status: event.target.value as TaskStatus }, t.board.statusUpdated)}>
                {TASK_ORDER.map((value) => (
                  <option key={value} value={value}>{t.board.status[value]}</option>
                ))}
              </select>
            </label>
            <label className="inline-field">
              <span>{t.board.ownerLabel}</span>
              <select value={task.assignee?.session_id ?? ''} onChange={(event) => void change({ assignee_session_id: event.target.value === '' ? null : event.target.value }, t.board.ownerUpdated)}>
                <option value="">{t.board.unclaimed}</option>
                {conversation.members.map((member) => (
                  <option key={member.session_id} value={member.session_id}>{member.display_name} · {member.label}</option>
                ))}
              </select>
            </label>
          </div>
          <form
            className="task-note"
            onSubmit={(event) => {
              event.preventDefault();
              void change({ note: note.trim() }, t.board.noteUpdated).then(() => setNote(''));
            }}
          >
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t.board.notePlaceholder} aria-label={t.board.noteAria} />
            <button type="submit" className="btn btn-sm" disabled={note.trim() === ''}>{t.board.saveNoteBtn}</button>
          </form>
          <span className="detail-time">{t.board.updatedAt(formatFullTime(task.updated_at, t.dateLocale))}</span>
        </div>
      )}
    </li>
  );
}

export function BoardView({ conversation, tasks, reload }: { conversation: Conversation; tasks: Task[]; reload: () => void }) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const open = OPEN_ORDER.flatMap((status) => tasks.filter((task) => task.status === status));
  const closed = tasks.filter((task) => task.status === 'done' || task.status === 'cancelled');
  return (
    <div className="board">
      <div className="board-inner">
        <div className="board-head">
          <p className="muted">{t.board.intro}</p>
          <button type="button" className="btn" onClick={() => setCreating(true)}>{t.board.newTaskBtn}</button>
        </div>
        {tasks.length === 0 && (
          <div className="empty">
            <h3>{t.board.emptyTitle}</h3>
            <p className="muted">{t.board.emptyDesc}</p>
          </div>
        )}
        {open.length > 0 && (
          <ul className="tasks">
            {open.map((task) => (
              <TaskRow key={task.task_id} task={task} conversation={conversation} onChanged={reload} />
            ))}
          </ul>
        )}
        {closed.length > 0 && (
          <details className="closed">
            <summary>{t.board.closedSummary(closed.length)}</summary>
            <ul className="tasks">
              {closed.map((task) => (
                <TaskRow key={task.task_id} task={task} conversation={conversation} onChanged={reload} />
              ))}
            </ul>
          </details>
        )}
      </div>
      {creating && <NewTaskDialog conversation={conversation} onClose={() => setCreating(false)} onCreated={reload} />}
    </div>
  );
}
