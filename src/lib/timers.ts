/**
 * Wrap a Node timer so it never keeps the event loop alive. `unref`
 * is present on Node's `Timeout` but not on the DOM timer type Jest
 * emits; we guard defensively so the call is portable.
 */
export function unrefTimer(timer: unknown): void {
  if (
    timer &&
    typeof (timer as { unref?: () => void }).unref === 'function'
  ) {
    (timer as { unref: () => void }).unref();
  }
}
