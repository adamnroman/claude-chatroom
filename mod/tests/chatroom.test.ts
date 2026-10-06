import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { clampPoll, parseRoom, pollDelay, wrapLines } from '../hooks/chat'
import { CLIENT_ID, COMPOSER, TURN_END, fakeWorld, fieldKey, mountBand, mountPane, startTurn } from './support'

const chat = ($: Engine, args: string) =>
  $.command.run({ command: 'chat', args, origin: COMPOSER, presentation: { isFullscreen: false, columns: 120 } })

describe('when the room shows', () => {
  test('opens when a turn starts and closes when Claude waits for input', async ($, on) => {
    const world = fakeWorld(on)

    await startTurn($, world)
    await $.turn.complete(TURN_END)

    expect(world.pane).toEqual(['open chatroom', 'close chatroom'])
    expect(world.clients[0]).toBe(CLIENT_ID)
  })

  test('a headless run opens nothing, asks nothing and counts nobody', async ($, on) => {
    const world = fakeWorld(on, { surfaces: [] })

    await startTurn($, world)
    await world.clock.advance(60_000)

    expect(world.pane).toEqual([])
    expect(world.polls).toEqual([])
  })

  test('stops asking once the turn ends', async ($, on) => {
    const world = fakeWorld(on)
    await startTurn($, world)
    await $.turn.complete(TURN_END)
    const asked = world.polls.length

    await world.clock.advance(60_000)

    expect(world.polls.length).toBe(asked)
  })
})

describe('the room in its pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: shows who is here and what was said`, async ($, on) => {
      const world = fakeWorld(on, { messages: [{ id: 1, name: 'ada', text: 'hello room', at: 0 }] })
      await startTurn($, world)

      const ui = await mountPane($, surface)

      expect(await ui.find({ type: 'Text', text: 'ada' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /hello room/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /3 here/ })).toBeDefined()
      await ui.unmount()
    })

    test(`${surface}: Enter says it in the room`, async ($, on) => {
      const world = fakeWorld(on)
      await startTurn($, world)
      const ui = await mountPane($, surface)

      await ui.input({ key: await fieldKey(ui), text: 'hi  there' })

      expect(world.posts).toEqual([{ name: expect.stringMatching(/^anon-[0-9a-f]{4}$/), text: 'hi there' }])
      expect(await ui.find({ type: 'Text', text: /hi there/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test('escape sequences, zero-width characters and stacked marks never reach the terminal', async ($, on) => {
    const world = fakeWorld(on, {
      messages: [{ id: 1, name: 'x\u001b[31m', text: 'clip\u001b]52;c;ZXZpbA==\u0007board a\u200bb e\u0301\u0301\u0301\u0301 \u202eevil', at: 0 }],
    })
    await startTurn($, world)

    const ui = await mountPane($)
    const drawn = JSON.stringify(await ui.drawn())

    expect(drawn).not.toMatch(/\\u001b|\\u0007|\u200b|\u202e/i)
    expect(await ui.find({ type: 'Text', text: /clip\]52;c;ZXZpbA==board ab e\u0301\u0301 evil/ })).toBeDefined()
    await ui.unmount()
  })

  test('CHATROOM_NAME makes this session its own person', async ($, on) => {
    const world = fakeWorld(on, { env: { CHATROOM_NAME: 'bob' } })
    await startTurn($, world)
    const ui = await mountPane($)

    await ui.input({ key: await fieldKey(ui), text: 'hello' })

    expect(world.posts).toEqual([{ name: 'bob', text: 'hello' }])
    await ui.unmount()
  })
})

describe('typing a long message', () => {
  // 34 characters fit beside the send label in a 44-column pane.
  const LONG = 'the quick brown fox jumps over the lazy dog and keeps running'

  test('wraps onto rows of its own and is sent whole', async ($, on) => {
    const world = fakeWorld(on)
    await startTurn($, world)
    const typed = await mountPane($)
    const firstKey = await fieldKey(typed)

    await typed.input({ key: firstKey, text: LONG, kind: 'change' })
    await typed.unmount()
    const wrapped = await mountPane($)

    expect(await wrapped.find({ type: 'Text', text: 'the quick brown fox jumps over' })).toBeDefined()
    expect((await wrapped.find({ type: 'Input' }))?.text).toBe('the lazy dog and keeps running')
    expect(await fieldKey(wrapped)).not.toBe(firstKey)

    await wrapped.input({ key: await fieldKey(wrapped), text: 'the lazy dog and keeps running!' })

    expect(world.posts.at(-1)?.text).toBe(`${LONG}!`)
    await wrapped.unmount()

    // The next message starts in a field of its own, with nothing left over.
    const next = await mountPane($)
    expect((await next.find({ type: 'Input' }))?.text).toBe('')
    expect(await fieldKey(next)).not.toBe(firstKey)
    await next.unmount()
  })

  test('emptying the field goes back to the line before, even when that line is full', async ($, on) => {
    const world = fakeWorld(on)
    await startTurn($, world)
    const typed = await mountPane($)

    // The first line fills the field exactly.
    await typed.input({ key: await fieldKey(typed), text: `${'a'.repeat(33)} second`, kind: 'change' })
    await typed.unmount()
    const wrapped = await mountPane($)
    expect((await wrapped.find({ type: 'Input' }))?.text).toBe('second')

    await wrapped.input({ key: await fieldKey(wrapped), text: '', kind: 'change' })
    await wrapped.unmount()
    const back = await mountPane($)

    expect((await back.find({ type: 'Input' }))?.text).toBe(`${'a'.repeat(33)} `)
    await back.unmount()
  })

  test('a refused message says why and goes back in the field', async ($, on) => {
    const world = fakeWorld(on)
    await startTurn($, world)
    const ui = await mountPane($)
    world.status = 429

    await ui.input({ key: await fieldKey(ui), text: 'too fast' })
    await ui.unmount()
    const after = await mountPane($)

    expect(await after.find({ type: 'Text', text: /Slow down/ })).toBeDefined()
    expect((await after.find({ type: 'Input' }))?.text).toBe('too fast')

    // The reason outlives the next good poll for a few seconds.
    world.status = 200
    await world.clock.advance(2_000)
    await after.unmount()
    const later = await mountPane($)
    expect(await later.find({ type: 'Text', text: /Slow down/ })).toBeDefined()
    await later.unmount()
  })

  test('every wrap keeps the text whole, fits the width, and shrinks when its last line goes', () => {
    const words = ['a', 'to', 'the', 'quick', 'jumping', 'x'.repeat(12), 'y'.repeat(40)]
    let seed = 7
    const pick = (count: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % count

    for (let round = 0; round < 2000; round++) {
      const width = 5 + pick(40)
      const text = Array.from({ length: 1 + pick(14) }, () => words[pick(words.length)]).join(pick(5) === 0 ? '  ' : ' ')
      const lines = wrapLines(text, width)

      expect(lines.join('')).toBe(text)
      expect(lines.every(line => line.length <= width)).toBe(true)

      if (lines.length > 1) {
        expect(lines.at(-1)).not.toBe('')
        expect(wrapLines(lines.slice(0, -1).join(''), width).length).toBe(lines.length - 1)
      }
    }
  })
})

describe('the server holds the brakes', () => {
  test('asks again at the pace the server names', async ($, on) => {
    const world = fakeWorld(on, { pollMs: 60_000 })
    await startTurn($, world)
    expect(world.polls.length).toBe(1)

    await world.clock.advance(30_000)
    expect(world.polls.length).toBe(1)

    await world.clock.advance(30_000)
    expect(world.polls.length).toBe(2)
  })

  test('waits longer after each failure in a row', async ($, on) => {
    const world = fakeWorld(on, { status: 500 })
    await startTurn($, world)

    // 4 s, then 8 s, then 16 s after the first failure: three more in 28 s, where a fixed pace would make fourteen.
    await world.clock.advance(28_000)

    expect(world.polls.length).toBe(4)
  })

  test('a closed room stops this session: no more requests, no pane next turn', async ($, on) => {
    const world = fakeWorld(on, { status: 503, error: 'closed' })
    await startTurn($, world)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /closed/ })).toBeDefined()
    await ui.unmount()
    await $.turn.complete(TURN_END)

    await $.turn.start({ text: 'again', turnId: 'turn-2' })
    await world.clock.advance(60_000)

    expect(world.polls.length).toBe(1)
    expect(world.pane).toEqual(['open chatroom', 'close chatroom'])
  })

  test('a copy the server calls too old stops and says to update', async ($, on) => {
    const world = fakeWorld(on, { status: 426, error: 'upgrade_required' })
    await startTurn($, world)
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Text', text: /Update the chatroom plugin/ })).toBeDefined()
    await ui.unmount()
    await world.clock.advance(60_000)
    expect(world.polls.length).toBe(1)
  })

  test('drops what it holds when the server removed history', async ($, on) => {
    const world = fakeWorld(on, {
      messages: [
        { id: 1, name: 'ada', text: 'keep me', at: 0 },
        { id: 2, name: 'eve', text: 'remove me', at: 0 },
      ],
    })
    await startTurn($, world)

    world.messages = [{ id: 1, name: 'ada', text: 'keep me', at: 0 }]
    world.epoch = 2
    await world.clock.advance(2_000)
    const ui = await mountPane($)

    expect(await ui.find({ type: 'Text', text: /keep me/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /remove me/ })).toBeUndefined()
    await ui.unmount()
  })

  test('nothing the server says is used as it came', () => {
    const room = parseRoom(
      JSON.stringify({ messages: [{ id: 2.5, name: 'a', text: 'x' }, { id: -1, text: 'y' }, { id: 7, text: 'ok' }], online: -4, poll_ms: 5, epoch: 'x' }),
    )

    expect(room.messages.map(message => message.id)).toEqual([7])
    expect(room.online).toBe(0)
    expect(room.pollMs).toBe(2000)
    expect(clampPoll(9_999_999)).toBe(300_000)
    expect(pollDelay(2000, 0)).toBe(2000)
    expect(pollDelay(2000, 30)).toBe(60_000)
  })
})

describe('the band, where no pane is placed', () => {
  test('hidden while Claude waits for input', async ($, on) => {
    const world = fakeWorld(on, { placesPanes: false })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    const ui = await mountBand($, false)

    expect(await ui.find({ text: /here/ })).toBeUndefined()
    expect(world.polls).toEqual([])
    await ui.unmount()
  })

  test('shows the room while Claude works', async ($, on) => {
    const world = fakeWorld(on, { placesPanes: false, messages: [{ id: 1, name: 'ada', text: 'hello room', at: 0 }] })
    await startTurn($, world)

    const ui = await mountBand($)

    expect(await ui.find({ type: 'Text', text: /hello room/ })).toBeDefined()
    await ui.unmount()
  })

  test('stays out of the way where the pane is placed', async ($, on) => {
    const world = fakeWorld(on)
    await startTurn($, world)

    const ui = await mountBand($)

    expect(await ui.find({ text: /here/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('/chat', () => {
  test('sets a name, sends with it, and never prints the room', async ($, on) => {
    const world = fakeWorld(on, { messages: [{ id: 1, name: 'ada', text: 'secret plans', at: 0 }] })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    const named = await chat($, 'name grace!')
    const sent = await chat($, 'morning all')

    expect(named.text).toBe('You are grace in the chat.')
    expect(sent.text).toBe('Sent.')
    expect(world.posts).toEqual([{ name: 'grace', text: 'morning all' }])
    expect(`${named.text}${sent.text}`).not.toContain('secret plans')
  })

  test('a sentence that starts with "name" is a message, not a rename', async ($, on) => {
    const world = fakeWorld(on, { env: { CHATROOM_NAME: 'ada' } })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    await chat($, 'name one thing you like about rust')

    expect(world.posts).toEqual([{ name: 'ada', text: 'name one thing you like about rust' }])
  })

  test('off hides the room for the session, on brings it back', async ($, on) => {
    const world = fakeWorld(on)
    await startTurn($, world)

    await chat($, 'off')
    const asked = world.polls.length
    await world.clock.advance(10_000)
    await $.turn.complete(TURN_END)
    await $.turn.start({ text: 'again', turnId: 'turn-2' })
    await world.clock.settle()

    expect(world.polls.length).toBe(asked)
    expect(world.pane.filter(step => step.startsWith('open'))).toEqual(['open chatroom'])

    await chat($, 'on')
    await world.clock.settle()

    expect(world.pane.at(-1)).toBe('open chatroom')
    expect(world.polls.length).toBe(asked + 1)
  })
})
