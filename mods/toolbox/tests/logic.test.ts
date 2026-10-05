import { describe, expect, test } from 'claude-code/testing'

import { composeServices, detectTasks, gradleProjects, packageRunner, parseGradleTaskList, workspaceGlobs } from '../hooks/detect'
import { globTest, LogBuffer, pathSuggestions, progressOf, stripAnsi } from '../hooks/paths'
import { elapsed, progressIcon, quickSummary, quickTile, runText } from '../hooks/views/tools'
import { messagesFor } from '../hooks/i18n'
import { askedParams, fill, paramNames, parseTools, settleRuns, summarize, shellQuote, startingValues, toolId, toolsText, valuesProblem, workingFolder } from '../hooks/tools'

describe('a tool\'s command', () => {
  test('names its parameters once each, in order, raw or not', async () => {
    expect(paramNames('mvn -pl {{module}} {{ goal }} {{module}} {{flags|raw}}')).toEqual(['module', 'goal', 'flags'])
  })

  test('in a shell command a value is one quoted word unless raw; a prompt takes it as written', async () => {
    const values = { file: "my docs/it's.md", flags: '-x -y' }
    expect(fill({ kind: 'shell', run: 'cat {{file}} {{flags|raw}}' }, values)).toBe(`cat 'my docs/it'\\''s.md' -x -y`)
    expect(fill({ kind: 'prompt', run: 'Review {{file}}' }, values)).toBe("Review my docs/it's.md")
    expect(shellQuote('src/app.ts')).toBe('src/app.ts')
    expect(shellQuote('')).toBe("''")
  })

  test('asks for the parameters marked ask and those with no setting; fixed ones keep their value', async () => {
    const tool = { run: '{{a}} {{b}} {{c}}', params: { a: { type: 'text' as const, mode: 'fixed' as const, value: 'A' }, b: { type: 'text' as const, mode: 'ask' as const, value: 'B0' } } }
    expect(askedParams(tool)).toEqual(['b', 'c'])
    expect(startingValues(tool, { b: 'B1', a: 'ignored' })).toEqual({ a: 'A', b: 'B1', c: '' })
    expect(valuesProblem({ run: '{{m}}', params: { m: { type: 'choice', mode: 'ask', choices: ['api'] } } }, { m: 'web' })).toBe('m')
  })

  test('runs only inside the project', async () => {
    expect(workingFolder('/p', undefined)).toBe('/p')
    expect(workingFolder('/p', './apps/web')).toBe('/p/apps/web')
    expect(() => workingFolder('/p', '../other')).toThrow()
    expect(() => workingFolder('/p', '/etc')).toThrow()
  })
})

test('the tools file keeps what is whole and names what is not', async () => {
  const text = JSON.stringify({ tools: [{ name: 'dev', kind: 'shell', run: 'pnpm dev' }, { name: 'bad', kind: 'nope', run: 'x' }, { kind: 'shell', run: 'x' }] })
  const { tools, problems } = parseTools(text)
  expect(tools.map(tool => [tool.id, tool.name])).toEqual([['dev', 'dev']])
  expect(problems).toEqual(['tools[1]', 'tools[2]'])
  expect(parseTools(toolsText(tools)).tools).toEqual(tools)
  expect(toolId('Dev Server!', ['dev-server'])).toBe('dev-server-2')
})

describe('build files', () => {
  test('npm scripts run with the lockfile\'s runner, workspace packages in their folder', async () => {
    const files = {
      'package.json': JSON.stringify({ workspaces: ['apps/*'], scripts: { dev: 'vite', build: 'vite build' } }),
      'apps/web/package.json': JSON.stringify({ name: '@x/web', scripts: { test: 'vitest' } }),
    }
    const tasks = detectTasks(files, new Set(['pnpm-lock.yaml', 'vite.config.ts']))
    expect(tasks.filter(task => task.source === 'npm').map(task => [task.name, task.run, task.cwd])).toEqual([
      ['dev', 'pnpm run dev', undefined],
      ['build', 'pnpm run build', undefined],
      ['test (@x/web)', 'pnpm run test', 'apps/web'],
    ])
    // The scripts already run Vite: no Vite task of its own but preview.
    expect(tasks.filter(task => task.source === 'vite').map(task => task.run)).toEqual(['pnpm exec vite preview'])
    expect(packageRunner(new Set())).toBe('npm')
    expect(workspaceGlobs(JSON.stringify({ workspaces: { packages: ['libs/*'] } }))).toEqual(['libs/*'])
  })

  test('Maven gives its lifecycle, its modules as a choice, and spring-boot:run when the plugin is there', async () => {
    const pom = '<project><modules><module>api</module><module>web</module></modules><build><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></build></project>'
    const tasks = detectTasks({ 'pom.xml': pom }, new Set(['mvnw']))
    expect(tasks.map(task => task.run)).toContain('./mvnw clean install')
    expect(tasks.map(task => task.run)).toContain('./mvnw spring-boot:run')
    expect(tasks.find(task => task.run.includes('-pl'))?.params?.module?.choices).toEqual(['api', 'web'])
  })

  test('Gradle gives its subprojects; its own task list is read when asked', async () => {
    expect(gradleProjects("rootProject.name = 'x'\ninclude(\"api\", \":web\")\ninclude 'tools:cli'")).toEqual([':api', ':web', ':tools:cli'])
    const tasks = detectTasks({ 'build.gradle.kts': 'plugins { id("org.springframework.boot") }', 'settings.gradle.kts': 'include("api")' }, new Set(['gradlew']))
    expect(tasks.map(task => task.run)).toContain('./gradlew bootRun')
    expect(tasks.find(task => task.params?.project)?.params?.project?.choices).toEqual([':api'])
    const listed = parseGradleTaskList('Build tasks\n-----------\nbuild - Assembles and tests.\nclean - Deletes the build directory.\n\nRules\n-----\nPattern: clean<TaskName>: Cleans the output.\n', './gradlew')
    expect(listed.map(task => task.name)).toEqual(['build', 'clean'])
  })

  test('Cargo, make, just, compose, go and Python each give theirs', async () => {
    const tasks = detectTasks(
      {
        'Cargo.toml': '[workspace]\nmembers = ["crates/core", "crates/cli"]\n\n[[bin]]\nname = "tool"\npath = "src/main.rs"\n',
        Makefile: 'all: build\nbuild:\n\tgo build\nVAR := 1\n.PHONY: all\n',
        justfile: 'test filter:\n  cargo test {{filter}}\n',
        'compose.yaml': 'services:\n  db:\n    image: postgres\n  web:\n    build: .\nvolumes:\n  data:\n',
        'go.mod': 'module x\n',
        'pyproject.toml': '[project.scripts]\nserve = "x:main"\n\n[tool.pytest.ini_options]\n',
      },
      new Set(['uv.lock']),
    )
    const runs = tasks.map(task => task.run)
    expect(runs).toContain('cargo run --bin tool')
    expect(tasks.find(task => task.run.includes('-p {{package}}'))?.params?.package?.choices).toEqual(['core', 'cli'])
    expect(runs).toEqual(expect.arrayContaining(['make all', 'make build', 'just test {{filter}}', 'go test ./...', 'uv run serve', 'uv run pytest']))
    expect(runs).not.toContain('make VAR')
    expect(composeServices('services:\n  db:\n    image: postgres\n  web:\n    build: .\n')).toEqual(['db', 'web'])
  })
})

describe('paths and logs', () => {
  test('suggests folders then files starting with what was typed, matching the glob', async () => {
    const entries = [
      { name: 'src', kind: 'dir' as const },
      { name: 'scripts', kind: 'dir' as const },
      { name: 'setup.ts', kind: 'file' as const },
      { name: 'setup.md', kind: 'file' as const },
      { name: 'node_modules', kind: 'dir' as const },
      { name: '.secret', kind: 'file' as const },
    ]
    expect(pathSuggestions('s', entries, { glob: '*.ts' })).toEqual(['scripts/', 'src/', 'setup.ts'])
    expect(pathSuggestions('apps/s', entries, { pathKind: 'dir' })).toEqual(['apps/scripts/', 'apps/src/'])
    expect(pathSuggestions('', entries).includes('node_modules/')).toBe(false)
    expect(globTest('*.test.ts')('a.test.ts')).toBe(true)
  })

  test('keeps whole lines as they come, a line cut between pieces joined, colours removed', async () => {
    const buffer = new LogBuffer()
    buffer.push('one\ntw')
    buffer.push('o\r\nthree')
    expect(buffer.lines).toEqual(['one', 'two'])
    buffer.end()
    expect(buffer.lines).toEqual(['one', 'two', 'three'])
    expect(buffer.takePending()).toBe('one\ntwo\nthree\n')
    expect(buffer.window(10)).toEqual({ text: 'two\nthree', first: 1, last: 3 })
    expect(buffer.window(9)).toEqual({ text: 'three', first: 2, last: 3 })
    expect(buffer.window(100, undefined, 1)).toEqual({ text: 'three', first: 2, last: 3 })
    expect(stripAnsi('\u001b[32mok\u001b[0m')).toBe('ok')
  })
})

describe('how far a run has got', () => {
  test('reads the newest percentage or count of a total, and nothing else', async () => {
    expect(progressOf(['Downloading 12%', 'Downloading 45%'])).toBe(45)
    expect(progressOf(['[3/10] Compiling api', 'warning: unused'])).toBe(30)
    expect(progressOf(['update /src/retry.ts (4)', 'GET /api/v1 200'])).toBeUndefined()
    expect(progressOf(['150% faster'])).toBeUndefined()
  })

  test('draws a share as a circle filling by quarters, and time in seconds and minutes', async () => {
    expect([0, 20, 50, 70, 100].map(progressIcon)).toEqual(['○', '◔', '◑', '◕', '●'])
    expect([5_000, 90_000, 3_900_000].map(elapsed)).toEqual(['5s', '1m 30s', '1h 5m'])
  })

  test('a tile says each state in words, in its colour, and blinks what waits', async () => {
    const m = messagesFor('en')
    const tool = { id: 'b', name: 'build', kind: 'shell' as const, run: 'make' }
    const running = quickTile(tool, { state: 'running', startedAt: 0, command: 'make' }, { progress: 50 }, 12_000, m)
    expect([running.icon, running.status, running.ground]).toEqual(['◑', 'running · 12s · 50%', 'ok'])
    const queued = (now: number) => quickTile({ ...tool, kind: 'claude' }, { state: 'queued', startedAt: 0, command: '/clear' }, undefined, now, m)
    expect([queued(0).isLit, queued(500).isLit, queued(0).ground]).toEqual([true, false, 'warn'])
    const failed = quickTile(tool, { state: 'failed', startedAt: 0, endedAt: 3_000, code: 2, command: 'make' }, undefined, 9_000, m)
    expect([failed.icon, failed.status, failed.ground]).toEqual(['✖', 'failed (exit 2) · took 3s · 6s ago', 'danger'])
    expect(quickTile({ ...tool, confirm: true }, undefined, undefined, 0, m).status).toBe('press to run · shell · asks first')
  })

  test('a tool keeps its ask-first setting through the file', async () => {
    expect(parseTools('{"tools":[{"name":"/clear","kind":"claude","run":"/clear","confirm":true}]}').tools[0]?.confirm).toBe(true)
  })
})

test('a reload settles what it no longer holds: a shell run stopped, a Claude command handed over done', async () => {
  const runs = {
    dev: { state: 'running' as const, startedAt: 1, command: 'vite' },
    reload: { state: 'queued' as const, startedAt: 1, command: '/reload-plugins' },
    held: { state: 'queued' as const, startedAt: 1, command: '/compact' },
    old: { state: 'done' as const, startedAt: 1, endedAt: 2, command: 'make' },
  }
  const settled = settleRuns(runs, id => id === 'held', 50)
  expect([settled.dev?.state, settled.reload?.state, settled.held?.state, settled.old?.endedAt]).toEqual(['stopped', 'done', 'queued', 2])
  expect(settled.reload?.endedAt).toBe(50)
})

test('a run says how long it took and how long ago, and the quick view sums up what runs and failed', async () => {
  const m = messagesFor('en')
  expect(runText({ state: 'done', startedAt: 0, endedAt: 3_000, command: 'make' }, 123_000, m)).toBe('done · took 3s · 2m 0s ago')
  expect(runText({ state: 'running', startedAt: 0, command: 'make' }, 5_000, m)).toBe('running · 5s')
  const runs = {
    a: { state: 'running' as const, startedAt: 0, command: 'a' },
    b: { state: 'failed' as const, startedAt: 0, endedAt: 10, command: 'b' },
    c: { state: 'failed' as const, startedAt: 0, endedAt: 30, command: 'c' },
  }
  expect(quickSummary(runs, m)).toEqual({ text: '1 running · 2 failed', tone: 'ok' })
  expect(quickSummary({}, m).text).toMatch(/^Press a tile to run it/)
  // The band counts only failures after the toolbox was last opened.
  expect(summarize(runs, 20)).toEqual({ running: 1, waiting: 0, failed: 1 })
})
