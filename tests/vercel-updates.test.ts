import { describe, expect, test } from "bun:test";
import { applyVercelUpdates, assertDeployedCommit, assertProductionAlias, createVercelApi, describeVercelUpdates, parseVercelUpdates, planVercelUpdates } from "../scripts/release/vercel-updates.mjs";
import { executeRelease, VERCEL_SYNC_STEPS } from "../scripts/release/sequence.mjs";

const recipe = (environment: any[] = [], project = {}) => ({ schemaVersion: 1, project, environment });
const sha = "a".repeat(40);
const deployed = () => ({ projectId: "prj_test", target: "production", readyState: "READY", meta: { githubCommitSha: sha } });

function provider(envs: any[] = [], initial = {}) {
  const state = { project: { id: "prj_test", ...initial }, envs: structuredClone(envs) };
  const writes: any[] = [];
  const api = async (path: string, { method = "GET", body }: any = {}) => {
    if (method === "GET") return path.endsWith("/env") ? { envs: structuredClone(state.envs) } : structuredClone(state.project);
    writes.push({ path, method, body: structuredClone(body) });
    if (path === "/v9/projects/prj_test") Object.assign(state.project, body);
    else if (method === "POST") state.envs.push({ ...body, id: `env_${state.envs.length}` });
    else Object.assign(state.envs.find((row: any) => path.endsWith(`/${row.id}`)), body);
    return {};
  };
  return { state, writes, api };
}

describe("Vercel post-deployment updates", () => {
  test("checks live alias ownership and routing even when the project snapshot omits a custom domain", async () => {
    const good = { alias: "www.example.test", projectId: "prj_test", deploymentId: "dpl_current", redirect: null };
    const options = { productionUrl: "https://www.example.test", projectId: "prj_test", deploymentId: "dpl_current" };
    await assertProductionAlias({ ...options, api: async (path: string) => {
      expect(path).toBe("/v4/aliases/www.example.test");
      return good;
    } });
    for (const changed of [{ alias: "other.example.test" }, { projectId: "prj_other" },
      { deploymentId: "dpl_old" }, { redirect: "https://other.example.test" }]) {
      await expect(assertProductionAlias({ ...options, api: async () => ({ ...good, ...changed }) })).rejects.toThrow("route directly");
    }
  });

  test("uses committed Vercel build settings and never exposes resolved secrets in the local plan", () => {
    const updates = parseVercelUpdates(recipe([{ key: "SERVICE_TOKEN", fromEnv: "DEPLOY_VALUE" }], { nodeVersion: "24.x" }),
      { buildCommand: "bun run build", installCommand: "bun install --frozen-lockfile" }, { DEPLOY_VALUE: "private-value" });
    expect(updates.project).toEqual({ nodeVersion: "24.x", buildCommand: "bun run build", installCommand: "bun install --frozen-lockfile" });
    expect(updates.environment[0]).toEqual({ key: "SERVICE_TOKEN", value: "private-value", type: "encrypted", target: ["production"] });
    expect(JSON.stringify(describeVercelUpdates(updates))).not.toContain("private-value");
  });

  test("missing secret inputs are named without falling back to the application variable", () => {
    const updates = parseVercelUpdates(recipe([{ key: "SERVICE_TOKEN", fromEnv: "DEPLOY_VALUE" }]), {}, { SERVICE_TOKEN: "wrong-input" });
    expect(updates.missing).toEqual(["DEPLOY_VALUE"]);
    expect(updates.environment[0].value).toBeUndefined();
  });

  test("rejects configuration ambiguity, scope overrides, duplicates, and reserved persistence targets", () => {
    for (const environment of [
      [{ key: "DATABASE_URL", fromEnv: "URL" }], [{ key: "API_KEY_ENCRYPTION_KEY", fromEnv: "NEW_KEY" }],
      [{ key: "VERCEL_TOKEN", fromEnv: "TOKEN" }], [{ key: "A", value: "x", fromEnv: "Y" }],
      [{ key: "A", value: "x", target: ["preview"] }], [{ key: "A", value: "x" }, { key: "A", value: "y" }],
      [{ key: "A", value: "secret", type: "encrypted" }], [{ key: "A", fromEnv: "B", type: "plain" }],
      [{ key: "A", value: 1 }], [{ key: "A", fromEnv: "not a name" }],
    ]) expect(() => parseVercelUpdates(recipe(environment))).toThrow();
    expect(() => parseVercelUpdates(recipe([], { rootDirectory: "/tmp" }))).toThrow("Unsupported");
    expect(() => parseVercelUpdates(recipe([], { buildCommand: "new" }), { buildCommand: "old" })).toThrow("vercel.json");
    expect(() => parseVercelUpdates(recipe([], { nodeVersion: null }))).toThrow("Invalid");
    expect(() => parseVercelUpdates({ ...recipe(), deletion: ["A"] })).toThrow("schema");
  });

  test("only the exact deployed production commit may run post-deployment persistence changes", () => {
    assertDeployedCommit(deployed(), "prj_test", sha);
    assertDeployedCommit({ ...deployed(), meta: {}, gitSource: { sha } }, "prj_test", sha);
    for (const deployment of [
      { ...deployed(), projectId: "other" }, { ...deployed(), readyState: "BUILDING" }, { ...deployed(), target: "preview" },
      { ...deployed(), meta: {} }, { ...deployed(), meta: { marginReleaseSha: sha, githubCommitSha: "b".repeat(40) } },
    ]) expect(() => assertDeployedCommit(deployment, "prj_test", sha)).toThrow();
    expect(() => assertDeployedCommit(deployed(), "prj_test", "b".repeat(40))).toThrow("exact local HEAD");
  });

  test("updates only declared project fields and production variables, retaining unrelated preview values", async () => {
    const fixture = provider([{ id: "preview", key: "FLAG", target: ["preview"], value: "preview", type: "plain" },
      { id: "prod", key: "FLAG", target: ["production"], value: "old", type: "plain" }], { framework: "vite", nodeVersion: "22.x" });
    const updates = parseVercelUpdates(recipe([{ key: "FLAG", value: "new" }, { key: "SERVICE_TOKEN", fromEnv: "DEPLOY_VALUE" }], { nodeVersion: "24.x" }), {}, { DEPLOY_VALUE: "private" });
    const receipts: any[] = [];
    const result = await applyVercelUpdates({ ...fixture, projectId: "prj_test", updates, onApplied: (receipt: any) => receipts.push(structuredClone(receipt)) });
    expect(result).toEqual({ projectSettings: ["nodeVersion"], environment: ["FLAG", "SERVICE_TOKEN"] });
    expect(fixture.state.envs[0].value).toBe("preview");
    expect(fixture.state.envs[1].value).toBe("new");
    expect(fixture.writes.map(({ method }) => method)).toEqual(["PATCH", "PATCH", "POST"]);
    expect(receipts).toHaveLength(3);
    expect(JSON.stringify(receipts)).not.toContain("private");
    fixture.writes.length = 0;
    await applyVercelUpdates({ ...fixture, projectId: "prj_test", updates });
    expect(fixture.state.envs).toHaveLength(3);
    expect(fixture.writes.map(({ method }) => method)).toEqual(["PATCH", "PATCH"]);
  });

  test("preflights all scopes before any mutation, including project settings", async () => {
    for (const unsupported of [
      { target: ["production", "preview"] }, { customEnvironmentIds: ["env_custom"] }, { configurationId: "integration" },
      { system: true }, { type: "system" }, { type: "secret" }, { id: undefined },
    ]) {
      const fixture = provider([{ key: "TOKEN", id: "env_one", target: ["production"], type: "encrypted", ...unsupported }]);
      await expect(applyVercelUpdates({ ...fixture, projectId: "prj_test", updates: parseVercelUpdates(recipe([
        { key: "EARLY", value: "one" }, { key: "TOKEN", fromEnv: "INPUT" }], { nodeVersion: "24.x" }), {}, { INPUT: "secret" }) })).rejects.toThrow("production-only");
      expect(fixture.writes).toEqual([]);
    }
  });

  test("preserves sensitive storage and refuses exposing existing encrypted values as plain text", async () => {
    const fixture = provider([{ id: "env_one", key: "TOKEN", target: "production", type: "sensitive" }]);
    await applyVercelUpdates({ ...fixture, projectId: "prj_test", updates: parseVercelUpdates(recipe([{ key: "TOKEN", fromEnv: "INPUT" }]), {}, { INPUT: "secret" }) });
    expect(fixture.writes[0].body.type).toBe("sensitive");
    await expect(applyVercelUpdates({ ...fixture, projectId: "prj_test", updates: parseVercelUpdates(recipe([{ key: "TOKEN", value: "public" }])) })).rejects.toThrow("plain text");
  });

  test("incomplete, duplicate, or wrong-project provider results cannot trigger writes", async () => {
    const updates = parseVercelUpdates(recipe([{ key: "FLAG", value: "new" }]));
    for (const listing of [{}, { envs: [], pagination: { next: 123 } }, { envs: [
      { key: "FLAG", id: "a", target: "production" }, { key: "FLAG", id: "b", target: ["production"] },
    ] }]) {
      const api = async (path: string, options: any) => {
        expect(options).toBeUndefined();
        return path.endsWith("/env") ? listing : { id: "prj_test" };
      };
      await expect(planVercelUpdates({ api, projectId: "prj_test", updates })).rejects.toThrow();
    }
    await expect(planVercelUpdates({ api: async () => ({ id: "wrong" }), projectId: "prj_test", updates })).rejects.toThrow("identity");
  });

  test("retry reconciles successful env writes when a later request had an uncertain result", async () => {
    const fixture = provider();
    const updates = parseVercelUpdates(recipe([{ key: "FIRST", value: "one" }, { key: "SECOND", value: "two" }]));
    let fail = true;
    const api = async (path: string, options: any) => {
      const response = await fixture.api(path, options);
      if (fail && options?.body?.key === "SECOND") { fail = false; throw new Error("connection lost after write"); }
      return response;
    };
    await expect(applyVercelUpdates({ api, projectId: "prj_test", updates })).rejects.toThrow("connection lost");
    expect(fixture.state.envs).toHaveLength(2);
    await applyVercelUpdates({ api, projectId: "prj_test", updates });
    expect(fixture.state.envs).toHaveLength(2);
    expect(fixture.writes.slice(-2).map(({ method }) => method)).toEqual(["PATCH", "PATCH"]);
  });

  test("API pins the team and origin, uses JSON, and suppresses secrets from provider/network errors", async () => {
    const requests: any[] = [];
    const api = createVercelApi({ config: { orgId: "team_test" }, token: "api-secret", fetchImpl: async (url: URL, options: any) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ id: "prj_test" }));
    } });
    await api("/v9/projects/prj_test", { method: "PATCH", body: { buildCommand: "bun run build" } });
    expect(requests[0].url.searchParams.get("teamId")).toBe("team_test");
    expect(requests[0].options.redirect).toBe("error");
    expect(JSON.parse(requests[0].options.body)).toEqual({ buildCommand: "bun run build" });
    await expect(api("https://unrelated.test/steal")).rejects.toThrow("origin");
    for (const result of [new Response("private-value", { status: 400 }), new Response("private-value"),
      new Response(JSON.stringify({ errors: [{ message: "private-value" }] }), { status: 201 }),
      new Response(JSON.stringify({ created: [], failed: [{ error: { message: "private-value" } }] }), { status: 201 }), new Error("private-value")]) {
      const failing = createVercelApi({ config: { orgId: "team_test" }, token: "secret", fetchImpl: async () => {
        if (result instanceof Error) throw result;
        return result;
      } });
      try { await failing("/v9/projects/prj_test"); throw new Error("unexpected success"); }
      catch (error: any) { expect(error.message).toContain("Vercel"); expect(error.message).not.toContain("private-value"); }
    }
  });

  test("post-deployment ordering backs up and rehearses before changes and verifies before promotion", async () => {
    const calls: string[] = [];
    const effects = Object.fromEntries([...VERCEL_SYNC_STEPS, "unlock"].map((name) => [name, async () => { calls.push(name); }]));
    expect((await executeRelease({ effects, postDeploy: true })).status).toBe("complete");
    expect(calls).toEqual(["validate", "lock", "checkpoint", "rehearse", "migrate", "configure", "stage", "jobs", "verifyCandidate", "promote", "verifyProduction", "unlock"]);
    // Even when all data receipts already exist, rebuilding is required to
    // activate project config after an interrupted previous run.
    calls.length = 0;
    await executeRelease({ effects, postDeploy: true });
    expect(calls).toContain("stage");
  });

  test("a failed sync stage prevents later changes, releases the lock, and cannot silently succeed", async () => {
    for (const [index, fail] of VERCEL_SYNC_STEPS.entries()) {
      const calls: string[] = [];
      const effects = Object.fromEntries([...VERCEL_SYNC_STEPS, "unlock"].map((name) => [name, async () => {
        calls.push(name);
        if (name === fail) throw new Error("stop");
      }]));
      const report = await executeRelease({ effects, postDeploy: true });
      expect(report.status).toBe("failed");
      expect(calls).toEqual([...VERCEL_SYNC_STEPS.slice(0, index + 1), ...(index > 1 ? ["unlock"] : [])]);
    }
  });
});
