// Serialized into sw.js: keep this function self-contained.
export function installUpdateProtocol(scope) {
  let restarting = false;
  const windows = async () => (await scope.clients.matchAll({ type: "window", includeUncontrolled: true }))
    .filter((client) => client.url.startsWith(scope.registration.scope));
  const ask = (client, type, id) => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error) => {
      clearTimeout(timer);
      channel.port1.close();
      error ? reject(new Error(error)) : resolve();
    };
    const timer = setTimeout(() => finish("Another tab did not respond. Open it and try again, or close it to continue."), 10000);
    channel.port1.onmessage = (event) => finish(event.data?.ready === true ? null : event.data?.error || "Another tab is not ready to restart.");
    try { client.postMessage({ type, id }, [channel.port2]); }
    catch { finish("A tab changed while preparing the update. Please try again."); }
  });
  scope.addEventListener("message", (event) => {
    if (event.data?.type !== "MARGIN_RESTART" || !event.ports?.[0] || !event.source?.id) return;
    const reply = event.ports[0];
    if (restarting) { reply.postMessage({ error: "An update is already being prepared in another tab." }); reply.close(); return; }
    restarting = true;
    event.waitUntil((async () => {
      const id = crypto.randomUUID();
      let clients = [];
      try {
        clients = await windows();
        if (!clients.some((client) => client.id === event.source.id)) throw new Error("Open the app again before restarting.");
        const confirmClients = async () => {
          const current = await windows();
          if (current.length !== clients.length || current.some((client) => !clients.some((old) => old.id === client.id))) {
            throw new Error("The open tabs changed. Please try Restart now again.");
          }
        };
        // allSettled ensures cancellation follows every reply, including slow saves.
        const phase = async (type) => {
          const results = await Promise.allSettled(clients.map((client) => ask(client, type, id)));
          const failed = results.find((result) => result.status === "rejected");
          if (failed) throw failed.reason;
        };
        await phase("MARGIN_PREPARE_UPDATE");
        await confirmClients();
        await phase("MARGIN_COMMIT_UPDATE");
        await confirmClients();
        await scope.skipWaiting();
        // Also supports retrying a tab that safely declined the first reload.
        for (const client of clients) {
          try { client.postMessage({ type: "MARGIN_RELOAD_UPDATE", id }); } catch { /* Already closed. */ }
        }
        reply.postMessage({ ready: true });
      } catch (error) {
        for (const client of clients) {
          try { client.postMessage({ type: "MARGIN_CANCEL_UPDATE", id }); }
          catch { /* Closed tabs no longer need to release their input lock. */ }
        }
        reply.postMessage({ error: error.message || "The update could not be prepared. Please try again." });
      } finally { restarting = false; reply.close(); }
    })());
  });
}
