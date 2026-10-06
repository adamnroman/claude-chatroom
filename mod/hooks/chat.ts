import type { ChatMessage } from '../types'

// Where the room lives. CHATROOM_URL overrides it for development.
export const DEFAULT_SERVER = 'https://claude-chatroom.adamnroman.workers.dev'
export const CLIENT_HEADER = 'x-chatroom-client'
// Keep in step with plugin.json's version: the server reads it to retire old copies.
export const CLIENT_VERSION = '0.1.0'
export const CLIENT_ID = `claude-code-chatroom/${CLIENT_VERSION}`

// The server says how often to ask (poll_ms); the mod obeys within these bounds.
export const DEFAULT_POLL_MS = 2000
export const MIN_POLL_MS = 2000
export const MAX_POLL_MS = 300_000
// After a failure each wait doubles, up to this.
export const MAX_BACKOFF_MS = 60_000
// A request that has not come back by now no longer blocks the next one.
export const STUCK_POLL_MS = 15_000
// A refused send keeps its reason on screen this long.
export const SEND_NOTICE_MS = 6000
// The server's answers that end the room for this session: gone, this copy is too old, closed.
export const STOP_STATUSES: readonly number[] = [410, 426, 503]
export const KEEP_MESSAGES = 100
export const MAX_ONLINE = 1_000_000

// The room is a pane: docked on the right in the fullscreen layout, else above the prompt.
export const PANE_ID = 'chatroom'
export const PANE_TITLE = 'chat'
export const DOCK_COLUMNS = 44
export const INLINE_ROWS = 10
export const ROOM_PADDING_X = 1
export const HEADER_ROWS = 1
export const SUBMIT_LABEL = 'send'
// The field draws " ⏎ send" beside the text while it has the keyboard.
export const INPUT_LABEL_COLUMNS = ` ⏎ ${SUBMIT_LABEL}`.length
export const CURSOR_COLUMNS = 1
// Padding on each side.
export const PANE_CHROME_COLUMNS = ROOM_PADDING_X * 2
// Where no pane can be placed, the room falls back to a band above the prompt.
export const BAND_MAX_ROWS = 10
// The band's own border, top and bottom.
export const BAND_CHROME_ROWS = 2
// Border and padding on each side.
export const BAND_CHROME_COLUMNS = 4
export const MAX_TEXT_CHARS = 280
export const MAX_NAME_CHARS = 20

export type RoomUpdate = {
  messages: ChatMessage[]
  online: number
  pollMs: number
  /** Changes when the server removed history. */
  epoch: number
  /** The newest id the server has given out. */
  latest: number
}

const NAME_COLORS = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red'] as const

// Control characters would reach the terminal as escape sequences, bidi marks
// can make a line read differently than it is, zero-width characters make
// blank or look-alike messages. The server strips these too; a reader never
// trusts the room to have done it.
// Written as escapes on purpose: the characters themselves are invisible in an editor.
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g
// More than two combining marks on one character is decoration stacked over other lines.
const STACKED_MARKS = /(\p{M}{2})\p{M}+/gu
const NAME_UNSAFE = /[^A-Za-z0-9_.-]/g
const HIGH_SURROGATE = /[\uD800-\uDBFF]/

/** One line of chat text, safe to draw in a terminal, or '' when nothing is left. */
export function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') {
    return ''
  }

  const line = raw.replace(/\s+/g, ' ').replace(UNSAFE, '').replace(STACKED_MARKS, '$1').trim()

  return Array.from(line).slice(0, MAX_TEXT_CHARS).join('')
}

/** A handle the server accepts, or '' when nothing usable is left. */
export function cleanName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(NAME_UNSAFE, '').slice(0, MAX_NAME_CHARS) : ''
}

export function colorFor(name: string): string {
  let hash = 0

  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }

  return NAME_COLORS[hash % NAME_COLORS.length] ?? 'cyan'
}

/** `count` random bytes as hex, for a handle or a client id. */
export function randomHex(count: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(count)), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Only what the server sent that looks like a message, cleaned again for the terminal. */
export function parseMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw.slice(-KEEP_MESSAGES).flatMap(item => {
    const { id, name, text, at } = (item ?? {}) as Record<string, unknown>
    const clean = cleanText(text)

    return Number.isSafeInteger(id) && (id as number) > 0 && clean
      ? [{ id: id as number, name: cleanName(name) || 'anon', text: clean, at: Number(at) || 0 }]
      : []
  })
}

const wholeNumber = (raw: unknown, fallback: number): number => (Number.isSafeInteger(raw) && (raw as number) >= 0 ? (raw as number) : fallback)

export const clampPoll = (ms: number): number => Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, ms))

/** A poll's answer, with every field checked: nothing the server says is used as it came. */
export function parseRoom(body: string): RoomUpdate {
  const raw = JSON.parse(body) as Record<string, unknown> | null
  const messages = parseMessages(raw?.messages)

  return {
    messages,
    online: Math.min(MAX_ONLINE, wholeNumber(raw?.online, 0)),
    pollMs: clampPoll(wholeNumber(raw?.poll_ms, DEFAULT_POLL_MS)),
    epoch: wholeNumber(raw?.epoch, 0),
    latest: wholeNumber(raw?.latest, messages.at(-1)?.id ?? 0),
  }
}

/** How long to wait before asking again: the server's pace, doubled for each failure in a row. */
export function pollDelay(pollMs: number, failures: number): number {
  return failures === 0 ? pollMs : Math.min(MAX_BACKOFF_MS, pollMs * 2 ** Math.min(failures, 10))
}

/** Old and new together, by id, oldest first, the latest KEEP_MESSAGES. */
export function mergeMessages(current: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map(message => [message.id, message]))

  for (const message of incoming) {
    byId.set(message.id, message)
  }

  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-KEEP_MESSAGES)
}

/** How many rows `line` takes once word-wrapped at `columns`; a word longer than a row breaks across rows. */
export function wrappedRows(line: string, columns: number): number {
  const width = Math.max(1, columns)
  let rows = 1
  let used = 0

  for (const word of line.split(' ')) {
    let length = Array.from(word).length

    if (used > 0 && used + 1 + length <= width) {
      used += 1 + length
      continue
    }

    if (used > 0) {
      rows++
    }

    while (length > width) {
      rows++
      length -= width
    }

    used = length
  }

  return rows
}

/**
 * `text` cut into lines of at most `width` characters, broken after a space
 * where there is one. The lines joined are `text` exactly, so a prefix of
 * lines is a prefix of the text, and only an empty text gives an empty line:
 * taking the last line away always leaves one fewer.
 */
export function wrapLines(text: string, width: number): string[] {
  const size = Math.max(1, width)
  const lines: string[] = []
  let rest = text

  while (rest.length > size) {
    const space = rest.slice(0, size).lastIndexOf(' ')
    let cut = space > 0 ? space + 1 : size

    // Never between the two halves of one character.
    if (cut > 1 && HIGH_SURROGATE.test(rest.charAt(cut - 1))) {
      cut -= 1
    }

    lines.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }

  lines.push(rest)

  return lines
}

/** How many terminal rows a message takes with its name in front, wrapped at `columns`. */
export function rowsFor(message: ChatMessage, columns: number): number {
  return wrappedRows(`${message.name} ${message.text}`, columns)
}

/** The newest messages that fit in `rows` rows, oldest first. */
export function fitMessages(messages: readonly ChatMessage[], rows: number, columns: number): ChatMessage[] {
  const shown: ChatMessage[] = []
  let used = 0

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]

    if (!message) {
      continue
    }

    used += rowsFor(message, columns)

    if (used > rows) {
      break
    }

    shown.unshift(message)
  }

  return shown
}

/** What a failed request means for the person, in a few words. */
export function noticeFor(status: number, body: string): string {
  if (status === 426) {
    return 'This copy of the chat mod is too old. Update the chatroom plugin to rejoin.'
  }

  if (status === 503 || status === 410) {
    return 'The chat room is closed.'
  }

  if (status === 429) {
    if (body.includes('busy')) {
      return 'The room is busy. Try again in a moment.'
    }

    return body.includes('rate_limited') ? 'Too many requests from your network.' : 'Slow down: one message a second.'
  }

  return body.includes('empty') ? 'Nothing to send.' : `Chat server error (${status}).`
}
