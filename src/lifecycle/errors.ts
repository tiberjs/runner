/** Preserve a sole failure by identity; aggregate only when several were retained. */
export function combinedError(
  errors: readonly unknown[],
  message = "Multiple operations failed.",
): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}
