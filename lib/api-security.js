const PROTECTED_ROUTES = [
  { path: "/api/plan", method: "POST" },
  { path: "/api/vision", method: "POST" },
  { path: "/api/chat/interpret", method: "POST" },
  { path: "/api/grocery/offers", method: "POST" },
  { path: "/api/geo/describe", method: "POST" },
];

function normalizeRoutePath(value) {
  const path = String(value || "/").split("?", 1)[0].toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isBotProtectionEnabled(env = process.env) {
  return Boolean(env.VERCEL) || env.NODE_ENV === "production";
}

function isDiagnosticsAvailable(env = process.env, req) {
  if (isBotProtectionEnabled(env)) return false;
  const address = String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || "").toLowerCase();
  if (address) return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
  const hostname = String(req?.hostname || "").toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function createBotProtectionMiddleware({ checker, enabled, timeoutMs = 8000 }) {
  if (typeof checker !== "function") throw new TypeError("A BotID checker is required.");
  const protectedMethods = new Map(PROTECTED_ROUTES.map((route) => [
    `${route.method} ${normalizeRoutePath(route.path)}`,
    route,
  ]));

  return async function botProtection(req, res, next) {
    const method = String(req.method || "").toUpperCase();
    const route = protectedMethods.get(`${method} ${normalizeRoutePath(req.path || req.url)}`);
    if (!route || !enabled) return next();

    const headers = req.headers || {};
    const proof = headers["x-is-human"];
    if (typeof proof !== "string" || !proof.trim() || proof.length > 8192) {
      return res.status(403).json({ ok: false, failure: { message: "Complete the browser check and try again." } });
    }

    // Bind the proof to the exact request target. Express routes can be
    // case-insensitive and tolerate a trailing slash, but BotID must validate
    // the path and method that will actually reach the handler.
    if (headers["x-path"] !== req.path || String(headers["x-method"] || "").toUpperCase() !== method) {
      return res.status(403).json({ ok: false, failure: { message: "Complete the browser check and try again." } });
    }

    let timeout;
    try {
      const result = await Promise.race([
        checker({
          developmentOptions: { isDevelopment: false },
          advancedOptions: {
            checkLevel: "basic",
            headers: { ...headers, "x-path": req.path, "x-method": method },
          },
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("BotID check timed out.")), timeoutMs);
        }),
      ]);
      if (result?.isHuman !== true || result.isBot !== false || result.isVerifiedBot !== false || result.bypassed !== false) {
        return res.status(403).json({ ok: false, failure: { message: "Complete the browser check and try again." } });
      }
      req.botId = result;
      return next();
    } catch {
      return res.status(503).json({ ok: false, failure: { message: "The browser check is temporarily unavailable. Try again shortly." } });
    } finally {
      clearTimeout(timeout);
    }
  };
}

module.exports = {
  PROTECTED_ROUTES,
  normalizeRoutePath,
  isBotProtectionEnabled,
  isDiagnosticsAvailable,
  createBotProtectionMiddleware,
};
