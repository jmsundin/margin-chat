import { spawn, spawnSync } from "node:child_process";

// The server reads the same Markdown codec as the browser. Refresh the checked-in
// generated module before starting either development process.
const codecBuild = spawnSync("bun", ["run", "build:vault-codec"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (codecBuild.error || codecBuild.status !== 0) {
  if (codecBuild.error) console.error("Unable to build the Markdown codec.", codecBuild.error);
  process.exit(codecBuild.status ?? 1);
}

const children = [
  {
    label: "server",
    proc: spawn("bun", ["run", "dev:server"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    }),
  },
  {
    label: "client",
    proc: spawn("bun", ["run", "dev:client"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    }),
  },
];

let exiting = false;

function relay(label, stream, writer) {
  stream.on("data", (chunk) => {
    writer.write(`[${label}] ${chunk}`);
  });
}

function shutdown(code = 0) {
  if (exiting) {
    return;
  }

  exiting = true;

  for (const child of children) {
    child.proc.kill("SIGTERM");
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.proc.killed) {
        child.proc.kill("SIGKILL");
      }
    }

    process.exit(code);
  }, 300);
}

for (const child of children) {
  relay(child.label, child.proc.stdout, process.stdout);
  relay(child.label, child.proc.stderr, process.stderr);

  child.proc.on("exit", (code, signal) => {
    if (exiting) {
      return;
    }

    if (signal) {
      shutdown(1);
      return;
    }

    shutdown(code ?? 0);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
