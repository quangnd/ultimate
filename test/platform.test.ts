import { expect, it } from 'vitest'
import { below, inside, notOnWindows, samePath, slash } from '../lib/platform.ts'

it('compares Windows paths whatever separator or drive-letter case a watcher or Vite gives', () => {
  const root = 'C:\\Users\\me\\.ultimate\\extensions'
  expect(slash('C:\\Users\\me', 'win32')).toBe('C:/Users/me')
  expect(below('c:/users/me/.ultimate/extensions/hello/web.tsx', root, 'win32')).toBe(
    'hello/web.tsx',
  )
  expect(below('C:\\Users\\me\\.ultimate\\extensions\\hello\\server.ts', root, 'win32')).toBe(
    'hello/server.ts',
  )
  expect(below(root, `${root}\\`, 'win32')).toBe('')
  expect(inside('C:/Users/me/.ultimate/extensions-old/x.ts', root, 'win32')).toBe(false)
  expect(inside('D:/Users/me/.ultimate/extensions/x.ts', root, 'win32')).toBe(false)
  expect(samePath('c:/users/me/.ultimate/extensions/', root, 'win32')).toBe(true)
})

it('leaves POSIX paths exactly as they are, case and backslashes included', () => {
  expect(slash('/home/me/a\\b', 'linux')).toBe('/home/me/a\\b')
  expect(below('/home/me/ext/hello/web.tsx', '/home/me/ext', 'linux')).toBe('hello/web.tsx')
  expect(inside('/home/ME/ext/x.ts', '/home/me/ext', 'linux')).toBe(false)
  expect(inside('/home/me/ext-old/x.ts', '/home/me/ext', 'linux')).toBe(false)
  expect(below('/a', '/', 'linux')).toBe('a')
})

it('names the feature a Windows user cannot use yet', () => {
  expect(() => notOnWindows('The browser tool', 'win32')).toThrow(
    'The browser tool is not available on Windows yet',
  )
  expect(() => notOnWindows('The browser tool', 'darwin')).not.toThrow()
})
