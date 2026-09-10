import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@rspack/cli";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  context: root,
  mode: "production",
  target: "node20",
  externalsType: "module",
  externals: [/^node:/],
  entry: "./src/index.ts",
  devtool: "source-map",
  experiments: {
    outputModule: true,
  },
  output: {
    path: path.join(root, "dist"),
    filename: "index.js",
    clean: true,
    module: true,
    library: {
      type: "module",
    },
  },
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: {
              syntax: "typescript",
            },
            target: "es2022",
          },
        },
      },
    ],
  },
  optimization: {
    minimize: false,
  },
});
