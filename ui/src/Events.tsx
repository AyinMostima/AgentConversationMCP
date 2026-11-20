// Committed event stream view for inspecting sends, receipts, pairings, and
// configuration updates in chronological order.
import { useMemo, useState } from 'react';
import { useConsole } from './App';
import { Segmented, conversationName as nameOf, formatFullTime, shortId } from './format';
import { useI18n } from './i18n';

export function EventsView() {
  const { data, events, connection } = useConsole();
  const { t } = useI18n();
  const [group, setGroup] = useState('');
  const groups = useMemo(
    () => [
      { id: '', label: t.events.groups.all },
      { id: 'message.', label: t.events.groups.message },
      { id: 'pairing.', label: t.events.groups.pairing },
      { id: 'session.', label: t.events.groups.session },
      { id: 'conversation.', label: t.events.groups.conversation },
    ],
    [t],
  );
  const shown = useMemo(() => events.filter((event) => event.event_type.startsWith(group)).slice().reverse(), [events, group]);
  const conversationName = (id: string | null) => {
    const found = id === null ? undefined : data.conversations.find((entry) => entry.conversation_id === id);
    if (found === undefined) {
      return id === null ? '—' : shortId(id);
    }
    return found.kind === 'topic' ? found.task_code : nameOf(found, t);
  };
  const actorName = (id: string | null) => {
    if (id === null) {
      return t.common.operatorOrSystem;
    }
    const session = data.sessions.find((entry) => entry.session_id === id);
    return session === undefined ? shortId(id) : `${data.agents.find((agent) => agent.agent_id === session.agent_id)?.display_name ?? session.agent_id} · ${session.label}`;
  };
  const connLabel = connection === 'live' ? t.events.connLive : connection === 'connecting' ? t.events.connConnecting : t.events.connReconnecting;
  return (
    <main className="page sheet">
      <div className="page-inner">
        <header className="page-head">
          <div>
            <h1>{t.events.title}</h1>
            <p>{t.events.subtitle}</p>
          </div>
        </header>
        <p className="summary-line">{t.events.summary(data.event_watermark, events.length, connLabel)}</p>
        <div>
          <Segmented size="sm" label={t.events.groupAria} value={group} onChange={setGroup} options={groups} />
        </div>
        {shown.length === 0 ? (
          <p className="empty-inline">{t.events.empty}</p>
        ) : (
          <div className="table-wrap">
            <table className="table table-events">
              <thead>
                <tr>
                  <th>{t.events.colId}</th>
                  <th>{t.events.colTime}</th>
                  <th>{t.events.colEvent}</th>
                  <th>{t.events.colConversation}</th>
                  <th>{t.events.colActor}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((event) => (
                  <tr key={event.event_id}>
                    <td className="mono">{event.event_id}</td>
                    <td className="muted nowrap">{formatFullTime(event.occurred_at, t.dateLocale)}</td>
                    <td title={event.event_type}>{t.events.types[event.event_type] ?? event.event_type}</td>
                    <td className="mono">{conversationName(event.conversation_id)}</td>
                    <td title={event.entity_id}>{actorName(event.actor_id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
