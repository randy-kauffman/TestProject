import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const scroll = { offset: 0, bodyRows: 10 }

const band = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'session-meter',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll, view: {} },
  }) as const

const pane = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'session-meter',
    surface,
    component: 'Pane',
    requestId: 'session-meter',
    props: { title: 'Session', isFocused: false, bodyColumns: 60, placement: 'dock', scroll, view: {} },
  }) as const

// The engine beneath the plugin: the task tools and the spawn answer as a session's would.
const engine = (on: On) => {
  mock.clock(on, { now: 1_000_000 })
  // The engine's own drawing beneath the plugin, for when it passes.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  let next = 0
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => ({ result: { task: { id: String(++next), subject: String((e as { subject?: string }).subject) } } }))
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({ result: { success: true, taskId: String((e as { taskId?: string }).taskId), updatedFields: [] } }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: '' }))
}

const spawn = (subagentType: string, description: string, background: boolean) => ({
  tool_use_id: 'toolu_1',
  prompt: description,
  description,
  subagentType,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background,
  fork: false,
})

const todos = (statuses: ('pending' | 'in_progress' | 'completed')[]) =>
  statuses.map((status, i) => ({ content: `Task ${i + 1}`, activeForm: `Doing task ${i + 1}`, status }))

// The band's text: Text children on the terminal, the Svg's alt on the desktop.
async function bandText($: Engine, surface: (typeof SURFACES)[number]): Promise<string | null> {
  const ui = await $.ui.mount(band(surface))
  const found = await ui.findAll({})
  await ui.unmount()
  if (!found.some(el => el.key === 'dismiss')) return null
  return found.map(el => (el.type === 'Svg' ? String(el.props.alt) : el.text)).join(' ')
}

describe('progress bar', () => {
  test('stays out of the way with no task list and no subagents', async ($, on) => {
    engine(on)
    for (const surface of SURFACES) expect(await bandText($, surface)).toBe(null)
  })

  test('follows TodoWrite on every surface', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'TodoWrite', todos: todos(['completed', 'in_progress', 'pending']) })
    for (const surface of SURFACES) {
      const text = await bandText($, surface)
      expect(text).toContain('1/3')
      expect(text).toContain('Doing task 2')
    }
  })

  test('follows TaskCreate and TaskUpdate by id, deletions included', async ($, on) => {
    engine(on)
    for (const subject of ['A', 'B', 'C']) await $.tool.call({ tool: 'TaskCreate', subject, description: subject, activeForm: `Working ${subject}` })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'deleted' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
    for (const surface of SURFACES) {
      const text = await bandText($, surface)
      expect(text).toContain('1/2')
      expect(text).toContain('Working B')
    }
  })

  test('a dismissed bar comes back with the next batch', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'TodoWrite', todos: todos(['completed', 'completed']) })
    const ui = await $.ui.mount(band('terminal'))
    await ui.press({ key: 'dismiss' })
    await ui.unmount()
    expect(await bandText($, 'terminal')).toBe(null)
    await $.tool.call({ tool: 'TodoWrite', todos: todos(['in_progress', 'pending']) })
    expect(await bandText($, 'terminal')).toContain('0/2')
  })

  test('the progress tool names the job and finishes it', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'mcp__session-meter__progress', title: 'Migración', total: 4, done: 1 })
    expect(await bandText($, 'terminal')).toContain('1/4')
    await $.tool.call({ tool: 'mcp__session-meter__progress', finished: true })
    for (const surface of SURFACES) expect(await bandText($, surface)).toContain('Migración')
  })

  test('off hides it whatever happens', { options: { band: 'off' } }, async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'TodoWrite', todos: todos(['in_progress']) })
    expect(await bandText($, 'terminal')).toBe(null)
  })
})

describe('session panel', () => {
  test('a subagent is running until its own turn completes, background or not', async ($, on) => {
    engine(on)
    await $.agent.spawn(spawn('Explore', 'Scan the repo', true))
    expect(await bandText($, 'terminal')).toContain('×1')
    await $.turn.complete({
      agentId: 'agent-1',
      reason: 'answer',
      answer: 'done',
      durationMs: 1000,
      isAborted: false,
      turnId: 't1',
      // A partial usage must not turn into NaN.
      usage: { model: 'claude-haiku-5-5', input_tokens: 1_000_000, output_tokens: 0 } as never,
    })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      const all = (await ui.findAll({})).map(el => (el.type === 'Svg' ? String(el.props.alt) : el.text)).join(' ')
      await ui.unmount()
      expect(all).toContain('Scan the repo')
      expect(all).toContain('≈$0.10')
      expect(all).not.toContain('NaN')
    }
  })

  test('price overrides win over the built-in table', { options: { prices: 'haiku-5-5=2/0/0/0' } }, async ($, on) => {
    engine(on)
    await $.agent.spawn(spawn('Explore', 'Scan', false))
    await $.turn.complete({
      agentId: 'agent-1',
      reason: 'answer',
      answer: '',
      durationMs: 1,
      isAborted: false,
      turnId: 't1',
      usage: { model: 'claude-haiku-5-5', input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.findAll({})).map(el => el.text).join(' ')).toContain('≈$2.00')
    await ui.unmount()
  })

  test('counts the main loop and engine-run requests apart', async ($, on) => {
    engine(on)
    const usage = { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { ...usage, model: e.model } }
    })
    const step = (agentId?: string) => ({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high' as const, messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of $.turn.step(step())) void _
    for await (const _ of $.turn.step(step('compaction-fork'))) void _
    const ui = await $.ui.mount(pane('terminal'))
    const text = (await ui.findAll({})).map(el => el.text).join(' ')
    await ui.unmount()
    // Opus 5.5 at 4/20: 0.4 + 0.2 for each of the two requests.
    expect(text).toContain('Opus 5.5 · high')
    expect(text).toContain('≈$0.60')
    expect(text).toMatch(/Other \(compaction, forks\): 110k tok · ≈\$0\.60/)
  })

  test('says so, with the figures as text, when no surface places the pane', { options: { language: 'es' } }, async ($, on) => {
    engine(on)
    on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'no surface places panes' } }))
    on('ui.panes', () => ({ value: [{ id: 'session-meter', title: 'Sesión', isShown: false, isFocused: false, isPlaced: false }] }))
    await $.tool.call({ tool: 'TodoWrite', todos: todos(['completed', 'in_progress']) })
    const run = { command: 'session-meter', args: '', origin: { kind: 'human' }, presentation: { isFullscreen: false, columns: 100 } } as never
    // Run twice: an undrawn pane is reopened, never toggled closed unseen.
    for (let i = 0; i < 2; i++) {
      const { text } = (await $.command.run(run)) as { text: string }
      expect(text).toContain('no muestra el panel')
      expect(text).toContain('no surface places panes')
      expect(text).toContain('Tareas · 1/2')
      expect(text).toContain('● Doing task 2')
    }
  })

  test('texto prints the panel and debug says where it was drawn', async ($, on) => {
    engine(on)
    on('ui.panes', () => ({ value: [] }))
    on('session.surfaces', () => ({ value: ['desktop' as const] }))
    await $.tool.call({ tool: 'TodoWrite', todos: todos(['in_progress']) })
    const ui = await $.ui.mount(pane('desktop'))
    await ui.unmount()
    const run = (args: string) => ({ command: 'session-meter', args, origin: { kind: 'human' }, presentation: { isFullscreen: false, columns: 100 } }) as never
    expect(((await $.command.run(run('texto'))) as { text: string }).text).toContain('Tasks · 0/1')
    expect(((await $.command.run(run('debug'))) as { text: string }).text).toContain('Pane@desktop ×1')
  })

  test('speaks Spanish', { options: { language: 'es' } }, async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      const text = (await ui.findAll({ type: 'Text' })).map(el => el.text).join(' ')
      await ui.unmount()
      expect(text).toContain('Sin lista de tareas todavía.')
      expect(text).toContain('Sin subagentes todavía.')
    }
  })
})
