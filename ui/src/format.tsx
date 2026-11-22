// Presentation helpers: localized time and identifiers, provider marks, icons,
// interactive controls, and a safe Markdown renderer.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Conversation, ReceiptStatus, SessionStatus } from './api';
import { useI18n, type Messages } from './i18n';

/** Maps a provider identifier to its desktop client dispatcher name. */
export const CLIENT_OF_PROVIDER: Record<string, string> = { openai: 'codex', google: 'antigravity', anthropic: 'claude' };

/** Human-readable client label for quota and route diagnostics. */
export function clientDisplayName(client: string): string {
  return ({ codex: 'Codex', antigravity: 'Antigravity', claude: 'Claude' } as Record<string, string>)[client] ?? client;
}

/** Display title for a conversation, including lobby and direct threads. */
export function conversationName(conversation: Conversation, t: Messages, detail: 'short' | 'full' = 'short'): string {
  if (conversation.kind === 'lobby') {
    return t.conversation.lobby;
  }
  if (conversation.kind === 'direct') {
    const names = conversation.members.map((member) => (detail === 'full' ? `${member.display_name} · ${member.label}` : member.label));
    return names.length >= 2 ? names.join(' ↔ ') : names.length === 1 ? t.conversation.directSingle(names[0]) : t.conversation.directFallback;
  }
  return conversation.title;
}

export function formatTime(iso: string, dateLocale = 'en-US'): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) {
    return time;
  }
  return `${date.toLocaleDateString(dateLocale, { month: 'numeric', day: 'numeric' })} ${time}`;
}

export function formatFullTime(iso: string | null, dateLocale = 'en-US'): string {
  return iso === null ? '—' : new Date(iso).toLocaleString(dateLocale, { hour12: false });
}

/** Shortens stable IDs (e.g. "ses_3f9a...c21e") for compact display. */
export function shortId(id: string | null): string {
  if (id === null) {
    return '—';
  }
  const [prefix, rest] = id.split('_');
  return rest === undefined || rest.length <= 10 ? id : `${prefix}_${rest.slice(0, 4)}…${rest.slice(-4)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const PROVIDERS: Record<string, { name: string; mark: string; tone: string }> = {
  anthropic: { name: 'Claude', mark: 'C', tone: 'clay' },
  openai: { name: 'Codex', mark: 'X', tone: 'ink' },
  google: { name: 'Antigravity', mark: 'A', tone: 'sky' },
  xai: { name: 'Grok', mark: 'G', tone: 'plum' },
};

export function providerInfo(provider: string | null, t: Messages): { name: string; mark: string; tone: string } {
  if (provider === null) {
    return { name: t.common.operator, mark: t.common.operatorMark, tone: 'accent' };
  }
  return PROVIDERS[provider] ?? { name: provider, mark: provider.slice(0, 1).toUpperCase(), tone: 'ink' };
}

// Who speaks has a face: one picture per application, and one for the operator
// (ui/public/avatars: the operator's own drawings, unchanged). Anything else
// keeps its monogram.
const AVATARS: Record<string, string> = { anthropic: 'claude', openai: 'codex', google: 'antigravity', xai: 'grok' };

export function ProviderMark({ provider, size = 'md' }: { provider: string | null; size?: 'sm' | 'md' }) {
  const { t } = useI18n();
  const info = providerInfo(provider, t);
  const avatar = provider === null ? 'operator' : AVATARS[provider];
  if (avatar !== undefined) {
    return <img className={`mark mark-${size} mark-avatar`} src={`/avatars/${avatar}.png`} alt="" aria-hidden="true" loading="lazy" draggable={false} />;
  }
  return (
    <span className={`mark mark-${size}`} aria-hidden="true">
      {info.mark}
    </span>
  );
}

export const SESSION_TONE: Record<SessionStatus, string> = {
  pending: 'muted',
  requested: 'review',
  active: 'ok',
  revoked: 'danger',
  expired: 'muted',
};

export const RECEIPT_TONE: Record<ReceiptStatus, string> = {
  available: 'muted',
  read: 'info',
  acknowledged: 'ok',
};

export const RUN_TONE: Record<string, string> = {
  running: 'info',
  waiting: 'warn',
  completed: 'ok',
  failed: 'danger',
  cancelled: 'muted',
};

// ---- icons -----------------------------------------------------------------

const PATHS: Record<string, string> = {
  chat: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V16A2.5 2.5 0 0 1 4 13.5z',
  agents: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm-6 8.5c0-3 2.7-5 6-5s6 2 6 5M16.5 5a3 3 0 0 1 0 6m2 3.6c1.5.8 2.5 2.2 2.5 3.9',
  pulse: 'M3 12h4l2.5-6 4 12 2.5-6h5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checks: 'M2.5 12.5l4 4 8-9M10 15.5l1.5 1 9-9.5',
  dot: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  alert: 'M12 8.5v4.5m0 3.5v.01M10.3 4.2 3 17a2 2 0 0 0 1.7 3h14.6A2 2 0 0 0 21 17L13.7 4.2a2 2 0 0 0-3.4 0z',
  ban: 'M5.6 5.6l12.8 12.8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3M20 16v-8',
  send: 'M4.5 12 20 4.5 15.5 20l-3.6-6.2zm7.4 1.8L20 4.5',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  panel: 'M4 5h16v14H4zM14.5 5v14',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-13v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z',
  file: 'M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20zM14 3.5v4h4',
  reply: 'M9.5 7 5 11.5 9.5 16M5 11.5h9a5 5 0 0 1 5 5V18',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3m-11 0h12v9H6z',
  down: 'M6 9.5l6 6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  key: 'M14.5 9.5a4 4 0 1 1-3.9 5H8v2.5H5.5V19H3v-2.6l5.6-5.6a4 4 0 0 1 5.9-1.3z',
  folder: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.5H19A1.5 1.5 0 0 1 20.5 9.500v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  hash: 'M9.5 4 8 20M16 4l-1.500 16M4.500 9h16M3.500 15h16',
  link: 'M10 14a4.500 4.500 0 0 0 6.400 0l3-3a4.500 4.500 0 0 0-6.400-6.400l-1 1M14 10a4.500 4.500 0 0 0-6.400 0l-3 3a4.500 4.500 0 0 0 6.400 6.400l1-1',
  filter: 'M4 6.500h16M7 12h10M10 17.500h4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.1-4.1',
  archive: 'M4 5h16v4H4zM5.5 9v9.5h13V9M10 13h4',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l.8 12.5h8.4L17 7M10.5 11v5M13.5 11v5',
  edit: 'M5 19h4L19 9l-4-4L5 15zM13.5 6.5l4 4',
  broom: 'M19.5 4.5 13 11M10.5 9.5l4 4-2 5.500c-3 .500-6-.500-8-3 2.500-.500 4-2 6-6.500z',
  restart: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.5 12h17M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.200 6.400-3.700 9c-2.500-2.600-3.700-5.600-3.700-9S9.500 5.600 12 3z',
  lang: 'M4 5h8M8 3v2m2.5 0c-.8 3.2-2.8 6-6 7.5M5.5 8c1.1 1.7 2.8 3.3 5 4.5M13 19l3.5-9L20 19m-5.8-2.5h4.6',
};

/** Tracks pending state while an async action runs. */
export function useBusy(): [boolean, <T>(work: Promise<T>) => Promise<T>] {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const track = useCallback(<T,>(work: Promise<T>): Promise<T> => {
    setBusy(true);
    return work.finally(() => mounted.current && setBusy(false));
  }, []);
  return [busy, track];
}

/** Button that disables itself and displays a spinner while its async action runs. */
export function ActionButton({ onAction, className = 'btn', disabled = false, title, children }: { onAction: () => unknown; className?: string; disabled?: boolean; title?: string; children: ReactNode }) {
  const [busy, track] = useBusy();
  return (
    <button type="button" className={`${className} ${busy ? 'is-busy' : ''}`} disabled={disabled || busy} aria-busy={busy} title={title} onClick={() => void track(Promise.resolve(onAction()))}>
      {children}
    </button>
  );
}

/** Form submit button sharing the same busy spinner indicator. */
export function SubmitButton({ busy, disabled = false, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="submit" className={`btn btn-primary ${busy ? 'is-busy' : ''}`} disabled={disabled || busy} aria-busy={busy}>
      {children}
    </button>
  );
}

/** Toggle switch with optimistic visual movement that settles to server state. */
export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (next: boolean) => unknown; label: string; disabled?: boolean }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [, track] = useBusy();
  const shown = pending ?? checked;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      aria-label={label}
      title={label}
      className={`switch ${shown ? 'is-on' : ''}`}
      disabled={disabled || pending !== null}
      onClick={() => {
        setPending(!checked);
        void track(Promise.resolve(onChange(!checked))).finally(() => setPending(null));
      }}
    >
      <span className="switch-thumb" />
    </button>
  );
}

/** Segmented tab control with a sliding active thumb. */
export function Segmented<T extends string>({ options, value, onChange, label, size = 'md' }: { options: { id: T; label: ReactNode }[]; value: T | null; onChange: (id: T) => void; label: string; size?: 'sm' | 'md' }) {
  const index = options.findIndex((option) => option.id === value);
  return (
    <div className={`segmented segmented-${size}`} role="tablist" aria-label={label} style={{ '--count': options.length, '--index': Math.max(0, index) } as CSSProperties}>
      {index >= 0 && <span className="segmented-thumb" aria-hidden="true" />}
      {options.map((option) => (
        <button key={option.id} type="button" role="tab" aria-selected={option.id === value} className={`segmented-item ${option.id === value ? 'is-active' : ''}`} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Disclosure toggle ("...") for secondary details. */
export function MoreButton({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className={`btn btn-quiet btn-icon more-btn ${open ? 'is-open' : ''}`} aria-expanded={open} aria-label={label} title={label} onClick={onToggle}>
      <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.600" strokeLinecap="round" aria-hidden="true">
        <path d={PATHS.more} />
      </svg>
    </button>
  );
}

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.dot} />
    </svg>
  );
}

/** Status indicator pairing a 6px dot with descriptive text. */
export function Pill({ tone, children }: { tone: string; icon?: string; children: ReactNode }) {
  return <span className={`status status-${tone}`}>{children}</span>;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`btn btn-quiet btn-sm ${copied ? 'is-done' : ''}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {copied ? t.common.copied : (label ?? t.common.copy)}
    </button>
  );
}

// ---- markdown subset -------------------------------------------------------

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>)\]]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    const key = `${keyBase}-${index++}`;
    if (match[1] !== undefined) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noreferrer noopener">
          {token}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

/** Renders fenced code blocks, lists, inline code, bold text, and links safely as React elements. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, partIndex) => {
    if (partIndex % 2 === 1) {
      const body = part.replace(/^[a-zA-Z0-9_-]*\n/, '');
      blocks.push(
        <pre key={`code-${partIndex}`}>
          <code>{body.replace(/\n$/, '')}</code>
        </pre>,
      );
      return;
    }
    const lines = part.split('\n');
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const flush = (key: string) => {
      if (paragraph.length > 0) {
        blocks.push(
          <p key={`p-${key}`}>
            {paragraph.flatMap((line, lineIndex) => [...(lineIndex > 0 ? [<br key={`br-${key}-${lineIndex}`} />] : []), ...inline(line, `${key}-${lineIndex}`)])}
          </p>,
        );
        paragraph = [];
      }
      if (list !== null) {
        const items = list.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `${key}-li-${itemIndex}`)}</li>);
        blocks.push(list.ordered ? <ol key={`l-${key}`}>{items}</ol> : <ul key={`l-${key}`}>{items}</ul>);
        list = null;
      }
    };
    lines.forEach((line, lineIndex) => {
      const key = `${partIndex}-${lineIndex}`;
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        if (paragraph.length > 0 || (list !== null && list.ordered !== isOrdered)) {
          flush(key);
        }
        list ??= { ordered: isOrdered, items: [] };
        list.items.push((bullet ?? ordered)![1]);
      } else if (line.trim() === '') {
        flush(key);
      } else {
        if (list !== null) {
          flush(key);
        }
        paragraph.push(line);
      }
    });
    flush(`${partIndex}-end`);
  });
  return <div className="md">{blocks}</div>;
}
