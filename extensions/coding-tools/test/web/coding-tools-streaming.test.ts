import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ToolCallView } from '../../../../web/src/sdk/types.ts'

let showWriting = false

vi.mock('@/sdk', async () => ({
  api: { action: () => new Promise(() => {}) },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (extension: unknown) => extension,
  formatBytes: (bytes: number) => `${bytes} B`,
  shortenPath: (path: string) => path,
  useConversation: () => undefined,
  useExtensionUiState: () => [showWriting, () => {}],
  useStore: () => undefined,
  useToolDuration: () => undefined,
}))

const { default: codingTools } = await import('../../web.tsx')
const tools = codingTools.tools as Record<string, (props: { call: ToolCallView }) => unknown>

beforeEach(() => {
  showWriting = false
})

const render = (
  name: string,
  args: ToolCallView['args'],
  status: ToolCallView['status'],
  output = '',
) =>
  renderToStaticMarkup(
    createElement(tools[name] as never, {
      call: { id: 'c1', name, args, status, output, images: [], diagnostics: [] },
    }),
  )
const rows = (html: string) => html.match(/text-diff-(add|del)/g)?.length ?? 0

it('keeps a streaming write or edit closed, its header showing the verb, then the path and line count', () => {
  const write = { path: 'a.ts', content: 'one\ntwo' }
  const edit = { path: 'a.ts', edits: [{ oldText: 'one', newText: 'uno' }] }
  expect(render('write', {}, 'streaming')).toContain('writing…')
  expect(render('edit', {}, 'streaming')).toContain('editing…')
  const writing = render('write', write, 'streaming')
  expect(writing).toContain('a.ts')
  expect(writing).toContain('2 lines')
  expect(writing).not.toContain('two')
  expect(writing).not.toContain('animate-pulse-dot')
  const editing = render('edit', edit, 'streaming')
  expect(editing).toContain('a.ts')
  expect(editing).not.toContain('uno')
  expect(editing).not.toContain('animate-pulse-dot')
})

it('opens a write or edit once it has failed, and an edit once it is written', () => {
  expect(render('write', { path: 'a.ts', content: 'one' }, 'error', 'EACCES')).toContain('EACCES')
  const edit = { path: 'a.ts', edits: [{ oldText: 'one\ntwo', newText: 'uno' }] }
  expect(render('edit', edit, 'pending')).toContain('uno')
})

it('renders a streaming edit with no text yet as a caret, without placeholder rows or counts', () => {
  showWriting = true
  const empty: ToolCallView['args'][] = [
    {},
    { path: 'a.ts', edits: [{ oldText: '', newText: '' }] },
  ]
  for (const args of empty) {
    const html = render('edit', args, 'streaming')
    expect(rows(html)).toBe(0)
    expect(html).not.toMatch(/\+\d|−\d/)
    expect(html).toContain('animate-pulse-dot')
  }
  expect(render('edit', {}, 'streaming')).toContain('editing…')
})

it('with the setting on, streams only the text that arrived and counts changes once the call is written', () => {
  showWriting = true
  const args = { path: 'a.ts', edits: [{ oldText: 'one\ntwo', newText: 'uno' }] }
  const streaming = render('edit', args, 'streaming')
  expect(streaming).toContain('uno')
  expect(streaming).not.toContain('−2')
  expect(render('edit', args, 'pending')).toContain('−2')
  const write = render('write', { path: 'a.ts', content: 'one\ntwo' }, 'streaming')
  expect(write).toContain('two')
  expect(write).toContain('animate-pulse-dot')
})
