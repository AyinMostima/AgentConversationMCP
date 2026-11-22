// Settings view: interface language, route diagnostics, rate limits, Grok Bot
// prefill target, optional ngrok remote access, and service restart control.
import { useState } from 'react';
import type { ClientHook } from './api';
import { useConsole } from './App';
import { ActionButton, CLIENT_OF_PROVIDER, CopyButton, Icon, MoreButton, Pill, Segmented, SubmitButton, Switch, formatTime, useBusy } from './format';
import { useI18n, type LanguagePref, type Messages } from './i18n';

/** Console language selector: Auto (browser locale), English, or Simplified Chinese. */
function LanguageSetting() {
  const { pref, locale, setPref, t } = useI18n();
  const resolved = locale === 'en' ? t.settings.resolvedEn : t.settings.resolvedZh;
  return (
    <section className="setting">
      <Icon name="lang" size={18} />
      <div>
        <strong>{t.settings.languageTitle}</strong>
        <p>{pref === 'auto' ? t.settings.languageDescAuto(resolved) : t.settings.languageDescManual(resolved)}</p>
      </div>
      <Segmented<LanguagePref>
        size="sm"
        label={t.settings.languageAria}
        value={pref}
        onChange={setPref}
        options={[
          { id: 'auto', label: t.settings.langAuto },
          { id: 'en', label: t.settings.langEn },
          { id: 'zh-CN', label: t.settings.langZh },
        ]}
      />
    </section>
  );
}

/** The operator's standing rules for every session: shown to each conversation once, and again when changed. */
function SharedRules() {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const current = data.settings.shared_rules;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(current);
  const [busy, track] = useBusy();
  const lines = current.split('\n').filter((line) => line.trim() !== '').length;
  return (
    <section className="setting setting-stack">
      <div className="setting-row">
        <Icon name="check" size={18} />
        <div>
          <strong>{t.settings.rulesTitle}</strong>
          <p>{current.trim() === '' ? t.settings.rulesNone : t.settings.rulesSome(lines, formatTime(data.settings.shared_rules_at, t.dateLocale))}</p>
        </div>
        <MoreButton
          open={open}
          onToggle={() => {
            setText(current);
            setOpen((value) => !value);
          }}
          label={t.settings.rulesEditAria}
        />
      </div>
      {open && (
        <form
          className="hook-form"
          onSubmit={(event) => {
            event.preventDefault();
            void track(run(() => api.setSharedRules(text.trim()), t.settings.rulesSaved)).then((saved) => saved !== undefined && setOpen(false));
          }}
        >
          <p className="muted small">{t.settings.rulesIntro}</p>
          <textarea className="rules-text" rows={7} maxLength={6000} value={text} placeholder={t.settings.rulesPlaceholder} aria-label={t.settings.rulesTitle} onChange={(event) => setText(event.target.value)} />
          <div className="row-actions">
            <SubmitButton busy={busy} disabled={text.trim() === current.trim()}>{t.common.save}</SubmitButton>
          </div>
        </form>
      )}
    </section>
  );
}

/** Per-session rate limits and duplicate collapsing controls. */
function FloodControl() {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const current = data.settings;
  const [open, setOpen] = useState(false);
  const [perMinute, setPerMinute] = useState(String(current.message_rate_per_minute));
  const [perHour, setPerHour] = useState(String(current.message_rate_per_hour));
  const [window_, setWindow] = useState(String(current.duplicate_window_seconds));
  const [urgent, setUrgent] = useState(String(current.urgent_per_hour));
  const [busy, track] = useBusy();
  const whole = (text: string) => /^\d+$/.test(text.trim());
  const describe = (value: number, unit: string) => (value === 0 ? t.settings.unlimited : `${value} ${unit}`);
  return (
    <section className="setting setting-stack">
      <div className="setting-row">
        <Icon name="filter" size={18} />
        <div>
          <strong>{t.settings.floodTitle}</strong>
          <p>
            {t.settings.floodSummary(
              describe(current.message_rate_per_minute, t.settings.perMinUnit),
              describe(current.message_rate_per_hour, t.settings.perHourUnit),
              current.duplicate_window_seconds,
              describe(current.urgent_per_hour, t.settings.perHourUnit),
            )}
          </p>
        </div>
        <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.settings.adjustLimitsAria} />
      </div>
      {open && (
        <form
          className="hook-form"
          onSubmit={(event) => {
            event.preventDefault();
            void track(
              run(
                () => api.setLimits({ message_rate_per_minute: Number(perMinute), message_rate_per_hour: Number(perHour), duplicate_window_seconds: Number(window_), urgent_per_hour: Number(urgent) }),
                t.settings.limitsUpdated,
              ),
            );
          }}
        >
          <p className="muted small">{t.settings.floodIntro}</p>
          <div className="field-row">
            <label className="field">
              <span>{t.settings.perMinLabel}</span>
              <input inputMode="numeric" value={perMinute} onChange={(event) => setPerMinute(event.target.value)} />
            </label>
            <label className="field">
              <span>{t.settings.perHourLabel}</span>
              <input inputMode="numeric" value={perHour} onChange={(event) => setPerHour(event.target.value)} />
            </label>
            <label className="field">
              <span>{t.settings.dupWindowLabel}</span>
              <input inputMode="numeric" value={window_} onChange={(event) => setWindow(event.target.value)} />
            </label>
            <label className="field">
              <span>{t.settings.urgentPerHourLabel}</span>
              <input inputMode="numeric" value={urgent} onChange={(event) => setUrgent(event.target.value)} />
            </label>
          </div>
          <p className="muted small">{t.settings.urgentHint}</p>
          <div className="row-actions">
            <SubmitButton busy={busy} disabled={!whole(perMinute) || !whole(perHour) || !whole(window_) || !whole(urgent)}>{t.common.save}</SubmitButton>
          </div>
        </form>
      )}
    </section>
  );
}

const COMPONENT_TONE: Record<string, string> = {
  missing: 'muted',
  installing: 'proposed',
  installed: 'ok',
  failed: 'danger',
};

/** Optional remote access to the console via an on-demand ngrok component. */
function RemoteAccess() {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const remote = data.remote_access;
  const [open, setOpen] = useState(false);
  const [authtoken, setAuthtoken] = useState('');
  const [domain, setDomain] = useState(remote.domain ?? '');
  const [busy, track] = useBusy();
  const installed = remote.component === 'installed';
  const ready = installed && remote.has_authtoken;
  const summary = remote.enabled
    ? remote.state === 'online'
      ? t.settings.remoteOnline
      : remote.state === 'error'
        ? t.settings.remoteError(remote.detail ?? t.common.unknown)
        : t.settings.remoteConnecting
    : !installed
      ? t.settings.remoteMissing
      : !remote.has_authtoken
        ? t.settings.remoteNeedToken
        : t.settings.remoteOff;
  const compTone = COMPONENT_TONE[remote.component] ?? 'muted';
  const compLabel = t.settings.component[remote.component] ?? t.settings.component.missing;
  return (
    <section className="setting setting-stack">
      <div className="setting-row">
        <Icon name="globe" size={18} />
        <div>
          <strong>{t.settings.remoteTitle}</strong>
          <p className="wrap">
            {summary}
            {remote.enabled && remote.state === 'online' && remote.public_url !== null && <a href={remote.public_url} target="_blank" rel="noreferrer noopener">{remote.public_url}</a>}
          </p>
        </div>
        {remote.enabled && remote.state === 'online' && remote.public_url !== null && <CopyButton text={remote.public_url} label={t.settings.copyUrl} />}
        <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.settings.remoteSettingsAria} />
        <Switch
          checked={remote.enabled}
          label={t.settings.remoteSwitchAria}
          disabled={!ready && !remote.enabled}
          onChange={(next) => run(() => api.setRemoteAccess({ enabled: next }), next ? t.settings.remoteOnToast : t.settings.remoteOffToast)}
        />
      </div>
      {open && (
        <form
          className="hook-form"
          onSubmit={(event) => {
            event.preventDefault();
            void track(run(() => api.setRemoteAccess({ authtoken: authtoken.trim() === '' ? undefined : authtoken.trim(), domain: domain.trim() }), t.settings.remoteSaved)).then((saved) => saved !== undefined && setAuthtoken(''));
          }}
        >
          <p className="muted small">{t.settings.remoteWarning}</p>
          <div className="hook-state">
            <span>{t.settings.componentLabel}</span>
            <Pill tone={compTone}>{compLabel}</Pill>
            {!installed && (
              <ActionButton className="btn btn-sm" disabled={remote.component === 'installing'} onAction={() => run(() => api.installRemoteComponent(), t.settings.installStarted)}>
                {remote.component === 'failed' ? t.settings.reinstallBtn : t.settings.installBtn}
              </ActionButton>
            )}
          </div>
          {!installed && <p className="muted small">{t.settings.installHint(remote.component_detail)}</p>}
          <label className="field">
            <span>{t.settings.tokenLabel}</span>
            <input type="password" value={authtoken} onChange={(event) => setAuthtoken(event.target.value)} placeholder={remote.has_authtoken ? t.settings.tokenPlaceholderSaved : t.settings.tokenPlaceholderNew} spellCheck={false} autoComplete="off" />
            <small>{t.settings.tokenHint}</small>
          </label>
          <label className="field">
            <span>{t.settings.domainLabel}</span>
            <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder={t.settings.domainPlaceholder} spellCheck={false} autoComplete="off" />
          </label>
          <div className="row-actions">
            <SubmitButton busy={busy} disabled={authtoken.trim() === '' && !remote.has_authtoken}>{t.common.save}</SubmitButton>
          </div>
        </form>
      )}
    </section>
  );
}

interface Route {
  key: string;
  name: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
  label: string;
  detail: string;
  attention: boolean;
}

function wakeFailureHint(detail: string | null, t: Messages): string {
  const code = /HTTP (\d+)/.exec(detail ?? '')?.[1];
  if (code === '401' || code === '403') return t.settings.wakeHint401;
  if (code === '404' || code === '410') return t.settings.wakeHint404;
  if (code === '429') return t.settings.wakeHint429;
  if (code !== undefined && code.startsWith('5')) return t.settings.wakeHint5xx;
  if (code !== undefined) return t.settings.wakeHintCode(code);
  return t.settings.wakeHintNetwork(detail ?? t.common.unknown);
}

function idleRoute(provider: string, hook: ClientHook, dispatchClients: string[], watching: boolean, t: Messages): string {
  if (provider === 'anthropic') {
    return watching ? t.settings.idleClaudeWatching : t.settings.idleClaudeStandby;
  }
  if (provider === 'openai') {
    if (!dispatchClients.includes('codex')) return t.settings.idleCodexNoCli;
    if (!hook.knows_conversation) return t.settings.idleCodexNoConv;
    return t.settings.idleCodexQueue;
  }
  return dispatchClients.includes('antigravity') ? t.settings.idleAntigravityCli : t.settings.idleAntigravity;
}

/** Diagnostic view of all active ingress/egress routes and hook states. */
function Routes() {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const age = (iso: string | null) => (iso === null ? Number.POSITIVE_INFINITY : now - new Date(iso).getTime());
  const routes: Route[] = [];
  for (const session of data.sessions.filter((entry) => entry.status === 'active')) {
    const agent = data.agents.find((entry) => entry.agent_id === session.agent_id);
    const who = `${agent?.display_name ?? session.agent_id} · ${session.label}`;
    const keepsBridge = session.self_enrolled && agent?.provider !== 'xai';
    const silent = keepsBridge && session.bridge_tools === null;
    const fewer = session.bridge_tools !== null && session.bridge_tools !== data.tool_count;
    const behind = keepsBridge && session.bridge_tools !== null && (session.bridge_contract ?? 1) !== data.tool_contract;
    // A relaying bridge always calls the current tools; its client only has to list them
    // again, which it is told to do. Nothing for the operator to act on.
    const catching = session.bridge_relay && !silent && (fewer || behind);
    const stale = !catching && (silent || fewer || behind);
    routes.push({
      key: `${session.session_id}-in`,
      name: t.settings.routeAccess(who),
      tone: session.last_seen_at === null ? 'muted' : stale ? 'warn' : 'ok',
      label: session.last_seen_at === null ? t.settings.stNever : stale ? t.settings.stRestart : catching ? t.settings.stCatching : t.settings.stOk,
      attention: session.last_seen_at !== null && stale,
      detail:
        session.last_seen_at === null
          ? t.settings.detailNever
          : catching
            ? t.settings.detailCatching
            : fewer
            ? `${t.settings.detailFewerTools(session.bridge_tools!, data.tool_count)}${t.settings.restartHint}`
            : silent
              ? `${t.settings.detailOldBridge(formatTime(session.last_seen_at, t.dateLocale))}${t.settings.restartHint}`
              : behind
                ? `${t.settings.detailOldContract}${t.settings.restartHint}`
                : t.settings.detailLastCall(formatTime(session.last_seen_at, t.dateLocale)),
    });
    if (session.host_seen_at !== null) {
      const listening = age(session.host_seen_at) < 60_000;
      routes.push({
        key: `${session.session_id}-host`,
        name: t.settings.routeBotHost(who),
        tone: listening ? 'ok' : 'muted',
        label: listening ? t.settings.stListening : t.settings.stNotListening,
        attention: false,
        detail: t.settings.detailHostSeen(formatTime(session.host_seen_at, t.dateLocale), listening),
      });
    }
    const provider = agent?.provider ?? '';
    if (t.settings.hookFirstStep[provider] !== undefined) {
      const ran = data.client_hooks.find((entry) => entry.session_id === session.session_id);
      const name = t.settings.routeDelivery(who);
      if (ran === undefined) {
        routes.push({ key: `${session.session_id}-hook`, name, tone: 'muted', label: t.settings.stNotSeen, detail: t.settings.hookFirstStep[provider], attention: true });
      } else {
        const watching = age(ran.watch_seen_at) < 90_000;
        const failed = ran.last_urgent !== null && ran.last_urgent.status === 'failed';
        const last =
          ran.last_delivery === null
            ? t.settings.deliveryLastNone
            : t.settings.deliveryLastSome(ran.last_delivery.messages, t.settings.deliveryRoute[ran.last_delivery.route] ?? ran.last_delivery.route, formatTime(ran.last_delivery.at, t.dateLocale));
        const urgent = !session.urgent_dispatch
          ? t.settings.deliveryUrgentOff
          : failed
            ? t.settings.deliveryUrgentFailed(formatTime(ran.last_urgent!.at, t.dateLocale), ran.last_urgent!.detail ?? t.common.unknown)
            : idleRoute(provider, ran, data.dispatch_clients, watching, t);
        // A client that has used up its quota can take no turn, however it is reached.
        const quota = data.client_limits?.[CLIENT_OF_PROVIDER[provider] ?? ''];
        if (quota !== undefined) {
          routes.push({ key: `${session.session_id}-hook`, name, tone: 'danger', label: t.settings.stNoQuota, attention: true, detail: t.settings.quotaUntil(formatTime(quota.until, t.dateLocale), quota.detail) });
          continue;
        }
        routes.push({
          key: `${session.session_id}-hook`,
          name,
          tone: failed && session.urgent_dispatch ? 'danger' : 'ok',
          label: failed && session.urgent_dispatch ? t.settings.stIdleFailed : watching ? t.settings.stWatching : t.settings.stOk,
          attention: failed && session.urgent_dispatch,
          detail: t.settings.deliverySummary(formatTime(ran.seen_at, t.dateLocale), t.settings.hookEvent[ran.event] ?? ran.event, ran.runs, last, urgent),
        });
      }
    }
    const hook = data.wake_hooks.find((entry) => entry.session_id === session.session_id);
    if (hook !== undefined) {
      const waiting = data.bot_requests.filter((entry) => entry.host.session_id === session.session_id && (entry.status === 'queued' || entry.status === 'taken')).length;
      const silentWake = hook.last_status === 'ok' && waiting > 0 && age(hook.last_ok_at) > 180_000 && (session.host_seen_at === null || session.host_seen_at < (hook.last_ok_at ?? ''));
      const route: Omit<Route, 'key' | 'name'> = !hook.enabled
        ? { tone: 'muted', label: t.settings.stDisabled, detail: t.settings.wakeDisabled, attention: false }
        : hook.last_attempt_at === null
          ? { tone: 'muted', label: t.settings.stUnused, detail: t.settings.wakeUnused, attention: false }
          : hook.last_status === 'failed'
            ? { tone: 'danger', label: t.settings.stFailed, detail: t.settings.wakeFailed(formatTime(hook.last_attempt_at, t.dateLocale), wakeFailureHint(hook.last_detail, t)), attention: true }
            : silentWake
              ? { tone: 'warn', label: t.settings.stSilent, detail: t.settings.wakeSilent(formatTime(hook.last_ok_at ?? hook.last_attempt_at, t.dateLocale), waiting), attention: true }
              : { tone: 'ok', label: t.settings.stOk, detail: t.settings.wakeOk(formatTime(hook.last_attempt_at, t.dateLocale), hook.last_status === 'sending', hook.include_text), attention: false };
      routes.push({ ...route, key: `${session.session_id}-wake`, name: t.settings.routeWake(who) });
    } else if (agent?.provider === 'xai') {
      routes.push({
        key: `${session.session_id}-wake`,
        name: t.settings.routeWake(who),
        tone: 'warn',
        label: t.settings.stUnset,
        detail: t.settings.wakeUnset,
        attention: true,
      });
    }
  }
  const remote = data.remote_access;
  if (remote.enabled || remote.component !== 'missing') {
    const tone: Route['tone'] = !remote.enabled ? 'muted' : remote.state === 'online' ? 'ok' : remote.state === 'error' ? 'danger' : 'warn';
    routes.push({
      key: 'remote',
      name: t.settings.routeRemote,
      tone,
      label: !remote.enabled ? t.settings.stOff : remote.state === 'online' ? t.settings.stOk : remote.state === 'error' ? t.settings.stFailed : t.settings.stConnecting,
      detail: !remote.enabled ? t.settings.remoteDetailOff : remote.state === 'error' ? remote.detail ?? t.common.unknown : remote.public_url ?? '',
      attention: tone === 'danger' || tone === 'warn',
    });
  }
  const broken = routes.filter((route) => route.tone === 'danger' || route.tone === 'warn').length;
  const attention = routes.filter((route) => route.attention);
  const shown = open ? routes : attention;
  return (
    <section className="setting setting-stack">
      <div className="setting-row">
        <Icon name="pulse" size={18} />
        <div>
          <strong>{t.settings.routesTitle}</strong>
          <p>
            {routes.length === 0 ? t.settings.routesEmpty : broken === 0 ? t.settings.routesAllOk(routes.length) : t.settings.routesWithIssues(routes.length, broken)}
            {data.settings.alerts_enabled ? t.settings.alertsOnDesc : t.settings.alertsOffDesc}
          </p>
        </div>
        {routes.length > attention.length && <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.settings.allRoutesAria} />}
        <Switch
          checked={data.settings.alerts_enabled}
          label={t.settings.alertsSwitchAria}
          onChange={(next) => run(() => api.setAlerts(next), next ? t.settings.alertsOnToast : t.settings.alertsOffToast)}
        />
      </div>
      {shown.length > 0 && (
        <ul className="routes">
          {shown.map((route) => (
            <li key={route.key} className="route">
              <span>{route.name}</span>
              <Pill tone={route.tone}>{route.label}</Pill>
              <span className="route-detail">{route.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Grok Bot deep-link target configuration. */
function GrokBot() {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const stored = data.settings.grok_bot_id;
  const [open, setOpen] = useState(false);
  const [botId, setBotId] = useState(stored);
  const [busy, track] = useBusy();
  return (
    <section className="setting setting-stack">
      <div className="setting-row">
        <Icon name="send" size={18} />
        <div>
          <strong>{t.settings.grokBotTitle}</strong>
          <p>
            {stored === '' ? (
              t.settings.grokBotSummaryMain
            ) : (
              <>
                {t.settings.grokBotSummaryCustomPrefix}
                <span className="mono">{stored}</span>
                {t.settings.grokBotSummaryCustomSuffix}
              </>
            )}
          </p>
        </div>
        <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.settings.grokBotSettingsAria} />
      </div>
      {open && (
        <form
          className="hook-form"
          onSubmit={(event) => {
            event.preventDefault();
            void track(run(() => api.setGrokBotId(botId.trim()), t.settings.grokBotSaved));
          }}
        >
          <p className="muted small">{t.settings.grokBotIntro}</p>
          <label className="field">
            <span>{t.settings.grokBotIdLabel}</span>
            <input value={botId} onChange={(event) => setBotId(event.target.value)} placeholder={t.settings.grokBotIdPlaceholder} spellCheck={false} autoComplete="off" />
            <small>{t.settings.grokBotIdHint}</small>
          </label>
          <div className="row-actions">
            <SubmitButton busy={busy} disabled={!/^[A-Za-z0-9_-]*$/.test(botId.trim())}>{t.common.save}</SubmitButton>
          </div>
        </form>
      )}
    </section>
  );
}

export function SettingsView() {
  const { data, requestRestart } = useConsole();
  const { t } = useI18n();
  return (
    <main className="page sheet">
      <div className="page-inner">
        <header className="page-head">
          <div>
            <h1>{t.settings.title}</h1>
            <p>{t.settings.subtitle}</p>
          </div>
        </header>
        <div className="settings-list">
          <LanguageSetting />
          <SharedRules />
          <Routes />
          <FloodControl />
          <GrokBot />
          <RemoteAccess />
          <section className="setting">
            <Icon name="restart" size={18} />
            <div>
              <strong>{t.settings.serviceTitle}</strong>
              <p>{t.settings.serviceSummary(data.service.version ?? t.common.unknown, data.schema_version)}</p>
            </div>
            <button type="button" className="btn" onClick={requestRestart}>{t.settings.restartBtn}</button>
          </section>
        </div>
      </div>
    </main>
  );
}
