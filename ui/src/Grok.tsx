// Deep-link prefill helper for Grok Bot:
//   grokbot://app/v1/prompt?id=<bot-id>&text=<message>
// Opens the local Grok Bot app and fills its input box (up to 1,000 chars,
// only when empty); the user submits manually.
import { useConsole } from './App';
import { Icon } from './format';
import { useI18n } from './i18n';

const LIMIT = 1000;

/** Builds a Grok Bot prefill deep link truncated to the 1,000-character ceiling. */
export function grokPrefillLink(text: string, botId: string, trailer: string): string {
  const characters = Array.from(text.trim());
  const shown = characters.length <= LIMIT ? characters.join('') : `${characters.slice(0, LIMIT - trailer.length).join('')}${trailer}`;
  const target = botId === '' ? '' : `id=${encodeURIComponent(botId)}&`;
  return `grokbot://app/v1/prompt?${target}text=${encodeURIComponent(shown)}`;
}

/** Renders a prefill link when a Grok Bot agent is configured. */
export function GrokPrefillButton({ text }: { text: string }) {
  const { data } = useConsole();
  const { t } = useI18n();
  if (!data.agents.some((agent) => agent.provider === 'xai') || text.trim() === '') {
    return null;
  }
  return (
    <a className="btn btn-quiet btn-sm" href={grokPrefillLink(text, data.settings.grok_bot_id, t.grok.trailer)} title={t.grok.buttonTitle}>
      <Icon name="send" size={14} />
      {t.grok.buttonLabel}
    </a>
  );
}
