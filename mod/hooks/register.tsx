/**
 * chatroom: one shared, public, unmoderated chat room for everyone with this mod.
 *
 * The room opens in a pane while Claude works and closes when Claude waits for
 * you: docked on the right of the transcript in the fullscreen layout, above
 * the prompt otherwise. ctrl+x tab focuses it to type; Esc goes back.
 * `/chat <message>` sends from the prompt, `/chat name <handle>` sets your name,
 * `/chat off` hides the room for the session.
 *
 * Nothing from the room reaches the model: messages are drawn in the pane only,
 * never written to the transcript.
 */
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement, RenderSurface, Timer } from 'claude-code'

import type { ChatMessage } from '../types'
import {
  BAND_CHROME_COLUMNS,
  BAND_CHROME_ROWS,
  BAND_MAX_ROWS,
  CLIENT_HEADER,
  CLIENT_ID,
  cleanName,
  cleanText,
  colorFor,
  CURSOR_COLUMNS,
  DEFAULT_POLL_MS,
  DEFAULT_SERVER,
  DOCK_COLUMNS,
  fitMessages,
  HEADER_ROWS,
  INLINE_ROWS,
  INPUT_LABEL_COLUMNS,
  mergeMessages,
  noticeFor,
  PANE_CHROME_COLUMNS,
  PANE_ID,
  PANE_TITLE,
  parseMessages,
  parseRoom,
  pollDelay,
  randomHex,
  ROOM_PADDING_X,
  SEND_NOTICE_MS,
  STOP_STATUSES,
  STUCK_POLL_MS,
  SUBMIT_LABEL,
  wrapLines,
} from './chat'

type Room = {
  messages: readonly ChatMessage[]
  online: number
  notice: string | null
  /** Rows for the whole room: the header, the messages and the input. */
  rows: number
  columns: number
  /** The band draws its own frame; the engine frames a pane. */
  hasFrame: boolean
  /** Says it in the room; resolves the problem to show, or null once it is sent. */
  onSubmit: (text: string) => Promise<string | null>
  /** The input needs more or fewer rows than it has: draw again. */
  onResize: () => void
}

const COMMAND = 'chat'
const INPUT_KEY = 'say'
const STORE_NAME = 'name'
const STORE_CLIENT = 'client'
const UNREACHABLE = 'Chat server unreachable.'
const NAME_RULES = 'Names use letters, digits, _ . and - (up to 20).'
const TYPE_HINT = 'ctrl+x tab to type'
// Field keys never repeat, also across a reload of this module.
const FIELD_SEED = randomHex(3)

const messagesAtom = atom({ plugin: 'chatroom', key: 'messages' } as const, [])
const onlineAtom = atom({ plugin: 'chatroom', key: 'online' } as const, 0)
const nameAtom = atom({ plugin: 'chatroom', key: 'name' } as const, null)
const noticeAtom = atom({ plugin: 'chatroom', key: 'notice' } as const, null)

// A turn is running on a surface someone can see.
let isTurnRunning = false
// The room is on screen for that turn, and polls.
let isShowing = false
// The person hid the room: it stays away until they run /chat.
let isDismissed = false
// The server ended the room for this session: closed, gone, or this copy is too old.
let isRoomOff = false
// The pace the server asked for, and how many requests in a row have failed.
let pollMs = DEFAULT_POLL_MS
let failures = 0
// When the request in flight began; 0 with none in flight.
let pollStartedAt = 0
let pollTimer: Timer | null = null
// The server's history marker. A change means messages were removed.
let roomEpoch: number | null = null
// A refused send keeps its reason on screen until then.
let noticeHeldUntil = 0
// What the person has typed so far. A redraw for a new message must not wipe it.
let draft = ''
// Names the input field. The engine remembers a field's own text by its key, so
// each time the room must put other text in the field it draws a new one.
let fieldEpoch = 0
// How much of the draft sat in front of the field when it was last drawn.
let fieldSplit = 0

/** Runs work nobody awaits. A session that ends mid-request is not an error. */
function detached(work: Promise<unknown>): void {
  work.catch(() => {})
}

async function serverUrl($: EngineInterface): Promise<string> {
  return ((await $.env.get('CHATROOM_URL')) || DEFAULT_SERVER).replace(/\/+$/, '')
}

/**
 * Who this session is in the room. The handle is the session's own, so two
 * sessions on one machine can be two people: CHATROOM_NAME or `/chat name`
 * sets it, else the machine's last handle, else a new `anon-xxxx`.
 */
async function identity($: EngineInterface): Promise<{ name: string; client: string }> {
  let name = await read($, nameAtom)

  if (!name) {
    const stored = cleanName(await $.store.get(STORE_NAME))
    const chosen = cleanName(await $.env.get('CHATROOM_NAME')) || stored || `anon-${randomHex(2)}`
    name = chosen
    await update($, nameAtom, () => chosen)

    if (!stored) {
      await $.store.set(STORE_NAME, chosen)
    }
  }

  let machine = await $.store.get(STORE_CLIENT)

  if (typeof machine !== 'string' || !machine) {
    machine = randomHex(8)
    await $.store.set(STORE_CLIENT, machine)
  }

  // One person with several sessions counts once in "N here"; two handles count twice.
  return { name, client: `${String(machine)}-${name}` }
}

/** Shows `notice` in the room. A held one stays until its time is up, whatever the next poll says. */
async function showNotice($: EngineInterface, notice: string | null, isHeld = false): Promise<void> {
  const now = await $.clock.now()

  if (isHeld) {
    noticeHeldUntil = now + SEND_NOTICE_MS
  } else if (notice === null && now < noticeHeldUntil) {
    return
  }

  if ((await read($, noticeAtom)) !== notice) {
    await update($, noticeAtom, () => notice)
  }
}

/** Asks the room for news once. Resolves true when it should be asked again at once. */
async function poll($: EngineInterface, server: string): Promise<boolean> {
  const now = await $.clock.now()

  if (pollStartedAt !== 0 && now - pollStartedAt < STUCK_POLL_MS) {
    return false
  }

  pollStartedAt = now

  try {
    const { client } = await identity($)
    const after = (await read($, messagesAtom)).at(-1)?.id ?? 0
    const response = await $.http.fetch(`${server}/messages?after=${after}&client=${client}`, {
      headers: { [CLIENT_HEADER]: CLIENT_ID },
    })

    if (!response.ok) {
      failures++

      if (STOP_STATUSES.includes(response.status)) {
        isRoomOff = true
      }

      await showNotice($, noticeFor(response.status, response.text))

      return false
    }

    const room = parseRoom(response.text)
    const isHistoryChanged = (roomEpoch !== null && room.epoch !== roomEpoch) || room.latest < after
    failures = 0
    pollMs = room.pollMs
    roomEpoch = room.epoch

    if (isHistoryChanged) {
      // The server removed messages: drop what is held and ask for the room afresh.
      await update($, messagesAtom, () => [])
    } else if (room.messages.length > 0) {
      await update($, messagesAtom, current => mergeMessages(current, room.messages))
    }

    if (room.online !== (await read($, onlineAtom))) {
      await update($, onlineAtom, () => room.online)
    }

    await showNotice($, null)

    return isHistoryChanged
  } catch {
    failures++
    await showNotice($, UNREACHABLE)

    return false
  } finally {
    pollStartedAt = 0
  }
}

/** Asks the room for news now, then again at the server's pace for as long as the room shows. */
async function pollWhileShowing($: EngineInterface, server: string): Promise<void> {
  pollTimer?.cancel()
  pollTimer = null

  if (!isShowing || isRoomOff) {
    return
  }

  const isAskingAgainNow = await poll($, server)

  if (isShowing && !isRoomOff) {
    pollTimer = $.clock.after(isAskingAgainNow ? 0 : pollDelay(pollMs, failures), () => detached(pollWhileShowing($, server)))
  }
}

/** Says `raw` in the room; resolves the problem to show, or null once it is sent. */
async function send($: EngineInterface, server: string, raw: string): Promise<string | null> {
  const text = cleanText(raw)

  if (!text) {
    return 'Nothing to send.'
  }

  if (isRoomOff) {
    return 'The chat room is closed.'
  }

  const { name } = await identity($)
  let notice: string | null = null

  try {
    const response = await $.http.fetch(`${server}/messages`, {
      method: 'POST',
      headers: { [CLIENT_HEADER]: CLIENT_ID, 'content-type': 'application/json' },
      body: JSON.stringify({ name, text }),
    })

    if (response.ok) {
      const sent = parseMessages([(JSON.parse(response.text) as { message?: unknown }).message])
      await update($, messagesAtom, current => mergeMessages(current, sent))
    } else {
      if (STOP_STATUSES.includes(response.status)) {
        isRoomOff = true
      }

      notice = noticeFor(response.status, response.text)
    }
  } catch {
    notice = UNREACHABLE
  }

  await showNotice($, notice, notice !== null)

  return notice
}

/** Shows the room for the running turn: opens its pane and starts asking for news. */
async function showRoom($: EngineInterface): Promise<void> {
  isShowing = true

  try {
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, columns: DOCK_COLUMNS, rows: INLINE_ROWS })
  } catch {
    // No pane here: the band above the prompt draws the room.
  }

  $.ui.invalidate('ui.render')
  detached(pollWhileShowing($, await serverUrl($)))
}

async function hideRoom($: EngineInterface): Promise<void> {
  isShowing = false
  pollTimer?.cancel()
  pollTimer = null
  await $.ui.close({ id: PANE_ID })
}

/** The room: who is here, the newest messages bottom-up, and the line to type in. */
function drawRoom(kit: Elements[RenderSurface], room: Room): RenderElement {
  const { Box, Text } = kit
  // The engine's field is one line and cuts what does not fit. So the draft is
  // wrapped here: its earlier lines are drawn as text, the field holds the last
  // one, and the messages give up a row for each line.
  const fieldColumns = room.columns - INPUT_LABEL_COLUMNS - CURSOR_COLUMNS
  const lines = wrapLines(draft, fieldColumns)
  const inputRows = Math.min(lines.length, Math.max(1, room.rows - HEADER_ROWS - 1))
  const messageRows = Math.max(1, room.rows - HEADER_ROWS - inputRows)
  const fieldText = lines.at(-1) ?? ''
  // What the field does not hold: this drawing's handlers put it back in front of what is typed.
  const typedBefore = draft.slice(0, draft.length - fieldText.length)
  const earlierLines = inputRows > 1 ? lines.slice(0, -1).slice(1 - inputRows) : []

  // The break moved (more typing, or the room changed width): the field's text is another, so the field is too.
  if (typedBefore.length !== fieldSplit) {
    fieldSplit = typedBefore.length
    fieldEpoch++
  }

  const epochDrawn = fieldEpoch
  const shown = fitMessages(room.messages, messageRows, room.columns)
  const frame = room.hasFrame ? ({ borderStyle: 'round', borderDimColor: true } as const) : {}

  return (
    <Box flexDirection="column" height={room.rows + (room.hasFrame ? BAND_CHROME_ROWS : 0)} paddingX={ROOM_PADDING_X} {...frame}>
      <Box>
        <Text dimColor>{String(room.online)} here · </Text>
        {room.notice ? <Text color="red">{room.notice}</Text> : <Text dimColor>{TYPE_HINT}</Text>}
      </Box>
      <Box flexDirection="column" height={messageRows} justifyContent="flex-end" overflow="hidden">
        {shown.length === 0 && <Text dimColor>No messages yet. Say hi.</Text>}
        {shown.map(message => (
          <Text wrap="wrap">
            <Text color={colorFor(message.name)} bold>
              {message.name}
            </Text>{' '}
            {message.text}
          </Text>
        ))}
      </Box>
      {earlierLines.map(line => (
        <Text wrap="truncate-end">{line}</Text>
      ))}
      {'Input' in kit && (
        <kit.Input
          key={`${INPUT_KEY}-${FIELD_SEED}-${epochDrawn}`}
          autoFocus
          placeholder="say something"
          value={fieldText}
          submitLabel={SUBMIT_LABEL}
          onInput={value => {
            draft = typedBefore + value
            const isStaleField = epochDrawn !== fieldEpoch

            // A key typed into a field that has since been replaced needs a fresh field to show it.
            if (isStaleField) {
              fieldEpoch++
            }

            if (isStaleField || wrapLines(draft, fieldColumns).length !== lines.length) {
              room.onResize()
            }
          }}
          onSubmit={value => {
            const text = typedBefore + value
            draft = ''
            fieldEpoch++
            room.onResize()
            detached(
              room.onSubmit(text).then(problem => {
                // A refused message goes back in the field, unless the person has typed since.
                if (problem !== null && draft === '') {
                  draft = text
                  fieldEpoch++
                  room.onResize()
                }
              }),
            )
          }}
        />
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    try {
      await $.command.register({
        name: COMMAND,
        description: 'Chat room: /chat <message> to say something, /chat name <handle>, /chat off',
        argumentHint: '<message> | name <handle> | off',
        immediate: true,
      })
    } catch {
      // Another /chat is taken: the room still works from its pane.
    }

    return started
  })

  on('turn.start', async ($, e, next) => {
    // A headless run (claude -p, CI) draws nowhere: no room, no requests, nobody counted as here.
    isTurnRunning = (await $.session.surfaces()).length > 0

    if (isTurnRunning && !isDismissed && !isRoomOff) {
      await showRoom($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      isTurnRunning = false
      await hideRoom($)
    }

    return next(e)
  })

  on('ui.close', { id: PANE_ID }, ($, e, next) => {
    if (e.origin.kind === 'person') {
      isDismissed = true
      isShowing = false
      pollTimer?.cancel()
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const server = await serverUrl($)

    return drawRoom($.ui.resolve(e), {
      messages: await read($, messagesAtom),
      online: await read($, onlineAtom),
      notice: await read($, noticeAtom),
      rows: e.props.scroll.bodyRows,
      columns: Math.max(10, e.props.bodyColumns - PANE_CHROME_COLUMNS),
      hasFrame: false,
      onSubmit: text => send($, server, text),
      onResize: () => $.ui.invalidate('ui.render'),
    })
  })

  // Where the surface places no pane, the room draws in the band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isShowing || !e.props.isWorking || e.props.hasSurvey) {
      return next(e)
    }

    if ((await $.ui.panes()).some(pane => pane.id === PANE_ID && pane.isPlaced)) {
      return next(e)
    }

    const server = await serverUrl($)

    return drawRoom($.ui.resolve(e), {
      messages: await read($, messagesAtom),
      online: await read($, onlineAtom),
      notice: await read($, noticeAtom),
      rows: Math.min(e.props.maxRows, BAND_MAX_ROWS) - BAND_CHROME_ROWS,
      columns: Math.max(10, e.props.bodyColumns - BAND_CHROME_COLUMNS),
      hasFrame: true,
      onSubmit: text => send($, server, text),
      onResize: () => $.ui.invalidate('ui.render'),
    })
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim()
    const words = args.split(/\s+/)
    const [first = '', second = ''] = words

    if (!args || args === 'on') {
      const { name } = await identity($)
      isDismissed = false

      if (isTurnRunning && !isRoomOff) {
        await showRoom($)
      }

      return {
        text: `You are ${name}. The room shows while Claude works: ${TYPE_HINT}, or /chat <message>. /chat name <handle> changes your name, /chat off hides the room.`,
      }
    }

    if (args === 'off') {
      isDismissed = true
      await hideRoom($)

      return { text: 'Chat hidden for this session. /chat brings it back.' }
    }

    // Only "/chat name <one word>" renames: a longer line starting with "name" is a message.
    if (first === 'name' && words.length === 2) {
      const name = cleanName(second)

      if (!name) {
        return { text: NAME_RULES }
      }

      await update($, nameAtom, () => name)
      await $.store.set(STORE_NAME, name)

      return { text: `You are ${name} in the chat.` }
    }

    // The reply never echoes the room: whatever the command prints, the model reads.
    return { text: (await send($, await serverUrl($), args)) ?? 'Sent.' }
  })
}
