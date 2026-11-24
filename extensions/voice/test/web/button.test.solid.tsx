import { Blob as NodeBlob } from 'node:buffer'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import type { UltimateContext } from '@/sdk/solid'
import type { StreamedView } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { getDraft } from '../../../../web/src/app/drafts.ts'
import { spliced } from '../../../../web/src/app/queued.ts'
import { store as clientStore } from '../../../../web/src/sdk/client.ts'
import { events } from '@/sdk/solid'
import { entersSend, registerVoice, VoiceButton } from '../../button.solid.tsx'
import voice from '../../web.solid.tsx'
import type { VoiceStatus } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  status: { available: true } as VoiceStatus,
  shortcut: null as string | null,
  empty: false,
  transcribe: vi.fn<(request: unknown, source: string | null) => void>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/extensions/voice/actions/status')
      return Response.json({ result: harness.status })
    if (path === '/api/extensions/voice/actions/shortcut')
      return Response.json({ result: harness.shortcut })
    if (path === '/api/extensions/voice/actions/transcribe') {
      harness.transcribe(
        JSON.parse(init?.body as string),
        new Headers(init?.headers).get('x-ultimate-source'),
      )
      return Response.json({ result: { text: harness.empty ? '' : 'hello from the mic' } })
    }
    return subscriptions.handle(path, init) ?? Response.json({ ok: true })
  }
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch: pageFetch,
  })
  const api = createApi(store, { fetch: pageFetch })
  return { store, api, reads: createReads(api, store), uiState: createUiState(undefined) }
})

class FakeRecorder extends EventTarget {
  static isTypeSupported = () => true
  mimeType = 'audio/webm;codecs=opus'
  state = 'inactive'
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    queueMicrotask(() => {
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['audio']) }))
      this.dispatchEvent(new Event('stop'))
    })
  }
}

const agent = createAgent()
const stopTrack = vi.fn<() => void>()
const microphone = async () => ({ getTracks: () => [{ stop: stopTrack }] })
const getUserMedia = vi.fn<typeof microphone>(microphone)

beforeEach(({ onTestFinished }) => {
  harness.sources.length = 0
  harness.shortcut = null
  harness.empty = false
  vi.clearAllMocks()
  getUserMedia.mockReset()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('Blob', NodeBlob)
  clientStore.start()
  onTestFinished(() => clientStore.stop())
  harness.sources[0].open()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function showConversation(id: number) {
  const conversation = parseConversationId(id)
  clientStore.show(conversation)
  await settle()
  const view = {
    conversation: { id: conversation },
    entries: [],
    docs: {},
  } as StreamedView
  harness.server!.of(id)!.send('view', view)
  flush()
}

async function mount(id: number, status: VoiceStatus) {
  harness.status = status
  await showConversation(id)
  const container = renderSolid(() => <VoiceButton />)
  await settle()
  flush()
  return container
}

async function press(label: string) {
  const control = agent.snapshot().find((entry) => !entry.offPage && entry.label === label)
  expect(control).toMatchObject({ component: 'button', label })
  const result = agent.act({ steps: [{ ref: control!.ref, action: 'press' }] })
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100)
  expect(await result).toMatchObject({ ok: true })
  if (!vi.isFakeTimers()) await settle()
  flush()
}

function expectPointerDownPrevented(container: HTMLElement, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`)
  expect(button).not.toBeNull()
  const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
  button!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
}

it('opens the key’s Secrets row when the blocked mic is pressed', async ({ onTestFinished }) => {
  const reason = 'Voice needs an OpenAI API key: add OPENAI_API_KEY in ⌘K → Secrets'
  const opened = vi.fn<(data: unknown) => void>()
  onTestFinished(events.on('secrets:open', opened))
  const container = await mount(7, { available: false, reason })
  const mic = container.querySelector('button[data-voice="blocked"]')
  expect(mic?.getAttribute('aria-label')).toBe(reason)
  expect(mic?.getAttribute('aria-disabled')).toBeNull()
  await press(reason)
  expect(opened).toHaveBeenCalledExactlyOnceWith({ name: 'OPENAI_API_KEY' })
  expect(getUserMedia).not.toHaveBeenCalled()

  harness.status = { available: true }
  events.emit('secrets:changed', undefined)
  await settle()
  flush()
  expect(container.querySelector('button[data-voice="idle"]')?.getAttribute('aria-label')).toBe(
    'Voice input',
  )
})

it('records for an agent and transcribes into the same composer, leaving the editor focused', async ({
  onTestFinished,
}) => {
  const container = await mount(8, { available: true })
  const editor = document.body.appendChild(document.createElement('textarea'))
  onTestFinished(() => editor.remove())
  editor.focus()
  expectPointerDownPrevented(container, 'Voice input')
  await press('Voice input')
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  expectPointerDownPrevented(container, 'Cancel recording')
  expectPointerDownPrevented(container, 'Done: put the transcript in the composer')
  expectPointerDownPrevented(container, 'Send')
  expect(document.activeElement).toBe(editor)
  await expectDistinctAgentNames(agent)
  await press('Done: put the transcript in the composer')
  expect(document.activeElement).toBe(editor)
  expect(stopTrack).toHaveBeenCalledTimes(1)
  expect(harness.transcribe).toHaveBeenCalledExactlyOnceWith(
    {
      args: { audio: 'YXVkaW8=', mimeType: 'audio/webm;codecs=opus' },
      conversationId: 8,
    },
    'agent',
  )
  expect(getDraft(8).get().text).toBe('hello from the mic')
})

it('releases a late microphone stream without transcribing after a conversation switch', async () => {
  const permission = Promise.withResolvers<Awaited<ReturnType<typeof microphone>>>()
  getUserMedia.mockReturnValueOnce(permission.promise)
  const container = await mount(9, { available: true })
  const pressed = press('Voice input')
  await settle()
  expect(getUserMedia).toHaveBeenCalledTimes(1)

  await showConversation(10)

  const stopOtherTrack = vi.fn<() => void>()
  permission.resolve({ getTracks: () => [{ stop: stopTrack }, { stop: stopOtherTrack }] })
  await pressed
  expect(stopTrack).toHaveBeenCalledTimes(1)
  expect(stopOtherTrack).toHaveBeenCalledTimes(1)
  expect(container.querySelector('button[data-voice="idle"]')).not.toBeNull()
  expect(harness.transcribe).not.toHaveBeenCalled()
})

it('stops and transcribes automatically after five minutes', async () => {
  const container = await mount(11, { available: true })
  vi.useFakeTimers()
  let startedAt = Date.now()
  getUserMedia.mockImplementationOnce(() => {
    startedAt = Date.now()
    return microphone()
  })
  await press('Voice input')

  await vi.advanceTimersByTimeAsync(startedAt + 5 * 60_000 - Date.now() - 1)
  flush()
  expect(container.querySelector('button[aria-label="Send"]')).not.toBeNull()
  expect(stopTrack).not.toHaveBeenCalled()
  expect(harness.transcribe).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(1)
  flush()
  expect(stopTrack).toHaveBeenCalledTimes(1)
  expect(harness.transcribe).toHaveBeenCalledExactlyOnceWith(
    {
      args: { audio: 'YXVkaW8=', mimeType: 'audio/webm;codecs=opus' },
      conversationId: 11,
    },
    'app',
  )
  expect(getDraft(11).get().text).toBe('hello from the mic')
})

it('shows a microphone permission alert for eight seconds', async () => {
  const container = await mount(12, { available: true })
  vi.useFakeTimers()
  let deniedAt = Date.now()
  getUserMedia.mockImplementationOnce(async () => {
    deniedAt = Date.now()
    throw new DOMException('Permission denied', 'NotAllowedError')
  })
  await press('Voice input')

  const alert = () => container.querySelector('[role="alert"]')
  expect(alert()?.textContent).toBe(
    'Microphone access is blocked: allow it in the browser’s site settings',
  )
  await vi.advanceTimersByTimeAsync(deniedAt + 8000 - Date.now() - 1)
  flush()
  expect(alert()).not.toBeNull()
  await vi.advanceTimersByTimeAsync(1)
  flush()
  expect(alert()).toBeNull()
})

it('tells an Android system block apart from a blocked site', async () => {
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia },
    userAgent: 'Mozilla/5.0 (Linux; Android 15)',
  })
  const container = await mount(13, { available: true })
  const deny = (message: string) =>
    getUserMedia.mockImplementationOnce(async () => {
      throw new DOMException(message, 'NotAllowedError')
    })
  const alert = () => container.querySelector('[role="alert"]')?.textContent

  deny('Permission denied by system')
  await press('Voice input')
  expect(alert()).toBe(
    'Android blocks the mic for Chrome: allow it in Settings → Apps → Chrome → Permissions',
  )
  deny('Permission denied')
  await press('Voice input')
  expect(alert()).toBe(
    'Mic blocked for this site: allow it in Chrome → Settings → Site settings → Microphone',
  )
})

function composerForm(id: number) {
  const form = document.body.appendChild(document.createElement('form'))
  const editor = form.appendChild(document.createElement('textarea'))
  editor.dataset.conversation = String(id)
  const submit = form.appendChild(document.createElement('button'))
  submit.type = 'submit'
  const pressed = vi.fn<() => void>()
  submit.addEventListener('click', (event) => {
    event.preventDefault()
    pressed()
  })
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => (run(), 0))
  return { editor, pressed, remove: () => form.remove() }
}

it('Done puts the transcript in the composer without sending', async ({ onTestFinished }) => {
  await mount(14, { available: true })
  const composer = composerForm(14)
  onTestFinished(composer.remove)
  await press('Voice input')
  await press('Done: put the transcript in the composer')
  expect(getDraft(14).get().text).toBe('hello from the mic')
  expect(composer.pressed).not.toHaveBeenCalled()
})

it('Send puts the transcript in the composer and presses its submit button', async ({
  onTestFinished,
}) => {
  await mount(15, { available: true })
  const composer = composerForm(15)
  onTestFinished(composer.remove)
  await press('Voice input')
  await press('Send')
  expect(getDraft(15).get().text).toBe('hello from the mic')
  expect(composer.pressed).toHaveBeenCalledTimes(1)
})

it('sends nothing when the transcription is empty', async ({ onTestFinished }) => {
  const container = await mount(16, { available: true })
  const composer = composerForm(16)
  onTestFinished(composer.remove)
  await press('Voice input')
  harness.empty = true
  await press('Send')
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('No speech heard')
  expect(composer.pressed).not.toHaveBeenCalled()
})

it('Enter in that conversation’s composer sends while recording, and only there', async ({
  onTestFinished,
}) => {
  const container = await mount(17, { available: true })
  const composer = composerForm(17)
  onTestFinished(composer.remove)
  const elsewhere = document.body.appendChild(document.createElement('textarea'))
  elsewhere.dataset.conversation = '99'
  onTestFinished(() => elsewhere.remove())
  const enter = (target: HTMLElement) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }
  expect(enter(composer.editor).defaultPrevented).toBe(false)
  await press('Voice input')
  expect(enter(elsewhere).defaultPrevented).toBe(false)
  expect(container.querySelector('[data-voice-recording]')).not.toBeNull()
  expect(enter(composer.editor).defaultPrevented).toBe(true)
  await settle()
  flush()
  expect(getDraft(17).get().text).toBe('hello from the mic')
  expect(composer.pressed).toHaveBeenCalledTimes(1)
})

it('hides the composer’s own Send and the live voice button while recording', async () => {
  const container = await mount(18, { available: true })
  expect(container.querySelector('[data-voice-recording]')).toBeNull()
  await press('Voice input')
  const bar = container.querySelector('[data-voice-recording]')
  expect(bar?.querySelector('style')?.textContent).toBe(
    '[data-ui="composer"]:has([data-voice-recording]) button[type="submit"] { display: none }',
  )
})

it('entersSend needs a plain Enter, no composition, in the recording conversation’s composer', () => {
  const enter = {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
  }
  const id = parseConversationId(7)
  expect(entersSend(enter, '7', id, true)).toBe(true)
  expect(entersSend(enter, '7', id, false)).toBe(false)
  expect(entersSend(enter, '9', id, true)).toBe(false)
  expect(entersSend(enter, undefined, id, true)).toBe(false)
  expect(entersSend({ ...enter, shiftKey: true }, '7', id, true)).toBe(false)
  expect(entersSend({ ...enter, metaKey: true }, '7', id, true)).toBe(false)
  expect(entersSend({ ...enter, isComposing: true }, '7', id, true)).toBe(false)
  expect(entersSend({ ...enter, key: 'a' }, '7', id, true)).toBe(false)
})

function command(id: string) {
  const found = voice.commands?.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`No command ${id}`)
  return found
}
const inConversation = (id: number) =>
  ({ conversationId: parseConversationId(id) }) as UltimateContext

it('voice.toggle starts and stops the recording of the context conversation, and shows only where a composer offers voice', async () => {
  const toggle = command('voice.toggle')
  expect(toggle.when?.(inConversation(19))).toBe(false)
  const container = await mount(19, { available: true })
  expect(toggle.when?.(inConversation(19))).toBe(true)
  expect(toggle.when?.(inConversation(20))).toBe(false)
  expect(toggle.when?.({} as UltimateContext)).toBe(false)
  expect(toggle.whileTyping).toBe(true)

  await toggle.run(inConversation(19))
  await settle()
  flush()
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[data-voice-recording]')).not.toBeNull()

  await toggle.run(inConversation(19))
  await settle()
  flush()
  expect(harness.transcribe).toHaveBeenCalledTimes(1)
  expect(getDraft(19).get().text).toBe('hello from the mic')
})

it('voice.toggle listens on ⌘⌥V unless the user chose another shortcut', async () => {
  await mount(26, { available: true })
  expect(command('voice.toggle').keys).toBe('mod+alt+v')
})

it('voice.toggle hides once the browser cannot record', async () => {
  await mount(21, { available: true })
  expect(command('voice.toggle').when?.(inConversation(21))).toBe(true)
  vi.stubGlobal('isSecureContext', false)
  expect(command('voice.toggle').when?.(inConversation(21))).toBe(false)
})

it('voice.toggle listens on the chosen shortcut, shown in the hint', async () => {
  harness.shortcut = 'mod+alt+j'
  const container = await mount(22, { available: true })
  expect(command('voice.toggle').keys).toBe('mod+alt+j')
  const mic = container.querySelector('button[data-voice="idle"]')!
  mic.dispatchEvent(new FocusEvent('focus'))
  await settle()
  flush()
  expect(document.body.textContent).toContain(
    'Voice input: tap to record, tap again to transcribe · Ctrl+Alt+J',
  )
})

it('voice.cancel listens on Escape and only while this conversation records and is idle', async () => {
  const cancel = command('voice.cancel')
  expect(cancel.keys).toBe('escape')
  expect(cancel.whileTyping).toBe(true)
  const container = await mount(23, { available: true })
  expect(cancel.when?.(inConversation(23))).toBe(false)
  await press('Voice input')
  expect(cancel.when?.(inConversation(23))).toBe(true)
  expect(cancel.when?.(inConversation(24))).toBe(false)
  await cancel.run(inConversation(23))
  await settle()
  flush()
  expect(container.querySelector('button[data-voice="idle"]')).not.toBeNull()
  expect(stopTrack).toHaveBeenCalledTimes(1)
  expect(harness.transcribe).not.toHaveBeenCalled()
  expect(cancel.when?.(inConversation(23))).toBe(false)
})

it('registerVoice withdraws a conversation’s controls', () => {
  const withdraw = registerVoice(parseConversationId(25), {
    toggle: () => {},
    cancel: () => {},
    recording: false,
  })
  expect(command('voice.toggle').when?.(inConversation(25))).toBe(true)
  withdraw()
  expect(command('voice.toggle').when?.(inConversation(25))).toBe(false)
})

it('spaces inserted words from their neighbours and puts the cursor after them', () => {
  expect(spliced('', 0, 0, 'Hello')).toEqual({ text: 'Hello', cursor: 5 })
  expect(spliced('Fix the', 7, 7, 'login bug')).toEqual({ text: 'Fix the login bug', cursor: 17 })
  expect(spliced('Fix bug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fixbug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 8 })
  expect(spliced('Fix  bug', 4, 4, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fix XXX bug', 4, 7, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
})
