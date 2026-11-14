// Private snapshots are owned by offline-store. This worker stores only public
// static build assets so a saved snapshot can be opened after an offline reload.
export async function registerOfflineShell(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return false;
  try {
    await navigator.serviceWorker.register("/offline-worker.js", {
      scope: "/",
      updateViaCache: "none",
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 20_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}
