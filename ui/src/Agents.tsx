// Agents and pairing view: logical agents, bound sessions, approval queue
// (pairings, conversation proposals, held bot requests), wake hook config,
// and client onboarding wizard.
import { useMemo, useState } from 'react';
import type { Agent, BotRequest, Proposal, Session, WindowInfo } from './api';
import { ConfirmDialog, Dialog, useConsole } from './App';
import { GrokPrefillButton } from './Grok';
import { ActionButton, CopyButton, Icon, MoreButton, Pill, ProviderMark, SESSION_TONE, Segmented, SubmitButton, Switch, formatFullTime, formatTime, useBusy } from './format';
import { useI18n } from './i18n';

const PRESET_AGENTS = [
  { agent_id: 'agt_claude', provider: 'anthropic', client_kind: 'claude-desktop', display_name: 'Claude' },
  { agent_id: 'agt_codex', provider: 'openai', client_kind: 'codex-desktop', display_name: 'Codex' },
  { agent_id: 'agt_antigravity', provider: 'google', client_kind: 'antigravity', display_name: 'Antigravity' },
  { agent_id: 'agt_grok', provider: 'xai', client_kind: 'grok-bot', display_name: 'Grok Bot' },
];

const BOT_STATUS_TONE: Record<BotRequest['status'], string> = {
  held: 'review',
  queued: 'muted',
  taken: 'proposed',
  done: 'ok',
  failed: 'warn',
  rejected: 'danger',
};

function PairingWizard({ onClose, initialAgent }: { onClose: () => void; initialAgent?: string }) {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const [agentId, setAgentId] = useState(initialAgent ?? data.agents[0]?.agent_id ?? '');
  const [projectId, setProjectId] = useState(data.projects[0]?.project_id ?? '');
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<Session | null>(null);
  const [busy, track] = useBusy();
  const openMode = data.settings.open_mode;
  const agent = data.agents.find((entry) => entry.agent_id === agentId);
  const allGuides = useMemo(() => (issued?.token === undefined ? [] : t.agents.guides(issued.token, data.service, openMode)), [issued, data.service, openMode, t]);
  const [tab, setTab] = useState('');
  const active = allGuides.find((guide) => guide.id === tab) ?? allGuides.find((guide) => guide.provider === agent?.provider) ?? allGuides[0];

  if (issued === null) {
    return (
      <Dialog title={t.agents.pairingDialogTitle} onClose={onClose}>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void track(run(() => api.createPairing({ agent_id: agentId, project_id: projectId, label: label.trim() }))).then((created) => created !== undefined && setIssued(created));
          }}
        >
          <p className="muted">
            {t.agents.pairingIntroPrefix}
            <strong>{t.agents.pairingIntroStrong}</strong>
            {t.agents.pairingIntroSuffix}
          </p>
          <div className="field-row">
            <label className="field">
              <span>{t.agents.agentLabel}</span>
              <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                {data.agents.map((entry) => (
                  <option key={entry.agent_id} value={entry.agent_id}>{entry.display_name} ({entry.client_kind})</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t.agents.projectLabel}</span>
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {data.projects.map((entry) => (
                  <option key={entry.project_id} value={entry.project_id}>{entry.name}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>{t.agents.sessionLabelField}</span>
            <input autoFocus value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t.agents.sessionLabelPlaceholder} />
            <small>{t.agents.sessionLabelHint}</small>
          </label>
          <div className="form-actions">
            <button type="button" className="btn btn-quiet" onClick={onClose}>{t.common.cancel}</button>
            <SubmitButton busy={busy} disabled={label.trim() === '' || agentId === '' || projectId === ''}>{t.agents.issueTokenBtn}</SubmitButton>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog title={t.agents.guideDialogTitle} onClose={onClose} wide>
      <div className="form">
        <div className="callout callout-warn">
          <Icon name="key" />
          <div>
            <strong>{t.agents.oneTimeTitle}</strong>
            <p>{t.agents.oneTimeBody(issued.label, formatTime(issued.pairing_expires_at, t.dateLocale))}</p>
          </div>
        </div>
        <div className="token-row">
          <code className="token mono">{issued.token}</code>
          <CopyButton text={issued.token ?? ''} label={t.agents.copyToken} />
        </div>
        <Segmented label={t.agents.clientSegmentedAria} value={active?.id ?? null} onChange={setTab} options={allGuides.map((guide) => ({ id: guide.id, label: guide.name }))} />
        {active !== undefined && (
          <div className="guide">
            <p className="muted small">{t.agents.configLocation}<code>{active.file}</code></p>
            <ol className="steps">
              {active.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
            {active.blocks.map((block) => (
              <figure key={block.label} className="codeblock">
                <figcaption>
                  <span>{block.label}</span>
                  <CopyButton text={block.code} />
                </figcaption>
                <pre><code>{block.code}</code></pre>
              </figure>
            ))}
            {active.note !== undefined && (
              <p className="note"><Icon name="alert" size={14} /> {active.note}</p>
            )}
          </div>
        )}
        <details className="closed">
          <summary>{t.agents.standingSummary}</summary>
          <p className="muted small">{t.agents.standingDesc}</p>
          <figure className="codeblock">
            <figcaption>
              <span>{t.agents.standingTitle}</span>
              <CopyButton text={t.agents.standingText} />
            </figcaption>
            <pre><code>{t.agents.standingText}</code></pre>
          </figure>
        </details>
        <div className="form-actions">
          <span className="muted small">{openMode ? t.agents.footerOpen : t.agents.footerClosed}</span>
          <button type="button" className="btn btn-primary" onClick={onClose}>{t.common.done}</button>
        </div>
      </div>
    </Dialog>
  );
}

function NewAgentDialog({ onClose }: { onClose: () => void }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('anthropic');
  const [clientKind, setClientKind] = useState('claude-desktop');
  const [busy, track] = useBusy();
  return (
    <Dialog title={t.agents.newAgentTitle} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void track(run(() => api.createAgent({ provider, client_kind: clientKind.trim(), display_name: name.trim() }), t.agents.agentCreated)).then((created) => created !== undefined && onClose());
        }}
      >
        <p className="muted">{t.agents.newAgentIntro}</p>
        <label className="field">
          <span>{t.agents.displayNameLabel}</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t.agents.displayNamePlaceholder} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>{t.agents.providerLabel}</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
              <option value="xai">xAI</option>
              <option value="other">{t.agents.providerOther}</option>
            </select>
          </label>
          <label className="field">
            <span>{t.agents.clientKindLabel}</span>
            <input value={clientKind} onChange={(event) => setClientKind(event.target.value)} spellCheck={false} />
          </label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>{t.common.cancel}</button>
          <SubmitButton busy={busy} disabled={name.trim() === '' || clientKind.trim() === ''}>{t.agents.createBtn}</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

/** Outbound webhook wake configuration for a remotely hosted client session. */
function WakeHookForm({ session }: { session: Session }) {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const hook = data.wake_hooks.find((entry) => entry.session_id === session.session_id);
  const [url, setUrl] = useState(hook?.url ?? '');
  const [key, setKey] = useState('');
  const [busy, track] = useBusy();
  return (
    <form
      className="hook-form"
      onSubmit={(event) => {
        event.preventDefault();
        void track(run(() => api.setWakeHook(session.session_id, { url: url.trim(), key: key.trim() === '' ? undefined : key.trim() }), t.agents.wakeSaved)).then((saved) => saved !== undefined && setKey(''));
      }}
    >
      <p className="muted small">{t.agents.wakeIntro}</p>
      <label className="field">
        <span>{t.agents.wakeUrlLabel}</span>
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" spellCheck={false} autoComplete="off" />
      </label>
      <label className="field">
        <span>{t.agents.wakeKeyLabel}</span>
        <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={hook === undefined ? t.agents.wakeKeyPlaceholderNew : t.agents.wakeKeyPlaceholderSaved} spellCheck={false} autoComplete="off" />
        <small>{t.agents.wakeKeyHint}</small>
      </label>
      {hook !== undefined && (
        <div className="hook-state">
          <div className="switch-row">
            <span>{t.agents.wakeEnabledLabel}</span>
            <Switch checked={hook.enabled} label={t.agents.wakeEnabledAria} onChange={(next) => run(() => api.setWakeHook(session.session_id, { url: hook.url, enabled: next }), next ? t.agents.wakeEnabledOn : t.agents.wakeEnabledOff)} />
          </div>
          <div className="switch-row" title={t.agents.wakeIncludeTextTitle}>
            <span>{t.agents.wakeIncludeTextLabel}</span>
            <Switch checked={hook.include_text} label={t.agents.wakeIncludeTextLabel} onChange={(next) => run(() => api.setWakeHook(session.session_id, { url: hook.url, include_text: next }), next ? t.agents.wakeIncludeTextOn : t.agents.wakeIncludeTextOff)} />
          </div>
          <span className="muted small">
            {hook.last_attempt_at === null
              ? t.agents.wakeNeverSent
              : t.agents.wakeLastAttempt(formatTime(hook.last_attempt_at, t.dateLocale), t.agents.wakeStatus[hook.last_status ?? ''] ?? (hook.last_status ?? ''), hook.last_detail)}
          </span>
        </div>
      )}
      <div className="row-actions">
        <SubmitButton busy={busy} disabled={url.trim() === '' || (hook === undefined && key.trim() === '')}>{t.common.save}</SubmitButton>
        {hook !== undefined && <ActionButton className="btn btn-sm" onAction={() => run(() => api.testWakeHook(session.session_id), t.agents.wakeTestToast)}>{t.agents.wakeTestBtn}</ActionButton>}
        {hook !== undefined && <ActionButton className="btn btn-quiet btn-sm" onAction={() => run(() => api.removeWakeHook(session.session_id), t.agents.wakeRemoved).then(() => setUrl(''))}>{t.common.remove}</ActionButton>}
      </div>
    </form>
  );
}

const WINDOW_TONE: Record<string, string> = { idle: 'muted', busy: 'proposed', watching: 'ok' };

/** One conversation of an application: its name (click to change), what it is doing, where it works. */
function WindowLine({ window: entry }: { window: WindowInfo }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.name);
  const [busy, track] = useBusy();
  return (
    <li className="window-line">
      {editing ? (
        <form
          className="window-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void track(run(() => api.renameWindow(entry.window_id, name.trim()), t.agents.windowRenamed(name.trim()))).then((saved) => saved !== undefined && setEditing(false));
          }}
        >
          <input autoFocus value={name} aria-label={t.agents.windowRenameAria(entry.name)} spellCheck={false} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Escape' && setEditing(false)} />
          <SubmitButton busy={busy} disabled={name.trim() === '' || /[\s,"'[\]]/.test(name.trim())}>{t.agents.windowSave}</SubmitButton>
        </form>
      ) : (
        <button type="button" className="window-name mono" title={t.agents.windowRenameAria(entry.name)} aria-label={t.agents.windowRenameAria(entry.name)} onClick={() => { setName(entry.name); setEditing(true); }}>
          {entry.name}
        </button>
      )}
      <Pill tone={WINDOW_TONE[entry.state] ?? 'muted'}>{t.agents.windowState[entry.state] ?? entry.state}</Pill>
      {entry.imported && <span className="muted small" title={t.agents.windowImportedHint}>{t.agents.windowImported}</span>}
      {entry.title !== null && entry.title !== entry.name && <span className="muted small window-title" title={entry.title}>{entry.title}</span>}
      <span className="muted small">{formatTime(entry.last_active_at)}</span>
      {entry.cwd !== null && <span className="muted small mono window-cwd" title={entry.cwd}>{entry.cwd}</span>}
    </li>
  );
}

function SessionRow({ session, agent, showLink }: { session: Session; agent: Agent | undefined; showLink: boolean }) {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  // The single conversations of this application that were used lately.
  const windows = data.client_hooks.find((entry) => entry.session_id === session.session_id)?.windows ?? [];
  const status = t.sessionStatus[session.status];
  const closed = session.status === 'revoked' || session.status === 'expired';
  return (
    <>
      <tr className={closed ? 'is-closed' : ''}>
        <td>
          <div className="cell-agent">
            <ProviderMark provider={agent?.provider ?? 'other'} size="sm" />
            <span>{agent?.display_name ?? session.agent_id} · {session.label}</span>
          </div>
        </td>
        <td><Pill tone={SESSION_TONE[session.status]}>{status.label}</Pill></td>
        <td className="muted">{session.last_seen_at === null ? '—' : formatTime(session.last_seen_at, t.dateLocale)}</td>
        {showLink && (
          <td className="cell-switch">
            {!closed && (
              <Switch
                checked={session.linked}
                label={t.agents.linkAria(session.label)}
                onChange={(next) => run(() => api.setLinked(session.session_id, next), next ? t.agents.linkOn(session.label) : t.agents.linkOff(session.label))}
              />
            )}
          </td>
        )}
        <td className="cell-actions">
          <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.agents.detailsAria(session.label)} />
        </td>
      </tr>
      {open && (
        <tr className="row-detail">
          <td colSpan={showLink ? 5 : 4}>
            <dl className="facts facts-stack">
              <div><dt>{t.agents.claimedClient}</dt><dd>{session.claimed_client_kind ?? t.agents.notConnected}</dd></div>
              {session.claimed_cwd !== null && <div><dt>{t.agents.cwdLabel}</dt><dd className="mono wrap">{session.claimed_cwd}</dd></div>}
              {session.status === 'pending' && <div><dt>{t.agents.expiresLabel}</dt><dd>{formatFullTime(session.pairing_expires_at, t.dateLocale)}</dd></div>}
              <div><dt>{t.agents.sessionIdLabel}</dt><dd className="mono wrap">{session.session_id}</dd></div>
            </dl>
            <div className="row-actions">
              <CopyButton text={session.session_id} label={t.agents.copySessionId} />
              {!closed && (
                <button type="button" className="btn btn-sm" onClick={() => setRevoking(true)}>
                  {t.agents.revokeBtn}
                </button>
              )}
            </div>
            {windows.length > 0 && (
              <div className="windows" title={t.agents.windowsHint}>
                <div className="windows-head">{t.agents.windowsTitle(windows.length)}</div>
                <ul>
                  {windows.map((entry) => (
                    <WindowLine key={entry.window_id} window={entry} />
                  ))}
                </ul>
              </div>
            )}
            {session.status === 'active' && (
              <div className="switch-row" title={t.agents.rateExemptTitle}>
                <span>{t.agents.rateExemptLabel}</span>
                <Switch checked={session.rate_exempt} label={t.agents.rateExemptAria(session.label)} onChange={(next) => run(() => api.setRateExempt(session.session_id, next), next ? t.agents.rateExemptOn(session.label) : t.agents.rateExemptOff(session.label))} />
              </div>
            )}
            {session.status === 'active' && agent?.provider !== 'xai' && (
              <div className="switch-row" title={t.agents.urgentTitle}>
                <span>{t.agents.urgentLabel}</span>
                <Switch checked={session.urgent_dispatch} label={t.agents.urgentAria(session.label)} onChange={(next) => run(() => api.setUrgentDispatch(session.session_id, next), next ? t.agents.urgentOn(session.label) : t.agents.urgentOff(session.label))} />
              </div>
            )}
            {session.status === 'active' && (
              <details className="closed">
                <summary>{t.agents.wakeSummary}</summary>
                <WakeHookForm session={session} />
              </details>
            )}
            {revoking && (
              <ConfirmDialog
                title={t.agents.revokeDialogTitle}
                message={t.agents.revokeDialogMsg(session.label)}
                confirmLabel={t.agents.revokeConfirm}
                onConfirm={() => run(() => api.revokeSession(session.session_id), t.agents.revokedToast)}
                onClose={() => setRevoking(false)}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function RequestCard({ session, agent }: { session: Session; agent: Agent | undefined }) {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <article className="request">
      <header>
        <ProviderMark provider={agent?.provider ?? 'other'} />
        <div>
          <strong>{agent?.display_name ?? session.agent_id} · {session.label}</strong>
          <span className="muted small">{t.agents.requestedAt(session.claimed_client_kind ?? t.agents.unknownClient, formatTime(session.requested_at ?? session.created_at, t.dateLocale))}</span>
        </div>
        <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.agents.reqDetailsAria} />
      </header>
      {open && (
        <>
          <dl className="facts facts-stack">
            <div><dt>{t.agents.cwdLabel}</dt><dd className="mono wrap">{session.claimed_cwd ?? t.agents.notProvided}</dd></div>
            <div><dt>{t.agents.runIdLabel}</dt><dd className="mono">{session.claimed_run_id ?? t.agents.notProvided}</dd></div>
            <div><dt>{t.agents.extSessionLabel}</dt><dd className="mono">{session.external_session_id ?? t.agents.notProvided}</dd></div>
            <div><dt>{t.agents.projectLabel}</dt><dd>{data.projects.find((project) => project.project_id === session.project_id)?.name ?? session.project_id}</dd></div>
          </dl>
          <p className="muted small">{t.agents.selfReportedNote}</p>
        </>
      )}
      <footer>
        <ActionButton onAction={() => run(() => api.revokeSession(session.session_id), t.agents.rejectPairingToast)}>{t.agents.rejectBtn}</ActionButton>
        <ActionButton className="btn btn-primary" onAction={() => run(() => api.approvePairing(session.session_id), t.agents.approvedInstanceToast(session.label))}>{t.agents.approveInstanceBtn}</ActionButton>
      </footer>
    </article>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const labelOf = (sessionId: string) => {
    const session = data.sessions.find((entry) => entry.session_id === sessionId);
    return session === undefined ? sessionId : `${data.agents.find((agent) => agent.agent_id === session.agent_id)?.display_name ?? session.agent_id} · ${session.label}`;
  };
  return (
    <article className="request">
      <header>
        <ProviderMark provider={proposal.proposer.provider} />
        <div>
          <strong>{t.agents.proposalTitle(proposal.title)}</strong>
          <span className="muted small">{t.agents.proposedBy(proposal.proposer.display_name, proposal.proposer.label, formatTime(proposal.created_at, t.dateLocale))}</span>
        </div>
        <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.agents.proposalDetailsAria} />
      </header>
      {open && (
        <dl className="facts facts-stack">
          <div><dt>{t.tidy.taskCodeLabel}</dt><dd className="mono">{proposal.task_code}</dd></div>
          <div><dt>{t.agents.goalLabel}</dt><dd>{proposal.goal ?? t.agents.emptyField}</dd></div>
          <div><dt>{t.agents.purposeLabel}</dt><dd>{proposal.purpose ?? t.agents.emptyField}</dd></div>
          <div><dt>{t.agents.membersLabel}</dt><dd>{proposal.member_session_ids.map(labelOf).join(t.common.sep)}</dd></div>
        </dl>
      )}
      <footer>
        <ActionButton onAction={() => run(() => api.decideProposal(proposal.proposal_id, false), t.agents.rejectProposalToast)}>{t.agents.rejectBtn}</ActionButton>
        <ActionButton className="btn btn-primary" onAction={() => run(() => api.decideProposal(proposal.proposal_id, true), t.agents.approvedProposalToast(proposal.task_code))}>{t.agents.approveProposalBtn}</ActionButton>
      </footer>
    </article>
  );
}

function HeldBotRequestCard({ request }: { request: BotRequest }) {
  const { api, run } = useConsole();
  const { t } = useI18n();
  return (
    <article className="request">
      <header>
        <ProviderMark provider="xai" />
        <div>
          <strong>{t.agents.heldBotTitle(t.agents.botAction[request.action], request.bot)}</strong>
          <span className="muted small">{t.agents.heldBotMeta(request.requester.display_name, request.requester.label, request.host.display_name, formatTime(request.created_at, t.dateLocale))}</span>
        </div>
      </header>
      <p className="wrap">{request.text ?? t.agents.noBodyText}</p>
      <p className="muted small">{t.agents.holdExplanation(request.host.display_name)}</p>
      <footer>
        <ActionButton onAction={() => run(() => api.decideBotRequest(request.request_id, false), t.agents.rejectBotToast)}>{t.agents.rejectBtn}</ActionButton>
        <ActionButton className="btn btn-primary" onAction={() => run(() => api.decideBotRequest(request.request_id, true), t.agents.releaseBotToast)}>{t.agents.releaseBtn}</ActionButton>
      </footer>
    </article>
  );
}

function BotRequestRow({ request }: { request: BotRequest }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td>{request.requester.display_name} → {request.host.display_name}</td>
        <td>{t.agents.botAction[request.action]}{request.bot !== null ? ` (${request.bot})` : ''}</td>
        <td><Pill tone={BOT_STATUS_TONE[request.status]}>{t.agents.botStatus[request.status]}</Pill></td>
        <td className="muted">{formatTime(request.created_at, t.dateLocale)}</td>
        <td className="cell-actions">
          <MoreButton open={open} onToggle={() => setOpen((value) => !value)} label={t.agents.botDetailsAria} />
        </td>
      </tr>
      {open && (
        <tr className="row-detail">
          <td colSpan={5}>
            <dl className="facts facts-stack">
              <div><dt>{t.agents.instructionLabel}</dt><dd className="wrap">{request.text ?? t.common.none}</dd></div>
              <div><dt>{t.agents.responseLabel}</dt><dd className="wrap">{request.result ?? (request.host.last_listened_at === null ? t.agents.hostNotListening : t.agents.noResponseYet)}</dd></div>
              {request.finished_at !== null && <div><dt>{t.agents.finishedAtLabel}</dt><dd>{formatFullTime(request.finished_at, t.dateLocale)}</dd></div>}
            </dl>
            {(request.status === 'queued' || request.status === 'taken') && (
              <div className="row-actions">
                <GrokPrefillButton
                  text={t.agents.botPrefillText(request.request_id, request.requester.display_name, t.agents.botAction[request.action], request.bot, request.text)}
                />
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function AgentsView() {
  const { api, data, run } = useConsole();
  const { t } = useI18n();
  const [dialog, setDialog] = useState<'pair' | 'agent' | null>(null);
  const heldRequests = data.bot_requests.filter((entry) => entry.status === 'held');
  const pastRequests = data.bot_requests.filter((entry) => entry.status !== 'held');
  const agentOf = (id: string) => data.agents.find((agent) => agent.agent_id === id);
  const requested = data.sessions.filter((session) => session.status === 'requested');
  const proposals = data.proposals.filter((proposal) => proposal.status === 'pending');
  const open = data.sessions.filter((session) => session.status === 'active' || session.status === 'pending');
  const closed = data.sessions.filter((session) => session.status === 'revoked' || session.status === 'expired');
  const missingPresets = PRESET_AGENTS.filter((preset) => !data.agents.some((agent) => agent.agent_id === preset.agent_id));
  const canPair = data.agents.length > 0 && data.projects.length > 0;
  const openMode = data.settings.open_mode;

  const addPresets = async () => {
    for (const preset of missingPresets) {
      await api.createAgent(preset);
    }
  };

  return (
    <main className="page sheet">
      <div className="page-inner">
        <header className="page-head">
          <div>
            <h1>{t.agents.title}</h1>
            <p>{openMode ? t.agents.subtitleOpen : t.agents.subtitleClosed}</p>
          </div>
          <div className="page-actions">
            <details className="menu">
              <summary className="btn btn-quiet btn-icon" aria-label={t.agents.moreActions} title={t.agents.moreActions}>
                <Icon name="plus" />
              </summary>
              <div className="menu-pop menu-pop-down menu-pop-end">
                <button type="button" className="menu-item" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); setDialog('agent'); }}>{t.agents.newAgent}</button>
                {missingPresets.length > 0 && (
                  <button type="button" className="menu-item" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void run(addPresets, t.agents.presetsAdded); }}>
                    {t.agents.addPresets}
                  </button>
                )}
              </div>
            </details>
            <button type="button" className="btn" disabled={!canPair} title={canPair ? undefined : t.agents.issuePairingDisabled} onClick={() => setDialog('pair')}>{t.agents.issuePairing}</button>
          </div>
        </header>

        <section className="setting">
          <Icon name="link" size={18} />
          <div>
            <strong>{t.agents.openModeTitle}</strong>
            <p>{openMode ? t.agents.openModeDescOn : t.agents.openModeDescOff}</p>
          </div>
          <Switch checked={openMode} label={t.agents.openModeTitle} onChange={(next) => run(() => api.setOpenMode(next), next ? t.agents.openModeOnToast : t.agents.openModeOffToast)} />
        </section>

        {data.projects.length === 0 && <p className="next-step">{t.agents.noProjects}</p>}
        {data.projects.length > 0 && data.agents.length === 0 && (
          <p className="next-step">
            {t.agents.noAgents}
            <ActionButton className="btn btn-sm" onAction={() => run(addPresets, t.agents.presetsAdded)}>{t.agents.addPresetsBtn}</ActionButton>
          </p>
        )}

        {requested.length + proposals.length + heldRequests.length > 0 && (
          <section className="block">
            <h2>{t.agents.pendingHeading} <span className="count">{requested.length + proposals.length + heldRequests.length}</span></h2>
            <div className="requests">
              {heldRequests.map((request) => (
                <HeldBotRequestCard key={request.request_id} request={request} />
              ))}
              {proposals.map((proposal) => (
                <ProposalCard key={proposal.proposal_id} proposal={proposal} />
              ))}
              {requested.map((session) => (
                <RequestCard key={session.session_id} session={session} agent={agentOf(session.agent_id)} />
              ))}
            </div>
          </section>
        )}

        <section className="block">
          <h2>{t.agents.sessionsHeading} <span className="count">{open.length}</span></h2>
          {open.length === 0 ? (
            <p className="empty-inline">{t.agents.sessionsEmpty}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.agents.colSession}</th>
                    <th>{t.agents.colStatus}</th>
                    <th>{t.agents.colLastSeen}</th>
                    {openMode && <th>{t.agents.colLinked}</th>}
                    <th aria-label={t.agents.colDetails} />
                  </tr>
                </thead>
                <tbody>
                  {open.map((session) => (
                    <SessionRow key={session.session_id} session={session} agent={agentOf(session.agent_id)} showLink={openMode} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {closed.length > 0 && (
            <details className="closed">
              <summary>{t.agents.closedSummary(closed.length)}</summary>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {closed.map((session) => (
                      <SessionRow key={session.session_id} session={session} agent={agentOf(session.agent_id)} showLink={false} />
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </section>

        {pastRequests.length > 0 && (
          <details className="closed">
            <summary>{t.agents.botHistorySummary(pastRequests.length)}</summary>
            <p className="muted small">{t.agents.botHistoryHint}</p>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {pastRequests.map((request) => (
                    <BotRequestRow key={request.request_id} request={request} />
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {data.agents.length > 0 && (
          <details className="closed">
            <summary>{t.agents.logicalAgentsSummary(data.agents.length)}</summary>
            <ul className="agent-grid">
              {data.agents.map((agent) => {
                const count = data.sessions.filter((session) => session.agent_id === agent.agent_id && session.status === 'active').length;
                return (
                  <li key={agent.agent_id} className="agent-card" title={`${agent.client_kind} · ${agent.agent_id}`}>
                    <ProviderMark provider={agent.provider} size="sm" />
                    <div><span>{agent.display_name}</span></div>
                    <span>{t.agents.pairedCount(count)}</span>
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </div>
      {dialog === 'pair' && <PairingWizard onClose={() => setDialog(null)} />}
      {dialog === 'agent' && <NewAgentDialog onClose={() => setDialog(null)} />}
    </main>
  );
}
