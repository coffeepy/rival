## RivetKit Integration Guide

This server shows how to integrate **RivetKit** into your own backend as a **pure library**, instead of using Rivet’s built‑in server.

The pattern is:

- **Your app owns the HTTP server** (Hono, Express, Node `http`, etc.).
- RivetKit is initialized with `disableDefaultServer: true`.
- `registry.start()` returns a **standard Fetch API handler** you can mount or forward requests to.

This repo uses **Bun + Hono** for the main server, but the same idea works for Node/Express/Fastify.

---

### 1. Registry Setup (RivetKit as a Library)

In `server/registry.ts` we define our actors and initialize RivetKit:

```ts
import { actor, setup } from "rivetkit";

export const counter = actor({
  state: { count: 0 },
  actions: {
    increment: (c, x: number) => {
      c.state.count += x;
      c.broadcast("newCount", c.state.count);
      return c.state.count;
    },
  },
});

export const registry = setup({
  use: { counter },
  // Disable RivetKit's internal HTTP server; we will host it ourselves.
  disableDefaultServer: true,
  // Optional: state store configuration (defaults are fine for local dev)
  // state: { mode: "development" },
});
```

`registry.start()` then gives you:

```ts
const { client, fetch } = registry.start();
```

`fetch` is a **standard Fetch handler** that understands all of Rivet’s routes (e.g. `/actors`, `/health`, `/metadata`, WebSockets, etc.).

---

### 2. Hono‑First Server (Recommended Pattern)

In this project, `server/index.ts` creates a **Hono** app that:

- Serves the built frontend from `client/dist`.
- Mounts RivetKit’s Fetch handler so all Rivet routes are available under the same origin.
- Uses `@hono/node-server` (via Bun) to actually listen on a port.

Conceptually it looks like this:

```ts
import { Hono } from "hono";
import { realServe } from "@hono/node-server"; // via our adapter
import { registry } from "./registry";

// 1. Start RivetKit in "library" mode
const { fetch: rivetFetch } = registry.start();

// 2. Create the main Hono app for YOUR server
const app = new Hono();

// 2a. Frontend / static routes
app.get("/", async (c) => {
  const file = Bun.file("client/dist/index.html");
  if (await file.exists()) {
    const content = await file.arrayBuffer();
    return new Response(content, {
      headers: { "Content-Type": "text/html" },
    });
  }
});

app.get("/assets/*", async (c) => {
  const file = Bun.file(`client/dist${c.req.path}`);
  if (await file.exists()) {
    const content = await file.arrayBuffer();
    return new Response(content, {
      headers: { "Content-Type": file.type },
    });
  }
});

// 2b. Mount RivetKit
// RivetKit's router has a basePath of "/" and exposes `/actors`, `/health`, etc.
// Mounting at "/" means those routes are available as-is.
app.mount("/", rivetFetch);

// 3. Start the real HTTP server
realServe({ fetch: app.fetch, port: 6420 }, () => {
  console.log("Server running on http://localhost:6420");
  console.log("- Frontend: http://localhost:6420/");
  console.log("- RivetKit: http://localhost:6420/actors");
});
```

This is the **canonical pattern** for hosting a RivetKit‑powered backend alongside your own routes:

- Your framework (Hono) is in control.
- RivetKit is a mounted sub‑app, exposed through a Fetch handler.

> **Note:** This repo also includes a small build‑time adapter (`server/rivet-adapter.ts` + `scripts/build.ts`) to make RivetKit’s Node‑specific internals work when compiled into a single Bun executable. That’s a packaging concern only; the *logical integration pattern* is exactly as shown above.

---

### 3. Other Framework Examples

The same `disableDefaultServer` + `fetch` pattern works for other backends.

#### 3.1 Node.js (Vanilla HTTP)

```ts
import { createServer } from "node:http";
import { registry } from "./registry";

const { fetch: rivetFetch } = registry.start();

const server = createServer(async (req, res) => {
  // Route only the Rivet endpoints to RivetKit; everything else is your app
  if (req.url?.startsWith("/actors")) {
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as any,
      body: req.method !== "GET" && req.method !== "HEAD" ? req : undefined,
      // For streaming request bodies in Node 18+/Fetch, you may also need: duplex: "half"
    });

    const response = await rivetFetch(request);

    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      // @ts-ignore - ReadableStream to Node stream
      for await (const chunk of response.body) {
        res.write(chunk);
      }
    }
    res.end();
    return;
  }

  // Your other routes here...
  res.end("Hello from your main app!");
});

server.listen(3000);
```

#### 3.2 Express.js

```ts
import express from "express";
import { registry } from "./registry";

const { fetch: rivetFetch } = registry.start();
const app = express();

app.use(express.json());

// Mount RivetKit on /actors
app.all("/actors/*", async (req, res) => {
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  const request = new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: ["GET", "HEAD"].includes(req.method)
      ? undefined
      : JSON.stringify(req.body),
  });

  const response = await rivetFetch(request);

  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));

  const text = await response.text();
  res.send(text);
});

app.listen(3000);
```

#### 3.3 Hono (Generic, Non‑Bun Example)

If you’re not compiling to a Bun executable, a typical Node/Hono integration looks like:

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { registry } from "./registry";

const { fetch: rivetFetch } = registry.start();
const app = new Hono();

// Your routes...
app.get("/", (c) => c.text("Hello from your app!"));

// Mount RivetKit
app.mount("/", rivetFetch);

serve({ fetch: app.fetch, port: 6420 });
```

---

### 4. WebSockets & Advanced Considerations

- **WebSockets**: RivetKit heavily uses WebSockets internally. When `disableDefaultServer: true` is set, RivetKit still configures the Hono router so that WebSocket upgrades work as long as:
  - The underlying server (e.g. `@hono/node-server` or Bun) supports WebSockets.
  - The RivetKit router is mounted directly (via `app.mount("/", rivetFetch)` as in this project).
- **Base Path**: By default RivetKit’s router uses `basePath: "/"`, so actor APIs live at `/actors`. If you want to host them under a different prefix, you can pass a `basePath` in `registry.start({ basePath: "/api" })` and mount accordingly.

---

### 5. Local Development

- **Install deps**

```bash
bun install
cd server && bun install
cd ../client && bun install
```

- **Run dev server**

```bash
bun run dev:server
```

- **Build single executable (Bun)**

```bash
bun run build
./rival
```

This will embed the frontend assets and the RivetKit backend into a single `rival` binary.

