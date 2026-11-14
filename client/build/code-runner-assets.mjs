import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);

const TYPES = { ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".bin": "application/octet-stream" };
const typeOf = (name) => TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream";

/** A package's folder, found from its entry point (some packages don't export package.json). */
function packageDir(name) {
  for (let directory = dirname(require.resolve(name)); directory !== dirname(directory); directory = dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return directory;
  }
  throw new Error(`Couldn't find the ${name} package.`);
}
function versionOf(name) {
  return JSON.parse(readFileSync(join(packageDir(name), "package.json"), "utf8")).version;
}

/**
 * The runtimes code blocks run on (SQLite, the TypeScript compiler, the Java
 * compiler), served from the app's own origin under /code-runner/. They load
 * only when someone runs a cell in that language, so the offline copy skips
 * them (offline-service-worker.mjs) and the folder names carry each version
 * so a browser cache never mixes two.
 */
export function codeRunnerAssetsPlugin() {
  const sqljs = `sqljs-${versionOf("sql.js")}`;
  const typescript = `typescript-${versionOf("typescript")}`;
  const java = `java-wasm-${versionOf("@live-codes/java-wasm")}`;
  const sources = new Map([
    [`/code-runner/${sqljs}/sql-wasm.js`, join(packageDir("sql.js"), "dist", "sql-wasm.js")],
    [`/code-runner/${sqljs}/sql-wasm.wasm`, join(packageDir("sql.js"), "dist", "sql-wasm.wasm")],
    [`/code-runner/${typescript}/typescript.js`, join(packageDir("typescript"), "lib", "typescript.js")],
    [`/code-runner/${java}/worker-java.js`, join(packageDir("@live-codes/java-wasm"), "dist", "worker-java.js")],
    ...["compiler.wasm", "compiler.wasm-deobfuscator.wasm", "compile-classlib-teavm.bin", "runtime-classlib-teavm.bin"].map((name) =>
      [`/code-runner/${java}/teavm/${name}`, join(packageDir("@live-codes/java-wasm"), "dist", "teavm", name)]),
  ]);
  const urls = {
    sqlGlue: `/code-runner/${sqljs}/sql-wasm.js`,
    sqlWasm: `/code-runner/${sqljs}/sql-wasm.wasm`,
    typescript: `/code-runner/${typescript}/typescript.js`,
    javaWorker: `/code-runner/${java}/worker-java.js`,
    javaFiles: `/code-runner/${java}/teavm/`,
  };
  return {
    name: "marginchat-code-runner-assets",
    config() {
      return { define: { __CODE_RUNNER_ASSETS__: JSON.stringify(urls) } };
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = sources.get((request.url ?? "").split("?")[0]);
        if (!path) return next();
        response.setHeader("Content-Type", typeOf(path));
        response.end(readFileSync(path));
      });
    },
    async generateBundle() {
      for (const [url, path] of sources) {
        let source = readFileSync(path);
        // The TypeScript compiler ships unminified (9 MB); minifying keeps the download near 3 MB.
        if (url.endsWith("/typescript.js")) {
          try {
            const { transform } = await import("esbuild");
            source = (await transform(source.toString("utf8"), { minify: true, legalComments: "none", target: "es2020" })).code;
          } catch (error) {
            this.warn(`TypeScript compiler left unminified: ${error instanceof Error ? error.message : error}`);
          }
        }
        this.emitFile({ type: "asset", fileName: url.slice(1), source });
      }
    },
  };
}
