// Keep Bun resolver caches isolated from the other extension bundles.
  const built = await Bun.build({
    entrypoints: [new URL("../../src/workspace.tsx", import.meta.url).pathname], target: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "workspace-frame-probe", setup(build) {
      build.onResolve({ filter: /client\/src\/App$/ }, () => ({ path: "app-probe", namespace: "probe" }));
      build.onLoad({ filter: /.*/, namespace: "probe" }, () => ({ loader: "tsx", contents: `
        import React from "react";
        import { apiFetch } from ${JSON.stringify(new URL("../../../client/src/lib/apiTransport.ts", import.meta.url).pathname)};
        globalThis.__frameProbe = { props: null, renders: [], apiFetch };
        export default function App(props) {
          globalThis.__frameProbe.props = props;
          globalThis.__frameProbe.renders.push(props);
          return <div data-testid="shared-app">Shared Margin Chat workspace</div>;
        }
      ` }));
      build.onResolve({ filter: /\.css$/ }, ({ path }) => ({ path, namespace: "empty-style" }));
      build.onLoad({ filter: /.*/, namespace: "empty-style" }, () => ({ loader: "text", contents: "" }));
    } }],
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  await Bun.write(Bun.stdout, await built.outputs[0].text());
