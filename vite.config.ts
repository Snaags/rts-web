import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Pixi v8's normal entry (lib/index.mjs) re-exports lots of submodules and
  // depends on Rollup's tree-shaking + chunking to not break its internal
  // circular dependencies. In some Vite production builds the order works
  // out; in others (this one) it doesn't, and Pixi crashes during init with
  // "WebGL context was lost" (the actual root cause is a circular-dep bug
  // hidden by minification).
  //
  // pixi.js ships a pre-built single-file ESM at dist/pixi.mjs that has
  // everything in one cohesive module, no chunking, no circular deps. We
  // alias every `import ... from "pixi.js"` to that file via an absolute
  // path (the exports field in pixi's package.json doesn't expose this
  // subpath, so we have to bypass it).
  resolve: {
    alias: [
      {
        find: /^pixi\.js$/,
        replacement: pathResolve(
          __dirname,
          "node_modules/pixi.js/dist/pixi.mjs",
        ),
      },
    ],
  },
  build: {
    target: "es2022", // top-level await
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:8080",
        ws: true,
      },
    },
  },
});
