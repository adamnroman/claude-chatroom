import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { HttpResponse, On, RenderSurface } from 'claude-code'

import type { ChatMessage } from '../types'

export const SERVER = 'http://chat.test'
export const CLIENT_ID = 'claude-code-chatroom/0.1.0'
export const COMPOSER = { kind: 'composer' } as const
export const TURN_END = { answer: 'done', durationMs: 5, isAborted: false, turnId: 'turn-1', reason: 'answer' } as const
export const PANE_PROPS = { title: 'chat', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
export const BAND_PROPS = { hasSurvey: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} }

/** The chat server and the engine beneath the mod, held in memory. */
export type World = {
  messages: ChatMessage[]
  posts: { name: string; text: string }[]
  /** Every poll's URL, in order. */
  polls: string[]
  /** The client header of every request. */
  clients: string[]
  /** What the server answers with; 200 serves the room. */
  status: number
  error: string
  pollMs: number
  epoch: number
  /** What the mod asked of the room's pane, in order. */
  pane: string[]
  /** False where the surface places no pane. */
  placesPanes: boolean
  /** Where the session draws; empty for a headless run. */
  surfaces: RenderSurface[]
  env: Record<string, string>
  clock: MockClock
}

const reply = (status: number, body: unknown): { value: HttpResponse } => ({
  value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
})

export function fakeWorld(on: On, fields: Partial<World> = {}): World {
  const world: World = {
    messages: [],
    posts: [],
    polls: [],
    clients: [],
    status: 200,
    error: 'slow_down',
    pollMs: 2000,
    epoch: 1,
    pane: [],
    placesPanes: true,
    surfaces: ['terminal'],
    env: {},
    clock: mock.clock(on, { now: 1_000_000 }),
    ...fields,
  }
  let isPaneOpen = false

  mock.store(on)
  mock.env(on, { CHATROOM_URL: SERVER, ...world.env })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: world.surfaces }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    world.pane.push(`open ${e.id}`)
    isPaneOpen = true

    return { value: world.placesPanes ? { isPlaced: true } : { isPlaced: false, reason: 'no panes here' } }
  })
  on('ui.close', (_$, e) => {
    world.pane.push(`close ${e.id}`)
    isPaneOpen = false

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: isPaneOpen ? [{ id: 'chatroom', title: 'chat', isShown: true, isFocused: false, isPlaced: world.placesPanes }] : [],
  }))

  on('http.fetch', (_$, e) => {
    world.clients.push(e.init?.headers?.['x-chatroom-client'] ?? '')

    if (e.init?.method !== 'POST') {
      world.polls.push(e.url)
    }

    if (world.status !== 200) {
      return reply(world.status, { error: world.error })
    }

    if (e.init?.method === 'POST') {
      const { name, text } = JSON.parse(e.init.body ?? '{}') as { name: string; text: string }
      const message = { id: (world.messages.at(-1)?.id ?? 0) + 1, name, text, at: 0 }
      world.posts.push({ name, text })
      world.messages.push(message)

      return reply(200, { message })
    }

    const after = Number(new URL(e.url).searchParams.get('after'))
    const latest = world.messages.at(-1)?.id ?? 0

    return reply(200, {
      messages: world.messages.filter(message => message.id > (after > latest ? 0 : after)),
      online: 3,
      latest,
      epoch: world.epoch,
      poll_ms: world.pollMs,
    })
  })

  return world
}

export async function startTurn($: Engine, world: World): Promise<void> {
  await $.session.start({ cwd: '/work', surface: world.surfaces[0] ?? null, isInteractive: world.surfaces.length > 0 })
  await $.turn.start({ text: 'build it', turnId: 'turn-1' })
  await world.clock.settle()
}

export const mountPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'chatroom', surface, component: 'Pane', requestId: 'chatroom', props: PANE_PROPS })

export const mountBand = ($: Engine, isWorking = true) =>
  $.ui.mount({ plugin: 'chatroom', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, isWorking } })

/** The key of the input field as drawn now: it changes whenever the room swaps the field. */
export async function fieldKey(ui: { find: (query: { type: string }) => Promise<{ key: string | undefined; text: string } | undefined> }): Promise<string> {
  return (await ui.find({ type: 'Input' }))?.key ?? ''
}
