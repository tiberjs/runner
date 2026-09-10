import { span } from "../runtime/span.js";

/**
 * Method decorator that wraps the method in a {@link span} named after the
 * method (architecture §13): `@Span method()` desugars to
 * `span("method", () => method())`.
 */
export function Span<This, Args extends unknown[], T>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => Promise<T>>,
): void {
  const value = descriptor?.value;
  if (
    typeof target === "function" ||
    typeof value !== "function" ||
    (typeof key === "string" && key.startsWith("#"))
  ) {
    throw new TypeError("@Span requires a public instance method.");
  }
  const name = String(key);
  const wrapped = function (this: This, ...args: Args): Promise<T> {
    return span(name, () => value.apply(this, args));
  };
  Object.defineProperty(wrapped, "length", { value: value.length });
  descriptor.value = wrapped;
}
