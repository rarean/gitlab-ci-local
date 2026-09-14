# gitlab-ci-local MCP server

Optional MCP wrapper for harnesses that prefer tools over shell. It is a dumb
adapter: every tool shells out to the `gitlab-ci-local` CLI and nothing else —
no logic lives here, so the CLI stays the single source of truth (see the
[Agent & CI-bot usage](../../../README.md#agent--ci-bot-usage) contract).

This package is standalone; installing it changes nothing about the main
project's dependencies.

## Tools

| Tool | Maps to |
|---|---|
| `list_jobs(cwd)` | `gitlab-ci-local --list-json` |
| `run_jobs(cwd, jobs?, needs?, onlyNeeds?, stage?, variables?, cache?, stateDir?)` | job/stage selection + `--report-json` (temp file), returns the parsed report plus `cliExitCode` |
| `get_log(cwd, job, tailLines?, stateDir?)` | reads `<stateDir>/output/<job>.log` |
| `clear_cache(cwd, stateDir?)` | `gitlab-ci-local --clear-cache` |

`run_jobs` never throws on job failure: a non-zero CLI exit code is returned
inside the payload so the caller can branch on the report instead.

## Install and run

```bash
cd contrib/mcp-server
bun install
bun start                      # stdio transport, speaks MCP on stdin/stdout
```

The CLI is expected on `PATH` as `gitlab-ci-local`; point
`GITLAB_CI_LOCAL_BIN` at something else (a shim script, a checkout) to
override. Do not use a `GCL_`-prefixed name: the CLI maps `GCL_*`
environment variables to options, so such a name would leak into every
invocation it makes.

Claude Code example:

```bash
claude mcp add gitlab-ci-local -- sh -c 'cd /path/to/gitlab-ci-local/contrib/mcp-server && GITLAB_CI_LOCAL_BIN=/path/to/gitlab-ci-local bun src/index.ts'
```

## Test

The smoke test lives with the repo's other tests and is skipped automatically
while this package's dependencies are not installed:

```bash
cd contrib/mcp-server && bun install && cd ../..
bunx vitest run tests/mcp-server.test.ts
```

It spawns the server over stdio, performs the MCP handshake, and round-trips
`list_jobs` against a `tests/test-cases/` fixture through a shim that runs the
checkout's `src/index.ts` — proving the wrapper adds no behavior the CLI
doesn't have.
