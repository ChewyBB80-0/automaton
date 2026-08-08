/**
 * Observatory server.
 *
 * Serves the console on localhost and re-renders it from state.db on every
 * request, so reloading the page shows the agent's current state. Read-only:
 * it never writes to the database.
 *
 *   npx tsx tools/observatory/serve.ts <path-to-state.db> [port]
 *
 * The page refreshes itself every few seconds while the agent is running.
 */

import http from "http";
import path from "path";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";

const DB_PATH = process.argv[2];
const PORT = Number(process.argv[3] || process.env.PORT || 7717);
const HOST = process.env.HOST || "127.0.0.1";
const REFRESH_MS = Number(process.env.REFRESH_MS || 120_000);

if (!DB_PATH) {
  console.error("usage: serve.ts <state.db> [port]");
  process.exit(1);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RENDERER = path.join(HERE, "render-dashboard.ts");
const TMP = path.join(os.tmpdir(), `observatory-${process.pid}.html`);

const REFRESH_SNIPPET = `
<script>
  (function () {
    var KEY = "observatory:scroll";
    try {
      var y = sessionStorage.getItem(KEY);
      if (y) window.scrollTo(0, parseFloat(y));
    } catch (e) {}
    window.addEventListener("beforeunload", function () {
      try { sessionStorage.setItem(KEY, String(window.scrollY)); } catch (e) {}
    });

    var live = true;
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.style.cssText =
      "position:fixed;right:14px;bottom:14px;z-index:99;font:600 12px system-ui," +
      "sans-serif;padding:7px 12px;border-radius:999px;cursor:pointer;" +
      "border:1px solid rgba(127,127,127,0.35);background:rgba(127,127,127,0.14);" +
      "color:inherit;backdrop-filter:blur(6px)";
    function label() { toggle.textContent = live ? "● live" : "paused"; }
    label();
    toggle.addEventListener("click", function () { live = !live; label(); });
    document.body.appendChild(toggle);

    setInterval(function () { if (live) window.location.reload(); }, ${REFRESH_MS});
  })();
</script>`;

function render(): string {
  execFileSync("npx", ["tsx", RENDERER, DB_PATH, TMP], {
    cwd: path.resolve(HERE, "../.."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const html = fs.readFileSync(TMP, "utf-8");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
${html}
${REFRESH_SNIPPET}
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.url !== "/" && req.url !== "/index.html") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  try {
    const html = render();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  } catch (err: any) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(
      `Failed to render the console.\n\n${err?.stderr?.toString?.() || err?.message || err}`,
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`observatory → http://${HOST}:${PORT}`);
  console.log(`  database:  ${DB_PATH}`);
  console.log(`  refresh:   every ${REFRESH_MS}ms (toggle in the corner)`);
});

process.on("SIGINT", () => {
  server.close();
  try { fs.unlinkSync(TMP); } catch {}
  process.exit(0);
});
