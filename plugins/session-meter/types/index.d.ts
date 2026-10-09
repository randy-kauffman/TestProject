export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** One entry of the model's own task list (TodoWrite or TaskCreate/TaskUpdate). */
export type Task = {
  id: string
  title: string
  active?: string
  status: TaskStatus
}

/** What the optional `progress` tool set: a title, a finish, counts without a task list. */
export type Flow = {
  title: string
  isFinished: boolean
  total?: number
  done?: number
}

/** Tokens and an estimated cost; `isPriced` false when a model had no price. */
export type Meter = {
  model: string
  effort?: string
  tokens: number
  costUsd: number
  isPriced: boolean
  contextTokens: number
  contextMax: number
  requests: number
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = Meter & {
  id: string
  type: string
  description: string
  isBackground: boolean
  status: AgentStatus
  startedAt: number
  endedAt?: number
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

/** The engine's own figures, as the status line and /cost have them. */
export type Ledger = {
  startedAt: number
  costUsd?: number
  contextPercent?: number
  contextWindow?: number
}

export type Panel = { isCompact: boolean; isDoneCollapsed: boolean; isBandHidden: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-meter': {
      tasks: Task[]
      flow: Flow | null
      agents: AgentRun[]
      main: Meter | null
      other: Meter | null
      ledger: Ledger | null
      panel: Panel
      now: number
    }
  }
}
