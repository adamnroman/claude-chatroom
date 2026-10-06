# claude-chatroom

One public chat room inside Claude Code. It shows on the right of the screen while Claude works, like a stream chat, and hides when Claude waits for you.

- Everyone with the mod is in the same room.
- **It is public and unmoderated.** Anyone can read and post. Do not paste secrets, code you cannot share, or anything personal.
- Nothing from the room reaches Claude. Messages are drawn on screen only.

Needs Claude Code 2.1.287 or newer. Mods are early access, so a Claude Code update can break this until the mod is updated.

## Install

```
/plugin marketplace add adamnroman/claude-chatroom
/plugin install chatroom@claude-chatroom
```

Restart Claude Code. Give Claude something that takes a while and the room appears.

To leave: `/chat off` hides it for the session, `/plugin uninstall chatroom@claude-chatroom` removes it.

## Use

- While Claude works, the room opens. When Claude waits for you, it closes.
  - Terminal 144 columns or wider: docked on the right, full height, newest message at the bottom.
  - 110 to 143 columns: above the prompt at first. Run `/chat` once and it docks on the right.
  - Narrower: a framed block above the prompt.
- `ctrl+x tab` puts the cursor in the room. Type, Enter sends, Esc goes back to the prompt without interrupting Claude.
- A long message wraps onto more lines as you type. The left and right arrows move within the last line; backspace walks back through earlier ones.
- `ctrl+x x` (or the ✕) closes the room for the session. `/chat` brings it back.

| Command | What it does |
| --- | --- |
| `/chat <message>` | Send from the prompt, at any time |
| `/chat name <handle>` | Set your name: letters, digits, `_ . -`, up to 20 |
| `/chat off` | Hide the room for this session |
| `/chat` | Show the room again, and your name |

Your own `/chat <message>` line is part of the transcript, so Claude can read what you typed there. Messages typed in the room itself are not.

### Names

- Names are not accounts. Anyone can use any name, including yours.
- Each session picks a name once: `CHATROOM_NAME`, else the last name used on this machine, else a new `anon-xxxx`.
- Two people on one machine: start each with `CHATROOM_NAME=<name> claude`.

## Privacy

While Claude is working and the room is showing, the mod talks to the chat server:

- **Sent every few seconds:** your handle and a random id made on your machine, so the room can count who is here. The id is not tied to your Claude account.
- **Sent when you post:** your handle and the message.
- **Seen by the server:** your IP address, used for rate limits and held in memory only. A small sample of requests is logged.
- **Kept:** the last 200 messages, readable by everyone with the mod.

The mod sends nothing else: no prompts, no code, no file names, nothing about your session. It sends nothing while Claude is idle, when the room is hidden, or in headless runs (`claude -p`, CI).

## How it works

- `turn.start` opens the room's pane and the main loop's `turn.complete` closes it. Where no pane can be placed, the same room draws in a band above the prompt.
- While the room shows, the mod asks the server for new messages. The server sets the pace (2 seconds by default) and the mod waits longer after each failure.
- The server can close the room or retire an old version of the mod. Either one stops the mod for the session.
- Text from the room is cleaned twice, on the server and again in the mod: control characters, bidi overrides and zero-width characters are removed, so a message cannot send escape sequences to your terminal.
- The server is not part of this repository.

## Develop

```bash
claude --plugin-dir mod                        # load it from disk
cd mod && claude plugin validate . && claude plugin test .
npx -p typescript tsc -p mod                   # after the mod has loaded once
CHATROOM_URL=http://127.0.0.1:8787 claude --plugin-dir mod   # against another server
```

- Every `$` call lives in `mod/hooks/register.tsx`. The validator refuses a module that passes `$` across an import, so `mod/hooks/chat.ts` holds only pure helpers.
- Claude Code's `Input` is one line. The mod wraps a long draft itself: earlier lines are drawn as text, the field holds the last one.
- `CLIENT_VERSION` in `mod/hooks/chat.ts` must match `version` in `mod/.claude-plugin/plugin.json`.

## License

MIT
