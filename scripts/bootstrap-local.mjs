import { copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    shell: process.platform === "win32",
    stdio: "ignore"
  });
  child.unref();
}

if (!(await exists(".env"))) {
  await copyFile(".env.example", ".env");
  console.log("Created .env from .env.example. Add API keys in the Settings UI after the app opens.");
}

if (!(await exists("node_modules"))) {
  await run("npm", ["install"]);
}

await run("npm", ["run", "prisma:push"]);

setTimeout(() => openBrowser("http://127.0.0.1:5173"), 1200);
await run("npm", ["run", "dev"]);
