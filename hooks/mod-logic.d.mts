// Types for mod-logic.mjs.

export type Model = 'sonnet' | 'opus' | 'haiku' | 'fable'
export type Runtime = { port: number; token: string; pid?: number }
export type Family = { name: string; pattern: string; model: string | null }
export type Routing = { enabled: boolean; families: Family[] }
export type AgentInput = { model?: string; subagent_type?: string; description?: string }
export type MeasureInput = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd?: number }
  context: { percent?: number }
}

export const MODELS: readonly Model[]
export const BUILTIN_AGENTS: readonly string[]
export function isModel(m: unknown): m is Model
export function parseRuntime(text: string): Runtime | null
export function parseRouting(text: string): Routing | null
export function chooseModel(routing: Routing | null, input: AgentInput): { family: string; model: Model } | null
export function statusEvent(e: MeasureInput): Record<string, unknown>
export function inboxMessage(status: number, text: string): { submit: string; fromId?: string } | null
