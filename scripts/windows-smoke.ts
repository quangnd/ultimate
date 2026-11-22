import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { meansNone } from '../lib/errors.ts'
import { killTree } from '../lib/process-tree.ts'
import { gitBashPath } from '../lib/shell.ts'
import { pace, within } from '../lib/timers.ts'
import { scriptedModel } from '../test/e2e/scripted-model.ts'
import type { Answer, Turn } from '../test/e2e/scripted-model.ts'
import type { SystemInfo } from '../shared/protocol.ts'

const clone = resolve(import.meta.dirname, '..')
const marker = 'hello-user-extension-marker'
const helloText = 'hello from a user extension'

function answer(last: Turn): Answer {
  if (last.role === 'user' && last.text === 'hello') return { tool: { name: 'hello', args: {} } }
  if (last.role === 'user' && last.text === 'demo')
    return {
      text: 'I will run a shell command and edit the file it wrote.',
      tool: {
        name: 'bash',
        args: { command: "printf 'before\\n' > scratch.txt; echo starting; echo finished" },
      },
    }
  if (last.role === 'tool' && last.text.includes('finished'))
    return {
      tool: {
        name: 'edit',
        args: { path: 'scratch.txt', edits: [{ oldText: 'before', newText: 'after' }] },
      },
    }
  if (last.role === 'tool' && last.text.startsWith('Successfully')) return { text: '## Complete' }
  if (last.role === 'tool') return { text: last.text }
  return { text: 'Done.' }
}

const describe = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error)
const seconds = (count: number) => count * 1000
async function until(what: string, limit: number, test: () => boolean | Promise<boolean>) {
  const end = performance.now() + limit
  while (!(await test())) {
    if (performance.now() > end)
      throw new Error(`timed out after ${limit / 1000}s waiting for ${what}`)
    await pace(250)
  }
}

const root = mkdtempSync(join(tmpdir(), 'ultimate-smoke-'))
const project = join(root, 'project')
const home = join(root, 'ultimate-home')
const userHome = join(root, 'user')
const logPath = process.env.ULTIMATE_SMOKE_LOG
const fixture = process.env.ULTIMATE_SMOKE_FIXTURE ?? join(clone, 'test/fixtures/windows-hello')
let output = ''
let status = 0
let supervisor: ReturnType<typeof spawn> | undefined
let tabBrowser: Browser | undefined
let corePid: number | undefined
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const run = (command: string, args: string[]) => {
  const done = spawnSync(command, args, { cwd: project, encoding: 'utf8', timeout: seconds(60) })
  if (done.status !== 0)
    throw new Error(`${command} ${args.join(' ')}: ${done.stderr}${done.error}`)
}
const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(seconds(240)) })
const post = async (url: string, path: string, data: unknown) => {
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(seconds(30)),
  })
  if (!response.ok) throw new Error(`POST ${path} answered ${response.status}`)
}
async function systemInfo(url: string) {
  const controller = new AbortController()
  const response = await fetch(url + '/api/events', { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let wire = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) throw new Error('/api/events ended before a system event')
      wire += decoder.decode(value, { stream: true })
      const block = wire
        .split('\n\n')
        .slice(0, -1)
        .find((part) => part.startsWith('event: system'))
      if (block) return JSON.parse(/^data: (.+)$/m.exec(block)![1]) as SystemInfo
    }
  } finally {
    controller.abort()
  }
}
const history = async (url: string) =>
  JSON.stringify(
    (
      (await (await get(`${url}/api/conversations/1/history?before=999999999`)).json()) as {
        entries: unknown[]
      }
    ).entries,
  )
const toolResults = (entries: string, tool: string) =>
  [
    ...entries.matchAll(
      new RegExp(`"toolName":"${tool}"[^}]*?"text":"((?:[^"\\\\]|\\\\.)*)"`, 'g'),
    ),
  ].map((match) => match[1])

async function launchBrowser() {
  for (const channel of ['chrome', 'msedge']) {
    const browser = await chromium.launch({ channel, headless: true }).catch(meansNone)
    if (browser) return browser
  }
  if (process.env.CI) throw new Error('no Chrome or Edge to launch on this runner')
  return undefined
}

const checks: [string, (url: string) => Promise<string>][] = [
  [
    'web bundle built and served',
    async (url) => {
      const page = await get(url + '/')
      const html = await page.text()
      if (!page.ok || !html.includes('<html')) throw new Error(`GET / answered ${page.status}`)
      const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1])
      if (!assets.length) throw new Error(`no script or stylesheet in the page:\n${html}`)
      for (const asset of assets) {
        const response = await get(url + asset)
        if (!response.ok) throw new Error(`${asset} answered ${response.status}`)
      }
      return `${assets.length} assets`
    },
  ],
  [
    'user extension listed with server and web facets, marker in the bundle',
    async (url) => {
      const system = await systemInfo(url)
      corePid = system.process.pid
      const hello = system.extensions.find((extension) => extension.name === 'hello')
      if (!hello)
        throw new Error(`hello not listed: ${system.extensions.map((e) => e.name).join(', ')}`)
      if (hello.source !== 'user') throw new Error(`hello source is ${hello.source}`)
      if (!hello.facets.server || !hello.facets.web)
        throw new Error(`facets ${JSON.stringify(hello.facets)}`)
      if (hello.server?.error) throw new Error(`server facet: ${hello.server.error}`)
      if (!hello.server?.tools.some((tool) => tool.name === 'hello'))
        throw new Error(`hello tool not registered: ${JSON.stringify(hello.server)}`)
      const html = await (await get(url + '/')).text()
      const queue = [...html.matchAll(/(?:src|href)="(\/[^"]+\.js)"/g)].map((m) => url + m[1])
      const seen = new Set(queue)
      for (const script of queue) {
        const code = await (await get(script)).text()
        if (code.includes(marker)) return `${marker} found in ${script.split('/').pop()}`
        for (const [reference] of code.matchAll(/(?:\.\/|\/?assets\/)[\w.-]+\.js/g)) {
          const next = new URL(reference, reference.startsWith('.') ? script : url + '/').href
          if (seen.has(next)) continue
          seen.add(next)
          queue.push(next)
        }
      }
      throw new Error(`${marker} is in none of the ${queue.length} scripts of the bundle`)
    },
  ],
  [
    'the page renders the user extension in a real browser',
    async (url) => {
      const browser = await launchBrowser()
      if (!browser) return 'skipped: no Chrome or Edge found'
      try {
        const page = await browser.newPage()
        const problems: string[] = []
        page.on('pageerror', (error) => problems.push(error.message))
        page.on('console', (message) => message.type() === 'error' && problems.push(message.text()))
        await page.goto(url)
        await page
          .getByText(marker)
          .first()
          .waitFor({ timeout: seconds(90) })
          .catch((error: unknown) => {
            throw new Error(`${marker} never showed: ${describe(error)}\n${problems.join('\n')}`)
          })
        return `${marker} is visible`
      } finally {
        await browser.close()
      }
    },
  ],
  [
    'hello tool answers from the user extension',
    async (url) => {
      await post(url, '/api/conversations/1/submit', { text: 'hello' })
      await until(`the hello tool result`, seconds(60), async () =>
        toolResults(await history(url), 'hello').includes(helloText),
      )
      return helloText
    },
  ],
  [
    'bash and edit tools run in the project',
    async (url) => {
      await post(url, '/api/conversations/1/submit', { text: 'demo' })
      await until('## Complete', seconds(90), async () =>
        (await history(url)).includes('## Complete'),
      )
      const content = readFileSync(join(project, 'scratch.txt'), 'utf8')
      if (content !== 'after\n') throw new Error(`scratch.txt is ${JSON.stringify(content)}`)
      return 'scratch.txt is after'
    },
  ],
]

async function halt() {
  if (supervisor?.pid && supervisor.exitCode === null) {
    if (process.platform === 'win32') killTree(supervisor.pid)
    else supervisor.kill('SIGTERM')
    await until('the supervisor to exit', seconds(30), () => supervisor!.exitCode !== null).catch(
      () => supervisor!.kill('SIGKILL'),
    )
  }
  return [supervisor?.pid, corePid].filter((pid): pid is number => !!pid && alive(pid))
}

async function stop() {
  await tabBrowser?.close()
  const leaked = await halt()
  if (logPath && existsSync(join(home, 'supervisor.log')))
    copyFileSync(join(home, 'supervisor.log'), logPath + '.supervisor.log')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  if (leaked.length) throw new Error(`still running after cleanup: ${leaked.join(', ')}`)
  if (existsSync(root)) throw new Error(`could not remove ${root}`)
}

async function freePort() {
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
  const { port } = probe.address() as { port: number }
  await new Promise((done) => probe.close(done))
  return port
}

async function start(port: number) {
  output = ''
  supervisor = spawn(process.execPath, [join(clone, 'bin/ultimate.ts'), project, '--no-open'], {
    cwd: clone,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('ULTIMATE_')),
      ),
      ...model.env,
      HOME: userHome,
      USERPROFILE: userHome,
      ULTIMATE_HOME: home,
      ULTIMATE_USER_HOME: userHome,
      ULTIMATE_PORT: String(port),
      ULTIMATE_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const collect = (chunk: Buffer) => {
    output += chunk
    if (logPath) appendFileSync(logPath, chunk)
  }
  supervisor.stdout!.on('data', collect)
  supervisor.stderr!.on('data', collect)
  supervisor.on('exit', (code) => (output += `\n[supervisor exited with ${code}]\n`))
  await until('"Ultimate: http://" in the supervisor output', seconds(120), () =>
    /Ultimate: http:\/\/\S+/.test(output),
  )
  const url = /Ultimate: (http:\/\/\S+)/.exec(output)![1]
  console.log(`supervisor up at ${url}`)
  return url
}

async function leaveTabOpen(url: string) {
  tabBrowser = await launchBrowser()
  if (!tabBrowser) return undefined
  const tab = await tabBrowser.newPage()
  await tab.goto(url)
  await tab
    .locator('textarea')
    .first()
    .waitFor({ timeout: seconds(90) })
  if (await tab.getByText(marker).count())
    throw new Error(`${marker} shown before the extension exists`)
  return tab
}

async function tabShowsExtensionAfterRestart(tab: Page) {
  await tab
    .getByText(marker)
    .first()
    .waitFor({ timeout: seconds(90) })
    .catch((error: unknown) => {
      throw new Error(`the tab left open never showed ${marker}: ${describe(error)}`)
    })
}

const model = await scriptedModel(answer)
try {
  mkdirSync(project)
  mkdirSync(join(userHome, '.ultimate/extensions'), { recursive: true })
  mkdirSync(home)
  writeFileSync(join(userHome, '.ultimate/onboarding.json'), '{"firstRunDone":true}\n')
  if (process.platform === 'win32') {
    const gitFolder = process.env.PATH?.split(delimiter).find((folder) =>
      existsSync(join(folder, 'git.exe')),
    )
    const bash = gitFolder && gitBashPath({ env: { PATH: gitFolder } })
    if (!bash) throw new Error(`Git Bash is not found from git.exe's folder ${gitFolder}`)
    console.log(`ok   Git Bash found from git.exe's folder alone (${bash})`)
  }
  run('git', ['init', '--quiet'])
  const identity = ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com']
  writeFileSync(join(project, 'README.md'), '# smoke\n')
  run('git', ['add', '.'])
  run('git', [...identity, 'commit', '--quiet', '-m', 'first'])
  if (logPath) writeFileSync(logPath, '')
  const port = await freePort()
  const firstUrl = await start(port)
  const tab = await leaveTabOpen(firstUrl)
  console.log(
    `ok   first start without the user extension (${tab ? 'tab left open' : 'no browser'})`,
  )
  await halt()
  cpSync(fixture, join(userHome, '.ultimate/extensions/hello'), { recursive: true })
  const url = await start(port)
  if (tab) {
    await tabShowsExtensionAfterRestart(tab)
    console.log(`ok   the tab left open shows ${marker} after the restart, without a reload`)
  }
  for (const [name, check] of checks) {
    const started = Date.now()
    const detail = await within(seconds(300), check(url), () => new Error('check timed out'))
    console.log(`ok   ${name} (${detail}, ${Math.round((Date.now() - started) / 1000)}s)`)
  }
} catch (error) {
  status = 1
  console.log(`FAIL ${describe(error)}`)
  console.log(`--- supervisor output (tail) ---\n${output.split('\n').slice(-60).join('\n')}`)
  const log = join(home, 'supervisor.log')
  if (existsSync(log))
    console.log(
      `--- supervisor.log (tail) ---\n${readFileSync(log, 'utf8').split('\n').slice(-60).join('\n')}`,
    )
}
try {
  await model.close()
  await stop()
  console.log('ok   cleanup: supervisor tree stopped, temp directories removed')
} catch (error) {
  status = 1
  console.log(`FAIL cleanup: ${describe(error)}`)
}
process.exit(status)
