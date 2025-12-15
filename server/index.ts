import { upgradeWebSocket, websocket } from "hono/bun";
import { registry } from "./registry";

// Start RivetKit in "library mode" - no internal HTTP server
const defaultBasePath = "/engine";
const { fetch: rivetFetch } = registry.start({
	disableDefaultServer: true,
	noWelcome: true,
	basePath: defaultBasePath,
	// Provide the upgradeWebSocket function for Bun WebSocket support
	getUpgradeWebSocket: () => upgradeWebSocket,
});

// Use Bun.serve() with WebSocket support
Bun.serve({
	port: 3000,
	async fetch(request, server) {
		const url = new URL(request.url);
		const path = url.pathname;

		// 1. Static Routes (Frontend)
		if (path === "/") {
			const file = Bun.file("client/dist/index.html");
			if (await file.exists()) {
				return new Response(file, { headers: { "Content-Type": "text/html" } });
			}
		}

		if (path.startsWith("/assets/")) {
			const file = Bun.file(`client/dist${path}`);
			if (await file.exists()) {
				return new Response(file, { headers: { "Content-Type": file.type } });
			}
		}

		if (path === "/vite.svg") {
			const file = Bun.file("client/dist/vite.svg");
			if (await file.exists()) {
				return new Response(file, { headers: { "Content-Type": "image/svg+xml" } });
			}
		}

		// 2. Forward all other requests to RivetKit
		if (path.startsWith(defaultBasePath)) {
			// Pass { server } as env so upgradeWebSocket can access Bun's server.upgrade()
			return await rivetFetch(request, { server });
		}
		return new Response("Not found", { status: 404 });
	},
	// WebSocket handler from Hono's Bun adapter - handles open/close/message events
	websocket,
});

console.log("Server running on http://localhost:3000");
console.log("- Frontend: http://localhost:3000/");
console.log("- RivetKit: http://localhost:3000/engine");
