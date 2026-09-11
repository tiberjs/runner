import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { rspack } from "@rspack/core";
import type { Configuration } from "@rspack/core";
import { expect, test } from "vitest";

const runNode = promisify(execFile);

test("the production bundle preserves call body and cancellation failures", async () => {
  // Load the actual JavaScript build config without a test-only declaration module.
  const configUrl = new URL("../rspack.config.mjs", import.meta.url);
  const { default: config } = (await import(configUrl.href)) as { default: Configuration };
  const outputPath = await mkdtemp(path.join(tmpdir(), "runner-bundle-"));
  try {
    const compiler = rspack({
      ...config,
      output: { ...config.output, path: outputPath, filename: "index.mjs" },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        compiler.run((error, stats) => {
          if (error) {
            reject(error);
          } else if (!stats || stats.hasErrors()) {
            reject(new Error(stats?.toString({ all: false, errors: true }) ?? "No build stats"));
          } else {
            resolve();
          }
        });
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        compiler.close((error) => (error ? reject(error) : resolve()));
      });
    }

    // Native Node loading must exercise the emitted helpers, not Vitest's source transform.
    const { stdout } = await runNode(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        const { call, execute } = await import(process.argv[1]);
        const controller = new AbortController();
        const bodyCause = new Error("body cause");
        const cancelCause = new Error("cancel cause");
        const bodyFailure = new Error("body failed", { cause: bodyCause });
        const cancelFailure = new Error("cancel failed", { cause: cancelCause });
        const failure = await execute({ signal: controller.signal }, () =>
          call(({ onCancel }) => {
            onCancel(async () => { throw cancelFailure; });
            controller.abort(new Error("stop"));
            throw bodyFailure;
          }),
        ).catch(error => error);
        console.log(JSON.stringify({
          name: failure?.name,
          cancellation: failure?.error === cancelFailure,
          operation: failure?.suppressed === bodyFailure,
          cancellationCause: failure?.error?.cause === cancelCause,
          operationCause: failure?.suppressed?.cause === bodyCause,
        }));
      `,
      pathToFileURL(path.join(outputPath, "index.mjs")).href,
    ]);
    expect(JSON.parse(stdout)).toEqual({
      name: "SuppressedError",
      cancellation: true,
      operation: true,
      cancellationCause: true,
      operationCause: true,
    });
  } finally {
    await rm(outputPath, { recursive: true, force: true });
  }
}, 30_000);
