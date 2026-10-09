import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, Ledger, Meter, Panel, Task, TaskStatus } from '../types'

// Inspired by savvy-progress (github.com/johnnyvizz/claude-kit, MIT), rebuilt to
// stand on its own: the bar follows Claude's own task list, the panel follows
// the whole session.

const tasks = atom({ plugin: 'session-meter', key: 'tasks' } as const, [])
const flow = atom({ plugin: 'session-meter', key: 'flow' } as const, null)
const agents = atom({ plugin: 'session-meter', key: 'agents' } as const, [])
const main = atom({ plugin: 'session-meter', key: 'main' } as const, null)
const other = atom({ plugin: 'session-meter', key: 'other' } as const, null)
const ledger = atom({ plugin: 'session-meter', key: 'ledger' } as const, null)
const panel = atom({ plugin: 'session-meter', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  isBandHidden: false,
})
const now = atom({ plugin: 'session-meter', key: 'now' } as const, 0)

const PROGRESS_TOOL = 'mcp__session-meter__progress'
const STEP_TOOL = 'mcp__session-meter__step'
const PANE = 'session-meter'
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'
const CLAY = '#D97757'
const INK = '#1F1E1D'

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else
// the process locale; English when nothing matches.

type Lang = 'es' | 'en' | 'ru'

const STRINGS = {
  es: {
    pane: 'Sesión',
    progress: 'Progreso',
    cost: 'Costo',
    tokens: 'Tokens',
    time: 'Tiempo',
    context: 'Contexto',
    collapse: 'Contraer',
    expand: 'Expandir',
    tasks: 'Tareas',
    mainLoop: 'Sesión principal',
    running: 'En curso',
    finished: 'Terminados',
    other: 'Otros (compactación, forks)',
    noTasks: 'Sin lista de tareas todavía.',
    noAgents: 'Sin subagentes todavía.',
    failed: 'error',
    background: 'segundo plano',
    tokensWord: 'tokens',
    done: 'Listo',
    opened: 'Panel de sesión abierto.',
    closed: 'Panel de sesión cerrado.',
    textHint: '¿No lo ves? /session-meter texto lo muestra acá.',
    unplaced: 'La app conectada no muestra el panel en esta sesión; acá va el resumen en texto',
    costNote: 'Total: cifra del motor (/cost). Por fila: estimación con la tabla de precios.',
    costNoteEstimate: 'Todo es estimación con la tabla de precios (el motor no informó costo).',
    noPrice: 'sin precio',
    idle: 'Sesión',
  },
  en: {
    pane: 'Session',
    progress: 'Progress',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    context: 'Context',
    collapse: 'Collapse',
    expand: 'Expand',
    tasks: 'Tasks',
    mainLoop: 'Main session',
    running: 'Running',
    finished: 'Finished',
    other: 'Other (compaction, forks)',
    noTasks: 'No task list yet.',
    noAgents: 'No subagents yet.',
    failed: 'error',
    background: 'background',
    tokensWord: 'tokens',
    done: 'Done',
    opened: 'Session panel opened.',
    closed: 'Session panel closed.',
    textHint: "Can't see it? /session-meter texto prints it here.",
    unplaced: 'The attached app does not show the panel in this session; here is the summary as text',
    costNote: "Total: the engine's figure (/cost). Per row: an estimate from the price table.",
    costNoteEstimate: 'All figures are estimates from the price table (the engine reported no cost).',
    noPrice: 'no price',
    idle: 'Session',
  },
  ru: {
    pane: 'Сессия',
    progress: 'Прогресс',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    context: 'Контекст',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    tasks: 'Задачи',
    mainLoop: 'Основная сессия',
    running: 'Работают',
    finished: 'Завершены',
    other: 'Прочее (сжатие, форки)',
    noTasks: 'Списка задач пока нет.',
    noAgents: 'Субагентов пока нет.',
    failed: 'ошибка',
    background: 'в фоне',
    tokensWord: 'токенов',
    done: 'Готово',
    opened: 'Панель сессии открыта.',
    closed: 'Панель сессии закрыта.',
    textHint: 'Не видно? /session-meter texto покажет здесь.',
    unplaced: 'Подключённое приложение не показывает панель в этой сессии; вот сводка текстом',
    costNote: 'Итого: данные движка (/cost). По строкам: оценка по таблице цен.',
    costNoteEstimate: 'Все суммы — оценка по таблице цен (движок не сообщил стоимость).',
    noPrice: 'нет цены',
    idle: 'Сессия',
  },
} as const

type Strings = (typeof STRINGS)[Lang]

// Module scope is fine: session.start sets these again on every (re)load.
let lang: Lang = 'en'
let bandMode: 'auto' | 'always' | 'off' = 'auto'
let priceOverrides: PriceRow[] = []
const tr = (): Strings => STRINGS[lang]

const langOf = (v: unknown): Lang | null => {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim().toLowerCase()
  if (/^(es|spa|español|espanol|castellano)/.test(s)) return 'es'
  if (/^(ru|rus|русский)/.test(s)) return 'ru'
  if (/^(en|eng)/.test(s)) return 'en'
  return null
}

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'es' || option === 'en' || option === 'ru') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    const fromSettings = langOf(settings.language)
    if (fromSettings) return fromSettings
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return langOf(locale) ?? 'en'
}

// ---------------------------------------------------------------------------
// Prices: USD per million tokens (input, output, cache read, cache write 5m).
// Only per-row figures use them; the session total is the engine's own ledger.

type Price = [number, number, number, number]
type PriceRow = [(model: string) => boolean, Price]

const DEFAULT_PRICES: PriceRow[] = (
  [
    [/fable-5-1|mythos-5-1/, [10, 50, 0.25, 12.5]],
    [/fable|mythos/, [10, 50, 1, 12.5]],
    [/opus-5-5/, [4, 20, 0.2, 5]],
    [/opus/, [5, 25, 0.5, 6.25]],
    [/sonnet-5/, [2, 10, 0.2, 2.5]],
    [/sonnet/, [3, 15, 0.3, 3.75]],
    [/haiku-5/, [0.1, 0.5, 0.01, 0.125]],
    [/haiku/, [1, 5, 0.1, 1.25]],
  ] as [RegExp, Price][]
).map(([re, p]) => [(m: string) => re.test(m), p])

// 'opus-5-5=4/20/0.2/5; sonnet=2/10/0.2/2.5': a substring of the model id, then
// four numbers. A malformed entry is skipped, never guessed at.
const parsePrices = (spec: unknown): PriceRow[] =>
  typeof spec !== 'string'
    ? []
    : spec
        .split(/[;\n]/)
        .map(part => part.split('='))
        .flatMap(([pattern = '', values = '']): PriceRow[] => {
          const key = pattern.trim().toLowerCase()
          const nums = values.split('/').map(v => Number(v.trim()))
          if (!key || nums.length !== 4 || nums.some(x => !Number.isFinite(x) || x < 0)) return []
          return [[(m: string) => m.includes(key), nums as Price]]
        })

const priceOf = (model: string): Price | null => {
  const m = model.toLowerCase()
  return [...priceOverrides, ...DEFAULT_PRICES].find(([test]) => test(m))?.[1] ?? null
}

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

// Every usage field goes through this: a missing or odd value counts as 0, never NaN.
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

const allTokens = (u: Usage): number =>
  n(u.input_tokens) + n(u.output_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)

// What the request was answered over: the status line's definition of context.
const inputSide = (u: Usage): number =>
  n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)

const costOf = (model: string, u: Usage): number | null => {
  const p = priceOf(model)
  if (!p) return null
  const [i, o, r, w] = p
  return (n(u.input_tokens) * i + n(u.output_tokens) * o + n(u.cache_read_input_tokens) * r + n(u.cache_creation_input_tokens) * w) / 1e6
}

const windowOf = (model: string): number => (/haiku-(3|4)/i.test(model) ? 200_000 : 1_000_000)

const blankMeter = (model: string): Meter => ({
  model,
  tokens: 0,
  costUsd: 0,
  isPriced: true,
  contextTokens: 0,
  contextMax: windowOf(model),
  requests: 0,
})

// Adds one model response to a meter.
const charge = <M extends Meter>(m: M, model: string, u: Usage, effort?: unknown): M => {
  const cost = costOf(model, u)
  return {
    ...m,
    model,
    effort: effort === undefined ? m.effort : String(effort),
    tokens: m.tokens + allTokens(u),
    costUsd: m.costUsd + (cost ?? 0),
    isPriced: m.isPriced && cost !== null,
    contextTokens: inputSide(u),
    contextMax: windowOf(model),
    requests: m.requests + 1,
  }
}

// ---------------------------------------------------------------------------
// Formatting.

const fmtTokens = (x: number): string =>
  x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : `${Math.round(x)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtMeterCost = (m: Meter): string => (m.isPriced || m.costUsd > 0 ? `≈${fmtCost(m.costUsd)}${m.isPriced ? '' : '+'}` : tr().noPrice)

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const ctxPct = (m: Meter): number => (m.contextMax ? Math.min(100, Math.round((m.contextTokens / m.contextMax) * 100)) : 0)

const bar = (ratio: number, width: number): string => {
  const filled = Math.round(width * Math.max(0, Math.min(1, ratio)))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// The task list: Claude's own TodoWrite or TaskCreate/TaskUpdate/TaskList calls.
// Tasks are keyed by id and agents by agentId, so nothing is matched by text.

type TodoInput = { content?: string; status?: string; activeForm?: string }

const statusOf = (s: unknown): TaskStatus => (s === 'completed' || s === 'in_progress' ? s : 'pending')

const isAllDone = (list: Task[]): boolean => list.length > 0 && list.every(t => t.status === 'completed')

type Progress = { title: string; total: number; done: number; active: string; isFinished: boolean }

const progressOf = (list: Task[], f: Flow | null): Progress | null => {
  if (!f && list.length === 0) return null
  const total = Math.max(0, f?.total ?? list.length)
  const done = Math.min(total, Math.max(0, f?.done ?? list.filter(t => t.status === 'completed').length))
  const current = list.find(t => t.status === 'in_progress')
  return {
    title: f?.title || tr().progress,
    total,
    done,
    active: current ? current.active || current.title : '',
    isFinished: f?.isFinished === true || (total > 0 && done >= total),
  }
}

const ratioOf = (p: Progress): number => (p.isFinished ? 1 : p.total ? p.done / p.total : 0)

// A new batch of work shows the bar again after the person dismissed it.
async function newBatch($: EngineInterface): Promise<void> {
  await update($, panel, p => ({ ...p, isBandHidden: false }))
  await update($, flow, f => (f?.isFinished ? null : f))
}

// ---------------------------------------------------------------------------
// The engine's ledger and the clock.

async function refreshLedger($: EngineInterface): Promise<void> {
  try {
    const u = await $.session.usage()
    const next: Ledger = {
      startedAt: u.startedAt,
      costUsd: typeof u.cost?.usd === 'number' && Number.isFinite(u.cost.usd) ? u.cost.usd : undefined,
      contextPercent: u.context.percent,
      contextWindow: u.context.window,
    }
    await update($, ledger, () => next)
  } catch {
    // A host without a ledger: the panel falls back to estimates.
  }
}

async function tick($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
}

// Where the pane and the band were last drawn, per surface: what `debug` reports.
// Module scope on purpose: a diagnostic of this load, not session state.
const draws = new Map<string, { count: number; at: number; detail: string }>()
const noteDraw = (site: string, surface: string, detail: string, at: number): void => {
  const key = `${site}@${surface}`
  draws.set(key, { count: (draws.get(key)?.count ?? 0) + 1, at, detail })
}

type Toggle = { state: 'opened' } | { state: 'closed' } | { state: 'unplaced'; reason: string }

// Opens the pane, or closes it when a surface shows it. A pane left open but
// undrawn (no surface places panes) is opened again, never closed unseen.
async function togglePane($: EngineInterface): Promise<Toggle> {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isPlaced) {
    await $.ui.close({ id: PANE })
    return { state: 'closed' }
  }
  await tick($)
  await refreshLedger($)
  // With no surface attached the engine reports any pane as placed, yet nothing
  // ever draws it (a cloud session watched from an app that draws no mod UI).
  if ((await $.session.surfaces()).length === 0) return { state: 'unplaced', reason: 'no surface attached' }
  const opened = await $.ui.open({ id: PANE, title: tr().pane })
  return opened.isPlaced ? { state: 'opened' } : { state: 'unplaced', reason: opened.reason }
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Totals = { cost: number; isEstimate: boolean; tokens: number; time: number }

const totalsOf = (meters: Meter[], l: Ledger | null, at: number): Totals => {
  const estimate = meters.reduce((s, m) => s + m.costUsd, 0)
  const tokens = meters.reduce((s, m) => s + m.tokens, 0)
  const isEstimate = l?.costUsd === undefined
  return { cost: isEstimate ? estimate : (l?.costUsd ?? 0), isEstimate, tokens, time: l ? Math.max(0, at - l.startedAt) : 0 }
}

const fmtTotalCost = (t: Totals): string => `${t.isEstimate ? '≈' : ''}${fmtCost(t.cost)}`

// ---------------------------------------------------------------------------
// Desktop drawings: each row is one SVG, since the desktop wraps sibling
// elements onto new lines.

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁÁÉÍÓÚÑmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

const TYPE_COLOR: Record<string, string> = {
  main: CLAY,
  Explore: '#378ADD',
  Plan: '#BA7517',
  'general-purpose': '#7F77DD',
  fork: '#1D9E75',
}
const colorOf = (type: string): string => TYPE_COLOR[type.replace(/^[^:]*:/, '')] ?? '#888780'

// A pixel crab: the clay body, a hat band in the agent type's color, legs that
// step while it works. Pure CSS, so walking costs no redraws.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
@media (prefers-reduced-motion: reduce){.run *{animation:none!important}}
</style>`

const crab = (x: number, y: number, color: string, isWalking: boolean, scale = 1.1, dim = false): string => {
  const r = (cx: number, cy: number, w: number, h: number, c: string) =>
    `<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`
  const body = [r(7, 10, 16, 12, CLAY), r(3, 14, 4, 4, CLAY), r(23, 14, 4, 4, CLAY), r(9, 12, 2, 2, INK), r(19, 12, 2, 2, INK), r(7, 7, 16, 3, color)].join('')
  const la = r(7, 22, 2, 4, CLAY) + r(17, 22, 2, 4, CLAY)
  const lb = r(11, 22, 2, 4, CLAY) + r(21, 22, 2, 4, CLAY)
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="${isWalking ? 'run' : ''}"><g class="bd">${body}</g><g class="la">${la}</g><g class="lb">${lb}</g></g></g>`
}

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

const BAND_H = 22
const BAR_H = 16
const CELL = 3

const bandSvg = (p: Progress, W: number, right: string, isWorking: boolean): string => {
  const color = p.isFinished ? DONE : ACCENT
  const lead = p.isFinished ? p.title : p.active || p.title
  const label = p.isFinished ? tr().done : p.total ? `${p.done}/${p.total}` : '…'
  const title = fitText(lead, 13, Math.max(60, W * 0.38))
  const rightW = textWidth(right, 12.5) + 8
  const barX = Math.round(16 + textWidth(title, 13) + 12)
  const barW = Math.max(60, W - barX - rightW - 34)
  const fillW = Math.round(barW * ratioOf(p))
  const rows = Math.floor(BAR_H / CELL)
  const dots: string[] = []
  const cols = Math.floor(fillW / CELL)
  // Dithered fill: sparse at the start, dense toward the head.
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="d${Math.floor(noise(r, c) * 3)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  const ticks: string[] = []
  for (let i = 1; i < p.total && p.total <= 40; i++) {
    const x = Math.round((barW * i) / p.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }
  const pillW = Math.round(18 + label.length * 6.6)
  const pillX = Math.max(0, Math.min(barW - pillW, fillW - pillW))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${BAND_H}" viewBox="0 0 ${W} ${BAND_H}">${PANE_CSS}${CRAB_CSS}
<style>.d0,.d1,.d2{animation:tw 2.4s ease-in-out infinite}.d1{animation-delay:-.8s}.d2{animation-delay:-1.6s}
@keyframes tw{50%{opacity:${p.isFinished ? 0.8 : 0.35}}}@media (prefers-reduced-motion: reduce){.d0,.d1,.d2{animation:none}}</style>
<defs><clipPath id="c"><rect width="${barW}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${BAND_H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${BAND_H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${barX},${(BAND_H - BAR_H) / 2})">
<rect class="k" width="${barW}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)"><g fill="${color}">${dots.join('')}</g><g class="m">${ticks.join('')}</g></g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(label)}</text>
</g>
<text class="s" x="${W - 30}" y="${BAND_H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${xml(right)}</text>
${crab(W - 27, 0, CLAY, isWorking, 0.8)}
</svg>`
}

const headerSvg = (W: number, t: Totals, l: Ledger | null): string => {
  const s = tr()
  const gap = 6
  const tiles: [string, string][] = [
    [s.cost, fmtTotalCost(t)],
    [s.tokens, fmtTokens(t.tokens)],
    [s.time, fmtTime(t.time)],
    [s.context, l?.contextPercent === undefined ? '—' : `${l.contextPercent}%`],
  ]
  const tw = (W - gap * (tiles.length - 1)) / tiles.length
  const body = tiles
    .map(
      ([k, v], i) => `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="16" font-family="${FONT}" font-size="11">${xml(k)}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="33" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${xml(v)}</text>`,
    )
    .join('')
  return svg(W, 44, body)
}

type Row = { key: string; title: string; type: string; meter: Meter; status: 'running' | 'done' | 'failed' | 'main'; time: string; steps?: string; ratio: number | null; meta: string[] }

const statusMark = (x: number, y: number, status: Row['status'], color: string): string => {
  if (status === 'running' || status === 'main') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
}

const rowSvg = (W: number, row: Row): string => {
  const color = colorOf(row.type)
  const textW = W - 42 - 22
  const ctx = ctxPct(row.meter)
  const stats = `ctx ${ctx}% · ${fmtTokens(row.meter.tokens)} tok  ${fmtMeterCost(row.meter)}  ${row.time}`
  const stepsW = Math.max(0, textW - textWidth(stats, 11) - 12)
  // Without reported steps the bar shows the context fill, drawn grey.
  const fillW = Math.round(textW * (row.ratio ?? ctx / 100))
  return svg(
    W,
    66,
    `${crab(0, 14, color, row.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(row.title, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(row.type === 'main' ? '' : row.type)}</tspan><tspan class="s">${row.type === 'main' ? '' : '  ·  '}${xml(row.meta.join('  ·  '))}</tspan></text>
${row.steps && stepsW > 30 ? `<text class="t" x="42" y="49" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(row.steps, 11, stepsW))}</text>` : ''}
<text class="s" x="${42 + textW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(stats)}</text>
<rect class="k" x="42" y="55" width="${textW}" height="4" rx="2"/><rect${row.ratio === null ? ' class="m"' : ` fill="${color}"`} x="42" y="55" width="${fillW}" height="4" rx="2"/>
${statusMark(W - 8, 16, row.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

// ---------------------------------------------------------------------------

const agentRow = (a: AgentRun, at: number): Row => {
  const s = tr()
  const meta = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.isBackground) meta.push(s.background)
  if (a.status === 'failed') meta.push(s.failed)
  return {
    key: a.id,
    title: a.description || a.type,
    type: a.type,
    meter: a,
    status: a.status,
    time: fmtTime(elapsed(a, at)),
    steps: a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : undefined,
    ratio: a.status === 'done' ? 1 : a.stepTotal ? Math.min(1, (a.stepDone ?? 0) / a.stepTotal) : null,
    meta,
  }
}

const mainRow = (m: Meter, l: Ledger | null, t: Totals): Row => ({
  key: 'main',
  title: tr().mainLoop,
  type: 'main',
  // The engine's window and fill win over the guess from the model's name.
  meter: l?.contextWindow ? { ...m, contextMax: l.contextWindow } : m,
  status: 'main',
  time: fmtTime(t.time),
  ratio: null,
  meta: [m.effort ? `${modelName(m.model)} · ${m.effort}` : modelName(m.model)],
})

// An observer that fails never changes the call it watched: replay what next settled.
const passThrough = <E, R>(_$: unknown, e: E, next: (e: E) => R): R => next(e)

const TASK_GLYPH: Record<TaskStatus, string> = { completed: '✓', in_progress: '●', pending: '○' }

// The panel as plain lines, for a session whose app shows no panes.
async function summaryText($: EngineInterface): Promise<string> {
  const s = tr()
  const list = await read($, agents)
  const taskList = await read($, tasks)
  const m = await read($, main)
  const o = await read($, other)
  const l = await read($, ledger)
  const at = await $.clock.now()
  const t = totalsOf([...(m ? [m] : []), ...list, ...(o ? [o] : [])], l, at)
  const prog = progressOf(taskList, await read($, flow))
  const meterLine = (r: Row) =>
    `${r.title}${r.type === 'main' ? '' : ` (${r.type})`} ${r.status === 'done' ? '✓' : r.status === 'failed' ? '✗' : '●'} — ${r.meta.join(' · ')} · ${r.steps ? r.steps + ' · ' : ''}ctx ${ctxPct(r.meter)}% · ${fmtTokens(r.meter.tokens)} tok · ${fmtMeterCost(r.meter)} · ${r.time}`
  const lines = [
    `${s.cost} ${fmtTotalCost(t)} · ${fmtTokens(t.tokens)} ${s.tokensWord} · ${s.time} ${fmtTime(t.time)}${l?.contextPercent === undefined ? '' : ` · ${s.context} ${l.contextPercent}%`}`,
    '',
    prog ? `${s.tasks} · ${prog.isFinished ? s.done : `${prog.done}/${prog.total}`}` : s.noTasks,
    ...taskList.map(task => `  ${TASK_GLYPH[task.status]} ${task.status === 'in_progress' ? task.active || task.title : task.title}`),
    '',
    ...(m ? [meterLine(mainRow(m, l, t))] : []),
    ...(list.length ? [...list].reverse().map(a => meterLine(agentRow(a, at))) : [s.noAgents]),
    ...(o ? [`${s.other}: ${fmtTokens(o.tokens)} tok · ${fmtMeterCost(o)}`] : []),
    '',
    t.isEstimate ? s.costNoteEstimate : s.costNote,
  ]
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  // Options are known at load; only `auto` language waits for the session's settings.
  bandMode = options.band === 'always' || options.band === 'off' ? options.band : 'auto'
  priceOverrides = parsePrices(options.prices)
  lang = langOf(options.language) ?? 'en'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)

    await $.tool.register({
      name: 'progress',
      description:
        'Optional: names the progress bar above the prompt for a multi-step job, or reports progress when you are not using a task list. ' +
        'The bar already follows your task list (TodoWrite / TaskCreate / TaskUpdate) on its own. Fields left out keep their value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall job, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Steps planned, only when there is no task list.' },
          done: { type: 'integer', minimum: 0, description: 'Steps finished, only when there is no task list.' },
          finished: { type: 'boolean', description: 'True once the job is over.' },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the session panel. Call it with `total` (your plan in 3-8 steps) and `done: 0` ' +
        'after reading the brief, then again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
    })
    await $.command.register({
      name: 'session-meter',
      description: 'Show or hide the session panel (cost, tokens, context, time); "texto" prints it as text, "debug" says where it is drawn',
      argumentHint: '[texto | debug]',
    })
    await refreshLedger($)

    // Ticks the clocks while something is running or the panel is up.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        const isRunning = list.some(a => a.status === 'running')
        if (!isRunning && !(await $.ui.panes()).some(p => p.id === PANE)) return
        await tick($)
      })()
    })
    return started
  }).catch(passThrough)

  // A /clear starts the session's figures over, as the engine's own do.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, tasks, () => [])
      await update($, flow, () => null)
      await update($, agents, () => [])
      await update($, main, () => null)
      await update($, other, () => null)
      await update($, panel, p => ({ ...p, isBandHidden: false }))
    }
    return next(e)
  }).catch(passThrough)

  on('command.run', { command: 'session-meter' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (/^(texto|text|txt|текст)$/.test(arg)) {
      await refreshLedger($)
      return { text: await summaryText($) }
    }
    if (arg === 'debug') {
      const at = await $.clock.now()
      const panes = await $.ui.panes()
      const lines = [
        `surfaces: ${(await $.session.surfaces()).join(', ') || '(none)'}`,
        `panes: ${panes.map(p => `${p.id} placed=${p.isPlaced} shown=${p.isShown} focused=${p.isFocused}`).join('; ') || '(none)'}`,
        `language=${lang} band=${bandMode}`,
        'draws:',
        ...([...draws].map(([k, v]) => `  ${k} ×${v.count}, ${Math.round((at - v.at) / 1000)}s ago, ${v.detail}`) || []),
      ]
      if (draws.size === 0) lines.push('  (nothing drawn since the mod loaded)')
      return { text: lines.join('\n') }
    }
    const toggled = await togglePane($)
    if (toggled.state === 'closed') return { text: tr().closed }
    if (toggled.state === 'opened') return { text: `${tr().opened} ${tr().textHint}` }
    // Never claim a pane nobody can see: say why, and show the figures here instead.
    return { text: `${tr().unplaced} (${toggled.reason})\n\n${await summaryText($)}` }
  })

  // --- the task list ---------------------------------------------------------

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if ('isError' in ran && ran.isError) return ran
    if ('deny' in ran && ran.deny !== undefined) return ran
    const todos = ((e as unknown as { todos?: TodoInput[] }).todos ?? []).filter(t => t.content?.trim())
    const list: Task[] = todos.map((t, i) => ({
      id: `todo-${i}`,
      title: (t.content ?? '').trim(),
      active: t.activeForm?.trim() || undefined,
      status: statusOf(t.status),
    }))
    const prev = await read($, tasks)
    if (prev.length === 0 || isAllDone(prev)) await newBatch($)
    await update($, tasks, () => list)
    return ran
  }).catch(passThrough)

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (('isError' in ran && ran.isError) || ('deny' in ran && ran.deny !== undefined)) return ran
    const input = e as unknown as { subject?: string; activeForm?: string; tool_use_id: string }
    const id = (ran.result as { task?: { id?: unknown } } | undefined)?.task?.id
    const task: Task = {
      id: typeof id === 'string' && id ? id : input.tool_use_id,
      title: (input.subject ?? '').trim() || '…',
      active: input.activeForm?.trim() || undefined,
      status: 'pending',
    }
    const prev = await read($, tasks)
    // A task created once every earlier one is done starts a fresh batch.
    const isFresh = prev.length === 0 || isAllDone(prev)
    if (isFresh) await newBatch($)
    await update($, tasks, list => [...(isFresh ? [] : list.filter(t => t.id !== task.id)), task])
    return ran
  }).catch(passThrough)

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (('isError' in ran && ran.isError) || ('deny' in ran && ran.deny !== undefined)) return ran
    const input = e as unknown as { taskId?: string; status?: string; subject?: string; activeForm?: string }
    if (!input.taskId) return ran
    await update($, tasks, list =>
      input.status === 'deleted'
        ? list.filter(t => t.id !== input.taskId)
        : list.map(t =>
            t.id !== input.taskId
              ? t
              : {
                  ...t,
                  title: input.subject?.trim() || t.title,
                  active: input.activeForm?.trim() || t.active,
                  status: input.status ? statusOf(input.status) : t.status,
                },
          ),
    )
    return ran
  }).catch(passThrough)

  // TaskList answers the whole list: resync from it, so a missed call heals.
  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    if (('isError' in ran && ran.isError) || ('deny' in ran && ran.deny !== undefined)) return ran
    const listed = (ran.result as { tasks?: { id?: string; subject?: string; status?: string }[] } | undefined)?.tasks
    if (Array.isArray(listed)) {
      await update($, tasks, prev =>
        listed
          .filter(t => typeof t.id === 'string')
          .map(t => ({
            id: t.id ?? '',
            title: t.subject?.trim() || '…',
            active: prev.find(p => p.id === t.id)?.active,
            status: statusOf(t.status),
          })),
      )
    }
    return ran
  }).catch(passThrough)

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const input = e as unknown as { title?: string; total?: number; done?: number; finished?: boolean }
    const prev = await read($, flow)
    const title = input.title?.trim()
    if (title && (!prev || prev.isFinished || prev.title !== title)) await update($, panel, p => ({ ...p, isBandHidden: false }))
    const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined)
    const next = await update($, flow, f => {
      const isNew = !f || f.isFinished || (title !== undefined && title !== f.title)
      const base: Flow = isNew ? { title: '', isFinished: false } : f
      return {
        title: title || base.title,
        isFinished: input.finished === true,
        total: int(input.total) ?? base.total,
        done: int(input.done) ?? base.done,
      }
    })
    const p = progressOf(await read($, tasks), next)
    return { result: p ? `ok: ${p.done}/${p.total}${p.isFinished ? ' (finished)' : ''}` : 'ok' }
  })

  // A subagent's own steps: the call runs in its loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    await update($, agents, list =>
      list.map(a => {
        if (a.id !== agentId) return a
        const total = Math.max(0, Math.round(n(input.total) || a.stepTotal || 0))
        const done = Math.max(0, Math.round(n(input.done) || 0))
        return { ...a, stepTotal: total || undefined, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: 'ok' }
  })

  // --- subagents and model requests -------------------------------------------

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !started.agentId) return started
    const at = await $.clock.now()
    const run: AgentRun = {
      ...blankMeter(started.model),
      id: started.agentId,
      type: e.fork ? 'fork' : e.subagentType,
      description: e.description,
      isBackground: e.background,
      status: 'running',
      startedAt: at,
    }
    // Running state lives on the run itself (spawn to turn.complete), so a
    // background agent counts as running until it really finishes.
    await update($, agents, list => [...list.filter(a => a.id !== run.id), run].slice(-200))
    await update($, now, () => at)
    return started
  }).catch(passThrough)

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (!usage) return result
    const model = usage.model || e.model
    const agentId = e.agentId
    if (!agentId) {
      await update($, main, m => charge(m ?? blankMeter(model), model, usage, e.effort))
    } else if ((await read($, agents)).some(a => a.id === agentId)) {
      await update($, agents, list =>
        list.map(a => (a.id !== agentId ? a : { ...charge(a, model, usage, e.effort), status: 'running', endedAt: undefined })),
      )
    } else {
      // Compaction, memory, forks the engine runs on its own: counted, not lost.
      await update($, other, m => charge(m ?? blankMeter(model), model, usage))
    }
    await refreshLedger($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map(a => {
          if (a.id !== agentId) return a
          const ended: AgentRun = { ...a, status: e.reason === 'answer' ? 'done' : 'failed', endedAt: at }
          // A run whose steps went unseen still gets the turn's own sum.
          return a.requests === 0 && e.usage ? charge(ended, e.usage.model || a.model, e.usage) : ended
        }),
      )
      await update($, now, () => at)
    }
    await refreshLedger($)
    return next(e)
  }).catch(passThrough)

  // --- drawing ---------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    noteDraw('Pane', e.surface, `placement=${e.props.placement} cols=${e.props.bodyColumns}`, await $.clock.now())
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const taskList = await read($, tasks)
    const f = await read($, flow)
    const m = await read($, main)
    const o = await read($, other)
    const l = await read($, ledger)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), l?.startedAt ?? 0)

    const meters: Meter[] = [...(m ? [m] : []), ...list, ...(o ? [o] : [])]
    const t = totalsOf(meters, l, at)
    const prog = progressOf(taskList, f)
    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()

    const toggleCompact = (
      <Button key="compact" label={p.isCompact ? s.expand : s.collapse} plain onPress={() => update($, panel, x => ({ ...x, isCompact: !x.isCompact }))} />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, x => ({ ...x, isDoneCollapsed: !x.isDoneCollapsed }))}
      />
    )
    const summary = `${fmtTotalCost(t)} · ${fmtTokens(t.tokens)} ${s.tokensWord} · ${fmtTime(t.time)}${l?.contextPercent === undefined ? '' : ` · ctx ${l.contextPercent}%`}`
    const progLine = prog ? `${s.tasks} · ${prog.isFinished ? s.done : `${prog.done}/${prog.total}`}` : s.tasks
    const taskRows = taskList.map(task => (
      <Text key={`task-${task.id}`} dimColor={task.status === 'completed'} wrap="truncate-end">
        {TASK_GLYPH[task.status]} {task.status === 'in_progress' ? task.active || task.title : task.title}
      </Text>
    ))
    const rows: Row[] = [...(m ? [mainRow(m, l, t)] : []), ...running.map(a => agentRow(a, at))]
    const doneRows = finished.map(a => agentRow(a, at))

    // The terminal's table can still answer `Svg` (drawn as nothing): go by the surface.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const draw = (row: Row) => <Svg key={row.key} source={rowSvg(W, row)} alt={`${row.title}: ${modelName(row.meter.model)}, ${fmtMeterCost(row.meter)}`} width={W} height={66} />
      return (
        <Box flexDirection="column">
          <Svg source={headerSvg(W, t, l)} alt={summary} width={W} height={44} />
          {toggleCompact}
          {!p.isCompact && <Text dimColor>{t.isEstimate ? s.costNoteEstimate : s.costNote}</Text>}
          {!p.isCompact && <Text bold>{progLine}</Text>}
          {!p.isCompact && (taskRows.length ? taskRows : <Text dimColor>{s.noTasks}</Text>)}
          {rows.map(draw)}
          {!p.isCompact && list.length === 0 && <Text dimColor>{s.noAgents}</Text>}
          {!p.isCompact && finished.length > 0 && toggleDone}
          {!p.isCompact && !p.isDoneCollapsed && doneRows.map(draw)}
          {!p.isCompact && o && <Text dimColor>{`${s.other}: ${fmtTokens(o.tokens)} tok · ${fmtMeterCost(o)}`}</Text>}
        </Box>
      )
    }

    // Terminal and the rest: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const textRow = (row: Row) => (
      <Box key={row.key} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={colorOf(row.type)}>▣</Text>
          <Text bold wrap="truncate-end">
            {row.title}
          </Text>
          <Text color={row.status === 'failed' ? 'red' : row.status === 'done' ? 'green' : colorOf(row.type)}>
            {row.status === 'done' ? '✓' : row.status === 'failed' ? '✗' : '●'}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {'  '}
          {[row.type === 'main' ? '' : row.type, ...row.meta].filter(Boolean).join(' · ')}
        </Text>
        <Text wrap="truncate-end">
          {'  '}
          {row.ratio === null ? <Text dimColor>{bar(ctxPct(row.meter) / 100, barW)}</Text> : <Text color={colorOf(row.type)}>{bar(row.ratio, barW)}</Text>}
          <Text dimColor>
            {' '}
            {row.steps ? `${row.steps} · ` : ''}ctx {ctxPct(row.meter)}% · {fmtTokens(row.meter.tokens)} tok {fmtMeterCost(row.meter)} {row.time}
          </Text>
        </Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{summary}</Text>
          {toggleCompact}
        </Box>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {prog ? `${progLine}  ` : ''}
            {list.map(a => (
              <Text key={a.id} color={colorOf(a.type)}>
                {a.status === 'running' ? '●' : a.status === 'done' ? '✓' : '✗'}{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{t.isEstimate ? s.costNoteEstimate : s.costNote}</Text>
            <Text bold>{progLine}</Text>
            {taskRows.length ? taskRows : <Text dimColor>{s.noTasks}</Text>}
            <Box marginTop={1} flexDirection="column">
              {rows.map(textRow)}
              {list.length === 0 && <Text dimColor>{s.noAgents}</Text>}
              {finished.length > 0 && toggleDone}
              {!p.isDoneCollapsed && doneRows.map(textRow)}
              {o && <Text dimColor>{`${s.other}: ${fmtTokens(o.tokens)} tok · ${fmtMeterCost(o)}`}</Text>}
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    noteDraw('AbovePrompt', e.surface, `cols=${e.props.bodyColumns}`, await $.clock.now())
    if (bandMode === 'off' || e.props.hasSurvey) return next(e)
    const p: Panel = await read($, panel)
    if (p.isBandHidden) return next(e)
    const list = await read($, agents)
    const prog = progressOf(await read($, tasks), await read($, flow))
    const workers = list.filter(a => a.status === 'running').length
    if (!prog && workers === 0 && bandMode !== 'always') return next(e)

    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const l = await read($, ledger)
    const m = await read($, main)
    const o = await read($, other)
    const t = totalsOf([...(m ? [m] : []), ...list, ...(o ? [o] : [])], l, 0)
    const cost = fmtTotalCost(t)
    const crew = (
      <Button key="crew" label={workers ? `×${workers}` : '≡'} plain onPress={() => void togglePane($)} />
    )
    const dismiss = <Button key="dismiss" label="✕" plain role="dismiss" onPress={() => update($, panel, x => ({ ...x, isBandHidden: true }))} />

    // No progress to show: one quiet line with the session's cost.
    if (!prog) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text dimColor wrap="truncate-end">
            {s.idle} · {cost} · {fmtTokens(t.tokens)} {s.tokensWord}
            {l?.contextPercent === undefined ? '' : ` · ctx ${l.contextPercent}%`}
          </Text>
          {crew}
          {dismiss}
        </Box>
      )
    }

    const percent = `${Math.round(ratioOf(prog) * 100)}%`
    const lead = prog.isFinished ? prog.title : prog.active || prog.title
    const label = prog.isFinished ? s.done : prog.total ? `${prog.done}/${prog.total}` : '…'
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the two buttons and their gaps.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={bandSvg(prog, width, `${percent} · ${cost}`, e.props.isWorking || workers > 0)} alt={`${lead}: ${label}, ${percent}, ${cost}`} width={width} height={BAND_H} />
          {crew}
          {dismiss}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const leadW = Math.max(8, Math.min(36, lead.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - leadW - 36))
    const color = prog.isFinished ? DONE : ACCENT
    return (
      <Box flexDirection="row" gap={1}>
        <Box width={leadW} flexShrink={0}>
          <Text color={color}>● </Text>
          <Text wrap="truncate-end">{lead}</Text>
        </Box>
        <Text color={color}>{bar(ratioOf(prog), width)}</Text>
        <Text bold>{label}</Text>
        <Text dimColor>
          {percent} · {cost}
        </Text>
        {crew}
        {dismiss}
      </Box>
    )
  })
}
