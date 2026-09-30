(function initializeFridgeFuseBotProtection() {
  window.fridgeFuseBotReady = (async () => {
    try {
      const response = await fetch("/api/security/config", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Security config request failed.");
      const config = await response.json();
      if (!config || config.ok !== true || typeof config.enabled !== "boolean" || !Array.isArray(config.protectedRoutes)) {
        throw new Error("Security config was invalid.");
      }
      if (!config.enabled) return true;

      const { initBotId } = await import("/botid-client.mjs");
      const protect = config.protectedRoutes.map((route) => ({
        path: route.path,
        method: route.method,
        advancedOptions: { checkLevel: "basic" },
      }));
      initBotId({ protect });
      return true;
    } catch {
      throw new Error("The browser security check is unavailable. Try again later.");
    }
  })();

  // The promise remains rejected for protected actions to fail closed; attach
  // a handler now so a quiet tab does not emit an unhandled-rejection warning.
  window.fridgeFuseBotReady.catch(() => {});
})();
