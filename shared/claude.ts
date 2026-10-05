/** Where Claude Code keeps what it writes per project under its config directory. */

/** The longest project folder name Claude Code writes before it cuts the name and adds a hash. */
const PROJECT_NAME_MAX = 200
/** Claude Code's 32-bit string hash, the one its long project folder names end with. */
function nameHash(text: string): number {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0

  return hash
}

/**
 * The project folder Claude Code names after `root`: every character but a
 * letter or digit becomes `-`, and a name over 200 characters is cut there
 * and ends with `-` and a hash of the whole path, in base 36.
 */
export function projectFolder(root: string): string {
  const name = root.replace(/[^a-zA-Z0-9]/g, '-')
  if (name.length <= PROJECT_NAME_MAX) return name

  return `${name.slice(0, PROJECT_NAME_MAX)}-${Math.abs(nameHash(root)).toString(36)}`
}

/** The transcript Claude Code writes for a session started in `root`, under its config directory. */
export function transcriptPath(configDirectory: string, root: string, session: string): string {
  return `${configDirectory}/projects/${projectFolder(root)}/${session}.jsonl`
}
