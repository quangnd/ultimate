import { execFileSync, spawnSync } from 'node:child_process'
import { win32 } from 'node:path'

const commandTimeoutMs = 10000
const processNotFound = 128

export const system32 = (program: string, env: NodeJS.ProcessEnv = process.env) =>
  win32.join(env.SystemRoot || 'C:\\Windows', 'System32', program)

export function parseTasklist(output: string, pid: number) {
  for (const line of output.split(/\r?\n/)) {
    const row = /^"((?:[^"]|"")*)","(\d+)"/.exec(line.trim())
    if (row && Number(row[2]) === pid) return `${row[1].replaceAll('""', '"').toLowerCase()}:${pid}`
  }
  return undefined
}

export function windowsIdentity(pid: number) {
  const output = execFileSync(
    system32('tasklist.exe'),
    ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true, timeout: commandTimeoutMs },
  )
  return parseTasklist(output, pid)
}

export const taskkillArguments = (pid: number) => ['/F', '/T', '/PID', String(pid)]

export function killTree(pid: number) {
  const result = spawnSync(system32('taskkill.exe'), taskkillArguments(pid), {
    encoding: 'utf8',
    windowsHide: true,
    timeout: commandTimeoutMs,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && result.status !== processNotFound)
    throw new Error(`taskkill of process tree ${pid} exited ${result.status}: ${result.stderr}`)
}
