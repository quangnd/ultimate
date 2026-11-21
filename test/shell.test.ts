import { expect, it } from 'vitest'
import { gitBashPath } from '../lib/shell.ts'

const perUser = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git'
const present = (...paths: string[]) => ({ exists: (path: string) => paths.includes(path) })

it('finds Git Bash beside the git.exe on PATH, as a per-user install with bash off PATH has it', () => {
  const env = {
    PATH: `C:\\Windows\\System32;${perUser}\\cmd`,
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  }
  expect(
    gitBashPath({
      platform: 'win32',
      env,
      ...present(`${perUser}\\cmd\\git.exe`, `${perUser}\\bin\\bash.exe`),
    }),
  ).toBe(`${perUser}\\bin\\bash.exe`)
})

it('falls back to the known install folders and never to the WSL launcher in System32', () => {
  const env = { PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files' }
  expect(
    gitBashPath({
      platform: 'win32',
      env,
      ...present('C:\\Windows\\System32\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'),
    }),
  ).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  expect(
    gitBashPath({ platform: 'win32', env, ...present('C:\\Windows\\System32\\bash.exe') }),
  ).toBeUndefined()
})

it('leaves shell discovery to Pi everywhere but Windows', () => {
  expect(gitBashPath({ platform: 'darwin', ...present('/bin/bash') })).toBeUndefined()
})
