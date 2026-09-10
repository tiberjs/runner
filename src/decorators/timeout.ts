import { timeout } from "../runtime/timeout.js";

/**
 * Method decorator that wraps the method in a {@link timeout} scope
 * (architecture §13): `@Timeout(3000) method()` desugars to
 * `timeout(3000, () => method())`.
 */
export function Timeout(ms: number) {
  return function <This, Args extends unknown[], T>(
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
      throw new TypeError("@Timeout requires a public instance method.");
    }
    const wrapped = function (this: This, ...args: Args): Promise<T> {
      return timeout<T>(ms, () => value.apply(this, args));
    };
    Object.defineProperty(wrapped, "length", { value: value.length });
    descriptor.value = wrapped;
  };
}
