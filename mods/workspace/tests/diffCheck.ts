/**
 * What stops the engine reading a page as a diff, by its rule: a hunk is
 * `@@ -a,b +c,d @@` then exactly b lines of ` ` or `-` and d of ` ` or `+`;
 * lines before the first hunk are the file's headers, read past. A page with a
 * problem draws as plain code.
 */
export function hunkProblems(source: string): string[] {
  const problems: string[] = []
  let hunk: { old: number; new: number; at: number } | undefined
  let hunks = 0
  const close = () => {
    if (hunk && (hunk.old !== 0 || hunk.new !== 0)) problems.push(`hunk at line ${hunk.at} is short by -${hunk.old} +${hunk.new}`)
  }
  source.split('\n').forEach((line, index) => {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (header) {
      close()
      hunk = { old: Number(header[1] ?? 1), new: Number(header[2] ?? 1), at: index + 1 }
      hunks += 1
      return
    }
    if (!hunk || line.startsWith('\\')) return
    if (line.startsWith(' ')) {
      hunk.old -= 1
      hunk.new -= 1
    } else if (line.startsWith('-')) hunk.old -= 1
    else if (line.startsWith('+')) hunk.new -= 1
    else problems.push(`line ${index + 1} is no hunk line`)
    if (hunk.old < 0 || hunk.new < 0) problems.push(`hunk at line ${hunk.at} runs past its counts at line ${index + 1}`)
  })
  close()
  if (hunks === 0) problems.push('no hunk')

  return problems
}
