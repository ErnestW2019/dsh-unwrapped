/**
 * Session log → per-session facts, the only place that knows the DSH event
 * vocabulary. Pure: it takes an already-read `{ header, events }` snapshot and
 * never touches disk, a service, or a clock.
 *
 * Human-vs-AI is decided by provenance, not by role alone: `user/message` rows
 * whose `data.source.kind === 'user'` are human prompts, while synthetic
 * context injections (`agent`, hooks, goal rounds) are counted separately so
 * they never inflate the human side.
 */

const MAX_PREVIEWS = 3;
const PREVIEW_CHARS = 170;
/** Kept per human message for the "what you actually said" layer. */
const HUMAN_TEXT_CHARS = 120;
/** Ceiling on retained samples per session (`moments` only reads a handful). */
const MAX_HUMAN_SAMPLES = 800;
/**
 * A curated vocabulary beats raw n-grams here: CJK bigram counting without a
 * segmenter mostly surfaces 一个 / 就是 / 然后, which reads like a bug. These are
 * the words that actually make a rewind feel personal when counted back at you.
 */
const PHRASE_LEXICON = [
  '为什么', '怎么', '帮我', '看看', '确认', '试试', '再试', '不对', '等等', '算了',
  '谢谢', '抱歉', '能不能', '可不可以', '改一下', '再来', '继续', '先别', '好慢', '好快',
  '重构', '报错', '测试', '部署', '文档', '插件', '接口', '这个bug', '样式', '颜色',
  'why', 'again', 'test', 'deploy', 'plugin', 'bug', 'fix', 'doc', 'api', 'slow',
];

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let from = 0;
  let hits = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return hits;
    hits += 1;
    from = at + needle.length;
  }
}

/**
 * @typedef {{ t: number, chars: number }} Point
 * @typedef {{ t: number, chars: number, reasoningChars: number, tokens: TokenTotals|null }} AssistantPoint
 * @typedef {{ t: number, name: string, chars: number }} ToolPoint
 * @typedef {{ input: number, output: number, total: number, cacheRead: number, cacheWrite: number }} TokenTotals
 */

function emptyTokens() {
  return { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Token accounting from one `assistant/message` usage record.
 * `totalTokens` is optional; when the provider omits it the sum is used.
 */
function tokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = numberOrZero(usage.inputTokens);
  const output = numberOrZero(usage.outputTokens);
  const cacheRead = numberOrZero(usage.cacheReadTokens);
  const cacheWrite = numberOrZero(usage.cacheWriteTokens);
  const reported = numberOrZero(usage.totalTokens);
  const total = reported > 0 ? reported : input + output;
  if (total <= 0 && input <= 0 && output <= 0) return null;
  return { input, output, total, cacheRead, cacheWrite };
}

/**
 * Character counts + first visible preview from a message content array.
 * Reasoning parts are counted separately (they are model output but not chat).
 */
function summarizeContent(content) {
  let chars = 0;
  let reasoningChars = 0;
  let preview = '';
  let toolResultChars = 0;
  if (!Array.isArray(content)) return { chars, reasoningChars, preview, toolResultChars };
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const text = typeof part.text === 'string' ? part.text : '';
    if (part.type === 'text' || part.type === 'input-text') {
      chars += text.length;
      if (!preview) {
        const trimmed = text.trim();
        if (trimmed) preview = trimmed.slice(0, PREVIEW_CHARS);
      }
    } else if (part.type === 'reasoning') {
      reasoningChars += text.length;
    } else if (part.type === 'tool-result' || part.type === 'tool_result') {
      const nested = Array.isArray(part.content) ? part.content : [];
      for (const inner of nested) {
        if (inner && typeof inner.text === 'string') toolResultChars += inner.text.length;
      }
    }
  }
  return { chars, reasoningChars, preview, toolResultChars };
}

function errorMessage(reason) {
  if (!reason || typeof reason !== 'object') return null;
  const failure = reason.error ?? reason.failure ?? reason;
  if (typeof failure?.message === 'string' && failure.message.trim()) return failure.message.trim();
  return typeof reason.kind === 'string' ? reason.kind : null;
}

/**
 * Fold one session snapshot into facts.
 * @param {{ header?: object, events?: object[] }} raw
 * @returns {object|null} facts, or null when the snapshot is unusable
 */
function extractSession(raw) {
  const header = raw?.header ?? raw?.session ?? null;
  const events = Array.isArray(raw?.events) ? raw.events : Array.isArray(raw) ? raw : null;
  if (!header || !events) return null;
  const id = typeof header.id === 'string' ? header.id : null;
  if (!id) return null;

  /** @type {Point[]} */
  const humanPoints = [];
  /** @type {AssistantPoint[]} */
  const assistantPoints = [];
  /** @type {ToolPoint[]} */
  const toolPoints = [];
  /** @type {Point[]} */
  const turnPoints = [];
  /** @type {Point[]} */
  const stepPoints = [];
  /** @type {{ t: number, message: string }[]} */
  const failures = [];
  /** @type {TokenTotals} */
  const tokens = emptyTokens();
  /** @type {Record<string, number>} */
  const models = {};
  /** @type {Record<string, number>} */
  const providers = {};
  /** @type {string[]} */
  const previews = [];
  /** @type {{ t: number, text: string }[]} */
  const humanSamples = [];
  /** @type {Record<string, number>} */
  const phrases = {};
  /** @type {{ t: number, questions: number, thanks: number }[]} */
  const humanMarks = [];
  let injectedMessages = 0;
  let interrupted = 0;
  let toolResultChars = 0;
  let title = '';
  let model = null;
  let provider = null;
  let firstTs = 0;
  let lastTs = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const t = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : null;
    if (t === null) continue;
    if (!firstTs || t < firstTs) firstTs = t;
    if (t > lastTs) lastTs = t;
    const data = event.data && typeof event.data === 'object' ? event.data : {};

    switch (event.type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim()) title = data.title.trim();
        break;
      }
      case 'model/selection': {
        if (typeof data.model === 'string') model = data.model;
        if (typeof data.provider === 'string') provider = data.provider;
        break;
      }
      case 'request/header': {
        const config = data.header?.config;
        if (config && typeof config === 'object') {
          if (typeof config.model === 'string') model = config.model;
          if (typeof config.provider === 'string') provider = config.provider;
        }
        break;
      }
      case 'user/message': {
        const kind = data.source?.kind;
        if (kind === 'user') {
          const summary = summarizeContent(data.content);
          humanPoints.push({ t, chars: summary.chars });
          const folded = summary.preview ? summary.preview.toLowerCase() : '';
          // Per-message marks (not per-session totals) keep windowed counts exact
          // even when one session spans several reporting periods.
          humanMarks.push({
            t,
            questions: countOccurrences(summary.preview, '？') + countOccurrences(summary.preview, '?'),
            thanks: folded ? (folded.match(/谢谢|感谢|thanks|thank you|thx/g) ?? []).length : 0,
          });
          if (previews.length < MAX_PREVIEWS && summary.preview) previews.push(summary.preview);
          if (summary.preview) {
            if (humanSamples.length < MAX_HUMAN_SAMPLES) {
              humanSamples.push({ t, text: summary.preview.slice(0, HUMAN_TEXT_CHARS) });
            }
            for (const word of PHRASE_LEXICON) {
              const hits = countOccurrences(folded, word);
              if (hits > 0) phrases[word] = (phrases[word] ?? 0) + hits;
            }
          }
        } else {
          injectedMessages += 1;
        }
        break;
      }
      case 'assistant/message': {
        const summary = summarizeContent(data.message?.content ?? data.content);
        const usage = tokensFromUsage(data.usage);
        assistantPoints.push({
          t,
          chars: summary.chars,
          reasoningChars: summary.reasoningChars,
          tokens: usage,
          model,
          provider,
        });
        if (usage) {
          tokens.input += usage.input;
          tokens.output += usage.output;
          tokens.total += usage.total;
          tokens.cacheRead += usage.cacheRead;
          tokens.cacheWrite += usage.cacheWrite;
        }
        if (data.interrupted === true) interrupted += 1;
        if (model) models[model] = (models[model] ?? 0) + 1;
        if (provider) providers[provider] = (providers[provider] ?? 0) + 1;
        break;
      }
      case 'tool/call': {
        if (typeof data.name === 'string' && data.name) {
          toolPoints.push({ t, name: data.name, chars: 0 });
        }
        break;
      }
      case 'tool/result': {
        const summary = summarizeContent(data.message?.content ?? data.content);
        toolResultChars += summary.toolResultChars;
        break;
      }
      case 'turn/start': {
        turnPoints.push({ t, chars: 0 });
        break;
      }
      case 'turn/end': {
        const message = errorMessage(data.reason);
        if (message) failures.push({ t, message });
        break;
      }
      case 'step/end': {
        stepPoints.push({ t, chars: 0 });
        break;
      }
      default:
        break;
    }
  }

  return {
    id,
    title,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
    origin: typeof header.origin === 'string' ? header.origin : 'interactive',
    delegationDepth: numberOrZero(header.delegationDepth),
    isSeeded: header.isSeeded === true,
    createdAt: numberOrZero(header.createdAt),
    firstTs,
    lastTs,
    humanPoints,
    assistantPoints,
    toolPoints,
    turnPoints,
    stepPoints,
    failures,
    tokens,
    models,
    providers,
    previews,
    humanSamples,
    humanMarks,
    phrases,
    injectedMessages,
    interrupted,
    toolResultChars,
  };
}

export {
  extractSession,
  summarizeContent,
  tokensFromUsage,
  emptyTokens,
  PREVIEW_CHARS,
  PHRASE_LEXICON,
};
