import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import {
  defineWebExtension,
  events,
  plural,
  useCommands,
  useToolDuration,
  useUltimate,
} from '@/sdk'
import type { ToolCallView } from '@/sdk'

interface Result {
  url: string
  title: string | null
  description: string | null
}
type Details =
  | { status: 'success'; query: string; results: Result[] }
  | { status: 'error'; error: string; httpStatus: number | null; quotaExhausted: boolean }

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      className="mr-1.5 h-6 shrink-0 px-2 font-mono text-[11px]"
      onClick={onClick}
      size="xs"
      type="button"
      variant="outline"
    >
      {label}
    </Button>
  )
}

/** For a missing or rejected BRAVE_API_KEY: opens the Secrets panel at it, or, while `secrets` is off, the Extensions panel. */
function KeyAction({ error }: { error: string }) {
  const commands = useCommands()
  const ui = useUltimate()
  if (!error.includes('BRAVE_API_KEY')) return null
  const has = (id: string) => commands.some((command) => command.id === id)
  if (has('secrets.panel'))
    return (
      <Action
        label={error.includes('rejected') ? 'Replace key' : 'Add key'}
        onClick={() => events.emit('secrets:open', { name: 'BRAVE_API_KEY' })}
      />
    )
  if (has('onboarding.extensions'))
    return <Action label="Turn on secrets" onClick={() => ui.runCommand('onboarding.extensions')} />
  return null
}

function Link({
  url,
  className,
  children,
}: {
  url: string
  className?: string
  children: ReactNode
}) {
  return (
    <a className={className} href={url} rel="noreferrer" target="_blank" title={url}>
      {children}
    </a>
  )
}

function Search({ call }: { call: ToolCallView }) {
  const details = call.details as Details | undefined
  const duration = useToolDuration(call)
  const failure = details?.status === 'error' ? details : undefined
  const failed = call.status === 'error'
  const [open, setOpen] = useState(failed)
  const was = useRef(failed)
  useEffect(() => {
    if (failed && !was.current) setOpen(true)
    was.current = failed
  }, [failed])
  const results = (details?.status === 'success' && details.results) || []
  const query = typeof call.args.query === 'string' ? call.args.query : ''
  return (
    <Tool onOpenChange={setOpen} open={open}>
      <div className="flex items-center">
        <ToolHeader
          className="min-w-0 flex-1"
          meta={
            <>
              {details?.status === 'success' && <span>{plural(results.length, 'result')}</span>}
              {failure?.quotaExhausted && <span className="text-error">quota exhausted</span>}
              {duration && <span>{duration}</span>}
            </>
          }
          name="brave_search"
          state={call.status}
          title={<span className="text-foreground/90">{query}</span>}
        />
        {failure && <KeyAction error={failure.error} />}
      </div>
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">searching the web…</Shimmer>
          </ToolSection>
        )}
        {failure ? (
          <ToolSection>
            <div className="break-words text-error">{failure.error}</div>
            {failure.httpStatus && (
              <div className="text-[11px] text-muted-foreground/70">HTTP {failure.httpStatus}</div>
            )}
          </ToolSection>
        ) : details ? (
          results.length > 0 ? (
            <ol aria-label="Search results" className="divide-y divide-border/60">
              {results.map((result, index) => (
                <li className="flex gap-2.5 px-2.5 py-2" key={result.url}>
                  <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      className="block truncate font-sans text-[13px] text-foreground hover:underline"
                      url={result.url}
                    >
                      {result.title || bare(result.url)}
                    </Link>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {host(result.url)}
                    </div>
                    {result.description && (
                      <p className="mt-1 line-clamp-3 font-sans text-[12.5px] leading-snug text-muted-foreground">
                        {result.description}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <ToolSection className="text-muted-foreground/70">no results</ToolSection>
          )
        ) : (
          call.status === 'error' && <ToolOutput isError output={call.output} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics.filter((d) => d.code !== 'tool_error')} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({ tools: { brave_search: Search } })
