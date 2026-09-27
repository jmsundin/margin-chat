let bundledBackground: Promise<string> | undefined;

// Share the bundle between worker suites. Repeated Bun.build calls for the same
// workspace-linked entry can invalidate Bun's resolver cache in one test process.
export function buildBackground() {
  return bundledBackground ??= (async () => {
    const result = await Bun.build({
      entrypoints: [new URL("../src/background.ts", import.meta.url).pathname],
      target: "browser",
      format: "iife",
    });
    if (!result.success) throw new Error("Unable to build the background worker for tests.");
    return result.outputs[0].text();
  })();
}
