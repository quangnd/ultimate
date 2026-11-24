import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, expect, it } from 'vitest'
import { git } from '../../../lib/git.ts'
import { projectSettings } from '../../../lib/project-setup.ts'
import { context, prepareHarness } from '../../../server/harness.ts'
import { Metadata } from '../../../server/metadata.ts'
import { emit } from '../../../server/events.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { apis, removeTemp, temp } from '../../../test/helpers.ts'
import workspaceExtension from '../server.ts'
import { workspaces } from '../workspaces.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close()
})

async function fixture() {
  const root = await temp('ultimate-release-')
  const source = join(root, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await git(source, 'config', 'user.email', 'test@example.com')
  await git(source, 'config', 'user.name', 'Test')
  await writeFile(join(source, 'base'), 'base')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'Initial')
  const prepared = await prepareHarness({
    ultimateRoot: source,
    projectRoot: source,
    home: join(root, 'home'),
    userHome: root,
    faux: fauxProvider(),
  })
  let opened: Awaited<ReturnType<typeof prepared.open>>
  const resources = new Map<string, unknown>()
  const host = {
    ...prepared,
    projectSettings: () => projectSettings(source, root),
    harness: () => opened.harness,
    metadata: Metadata,
    emit,
    ...apis(),
    extensions: () => [{ name: 'workspaces', enabled: true }],
    resource<T>(key: string, create: () => T): T {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key) as T
    },
    onOpen: () => {},
    onClose: () => {},
    notice: () => {},
  } as unknown as ExtensionHost
  const service = workspaces(host)
  prepared.registry.install(workspaceExtension(host))
  opened = await prepared.open()
  closers.push(async () => {
    await opened.close()
    await removeTemp(root)
  })
  async function workspace(cwd = source) {
    const conversation = await opened.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
        init: (tx, id) => service.create(tx, id, cwd).then(() => undefined),
      },
      context,
    )
    await service.ready(conversation.id, context)
    return { id: conversation.id, record: (await service.get(conversation.id, context))! }
  }
  return { source, service, workspace }
}

// A worktree folder deleted outside Ultimate made release spawn git in a missing folder (ENOENT), which
// rejected the whole release and sweep chain on every start.
it('releases a workspace whose folder was deleted next to a healthy one', async () => {
  const { source, service, workspace } = await fixture()
  const missing = await workspace()
  const healthy = await workspace()
  await rm(missing.record.path, { recursive: true })
  const kept = await service.release([missing.id, healthy.id], context)
  expect(kept).toEqual([])
  expect((await service.get(missing.id, context))!.state).toBe('removed')
  expect((await service.get(healthy.id, context))!.state).toBe('removed')
  expect(await stat(healthy.record.path).catch(() => undefined)).toBeUndefined()
  const listed = await git(source, 'worktree', 'list', '--porcelain')
  expect(listed).not.toContain(missing.record.path)
  expect(listed).not.toContain(healthy.record.path)
})

// A nested workspace's source is its parent's worktree folder. With that folder deleted by hand, release spawned
// git in it (ENOENT) and aborted before reaching the remaining workspaces.
it('releases nested workspaces whose source folder was deleted, keeping the ones with work', async () => {
  const { source, service, workspace } = await fixture()
  await writeFile(join(source, '.gitignore'), '.vite/\n')
  const parent = await workspace()
  const cacheOnly = await workspace(parent.record.path)
  const withWork = await workspace(parent.record.path)
  const healthy = await workspace()
  await rm(parent.record.path, { recursive: true })
  await rm(cacheOnly.record.path, { recursive: true })
  await mkdir(join(cacheOnly.record.path, '.vite'), { recursive: true })
  await rm(withWork.record.path, { recursive: true })
  await mkdir(withWork.record.path)
  await writeFile(join(withWork.record.path, 'notes.txt'), 'unsaved')
  const kept = await service.release([parent.id, cacheOnly.id, withWork.id, healthy.id], context)
  expect(kept.map((item) => item.id).toSorted((a, b) => a - b)).toEqual(
    [parent.id, withWork.id].toSorted((a, b) => a - b),
  )
  expect(kept.find((item) => item.id === withWork.id)!.reason).toContain('not ignored')
  expect((await service.get(cacheOnly.id, context))!.state).toBe('removed')
  expect(await stat(cacheOnly.record.path).catch(() => undefined)).toBeUndefined()
  expect(await readFile(join(withWork.record.path, 'notes.txt'), 'utf8')).toBe('unsaved')
  expect((await service.get(healthy.id, context))!.state).toBe('removed')
  expect(await stat(healthy.record.path).catch(() => undefined)).toBeUndefined()
})
