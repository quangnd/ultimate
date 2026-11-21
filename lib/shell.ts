import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

type Probe = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

export function gitBashPath({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
}: Probe = {}) {
  if (platform !== 'win32') return undefined
  const gitFolders = (env.PATH ?? '')
    .split(win32.delimiter)
    .filter((directory) => directory && exists(win32.join(directory, 'git.exe')))
    .flatMap((directory) => [
      directory,
      win32.dirname(directory),
      win32.dirname(win32.dirname(directory)),
    ])
  const knownInstalls = [
    env.ProgramFiles && win32.join(env.ProgramFiles, 'Git'),
    env['ProgramFiles(x86)'] && win32.join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'Git'),
  ].filter((folder): folder is string => !!folder)
  return [...gitFolders, ...knownInstalls]
    .map((folder) => win32.join(folder, 'bin', 'bash.exe'))
    .find((candidate) => exists(candidate))
}
