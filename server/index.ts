import { Hono } from "hono";
import { serve } from "@hono/node-server"; // This will be redirected to adapter in the bundle, but we need the REAL one for starting
import { registry } from "./registry";
import { capturedApp, serve as mockServe, onCapture, realServe } from "./rivet-adapter";

// Start RivetKit - this will trigger our mock adapter via build-time aliasing
// The mock adapter captures the created app and suppresses the internal serve call
// Start RivetKit - this will trigger our mock adapter via build-time aliasing
// The mock adapter captures the created app and suppresses the internal serve call
const { fetch: rivetFetch } = registry.start();

// Use a new Hono app as the main router (since capturedApp is async)
// We will try to merge/use capturedApp when it becomes available, but for static routes we control the main app.
const app = new Hono();

// 1. Static Routes (Priority)
app.get("/", async (c) => {
	const file = Bun.file("client/dist/index.html");
	if (await file.exists()) {
		const content = await file.arrayBuffer();
		return new Response(content, { headers: { "Content-Type": "text/html" } });
	}
});

app.get("/assets/*", async (c) => {
	const path = c.req.path;
	const file = Bun.file(`client/dist${path}`);
	if (await file.exists()) {
		const content = await file.arrayBuffer();
		return new Response(content, { headers: { "Content-Type": file.type } });
	}
});

app.get("/vite.svg", async (c) => {
    const file = Bun.file("client/dist/vite.svg");
    if (await file.exists()) {
        const content = await file.arrayBuffer();
        return new Response(content, { headers: { "Content-Type": "image/svg+xml" } });
    }
});

// 2. Delegate to captured RivetKit app
// Note: We use capturedApp to handle upgrade requests correctly if needed, 
// but for standard HTTP fetch delegation, utilizing rivetFetch is safer as it binds context.
// 2. Delegate to captured RivetKit app
// Note: We use capturedApp to handle upgrade requests correctly if needed, 
// but for standard HTTP fetch delegation, utilizing rivetFetch is safer as it binds context.
app.all("*", (c) => rivetFetch(c.req.raw));

// Start the REAL server
// We use realServe (from adapter export) to listen
const server = realServe({ fetch: app.fetch, port: 6420 }, () => {
    console.log("Server running on http://localhost:6420");
    console.log("- Frontend: http://localhost:6420/");
    console.log("- RivetKit: http://localhost:6420/actors");
});

// IMPORTANT: Inject the WebSocket handling logic (from RivetKit) into our real server
// Since RivetKit initializes asynchronously, we use a callback to wait for capture
// IMPORTANT: Inject the WebSocket handling logic (from RivetKit) into our real server
// Since RivetKit initializes asynchronously, we use a callback to wait for capture
onCapture((rivetApp, injectWs) => {
    console.log("[Server] Injecting WebSocket handler into real server (async capture)");
    if (server) {
        injectWs(server);
    }
});
