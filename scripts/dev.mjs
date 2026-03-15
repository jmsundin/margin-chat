import { spawn } from "node:child_process";

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
