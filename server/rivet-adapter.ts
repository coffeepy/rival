export { serve as realServe } from "@hono/node-server";
export { createNodeWebSocket as realCreateNodeWebSocket } from "@hono/node-ws";
import { serve as realServe } from "@hono/node-server";
import { createNodeWebSocket as realCreateNodeWebSocket } from "@hono/node-ws";


// Global variable to capture the app instance
export let capturedApp: any = null;
export let capturedServer: any = null;

export let capturedInjectWebSocket: any = null;
type CaptureCallback = (app: any, injectWs: any) => void;
const captureCallbacks: CaptureCallback[] = [];

export function onCapture(cb: CaptureCallback) {
    if (capturedApp && capturedInjectWebSocket) {
        cb(capturedApp, capturedInjectWebSocket);
    } else {
        captureCallbacks.push(cb);
    }
}

// Mock createNodeWebSocket to capture the app
export function createNodeWebSocket(options: any) {
    console.log("[RivetAdapter] Capturing Hono App instance via createNodeWebSocket");
    capturedApp = options.app;
    
    // Call real implementation to get valid handlers
    const result = realCreateNodeWebSocket(options);
    
    // Capture the injection function so we can use it on our REAL server
    capturedInjectWebSocket = result.injectWebSocket;
    
    // Trigger callbacks
    captureCallbacks.forEach(cb => cb(capturedApp, capturedInjectWebSocket));
    
    return result;
}

// Mock serve to suppress default listening
export function serve(options: any, callback: any) {
    console.log("[RivetAdapter] Suppressing RivetKit internal serve() call");
    
    // We don't verify port or start listening.
    // We return a fake server object that satisfies injectWebSocket
    // The real server will be started by us in index.ts
    
    return {
        // Mock server object
        on: () => {},
        listen: () => {},
        address: () => ({ port: options.port }),
    };
}
