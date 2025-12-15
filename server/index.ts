import { setup } from "rivetkit";
import type { Client } from "rivetkit";

// The path where the frontend static files will be located
// In the single-executable build, we will bundle 'client/dist' so it is available at root.
const STATIC_DIR = "client/dist";

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. API / Rivet request handling (Placeholder)
    if (url.pathname.startsWith("/api")) {
      return new Response("API Placeholder");
    }

    // 2. Serve Static Files (Frontend)
    // We try to find the file in the static directory.
    // logical logic: / -> index.html, /assets/foo -> assets/foo
    let filePath = url.pathname;
    if (filePath === "/" || filePath === "") {
      filePath = "/index.html";
    }

    const file = Bun.file(`${STATIC_DIR}${filePath}`);
    
    // Check if the file exists
    if (await file.exists()) {
      return new Response(file);
    }

    // 3. SPA Fallback
    // If it's not a static file and not an API route, serve index.html
    // so React Router can handle it on the client side.
    const indexFile = Bun.file(`${STATIC_DIR}/index.html`);
    if (await indexFile.exists()) {
       return new Response(indexFile);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Listening on http://localhost:${server.port}`);