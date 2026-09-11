const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * Schedule a finite absolute deadline (epoch milliseconds). Long waits are
 * rearmed against the clock, avoiding native timer overflow. Even deadlines
 * already in the past run asynchronously. Disposal cancels pending delivery.
 */
export function scheduleDeadline(deadlineAt: number, onElapsed: () => void): Disposable {
  if (!Number.isFinite(deadlineAt)) {
    throw new RangeError("Deadline must be finite.");
  }

  let active = true;
  let timer = setTimeout(
    checkDeadline,
    Math.min(MAX_TIMER_DELAY, Math.max(0, deadlineAt - Date.now())),
  );

  function checkDeadline(): void {
    if (!active) {
      return;
    }

    const remaining = deadlineAt - Date.now();
    if (remaining > 0) {
      timer = setTimeout(checkDeadline, Math.min(MAX_TIMER_DELAY, remaining));
      return;
    }

    active = false;
    onElapsed();
  }

  return {
    [Symbol.dispose]() {
      if (!active) {
        return;
      }
      active = false;
      clearTimeout(timer);
    },
  };
}
