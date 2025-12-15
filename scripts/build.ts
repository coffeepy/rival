
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

console.log("Compiling server...");
const buildArgs = [
    "bun", 
    "build", 
    "--compile", 
    "server/index.ts", 
    ...assets, // Pass every asset file as an argument to bundle it
    "--outfile", 
    "rival"
];

const serverBuild = await Bun.spawn(buildArgs, {
    stdout: "inherit",
    stderr: "inherit"
});
await serverBuild.exited;

if (serverBuild.exitCode !== 0) {
    console.error("Server build failed");
    process.exit(1);
}

console.log("Build complete! ./rival created.");
