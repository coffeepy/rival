
import { Glob } from "bun";

console.log("Building client...");
const clientBuild = await Bun.spawn(["bun", "run", "build:client"], {
    stdout: "inherit",
    stderr: "inherit"
});
await clientBuild.exited;

if (clientBuild.exitCode !== 0) {
    console.error("Client build failed");
    process.exit(1);
}


console.log("Gathering assets...");
const glob = new Glob("**/*");
const assets: string[] = [];

// Scans for all files in client/dist
for await (const file of glob.scan("client/dist")) {
    const path = `client/dist/${file}`;
    // Only include files (not directories) to correctly embed them
    if (await Bun.file(path).exists()) {
        assets.push(path);
    }
}

console.log(`Found ${assets.length} assets to embed.`);

// Update bundling step to use plugin
console.log("Bundling server...");
const result = await Bun.build({
    entrypoints: ["server/index.ts"],
    target: "bun",
    outdir: "dist", // temporary, we use the output file
    minify: true,
    plugins: [{
        name: "rivet-fix",
        setup(build) {
            // 1. Resolve 'rivet-adapter-internal' to our local adapter file
            build.onResolve({ filter: /^rivet-adapter-internal$/ }, args => {
                return { path: process.cwd() + "/server/rivet-adapter.ts" };
            });

            // 2. Load RivetKit files and transform dynamic imports to static imports of our adapter
            build.onLoad({ filter: /node_modules\/rivetkit\/.*\.js$/ }, async (args) => {
                const text = await Bun.file(args.path).text();
                // Check if this file contains the crossPlatformServe function
                if (text.includes("crossPlatformServe") && text.includes("@hono/node-server")) {
                    console.log(`[rivet-fix] Patching ${args.path}`);
                    
                    // Replace the dynamic import logic with specific static strings that Bun can bundle
                    let newText = text;
                    
                    // Replace variable definitions to point to our identifier (logic semantic, mostly for clarity)
                    newText = newText.replace(
                        /const nodeServerModule = "@hono\/node-server";/g, 
                        'const nodeServerModule = "rivet-adapter-internal";'
                    );
                    newText = newText.replace(
                        /const nodeWsModule = "@hono\/node-ws";/g, 
                        'const nodeWsModule = "rivet-adapter-internal";'
                    );
                    
                    // CRITICAL: Replace the dynamic import(variable) with import("literal")
                    // This forces the bundler to include the module
                    // We interpret the existing code pattern: await import( ... nodeServerModule )
                    // We replace it with: await import("rivet-adapter-internal")
                    // We use a regex that matches the import call roughly
                    
                    // Pattern for @hono/node-server import
                    newText = newText.replace(
                        /await import\(\s*\/\* webpackIgnore: true \*\/\s*nodeServerModule\s*\)/g,
                        'await import("rivet-adapter-internal")'
                    );
                    
                    // Pattern for @hono/node-ws import
                    newText = newText.replace(
                        /await import\(\s*\/\* webpackIgnore: true \*\/\s*nodeWsModule\s*\)/g,
                        'await import("rivet-adapter-internal")'
                    );
                    
                    // 3. Runtime Fix: Replace c.req.valid("json") with await c.req.json() to fix validation crash
                    // This is needed because the bundled Hono instance might not have the validator middleware bundled correctly
                    newText = newText.replace(
                        /c\.req\.valid\("json"\)/g, 
                        'await c.req.json()'
                    );
                    
                    return { contents: newText, loader: "js" };
                }
                return undefined; // use default loader
            });
        },
    }],
});

if (!result.success) {
    console.error("Bundle failed:", result.logs);
    process.exit(1);
}

// Get the bundled code
const bundleContent = await result.outputs[0].text();
await Bun.write("server-bundle.js", bundleContent);
const bundleSize = (bundleContent.length / 1024 / 1024).toFixed(2);
console.log(`Bundled ${bundleSize} MB`);

console.log("Compiling to standalone executable...");
const compileArgs = [
    "bun",
    "build",
    "--compile",
    "server-bundle.js",
    ...assets, // Pass frontend assets to be embedded
    "--outfile",
    "rival"
];

const compileProcess = await Bun.spawn(compileArgs, {
    stdout: "inherit",
    stderr: "inherit"
});
await compileProcess.exited;

if (compileProcess.exitCode !== 0) {
    console.error("Compile failed");
    process.exit(1);
}

console.log("Build complete! ./rival created.");
