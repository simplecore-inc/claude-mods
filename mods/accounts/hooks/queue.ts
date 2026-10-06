/**
 * Work run one piece at a time, in the order asked: each piece starts once
 * the one before has settled, whether it resolved or threw, and its own
 * result or error goes to its caller alone.
 *
 * A piece must not wait on another piece of the same queue: it would wait
 * for itself.
 */
export function serialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()

  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => undefined)

    return run
  }
}
