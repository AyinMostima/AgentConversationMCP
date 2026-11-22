// Application shell: operator sign-in, shared console state (snapshot + SSE
// event stream with cursor resume), primary navigation, theme, and language.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ApiError, createApi, followEvents, type Api, type Bootstrap, type EventRecord } from './api';
import { AgentsView } from './Agents';
import { EventsView } from './Events';
import { ManageView } from './Manage';
import { OverviewView } from './Overview';
import { SettingsView } from './Settings';
import { ActionButton, Icon, Pill } from './format';
import { useI18n, type Messages } from './i18n';
import { WorkspaceView } from './Workspace';

const TOKEN_KEY = 'acm.operatorToken';
const THEME_KEY = 'acm.theme';
const MAX_EVENTS = 500;
const TOAST_LIFE = { ok: 3200, danger: 7000 };

type Connection = 'connecting' | 'live' | 'reconnecting';
type Theme = 'system' | 'light' | 'dark';
type View = 'workspace' | 'overview' | 'manage' | 'agents' | 'events' | 'settings';

interface Toast {
  id: number;
  tone: 'ok' | 'danger';
  text: string;
}

interface ConsoleState {
  api: Api;
  data: Bootstrap;
  events: EventRecord[];
  connection: Connection;
  refresh: () => Promise<void>;
  notify: (tone: Toast['tone'], text: string) => void;
  /** Runs an operator action, refreshes the snapshot, and reports the result. */
  run: <T>(action: () => Promise<T>, success?: string) => Promise<T | undefined>;
  /** Opens the service restart confirmation dialog. */
  requestRestart: () => void;
}

const ConsoleContext = createContext<ConsoleState | null>(null);

export function useConsole(): ConsoleState {
  const state = useContext(ConsoleContext);
  if (state === null) {
    throw new Error('useConsole must be used inside the console');
  }
  return state;
}

/** Maps API error codes to localized operator messages. */
export function explain(error: unknown, t: Messages): string {
  if (error instanceof ApiError) {
    const known: Record<string, string> = {
      VERSION_CONFLICT: t.errors.VERSION_CONFLICT,
      PAIRING_NOT_REQUESTED: t.errors.PAIRING_NOT_REQUESTED,
      PAIRING_EXPIRED: t.errors.PAIRING_EXPIRED,
      CROSS_PROJECT: t.errors.CROSS_PROJECT,
      SESSION_UNAVAILABLE: t.errors.SESSION_UNAVAILABLE,
      NOT_LINKED: t.errors.NOT_LINKED,
      DIRECT_MEMBERS_FIXED: t.errors.DIRECT_MEMBERS_FIXED,
      ALREADY_EXISTS: t.errors.ALREADY_EXISTS,
      ADMIN_REQUIRED: t.errors.ADMIN_REQUIRED,
    };
    console.error(`[${error.code}] ${error.message}`, error.details);
    return known[error.code] ?? t.errors.actionFailed(error.message);
  }
  return error instanceof Error ? error.message : String(error);
}

function readInitialToken(): string {
  // `npm run console` passes the token in the URL hash fragment (never sent to
  // the server); copy it to sessionStorage and strip the hash immediately.
  const fragment = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (fragment !== null && fragment !== '') {
    window.sessionStorage.setItem(TOKEN_KEY, fragment);
    window.history.replaceState(null, '', window.location.pathname);
    return fragment;
  }
  return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
}

function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (window.localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system');
  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && prefersDark.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    window.localStorage.setItem(THEME_KEY, theme);
    prefersDark.addEventListener('change', apply);
    return () => prefersDark.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}

function Brand() {
  const { t } = useI18n();
  return (
    <div className="brand">
      {/* The AGORA mark in its heavy cut for small sizes; scripts/build-icon.mjs draws the same shapes. */}
      <svg width="20" height="20" viewBox="0 0 512 512" aria-hidden="true">
        <rect width="512" height="512" rx="114" className="brand-tile" />
        <path
          transform="rotate(-35 256 256) translate(256 256) scale(0.9) translate(-256 -256)"
          d="M241 93.520A170 170 0 1 0 241 418.480A170 170 0 0 1 241 93.520ZM271 93.520A170 170 0 1 1 271 418.480A170 170 0 0 0 271 93.520Z"
          className="brand-glyph"
        />
        <path d="M256 202l54 54-54 54-54-54z" className="brand-glyph" />
      </svg>
      <span className="brand-name">{t.brandName}</span>
      <span className="brand-tagline">{t.brandTagline}</span>
    </div>
  );
}

function SignIn({ onToken, notice }: { onToken: (token: string) => void; notice: string }) {
  const { t, toggleLocale } = useI18n();
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(notice);
  useEffect(() => {
    setError(notice);
  }, [notice]);
  const submit = async () => {
    const token = value.trim();
    if (token === '') {
      return;
    }
    setChecking(true);
    try {
      await createApi(token).bootstrap();
      window.sessionStorage.setItem(TOKEN_KEY, token);
      onToken(token);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 401 ? t.signIn.invalidToken : t.signIn.connectFailed(explain(failure, t)));
    } finally {
      setChecking(false);
    }
  };
  return (
    <main className="signin">
      <form
        className="signin-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="signin-head">
          <Brand />
          <button type="button" className="btn btn-quiet btn-sm" title={t.topbar.langTitle} aria-label={t.topbar.langTitle} onClick={toggleLocale}>
            <Icon name="lang" size={15} />
            <span>{t.topbar.langShort}</span>
          </button>
        </div>
        <h1>{t.signIn.title}</h1>
        <p className="muted">
          {t.signIn.descBeforeToken}
          <code>admin-token.txt</code>
          {t.signIn.descMid}
          <code>npm run console</code>
          {t.signIn.descAfterCmd}
        </p>
        <label className="field">
          <span>{t.signIn.tokenLabel}</span>
          <input type="password" autoFocus autoComplete="off" spellCheck={false} placeholder="acmadmin_…" value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {error !== '' && (
          <p className="form-error" role="alert">
            <Icon name="alert" size={14} /> {error}
          </p>
        )}
        <button type="submit" className={`btn btn-primary btn-lg ${checking ? 'is-busy' : ''}`} disabled={checking || value.trim() === ''} aria-busy={checking}>
          {t.signIn.submit}
        </button>
      </form>
    </main>
  );
}

function Console({ token, onSignOut, theme, setTheme }: { token: string; onSignOut: (notice: string) => void; theme: Theme; setTheme: (theme: Theme) => void }) {
  const { t, toggleLocale } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const api = useMemo(() => createApi(token), [token]);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [view, setView] = useState<View>('workspace');
  const toastId = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const restartPending = useRef(false);

  const notify = useCallback((tone: Toast['tone'], text: string) => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, tone, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), TOAST_LIFE[tone]);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setData(await api.bootstrap());
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        onSignOut(tRef.current.console.sessionExpired);
      } else {
        notify('danger', tRef.current.console.refreshFailed(explain(failure, tRef.current)));
      }
    }
  }, [api, notify, onSignOut]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const result = await action();
        await refresh();
        if (success !== undefined) {
          notify('ok', success);
        }
        return result;
      } catch (failure) {
        notify('danger', explain(failure, tRef.current));
        if (failure instanceof ApiError && failure.code === 'VERSION_CONFLICT') {
          await refresh();
        }
        return undefined;
      }
    },
    [notify, refresh],
  );

  // Load initial snapshot, then follow committed events from its watermark.
  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0;
    let stopped = false;
    const onEvent = (event: EventRecord) => {
      cursor = event.event_id;
      setEvents((current) => [...current.slice(-(MAX_EVENTS - 1)), event]);
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void refresh(), 250);
    };
    const loop = async () => {
      try {
        const snapshot = await api.bootstrap();
        setData(snapshot);
        cursor = Math.max(0, snapshot.event_watermark - 100);
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) {
          onSignOut(tRef.current.console.sessionExpired);
          return;
        }
      }
      let delay = 800;
      while (!stopped) {
        try {
          await followEvents(token, cursor, onEvent, () => {
            setConnection('live');
            delay = 800;
            void refresh();
            if (restartPending.current) {
              restartPending.current = false;
              notify('ok', tRef.current.console.restarted);
            }
          }, controller.signal);
        } catch (failure) {
          if (stopped) {
            return;
          }
          if (failure instanceof ApiError && failure.status === 401) {
            onSignOut(tRef.current.console.sessionExpired);
            return;
          }
        }
        if (stopped) {
          return;
        }
        setConnection('reconnecting');
        await new Promise((done) => window.setTimeout(done, delay));
        delay = Math.min(delay * 2, 5000);
      }
    };
    void loop();
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(refreshTimer.current);
    };
  }, [api, token, refresh, onSignOut, notify]);

  const restart = async () => {
    if (data?.service.mcp_url === undefined) {
      notify('danger', t.console.restartNotManaged);
      return;
    }
    try {
      restartPending.current = true;
      await api.restartService(data.service.mcp_url);
      notify('ok', t.console.restarting);
    } catch (failure) {
      restartPending.current = false;
      notify('danger', t.console.restartFailed(explain(failure, t)));
    }
  };

  if (data === null) {
    return (
      <main className="signin">
        <div className="loading">
          <Brand />
          <p className="muted">{t.console.loading}</p>
        </div>
      </main>
    );
  }

  const pending =
    data.sessions.filter((session) => session.status === 'requested').length +
    data.proposals.filter((proposal) => proposal.status === 'pending').length +
    data.bot_requests.filter((entry) => entry.status === 'held').length;
  const state: ConsoleState = { api, data, events, connection, refresh, notify, run, requestRestart: () => setConfirmRestart(true) };
  const tabs: { id: View; label: string; icon: string; badge?: number }[] = [
    { id: 'workspace', label: t.nav.workspace, icon: 'chat' },
    { id: 'overview', label: t.nav.overview, icon: 'chart' },
    { id: 'manage', label: t.nav.manage, icon: 'checks' },
    { id: 'agents', label: t.nav.agents, icon: 'agents', badge: pending },
    { id: 'events', label: t.nav.events, icon: 'pulse' },
    { id: 'settings', label: t.nav.settings, icon: 'sliders' },
  ];
  const nextTheme: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const themeLabel = { system: t.topbar.themeSystem, light: t.topbar.themeLight, dark: t.topbar.themeDark }[theme];

  return (
    <ConsoleContext.Provider value={state}>
      <div className="app">
        <header className="topbar">
          <Brand />
          <span className="crumb">{tabs.find((tab) => tab.id === view)?.label}</span>
          <div className="topbar-end">
            {connection === 'live' && <Pill tone="ok">{t.topbar.live}</Pill>}
            {connection === 'connecting' && <Pill tone="muted">{t.topbar.connecting}</Pill>}
            {connection === 'reconnecting' && <Pill tone="warn">{t.topbar.reconnecting}</Pill>}
            <button type="button" className="btn btn-quiet btn-sm" title={t.topbar.restartTitle} aria-label={t.topbar.restart} onClick={() => setConfirmRestart(true)}>
              <Icon name="restart" size={16} />
              <span className="wide-only">{t.topbar.restart}</span>
            </button>
            <button type="button" className="btn btn-quiet btn-sm" title={t.topbar.langTitle} aria-label={t.topbar.langTitle} onClick={toggleLocale}>
              <Icon name="lang" size={16} />
              <span>{t.topbar.langShort}</span>
            </button>
            <button type="button" className="btn btn-quiet btn-sm" title={t.topbar.themeTitle} aria-label={t.topbar.themeTitle} onClick={() => setTheme(nextTheme)}>
              <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={16} />
              <span className="wide-only">{themeLabel}</span>
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => onSignOut('')}>
              {t.topbar.signOut}
            </button>
          </div>
        </header>
        <div className="frame">
          <nav className="rail" aria-label={t.nav.ariaLabel}>
            {tabs.map((tab) => (
              <button key={tab.id} type="button" className={`nav-item ${view === tab.id ? 'is-active' : ''}`} aria-current={view === tab.id ? 'page' : undefined} aria-label={tab.label} title={tab.label} onClick={() => setView(tab.id)}>
                <Icon name={tab.icon} size={18} />
                <span>{tab.label}</span>
                {tab.badge !== undefined && tab.badge > 0 && <span className="nav-count" aria-label={t.nav.pendingCount(tab.badge)} title={t.nav.pendingCount(tab.badge)}>{tab.badge}</span>}
              </button>
            ))}
          </nav>
          <div className="desk">
            {connection === 'reconnecting' && (
              <div className="notice-banner" role="status">
                <Icon name="clock" /> {t.console.reconnectBanner}
              </div>
            )}
            {view === 'workspace' && <WorkspaceView onOpenAgents={() => setView('agents')} />}
            {view === 'overview' && <OverviewView />}
            {view === 'manage' && <ManageView />}
            {view === 'agents' && <AgentsView />}
            {view === 'events' && <EventsView />}
            {view === 'settings' && <SettingsView />}
          </div>
        </div>
        {confirmRestart && (
          <ConfirmDialog
            title={t.restartDialog.title}
            message={t.restartDialog.message}
            confirmLabel={t.restartDialog.confirm}
            destructive={false}
            onConfirm={restart}
            onClose={() => setConfirmRestart(false)}
          />
        )}
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.tone}`} style={{ '--life': `${TOAST_LIFE[toast.tone]}ms` } as CSSProperties}>
              <Icon name={toast.tone === 'ok' ? 'check' : 'alert'} size={15} />
              <span>{toast.text}</span>
            </div>
          ))}
        </div>
      </div>
    </ConsoleContext.Provider>
  );
}

/** Modal dialog container used across create, edit, and confirmation flows. */
export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-quiet btn-icon" aria-label={t.common.close} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

/** In-app confirmation dialog for destructive or service-level actions. */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose, destructive = true }: { title: string; message: string; confirmLabel: string; onConfirm: () => unknown; onClose: () => void; destructive?: boolean }) {
  const { t } = useI18n();
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="form">
        <p className="muted">{message}</p>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" autoFocus onClick={onClose}>{t.common.cancel}</button>
          <ActionButton className={`btn ${destructive ? 'btn-destructive' : 'btn-primary'}`} onAction={() => Promise.resolve(onConfirm()).then(onClose)}>{confirmLabel}</ActionButton>
        </div>
      </div>
    </Dialog>
  );
}

export function App() {
  const [token, setToken] = useState(readInitialToken);
  const [notice, setNotice] = useState('');
  const signOut = useCallback((reason: string) => {
    window.sessionStorage.removeItem(TOKEN_KEY);
    setNotice(reason);
    setToken('');
  }, []);
  const [theme, setTheme] = useTheme();
  return token === '' ? <SignIn onToken={setToken} notice={notice} /> : <Console token={token} onSignOut={signOut} theme={theme} setTheme={setTheme} />;
}
