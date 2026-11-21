import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { arch, release, tmpdir, type } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { exec } from '../lib/exec.ts'
import { gitBashPath } from '../lib/shell.ts'
import { system32, windowsIdentity } from '../lib/process-tree.ts'

type Level = 'PASS' | 'WARN' | 'FAIL' | 'SKIP' | 'INFO'
type Finding = [Level, string, string?]

const clone = resolve(import.meta.dirname, '..')
const windows = process.platform === 'win32'
const pinned = /pnpm@([\d.]+)/.exec(
  (JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8')) as { packageManager: string })
    .packageManager,
)![1]
const tally: Record<Level, number> = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0, INFO: 0 }

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; shell?: boolean } = {},
) {
  try {
    const { stdout, stderr } = await exec(command, args, { timeout: 20_000, ...options })
    return { ok: true as const, out: (stdout || stderr).trim() }
  } catch (error) {
    const failure = error as { code?: string | number; stderr?: string; message: string }
    const detail = (failure.stderr || failure.message).trim().split('\n').slice(0, 3).join(' | ')
    return { ok: false as const, out: `${failure.code ?? 'error'}: ${detail}` }
  }
}
const version = (text: string) => text.match(/\d+(?:\.\d+)+/)?.[0] ?? text
const older = (found: string, wanted: string) =>
  found.localeCompare(wanted, undefined, { numeric: true }) < 0
const windowsOnly = (check: () => Promise<Finding[]>): Promise<Finding[]> =>
  windows ? check() : Promise.resolve([['SKIP', 'only checked on Windows']])

const nativeBlocked =
  'Company policy (AppLocker, WDAC or antivirus) probably blocks unsigned programs inside node_modules. Ask IT to allow this folder, or use a clone path they already trust.'
const tlsCodes = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_']

async function reach(url: string, optional = false): Promise<Finding[]> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    return [['PASS', `HTTP ${response.status}`]]
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const code = cause?.code ?? cause?.message ?? String(error)
    const tls = tlsCodes.some((part) => code.includes(part))
    const hint = tls
      ? 'A company proxy re-signs HTTPS. Try: set NODE_USE_SYSTEM_CA=1, then start a new terminal.'
      : 'Check the network, VPN or proxy (HTTPS_PROXY).'
    return [[optional ? 'WARN' : 'FAIL', code, optional ? `Optional. ${hint}` : hint]]
  }
}

const checks: [string, () => Promise<Finding[]>][] = [
  ['OS', async () => [['PASS', `${type()} ${release()} ${arch()} (${process.platform})`]]],
  [
    'Node >= 26',
    async () => [
      Number(process.versions.node.split('.')[0]) >= 26
        ? ['PASS', process.version]
        : [
            'FAIL',
            process.version,
            'Install Node 26 LTS (zip or per-user installer) and open a new terminal.',
          ],
    ],
  ],
  [
    `pnpm ${pinned}`,
    async () => {
      const found = await run('pnpm', ['--version'], { shell: windows })
      if (!found.ok) return [['FAIL', found.out, `Run: npm i -g pnpm@${pinned}`]]
      return [
        found.out === pinned
          ? ['PASS', found.out]
          : ['WARN', found.out, `package.json pins ${pinned}. Run: npm i -g pnpm@${pinned}`],
      ]
    },
  ],
  [
    'git version',
    async () => {
      const found = await run('git', ['--version'])
      if (!found.ok)
        return [
          ['FAIL', found.out, 'Install Git for Windows 2.54 or newer and open a new terminal.'],
        ]
      return [
        older(version(found.out), '2.54')
          ? [
              'WARN',
              found.out,
              'Older than 2.54: commit attribution hooks are silently ignored. Update Git for Windows.',
            ]
          : ['PASS', found.out],
      ]
    },
  ],
  [
    'git.exe path',
    () =>
      windowsOnly(async () => {
        const found = await run('where.exe', ['git'])
        return [
          found.ok
            ? ['PASS', found.out.split('\n')[0]]
            : [
                'FAIL',
                found.out,
                'git.exe is not on PATH. Add its Cmd folder, e.g. %LOCALAPPDATA%\\Programs\\Git\\cmd.',
              ],
        ]
      }),
  ],
  [
    'Git Bash (for the bash tool)',
    () =>
      windowsOnly(async () => {
        const bash = gitBashPath()
        if (!bash)
          return [
            [
              'FAIL',
              'not found next to git.exe or in the usual install folders',
              'Reinstall Git for Windows, or set "shellPath" in %USERPROFILE%\\.pi\\agent\\settings.json to your bash.exe.',
            ],
          ]
        const shown = await run(bash, ['--version'])
        const printed = await run(bash, ['-c', 'printf ok'])
        return [
          ['PASS', bash],
          shown.ok ? ['PASS', shown.out.split('\n')[0]] : ['FAIL', shown.out, nativeBlocked],
          printed.ok && printed.out === 'ok'
            ? ['PASS', "bash -c 'printf ok' printed ok"]
            : ['FAIL', printed.out, nativeBlocked],
        ]
      }),
  ],
  [
    'bash.exe first on PATH is not the WSL launcher',
    () =>
      windowsOnly(async () => {
        const found = await run('where.exe', ['bash'])
        const first = found.ok ? found.out.split('\n')[0] : ''
        return [
          first.toLowerCase().includes(`${win32.sep}system32${win32.sep}`)
            ? [
                'WARN',
                first,
                'This is the WSL launcher. Ultimate finds Git Bash itself; do not rely on PATH for bash.',
              ]
            : ['PASS', first || 'no bash.exe on PATH (Ultimate finds Git Bash from git.exe)'],
        ]
      }),
  ],
  [
    'tasklist and taskkill (process identity and tree kill)',
    () =>
      windowsOnly(async () => {
        let own: string | undefined
        let ownFailure: string | undefined
        try {
          own = windowsIdentity(process.pid)
        } catch (error) {
          ownFailure = (error as Error).message.split('\n')[0]
        }
        const killer = await run(system32('taskkill.exe'), ['/?'])
        return [
          own?.endsWith(`:${process.pid}`)
            ? ['PASS', `tasklist sees this process as ${own}`]
            : [
                'FAIL',
                ownFailure ?? String(own),
                'Ultimate identifies its processes with tasklist.exe, which is blocked or missing here.',
              ],
          killer.ok
            ? ['PASS', 'taskkill.exe runs']
            : ['FAIL', killer.out, 'Ultimate stops process trees with taskkill.exe.'],
        ]
      }),
  ],
  [
    'LongPathsEnabled',
    () =>
      windowsOnly(async () => {
        const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem'
        const found = await run('reg', ['query', key, '/v', 'LongPathsEnabled'])
        return [
          found.ok && /0x1\b/.test(found.out)
            ? ['PASS', 'LongPathsEnabled = 1']
            : [
                'WARN',
                found.out,
                'Long paths are off. Needs admin to change; keep the clone path short (C:\\ult).',
              ],
        ]
      }),
  ],
  [
    'git core.longpaths',
    async () => {
      const found = await run('git', ['config', '--global', '--get', 'core.longpaths'])
      return [
        found.ok && found.out === 'true'
          ? ['PASS', 'true']
          : [
              'WARN',
              found.ok ? found.out : 'unset',
              'Run: git config --global core.longpaths true',
            ],
      ]
    },
  ],
  [
    'git core.autocrlf',
    async () => {
      const found = await run('git', ['config', '--get', 'core.autocrlf'])
      return [['INFO', found.ok ? found.out : 'unset']]
    },
  ],
  [
    'bin/ultimate.ts has LF line endings',
    async () => [
      readFileSync(join(clone, 'bin/ultimate.ts'), 'utf8').includes('\r\n')
        ? [
            'WARN',
            'contains CRLF',
            'Clone the repository again into a new short folder so .gitattributes applies. Do not reset this clone if it holds changes you want to keep.',
          ]
        : ['PASS', 'LF'],
    ],
  ],
  [
    'clone path length',
    async () => [
      clone.length > 40
        ? [
            'WARN',
            `${clone.length} characters: ${clone}`,
            'Long paths break easily on Windows. Clone to a short path such as C:\\ult.',
          ]
        : ['PASS', `${clone.length} characters: ${clone}`],
    ],
  ],
  ['npm registry', () => reach('https://registry.npmjs.org/')],
  ['GitHub codeload', () => reach('https://codeload.github.com/')],
  ['GitHub API', () => reach('https://api.github.com/')],
  ['Anthropic API', () => reach('https://api.anthropic.com/')],
  ['GitHub Copilot API', () => reach('https://api.githubcopilot.com/')],
  ['OpenAI Codex login (optional)', () => reach('https://chatgpt.com/', true)],
  [
    'proxy and certificate environment',
    async () =>
      ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA'].map(
        (name): Finding => [
          'INFO',
          `${name}=${process.env[name]?.replace(/\/\/[^/@\s]*@/, '//***@') ?? '(unset)'}`,
        ],
      ),
  ],
  [
    'claude CLI (claude-code provider)',
    async () => {
      const found = await run('claude', ['--version'], { shell: windows })
      return [
        found.ok
          ? ['PASS', found.out]
          : [
              'WARN',
              found.out,
              'The claude-code provider needs the claude CLI on PATH and logged in. Run: claude',
            ],
      ]
    },
  ],
  [
    'symlinks (previews only, off on Windows)',
    async () => {
      const folder = mkdtempSync(join(tmpdir(), 'doctor-'))
      try {
        writeFileSync(join(folder, 'target'), '')
        symlinkSync(join(folder, 'target'), join(folder, 'link'))
        return [['INFO', 'can create symlinks']]
      } catch (error) {
        return [['INFO', `cannot create symlinks: ${(error as Error).message}`]]
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    },
  ],
  [
    'native tsc from node_modules runs',
    async () => {
      const found = await run(
        process.execPath,
        [join(clone, 'node_modules/typescript/bin/tsc'), '--version'],
        { cwd: clone },
      )
      return [found.ok ? ['PASS', found.out] : ['FAIL', found.out, nativeBlocked]]
    },
  ],
  [
    'vite-plus native addon loads',
    async () => {
      try {
        await import('vite-plus')
        return [['PASS', 'import(vite-plus) worked']]
      } catch (error) {
        return [['FAIL', (error as Error).message.split('\n')[0], nativeBlocked]]
      }
    },
  ],
  [
    'node:sqlite opens a database',
    async () => {
      try {
        const { DatabaseSync } = await import('node:sqlite')
        new DatabaseSync(':memory:').close()
        return [['PASS', 'in-memory DatabaseSync opened']]
      } catch (error) {
        return [
          [
            'FAIL',
            (error as Error).message,
            'node:sqlite needs Node 26. Check the Node version above.',
          ],
        ]
      }
    },
  ],
]

for (const [name, check] of checks) {
  for (const [level, evidence, hint] of await check()) {
    tally[level]++
    console.log(`${level.padEnd(4)} ${name}: ${evidence}`)
    if (hint && (level === 'WARN' || level === 'FAIL')) console.log(`     -> ${hint}`)
  }
}
const verdict = tally.FAIL
  ? `NOT READY: ${tally.FAIL} failed, ${tally.WARN} warnings. Paste this whole report back.`
  : tally.WARN
    ? `PROBABLY READY: ${tally.WARN} warnings to look at. Paste this whole report back.`
    : 'READY: every check passed.'
console.log(`\nVERDICT: ${verdict}`)
process.exit(tally.FAIL ? 1 : 0)
