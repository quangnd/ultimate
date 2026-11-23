import { defineWebExtension, getConversation } from '@/sdk/solid'
import type { UltimateContext } from '@/sdk/solid'
import { controlsOf, currentShortcut, unsupported, VoiceButton } from './button.solid.tsx'

const composerOffersVoice = (context: UltimateContext) =>
  !unsupported() && controlsOf(context.conversationId) !== undefined

const escapeCancelsRecording = ({ conversationId }: UltimateContext) =>
  conversationId !== undefined &&
  !getConversation(conversationId).busy &&
  (controlsOf(conversationId)?.recording ?? false)

export default defineWebExtension({
  slots: { 'composer.actions': [VoiceButton] },
  commands: [
    {
      id: 'voice.toggle',
      title: 'Voice input: start / stop recording',
      get keys() {
        return currentShortcut()
      },
      whileTyping: true,
      when: composerOffersVoice,
      run: ({ conversationId }) => controlsOf(conversationId)?.toggle(),
    },
    {
      id: 'voice.cancel',
      title: 'Voice input: cancel recording',
      keys: 'escape',
      whileTyping: true,
      when: escapeCancelsRecording,
      run: ({ conversationId }) => controlsOf(conversationId)?.cancel(),
    },
  ],
})
