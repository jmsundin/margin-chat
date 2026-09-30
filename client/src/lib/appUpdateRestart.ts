import { canReloadAfterAppUpdate, flushForAppUpdate, lockForAppUpdate } from "./appUpdateSafety";

export function requestAppRestart(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: string) => {
      clearTimeout(timer);
      channel.port1.close();
      error ? reject(new Error(error)) : resolve();
    };
    const timer = setTimeout(() => finish("The update did not respond. Please try again."), 25000);
    channel.port1.onmessage = (event) => finish(event.data?.ready === true ? undefined : event.data?.error || "The update could not be prepared.");
    try { worker.postMessage({ type: "MARGIN_RESTART" }, [channel.port2]); }
    catch { finish("This update is no longer available. Wait for the next update check."); }
  });
}

export function listenForAppRestart(onStatus: (message: string | null) => void, onError: (message: string) => void = () => {}): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  let pending: { id: string; worker: ServiceWorker; unlock: () => void; committed: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloading = false;
  const release = () => {
    clearTimeout(timer);
    pending?.unlock();
    pending = null;
    onStatus(null);
  };
  const message = (event: MessageEvent) => {
    const { type, id } = event.data ?? {};
    const worker = event.source as ServiceWorker | null;
    if (!worker || worker.scriptURL !== new URL("/sw.js", window.location.href).href || typeof id !== "string") return;
    if (type === "MARGIN_CANCEL_UPDATE") {
      if (pending?.id === id && pending.worker === worker) release();
      return;
    }
    if (type === "MARGIN_RELOAD_UPDATE") {
      if (pending?.id === id && pending.worker === worker) changed();
      return;
    }
    if (!["MARGIN_PREPARE_UPDATE", "MARGIN_COMMIT_UPDATE"].includes(type) || !event.ports[0]) return;
    const port = event.ports[0];
    void (async () => {
      try {
        if (type === "MARGIN_PREPARE_UPDATE") {
          if (pending) throw new Error("Another restart is already being prepared.");
          pending = { id, worker, unlock: lockForAppUpdate(), committed: false };
          onStatus("Waiting for active work, saving edits, and checking all open tabs…");
          timer = setTimeout(() => {
            release();
            onError("The restart timed out. Your current version is still open; try again.");
          }, 35000);
          // Let blur handlers and the existing note debounce publish their edits.
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        if (pending?.id !== id || pending.worker !== worker) throw new Error("Restart preparation expired. Please try again.");
        await flushForAppUpdate();
        if (pending?.id !== id || pending.worker !== worker) throw new Error("Restart preparation expired. Please try again.");
        if (type === "MARGIN_COMMIT_UPDATE") {
          pending.committed = true;
          onStatus("Restarting all open tabs…");
        }
        port.postMessage({ ready: true });
      } catch (error) {
        if (pending?.id === id && pending.worker === worker) release();
        port.postMessage({ error: error instanceof Error ? error.message : "Your edits could not be saved. Please try again." });
      } finally { port.close(); }
    })();
  };
  const changed = () => {
    // First install, unsolicited activation, and an expired preparation never reload a page.
    if (!reloading && pending?.committed && navigator.serviceWorker.controller === pending.worker) {
      if (!canReloadAfterAppUpdate()) {
        release();
        onError("New work arrived while restarting. Finish it, then try Restart now again.");
        return;
      }
      reloading = true;
      clearTimeout(timer);
      window.location.reload();
    }
  };
  navigator.serviceWorker.addEventListener("message", message);
  navigator.serviceWorker.addEventListener("controllerchange", changed);
  return () => {
    navigator.serviceWorker.removeEventListener("message", message);
    navigator.serviceWorker.removeEventListener("controllerchange", changed);
    release();
  };
}
