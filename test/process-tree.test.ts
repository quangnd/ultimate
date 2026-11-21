import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { operatingSystem } from '../extensions/prompt/server.ts'
import { groupTarget, stopGroup } from '../lib/process-group.ts'
import { parseTasklist, system32 } from '../lib/process-tree.ts'
import { temp } from './helpers.ts'

it('identifies a Windows process by image name and pid from tasklist output', () => {
  expect(parseTasklist('"Node.EXE","4321","Console","1","52,000 K"\r\n', 4321)).toBe(
    'node.exe:4321',
  )
  expect(
    parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n', 4321),
  ).toBe(undefined)
  expect(parseTasklist('', 4321)).toBe(undefined)
  expect(parseTasklist('"node.exe","99","Console","1","1 K"', 4321)).toBe(undefined)
})

it('finds Windows system tools beside SystemRoot', () => {
  expect(system32('taskkill.exe', { SystemRoot: 'D:\\Win' })).toBe(
    'D:\\Win\\System32\\taskkill.exe',
  )
  expect(system32('tasklist.exe', {})).toBe('C:\\Windows\\System32\\tasklist.exe')
})

it('names the leader itself as the Windows group and still refuses pids that name no process', () => {
  expect(groupTarget(4321, 'win32')).toBe(4321)
  expect(groupTarget(4321, 'linux')).toBe(-4321)
  expect(() => groupTarget(1, 'win32')).toThrow('Not a process group')
})

it('tells the agent that Windows commands run in Git Bash', () => {
  expect(operatingSystem('win32', 'x64')).toContain('Git Bash')
  expect(operatingSystem('darwin', 'arm64')).toBe('macOS arm64')
})

it('forgets a stale pid file on Windows without signalling whatever process now has that pid', async () => {
  const pidFile = join(await temp('ultimate-pid-'), 'group.pid')
  await writeFile(pidFile, `${process.pid}\n`)
  const kill = vi.spyOn(process, 'kill')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  try {
    await stopGroup(process.pid, { pidFile })
  } finally {
    Object.defineProperty(process, 'platform', platform)
    kill.mockRestore()
  }
  expect(kill).not.toHaveBeenCalled()
  await expect(readFile(pidFile)).rejects.toThrow('ENOENT')
})
