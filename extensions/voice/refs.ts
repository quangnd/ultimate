/** Voice input in the browser: whether an OpenAI API key can transcribe, and the transcription action. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** Whether voice input works: `available` with an OpenAI API key, else `reason` says what to do. */
export type VoiceStatus = { available: true } | { available: false; reason: string }

/** No arguments → whether an OpenAI API key exists to transcribe with. */
export const StatusAction = actionRef<null, VoiceStatus>('voice', 'status')
/** `{ audio: base64, mimeType }` → the transcribed text. Fails with a message the composer shows as is. */
export const TranscribeAction = actionRef<{ audio: string; mimeType: string }, { text: string }>(
  'voice',
  'transcribe',
)
/** No arguments → the `voice.shortcut` key of the user's settings (a chord such as `mod+alt+v`), or null when unset. Fails when the value is not one chord with `mod`, `alt` or `ctrl`. */
export const ShortcutAction = actionRef<null, string | null>('voice', 'shortcut')
