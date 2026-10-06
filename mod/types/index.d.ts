/** One line of the room, as the server keeps it. */
export type ChatMessage = { id: number; name: string; text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    chatroom: {
      /** The latest messages, oldest first. */
      messages: ChatMessage[]
      /** How many people polled the room in the last 30 seconds. */
      online: number
      /** This session's handle; null until the session first needs one. */
      name: string | null
      /** A problem worth showing in the band (server down, too fast); null when all is well. */
      notice: string | null
    }
  }
}
