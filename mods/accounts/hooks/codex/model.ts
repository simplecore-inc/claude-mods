// Adapted from the codex plugin of alex2481kobe/claude-mods (Apache License 2.0); see THIRD_PARTY_NOTICES.md.

import { homeDirectory } from '../credentials'
import type { Io } from '../io'

// What Codex runs with: its config.toml's top-level model and reasoning
// effort, under what a codex agent's prompt chose.

export type Choice = { model?: string; effort?: string }

export function configOf(toml: string): Choice {
  const choice: Choice = {}
  for (const line of toml.split('\n')) {
    const text = line.trim()
    if (text.startsWith('[')) break
    const pair = /^([A-Za-z_]+)\s*=\s*["']([^"']+)["']/.exec(text)
    if (pair?.[1] === 'model') choice.model = pair[2]
    if (pair?.[1] === 'model_reasoning_effort') choice.effort = pair[2]
  }
  return choice
}

// Codex model ids as people say them: `gpt-6.1-sol` reads `Sol 6.1`. An id
// of another shape is shown as it is.
export function nameOf(id: string): string {
  const match = /^gpt-([\d.]+)-([a-z]+)$/i.exec(id)
  const word = match?.[2]
  if (!match || !word) return id
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} ${match[1]}`
}

// `Sol 6.1 (high)`: the chosen model and effort over the config's. With
// neither naming a model, Codex picks its own; which one is known only once
// Codex runs (each turn's header names it), so the label says so.
export function labelOf(config: Choice, options: Choice): string {
  const id = options.model ?? config.model
  const model = id ? nameOf(id) : 'Codex default'
  const effort = options.effort ?? config.effort
  return effort ? `${model} (${effort})` : model
}

// The model ids Codex's model cache lists, newest first as it keeps them;
// empty when the cache is missing or its shape is not the one read here.
export function modelsOf(json: string): string[] {
  try {
    const cache = JSON.parse(json)
    const list = Array.isArray(cache) ? cache : (cache?.models ?? cache?.data)
    if (!Array.isArray(list)) return []
    return list.map((m: any) => m?.slug ?? m?.id).filter((s: unknown): s is string => typeof s === 'string')
  } catch (error) {
    if (error instanceof SyntaxError) return []
    throw error
  }
}

// Codex's own folder: `CODEX_HOME`, else `~/.codex`.
export async function codexHome(io: Io): Promise<string> {
  return (await io.env('CODEX_HOME')) || `${await homeDirectory(io)}/.codex`
}

// A file of Codex's folder; empty when it is not there.
async function readOr(io: Io, name: string): Promise<string> {
  const path = `${await codexHome(io)}/${name}`
  return (await io.exists(path)) ? io.read(path) : ''
}

// The model and effort Codex's config.toml names; empty when it names none.
export async function codexConfig(io: Io): Promise<Choice> {
  return configOf(await readOr(io, 'config.toml'))
}

// The model ids Codex's model cache lists.
export async function codexModels(io: Io): Promise<string[]> {
  return modelsOf(await readOr(io, 'models_cache.json'))
}
