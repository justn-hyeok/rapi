import { createServer, request as httpRequest } from "node:http";

const port = Number(process.env.RAPI_GATEWAY_PORT ?? "4600");
const healthPort = Number(process.env.RAPI_GATEWAY_HEALTH_PORT ?? "4601");
const targetPort = Number(process.env.PORT ?? "4000");
function respond(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const server = createServer((incoming, outgoing) => {
  const path = incoming.url?.split("?")[0] ?? "";
  // Discord's interactions, each person's star interest page and help page
  // and the owner's dashboard, which check their own signed links, a
  // service's return from connecting an
  // account (/connect/<service>/callback), which checks its signed state, and
  // the intro and privacy pages at / and /privacy, which also answer HEAD.
  const allowed =
    (incoming.method === "POST" &&
      (path === "/interactions" ||
        path === "/stars/interests" ||
        path === "/help/suggestions")) ||
    (incoming.method === "GET" &&
      (path === "/" ||
        path === "/privacy" ||
        path === "/stars" ||
        path === "/stars/data" ||
        path === "/help" ||
        path === "/dashboard" ||
        /^\/connect\/[a-z][a-z0-9_-]{1,31}\/callback$/.test(path))) ||
    (incoming.method === "HEAD" && (path === "/" || path === "/privacy"));
  if (!allowed) {
    incoming.resume();
    respond(outgoing, 404, { error: "not_found" });
    return;
  }
  const headers = { ...incoming.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["proxy-authorization"];
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: targetPort,
      method: incoming.method,
      path: incoming.url,
      headers: { ...headers, host: `127.0.0.1:${targetPort}` },
      timeout: 65_000,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!outgoing.headersSent)
      respond(outgoing, 502, { error: "upstream_unavailable" });
    else outgoing.destroy();
  });
  incoming.pipe(upstream);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `rapi public gateway listening on 127.0.0.1:${server.address().port}\n`,
  );
});

const healthServer = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    respond(response, 200, { ready: true });
    return;
  }
  if (request.method === "GET" && request.url === "/ready") {
    // An allowlist listener alone does not prove a functioning interaction path.
    void fetch(`http://127.0.0.1:${targetPort}/ready`, {
      signal: AbortSignal.timeout(3000),
    })
      .then(async (upstream) => {
        const body = await upstream.json();
        const ready = upstream.ok && body.ready === true;
        respond(response, ready ? 200 : 503, {
          ready,
          revision: body.revision ?? null,
        });
      })
      .catch(() =>
        respond(response, 503, { ready: false, error: "upstream_unavailable" }),
      );
    return;
  }
  respond(response, 404, { error: "not_found" });
});
healthServer.listen(healthPort, "127.0.0.1");

const shutdown = () => {
  healthServer.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
