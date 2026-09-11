import { afterEach, expect, test, vi } from "vitest";
import { scheduleDeadline } from "../src/job/deadline.js";

const MAX_TIMER_DELAY = 2 ** 31 - 1;

afterEach(() => vi.useRealTimers());

test("a deadline beyond the native timer limit rearms and fires only when due", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);
  const elapsed = vi.fn();
  const timer = scheduleDeadline(Date.now() + 2 ** 31, elapsed);

  vi.advanceTimersByTime(MAX_TIMER_DELAY);
  expect(elapsed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(elapsed).toHaveBeenCalledTimes(1);

  timer[Symbol.dispose]();
  vi.advanceTimersByTime(MAX_TIMER_DELAY);
  expect(elapsed).toHaveBeenCalledTimes(1);
});

test("disposing a rearmed deadline cancels delivery idempotently", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);
  const elapsed = vi.fn();
  const timer = scheduleDeadline(Date.now() + 2 ** 31, elapsed);

  vi.advanceTimersByTime(MAX_TIMER_DELAY);
  timer[Symbol.dispose]();
  timer[Symbol.dispose]();
  vi.advanceTimersByTime(100);

  expect(elapsed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("already elapsed deadlines are asynchronous and can still be disposed", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);
  const elapsed = vi.fn();
  const cancelled = vi.fn();
  scheduleDeadline(-1, elapsed);
  const timer = scheduleDeadline(1000, cancelled);

  expect(elapsed).not.toHaveBeenCalled();
  expect(cancelled).not.toHaveBeenCalled();
  timer[Symbol.dispose]();
  vi.advanceTimersByTime(0);

  expect(elapsed).toHaveBeenCalledTimes(1);
  expect(cancelled).not.toHaveBeenCalled();
});

test("a backward clock change rearms against the absolute deadline", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);
  const elapsed = vi.fn();
  scheduleDeadline(1100, elapsed);

  vi.setSystemTime(950);
  vi.advanceTimersByTime(100);
  expect(elapsed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(49);
  expect(elapsed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(elapsed).toHaveBeenCalledTimes(1);
});

test("non-finite deadlines reject without admitting a timer", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const elapsed = vi.fn();

  for (const deadlineAt of [NaN, Infinity, -Infinity]) {
    expect(() => scheduleDeadline(deadlineAt, elapsed)).toThrow(RangeError);
  }

  expect(vi.getTimerCount()).toBe(0);
  expect(elapsed).not.toHaveBeenCalled();
});

test("a forward clock jump expires a long deadline at the next timer check", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);
  const elapsed = vi.fn();
  const deadlineAt = Date.now() + MAX_TIMER_DELAY * 3;
  scheduleDeadline(deadlineAt, elapsed);

  vi.setSystemTime(deadlineAt);
  expect(elapsed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(MAX_TIMER_DELAY - 1);
  expect(elapsed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(elapsed).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(MAX_TIMER_DELAY * 2);
  expect(elapsed).toHaveBeenCalledTimes(1);
});

test("an elapsed callback failure is delivered once and leaves no live timer", () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);
  const failure = new Error("deadline callback failed");
  const elapsed = vi.fn(() => {
    throw failure;
  });
  const timer = scheduleDeadline(1100, elapsed);
  let thrown: unknown;
  try {
    vi.advanceTimersByTime(100);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(failure);
  expect(elapsed).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  timer[Symbol.dispose]();
  timer[Symbol.dispose]();
  vi.advanceTimersByTime(100);
  expect(elapsed).toHaveBeenCalledTimes(1);
});
