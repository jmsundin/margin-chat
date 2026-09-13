import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
await mkdir(resolve(root, "releases"), { recursive: true });
const output = resolve(root, `releases/margin-chat-${version}.zip`);
const files = (
  await readdir(resolve(root, "dist"), { recursive: true, withFileTypes: true })
).filter((entry) => entry.isFile());
if (!files.length) throw new Error("Build the extension before packaging.");
// Archive only the build output; source files, credentials, and dependencies stay out.
const process = Bun.spawn(["zip", "-q", "-r", "-FS", output, "."], {
  cwd: resolve(root, "dist"),
  stdout: "inherit",
  stderr: "inherit",
});
if (await process.exited)
  throw new Error("Unable to create the extension archive.");
console.log(`Release ready: ${output}`);
