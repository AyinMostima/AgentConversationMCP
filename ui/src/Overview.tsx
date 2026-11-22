// Overview: how busy the sessions are, where they talk, whether urgent messages
// get through, and how the boards stand. Charts are plain SVG/HTML on the
// console's tokens; every chart has a hover read-out and a table behind "...".
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Stats } from './api';
import { useConsole } from './App';
import { MoreButton, Segmented } from './format';
import { useI18n, type Messages } from './i18n';

type Range = '1' | '7' | '30';

/** Width of an element, followed as it changes. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Every bucket of the range, also the empty ones, keyed as the service keys them (UTC). */
function fill(stats: Stats): { at: string; date: Date; messages: number; urgent: number }[] {
  const hour = stats.bucket === 'hour';
  const step = hour ? 3600_000 : 86_400_000;
  const known = new Map(stats.series.map((entry) => [entry.at, entry]));
  const start = new Date(stats.from);
  const end = new Date(stats.to);
  const first = hour ? Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours()) : Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const list = [];
  for (let time = first; time <= end.getTime(); time += step) {
    const key = new Date(time).toISOString().slice(0, hour ? 13 : 10);
    const entry = known.get(key);
    list.push({ at: key, date: new Date(time), messages: entry?.messages ?? 0, urgent: entry?.urgent ?? 0 });
  }
  return list;
}

/** A rounded upper end and a square foot on the baseline. */
function column(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/** The smallest round number at or above the highest value; its half is round too. */
function niceMax(value: number): number {
  if (value <= 4) {
    return 4;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10].map((factor) => factor * power).find((candidate) => candidate >= value) ?? 10 * power;
}

function TimeChart({ stats }: { stats: Stats }) {
  const { t } = useI18n();
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const buckets = useMemo(() => fill(stats), [stats]);
  const hour = stats.bucket === 'hour';
  const anyUrgent = buckets.some((entry) => entry.urgent > 0);
  const height = 188;
  const left = 34;
  const bottom = 22;
  const top = 8;
  const plot = Math.max(0, width - left - 4);
  const band = buckets.length === 0 ? 0 : plot / buckets.length;
  const barWidth = Math.max(2, Math.min(24, band * 0.62));
  const max = niceMax(Math.max(1, ...buckets.map((entry) => entry.messages)));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  // Hours are shown in local time; a day is a UTC day, as the service counts it.
  const label = (date: Date) =>
    hour ? date.toLocaleTimeString(t.dateLocale, { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString(t.dateLocale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const every = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plot / 64))));
  const shown = hover === null ? null : buckets[hover];
  return (
    <section className="viz-card viz-wide">
      <header className="viz-head">
        <div>
          <h2>{t.overview.overTime}</h2>
          <p className="muted small">{hour ? t.overview.perHour : t.overview.perDay}</p>
        </div>
        <div className="viz-head-end">
          {anyUrgent && (
            <ul className="viz-legend" aria-label={t.overview.overTime}>
              <li><span className="viz-key viz-s1" />{t.overview.regular}</li>
              <li><span className="viz-key viz-s2" />{t.overview.urgent}</li>
            </ul>
          )}
          <MoreButton open={table} onToggle={() => setTable(!table)} label={table ? t.overview.hideTable : t.overview.showTable} />
        </div>
      </header>
      <div className="viz-plot" ref={box} onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${t.overview.overTime}: ${stats.messages}`}>
            {[0, 0.5, 1].map((share) => (
              <g key={share}>
                <line className={share === 0 ? 'viz-baseline' : 'viz-grid'} x1={left} x2={width - 4} y1={y(max * share)} y2={y(max * share)} />
                <text className="viz-tick" x={left - 6} y={y(max * share) + 4} textAnchor="end">{Math.round(max * share)}</text>
              </g>
            ))}
            {buckets.map((entry, index) => {
              const x = left + band * index + (band - barWidth) / 2;
              const ordinary = entry.messages - entry.urgent;
              const base = y(0);
              const ordinaryTop = y(ordinary);
              const urgentTop = y(entry.messages);
              const dim = hover !== null && hover !== index;
              return (
                <g key={entry.at} className={dim ? 'viz-dim' : ''}>
                  {ordinary > 0 && <path className="viz-s1-fill" d={entry.urgent > 0 ? `M${x},${base}V${ordinaryTop}H${x + barWidth}V${base}Z` : column(x, ordinaryTop, barWidth, base - ordinaryTop, 4)} />}
                  {entry.urgent > 0 && <path className="viz-s2-fill" d={column(x, urgentTop, barWidth, Math.max(1, ordinaryTop - urgentTop - (ordinary > 0 ? 2 : 0)), 4)} />}
                  {index % every === 0 && (
                    // A label near the right edge ends there instead of hanging over it.
                    <text className="viz-tick" x={Math.min(left + band * index + band / 2, width - 4)} y={height - 6} textAnchor={left + band * index + band / 2 > width - 34 ? 'end' : 'middle'}>{label(entry.date)}</text>
                  )}
                  <rect className="viz-hit" x={left + band * index} y={top} width={band} height={height - top - bottom} onMouseEnter={() => setHover(index)} />
                </g>
              );
            })}
          </svg>
        )}
        {shown !== null && hover !== null && (
          <div className="viz-tip" style={{ left: Math.min(Math.max(left + band * hover + band / 2, 70), width - 70), top: Math.max(0, y(shown.messages) - 52) }}>
            <strong>{label(shown.date)}{!hour && ` · ${shown.date.getUTCFullYear()}`}</strong>
            <span>{t.overview.tooltip(shown.messages, shown.urgent)}</span>
          </div>
        )}
      </div>
      {table && (
        <div className="viz-table-wrap">
          <table className="viz-table">
            <thead>
              <tr><th>{t.overview.when}</th><th>{t.overview.messages}</th><th>{t.overview.urgent}</th></tr>
            </thead>
            <tbody>
              {buckets.filter((entry) => entry.messages > 0).map((entry) => (
                <tr key={entry.at}><td>{label(entry.date)}</td><td>{entry.messages}</td><td>{entry.urgent}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Ranked bars of one measure: the label carries identity, so one hue does. */
function Ranked({ rows }: { rows: { key: string; label: string; detail?: string; value: number }[] }) {
  const { t } = useI18n();
  const [hover, setHover] = useState<string | null>(null);
  if (rows.length === 0) {
    return <p className="muted">{t.overview.nothing}</p>;
  }
  const max = Math.max(...rows.map((row) => row.value));
  return (
    <ol className="viz-ranked">
      {rows.map((row, index) => (
        <li key={row.key} className={hover !== null && hover !== row.key ? 'viz-dim' : ''} onMouseEnter={() => setHover(row.key)} onMouseLeave={() => setHover(null)} style={{ animationDelay: `${index * 30}ms` }}>
          <span className="viz-ranked-label" title={row.detail === undefined ? row.label : `${row.label} · ${row.detail}`}>
            {row.label}
            {row.detail !== undefined && <span className="muted"> · {row.detail}</span>}
          </span>
          <span className="viz-track">
            <span className="viz-bar" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
          </span>
          <span className="viz-value">{row.value}</span>
        </li>
      ))}
    </ol>
  );
}

/** Parts of a whole as one thin bar with a labelled legend; state colors never stand alone. */
function Parts({ parts, total, label }: { parts: { key: string; label: string; value: number; tone: string }[]; total: number; label: string }) {
  const { t } = useI18n();
  const present = parts.filter((part) => part.value > 0);
  return (
    <div className="viz-parts">
      {total === 0 ? (
        <p className="muted">{t.overview.nothing}</p>
      ) : (
        <div className="viz-partbar" role="img" aria-label={`${label}: ${present.map((part) => `${part.label} ${part.value}`).join(', ')}`}>
          {present.map((part) => (
            <span key={part.key} className={`viz-part tone-${part.tone}`} style={{ flexGrow: part.value }} title={`${part.label}: ${part.value}`} />
          ))}
        </div>
      )}
      <ul className="viz-legend viz-legend-list">
        {parts.map((part) => (
          <li key={part.key} className={part.value === 0 ? 'is-zero' : ''}>
            <span className={`viz-key tone-${part.tone}`} />
            <span>{part.label}</span>
            <strong>{part.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="viz-tile">
      <span className="viz-tile-label">{label}</span>
      <strong className="viz-tile-value">{value}</strong>
      {note !== undefined && <span className="muted small">{note}</span>}
    </div>
  );
}

function conversationLabel(entry: Stats['conversations'][number], t: Messages): string {
  if (entry.kind === 'lobby') {
    return t.overview.lobby;
  }
  if (entry.kind === 'direct' && entry.members !== '') {
    return entry.members;
  }
  return entry.title !== '' ? entry.title : entry.task_code;
}

export function OverviewView() {
  const { api, events } = useConsole();
  const { t } = useI18n();
  const [range, setRange] = useState<Range>('7');
  const [stats, setStats] = useState<Stats | null>(null);
  const [who, setWho] = useState<'sessions' | 'windows'>('sessions');
  // Read again when something happened, at most every few seconds.
  const stamp = Math.floor(events.length / 10);
  useEffect(() => {
    let cancelled = false;
    void api.stats(Number(range)).then((result) => !cancelled && setStats(result)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, range, stamp]);

  const handed = stats === null ? 0 : stats.deliveries.ok + stats.deliveries.failed;
  return (
    <main className="page sheet">
      <div className="page-inner viz">
        <header className="page-head">
          <div>
            <h1>{t.overview.title}</h1>
            <p>{t.overview.subtitle}</p>
          </div>
          <Segmented
            size="sm"
            label={t.overview.rangeAria}
            value={range}
            onChange={setRange}
            options={[
              { id: '1', label: t.overview.range1 },
              { id: '7', label: t.overview.range7 },
              { id: '30', label: t.overview.range30 },
            ]}
          />
        </header>
        {stats === null ? (
          <p className="muted">{t.overview.loading}</p>
        ) : (
          <>
            <div className="viz-tiles">
              <Tile label={t.overview.messages} value={String(stats.messages)} />
              <Tile label={t.overview.urgent} value={String(stats.urgent)} />
              <Tile label={t.overview.activeWindows} value={String(stats.active_windows)} />
              <Tile label={t.overview.handedOver} value={handed === 0 ? '—' : `${Math.round((stats.deliveries.ok / handed) * 100)}%`} note={handed === 0 ? t.overview.handedOverNone : `${stats.deliveries.ok} / ${handed}`} />
            </div>
            <TimeChart stats={stats} />
            <div className="viz-grid">
              <section className="viz-card">
                <header className="viz-head">
                  <h2>{t.overview.who}</h2>
                  <Segmented
                    size="sm"
                    label={t.overview.who}
                    value={who}
                    onChange={setWho}
                    options={[
                      { id: 'sessions', label: t.overview.whoSessions },
                      { id: 'windows', label: t.overview.whoWindows },
                    ]}
                  />
                </header>
                {who === 'sessions' ? (
                  <Ranked rows={stats.senders.map((entry, index) => ({ key: `${entry.label ?? 'operator'}-${index}`, label: entry.label === null ? t.overview.operator : entry.name, detail: entry.label ?? undefined, value: entry.messages }))} />
                ) : (
                  <Ranked rows={stats.windows.map((entry) => ({ key: entry.name, label: entry.name, detail: entry.app, value: entry.messages }))} />
                )}
              </section>
              <section className="viz-card">
                <header className="viz-head">
                  <h2>{t.overview.where}</h2>
                </header>
                <Ranked rows={stats.conversations.map((entry) => ({ key: entry.conversation_id, label: conversationLabel(entry, t), detail: entry.kind === 'direct' ? t.overview.direct : undefined, value: entry.messages }))} />
              </section>
              <section className="viz-card">
                <header className="viz-head">
                  <div>
                    <h2>{t.overview.deliveries}</h2>
                    <p className="muted small">{t.overview.deliveriesHint}</p>
                  </div>
                </header>
                <Parts
                  label={t.overview.deliveries}
                  total={Object.values(stats.deliveries).reduce((sum, value) => sum + value, 0)}
                  parts={[
                    { key: 'ok', label: t.overview.outcome.ok, value: stats.deliveries.ok, tone: 'good' },
                    { key: 'running', label: t.overview.outcome.running, value: stats.deliveries.running, tone: 'warning' },
                    { key: 'skipped', label: t.overview.outcome.skipped, value: stats.deliveries.skipped, tone: 'quiet' },
                    { key: 'failed', label: t.overview.outcome.failed, value: stats.deliveries.failed, tone: 'critical' },
                  ]}
                />
                {Object.keys(stats.delivery_routes).length > 0 && (
                  <ul className="viz-routes">
                    {Object.entries(stats.delivery_routes).map(([route, counts]) => (
                      <li key={route}>
                        <span>{t.overview.route[route] ?? route}</span>
                        <span className="muted small">
                          {counts.ok} {t.overview.outcome.ok}
                          {counts.failed > 0 && ` · ${counts.failed} ${t.overview.outcome.failed}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="viz-card">
                <header className="viz-head">
                  <div>
                    <h2>{t.overview.tasks}</h2>
                    <p className="muted small">{t.overview.tasksHint}</p>
                  </div>
                </header>
                <Parts
                  label={t.overview.tasks}
                  total={Object.values(stats.tasks).reduce((sum, value) => sum + value, 0)}
                  parts={(['todo', 'doing', 'blocked', 'done', 'cancelled'] as const).map((status) => ({
                    key: status,
                    label: t.overview.taskStatus[status],
                    value: stats.tasks[status],
                    tone: { todo: 'quiet', doing: 's1', blocked: 'critical', done: 'good', cancelled: 'faint' }[status],
                  }))}
                />
              </section>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
