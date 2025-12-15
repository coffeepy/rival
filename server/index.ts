import { registry } from "./registry";

// Force bundle these dependencies
import "@hono/node-server";
import "@hono/node-ws";

// Run server with default configuration
registry.start({ defaultServerPort: 6420 });
