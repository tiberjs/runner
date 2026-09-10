import ts from "typescript";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: false,
  plugins: [
    {
      name: "tiber-typescript",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith(".ts") || id.includes("/node_modules/")) {
          return;
        }

        const result = ts.transpileModule(code, {
          fileName: id,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            verbatimModuleSyntax: true,
            sourceMap: true,
          },
        });

        return { code: result.outputText, map: result.sourceMapText };
      },
    },
  ],
  test: {
    name: "@tiberjs/runner",
    environment: "node",
    pool: "forks",
    restoreMocks: true,
    include: ["tests/**/*.test.ts"],
  },
});
