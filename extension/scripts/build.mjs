import { mkdir, readFile, rm, copyFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = resolve(root, "dist");
await rm(outdir, { recursive: true, force: true });
await mkdir(resolve(outdir, "icons"), { recursive: true });
for (const entry of ["background", "popup", "options", "content"]) {
  const result = await Bun.build({
    entrypoints: [resolve(root, `src/${entry}.ts`)],
    outdir,
    target: "browser",
    format: entry === "content" ? "iife" : "esm",
    minify: true,
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
}
for (const file of ["popup.html", "options.html", "styles.css"]) {
  await copyFile(resolve(root, "public", file), resolve(outdir, file));
}
const manifest = JSON.parse(
  await readFile(resolve(root, "manifest.json"), "utf8"),
);
manifest.version = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
).version;
manifest.icons = {};
const svg = await readFile(
  resolve(root, "../client/public/favicon.svg"),
  "utf8",
);
for (const size of [16, 32, 48, 128]) {
  const path = `icons/icon-${size}.png`;
  await writeFile(
    resolve(outdir, path),
    new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng(),
  );
  manifest.icons[size] = path;
}
manifest.action.default_icon = manifest.icons;
await writeFile(
  resolve(outdir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`Extension ${manifest.version} built in extension/dist.`);
