/**
 * The tasks a project's build files offer, read from the files alone: nothing
 * here runs a build tool. The hooks module reads the files (`relative path →
 * text`) and says which others exist; each reader below turns one ecosystem's
 * files into tasks to add as tools.
 */
import type { DetectedTask } from '../types'

/** The files the detectors read, from the project's root; a workspace package's `package.json` is added by the caller. */
export const BUILD_FILES = [
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'Cargo.toml',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  '.justfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'go.mod',
  'pyproject.toml',
]

/** Files whose presence alone says something: a lockfile's runner, a wrapper script, a Vite config. */
export const MARKER_FILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'package-lock.json',
  'mvnw',
  'gradlew',
  'uv.lock',
  'poetry.lock',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
]

/** The package manager a project's lockfile names; npm without one. */
export function packageRunner(exists: ReadonlySet<string>): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (exists.has('pnpm-lock.yaml')) return 'pnpm'
  if (exists.has('yarn.lock')) return 'yarn'
  if (exists.has('bun.lockb') || exists.has('bun.lock')) return 'bun'

  return 'npm'
}

/** The folder globs a root `package.json` names as workspaces (`packages/*`), from either form it takes. */
export function workspaceGlobs(packageJson: string): string[] {
  const data = JSON.parse(packageJson) as { workspaces?: unknown }
  const raw = Array.isArray(data.workspaces) ? data.workspaces : (data.workspaces as { packages?: unknown } | undefined)?.packages

  return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === 'string') : []
}

function npmTasks(files: Record<string, string>, exists: ReadonlySet<string>): DetectedTask[] {
  const runner = packageRunner(exists)
  const tasks: DetectedTask[] = []
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('package.json')) continue
    let data: { name?: unknown; scripts?: Record<string, unknown> }
    try {
      data = JSON.parse(text) as typeof data
    } catch {
      continue
    }
    const folder = path.slice(0, -'package.json'.length).replace(/\/$/, '')
    for (const [script, command] of Object.entries(data.scripts ?? {})) {
      if (typeof command !== 'string') continue
      const where = folder === '' ? '' : ` (${typeof data.name === 'string' ? data.name : folder})`
      tasks.push({
        source: 'npm',
        name: `${script}${where}`,
        run: runner === 'npm' ? `npm run ${script}` : `${runner} run ${script}`,
        ...(folder ? { cwd: folder } : {}),
        description: command,
      })
    }
  }

  return tasks
}

function viteTasks(files: Record<string, string>, exists: ReadonlySet<string>): DetectedTask[] {
  if (![...exists].some(name => /^vite\.config\.[mc]?[jt]s$/.test(name))) return []
  // A script that already runs Vite is the way the project means it run: those come from npm.
  const scripts = files['package.json'] ? Object.values((JSON.parse(files['package.json']) as { scripts?: Record<string, unknown> }).scripts ?? {}) : []
  // Whether a script runs Vite this way: the dev server as `vite`, `vite dev` or `vite serve`.
  const runsVite = (pattern: RegExp) => scripts.some(command => typeof command === 'string' && pattern.test(command))
  const runner = packageRunner(exists)
  const exec = runner === 'npm' ? 'npx' : runner === 'pnpm' ? 'pnpm exec' : runner === 'yarn' ? 'yarn' : 'bunx'

  return [
    { verb: '', name: 'dev server', description: 'vite', pattern: /\bvite(\s+(dev|serve))?\s*($|&&|;|\s-)/ },
    { verb: 'build', name: 'build', description: 'vite build', pattern: /\bvite\s+build\b/ },
    { verb: 'preview', name: 'preview', description: 'vite preview', pattern: /\bvite\s+preview\b/ },
  ]
    .filter(({ pattern }) => !runsVite(pattern))
    .map(({ verb, name, description }) => ({ source: 'vite', name, run: `${exec} vite${verb ? ` ${verb}` : ''}`, description }))
}

function mavenTasks(files: Record<string, string>, exists: ReadonlySet<string>): DetectedTask[] {
  const pom = files['pom.xml']
  if (!pom) return []
  const mvn = exists.has('mvnw') ? './mvnw' : 'mvn'
  const tasks: DetectedTask[] = ['clean', 'compile', 'test', 'package', 'verify', 'install', 'clean install'].map(goal => ({
    source: 'maven',
    name: goal,
    run: `${mvn} ${goal}`,
  }))
  const modules = [...pom.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map(match => match[1] ?? '')
  if (modules.length > 0) {
    tasks.push({
      source: 'maven',
      name: 'one module: goal',
      run: `${mvn} -pl {{module}} -am {{goal}}`,
      description: 'a goal for one module and what it needs',
      params: {
        module: { type: 'choice', mode: 'ask', choices: modules },
        goal: { type: 'choice', mode: 'ask', choices: ['compile', 'test', 'package', 'install'], value: 'test' },
      },
    })
  }
  if (/<artifactId>\s*spring-boot-maven-plugin\s*<\/artifactId>/.test(pom)) tasks.push({ source: 'maven', name: 'spring-boot:run', run: `${mvn} spring-boot:run` })

  return tasks
}

/** The subprojects `settings.gradle(.kts)` includes, as `:a:b`. */
export function gradleProjects(settings: string): string[] {
  const found: string[] = []
  for (const line of settings.split('\n')) {
    if (!/^\s*include\b/.test(line)) continue
    for (const match of line.matchAll(/["']([^"']+)["']/g)) found.push(`:${(match[1] ?? '').replace(/^:/, '')}`)
  }

  return [...new Set(found)]
}

function gradleTasks(files: Record<string, string>, exists: ReadonlySet<string>): DetectedTask[] {
  const build = files['build.gradle'] ?? files['build.gradle.kts']
  const settings = files['settings.gradle'] ?? files['settings.gradle.kts']
  if (build === undefined && settings === undefined) return []
  const gradle = exists.has('gradlew') ? './gradlew' : 'gradle'
  const tasks: DetectedTask[] = ['build', 'clean', 'test', 'check', 'assemble'].map(task => ({ source: 'gradle', name: task, run: `${gradle} ${task}` }))
  if (/org\.springframework\.boot/.test(build ?? '')) tasks.push({ source: 'gradle', name: 'bootRun', run: `${gradle} bootRun` })
  if (/\bapplication\b/.test(build ?? '')) tasks.push({ source: 'gradle', name: 'run', run: `${gradle} run` })
  const projects = gradleProjects(settings ?? '')
  if (projects.length > 0) {
    tasks.push({
      source: 'gradle',
      name: 'one project: task',
      run: `${gradle} {{project}}:{{task}}`,
      description: 'a task for one subproject',
      params: {
        project: { type: 'choice', mode: 'ask', choices: projects },
        task: { type: 'text', mode: 'ask', value: 'test' },
      },
    })
  }

  return tasks
}

/** Gradle's own task list (`gradle tasks --all`): each `name - description` line under a heading. */
export function parseGradleTaskList(output: string, gradle: string): DetectedTask[] {
  const tasks: DetectedTask[] = []
  for (const line of output.split('\n')) {
    const match = /^([A-Za-z][\w:.-]*)(?: - (.*))?$/.exec(line.trim())
    if (!match?.[1] || /^-+$/.test(line.trim()) || line.includes(' tasks') || line.trim().endsWith('tasks')) continue
    if (line.startsWith(' ') || !match[2]) continue
    tasks.push({ source: 'gradle', name: match[1], run: `${gradle} ${match[1]}`, description: match[2] })
  }

  return tasks
}

/** A TOML array of strings after `key =` in `section`, as found; empty when absent. */
function tomlStrings(text: string, section: string, key: string): string[] {
  const body = new RegExp(`^\\[${section.replace(/[.[\]]/g, match => `\\${match}`)}\\]\\s*$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? ''
  const array = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(body)?.[1] ?? ''

  return [...array.matchAll(/["']([^"']+)["']/g)].map(match => match[1] ?? '')
}

function cargoTasks(files: Record<string, string>): DetectedTask[] {
  const toml = files['Cargo.toml']
  if (toml === undefined) return []
  const tasks: DetectedTask[] = ['build', 'build --release', 'test', 'check', 'clippy', 'fmt', 'run'].map(command => ({
    source: 'cargo',
    name: command,
    run: `cargo ${command}`,
  }))
  const members = tomlStrings(toml, 'workspace', 'members')
  if (members.length > 0) {
    tasks.push({
      source: 'cargo',
      name: 'one package: command',
      run: 'cargo {{command}} -p {{package}}',
      description: 'a command for one workspace member',
      params: {
        package: { type: 'choice', mode: 'ask', choices: members.map(member => member.split('/').pop() ?? member) },
        command: { type: 'choice', mode: 'ask', choices: ['build', 'test', 'check', 'clippy', 'run'], value: 'test' },
      },
    })
  }
  const bins = [...toml.matchAll(/^\[\[bin\]\][^[]*?^\s*name\s*=\s*["']([^"']+)["']/gms)].map(match => match[1] ?? '')
  for (const bin of bins) tasks.push({ source: 'cargo', name: `run ${bin}`, run: `cargo run --bin ${bin}` })

  return tasks
}

function makeTasks(files: Record<string, string>): DetectedTask[] {
  const name = ['Makefile', 'makefile', 'GNUmakefile'].find(file => files[file] !== undefined)
  if (!name) return []
  const targets = new Set<string>()
  for (const line of (files[name] ?? '').split('\n')) {
    const match = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line)
    if (match?.[1] && !match[1].startsWith('.')) targets.add(match[1])
  }

  return [...targets].map(target => ({ source: 'make', name: target, run: `make ${target}` }))
}

function justTasks(files: Record<string, string>): DetectedTask[] {
  const name = ['justfile', 'Justfile', '.justfile'].find(file => files[file] !== undefined)
  if (!name) return []
  const recipes: DetectedTask[] = []
  for (const line of (files[name] ?? '').split('\n')) {
    const match = /^@?([A-Za-z_][\w-]*)((?:\s+[^:=]+)?)\s*:(?!=)/.exec(line)
    if (!match?.[1]) continue
    const args = (match[2] ?? '').trim().split(/\s+/).filter(Boolean).map(arg => arg.replace(/[=+*].*$/, ''))
    recipes.push({
      source: 'just',
      name: match[1],
      run: `just ${match[1]}${args.map(arg => ` {{${arg}}}`).join('')}`,
      ...(args.length > 0 ? { params: Object.fromEntries(args.map(arg => [arg, { type: 'text' as const, mode: 'ask' as const }])) } : {}),
    })
  }

  return recipes
}

/** The service names under a compose file's top-level `services:`. */
export function composeServices(yaml: string): string[] {
  const services: string[] = []
  let isInside = false
  let indent = -1
  for (const line of yaml.split('\n')) {
    if (/^\S/.test(line)) {
      isInside = /^services\s*:/.test(line)
      indent = -1
      continue
    }
    if (!isInside) continue
    const match = /^(\s+)([\w.-]+)\s*:/.exec(line)
    if (!match?.[1] || !match[2]) continue
    if (indent === -1) indent = match[1].length
    if (match[1].length === indent) services.push(match[2])
  }

  return services
}

function composeTasks(files: Record<string, string>): DetectedTask[] {
  const name = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'].find(file => files[file] !== undefined)
  if (!name) return []
  const services = composeServices(files[name] ?? '')
  const tasks: DetectedTask[] = [
    { source: 'compose', name: 'up', run: 'docker compose up' },
    { source: 'compose', name: 'down', run: 'docker compose down' },
    { source: 'compose', name: 'ps', run: 'docker compose ps' },
  ]
  if (services.length > 0) {
    tasks.push({
      source: 'compose',
      name: 'logs of a service',
      run: 'docker compose logs -f {{service}}',
      params: { service: { type: 'choice', mode: 'ask', choices: services } },
    })
  }

  return tasks
}

function goTasks(files: Record<string, string>): DetectedTask[] {
  if (files['go.mod'] === undefined) return []

  return ['build ./...', 'test ./...', 'vet ./...', 'run .'].map(command => ({ source: 'go', name: command, run: `go ${command}` }))
}

function pythonTasks(files: Record<string, string>, exists: ReadonlySet<string>): DetectedTask[] {
  const toml = files['pyproject.toml']
  if (toml === undefined) return []
  const runner = exists.has('uv.lock') ? 'uv run' : exists.has('poetry.lock') ? 'poetry run' : ''
  const prefix = runner ? `${runner} ` : ''
  const body = /^\[project\.scripts\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? ''
  const scripts = [...body.matchAll(/^\s*([\w.-]+)\s*=/gm)].map(match => match[1] ?? '')
  const tasks: DetectedTask[] = scripts.map(script => ({ source: 'python', name: script, run: `${prefix}${script}` }))
  if (/\bpytest\b/.test(toml)) tasks.push({ source: 'python', name: 'pytest', run: `${prefix}pytest` })

  return tasks
}

/** Every task the project's build files offer, grouped by their ecosystem in a fixed order. */
export function detectTasks(files: Record<string, string>, exists: ReadonlySet<string>): DetectedTask[] {
  return [
    ...npmTasks(files, exists),
    ...viteTasks(files, exists),
    ...mavenTasks(files, exists),
    ...gradleTasks(files, exists),
    ...cargoTasks(files),
    ...makeTasks(files),
    ...justTasks(files),
    ...composeTasks(files),
    ...goTasks(files),
    ...pythonTasks(files, exists),
  ]
}
