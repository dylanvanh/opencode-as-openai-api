import { chmod, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export const FAKE_OPENCODE_SOURCE = `
import { createServer } from "node:http";

if (process.argv[2] === "--version") {
  console.log("1.18.16");
  process.exit(0);
}

if (process.argv[2] !== "serve") {
  console.error("unexpected OpenCode command");
  process.exit(1);
}

const portArgumentIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portArgumentIndex + 1]);
const server = createServer(async (request, response) => {
  const sendJson = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  if (request.url === "/global/health") return sendJson(200, { healthy: true });
  if (request.url === "/experimental/tool/ids") return sendJson(200, ["bash", "read"]);
  if (request.url === "/config/providers") {
    return sendJson(200, { providers: [{ id: "test", models: { model: {} } }] });
  }
  if (request.url === "/session" && request.method === "POST") {
    return sendJson(200, { id: "session-1" });
  }
  if (request.url === "/session/session-1/message" && request.method === "POST") {
    return sendJson(200, {
      info: { tokens: { input: 2, output: 3, reasoning: 0 } },
      parts: [{ type: "text", text: "Hello from fake OpenCode" }],
    });
  }
  if (request.url === "/session/session-1" && request.method === "DELETE") {
    response.writeHead(204);
    return response.end();
  }

  return sendJson(404, { error: "not found" });
});

server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
process.once("SIGINT", () => server.close(() => process.exit(0)));
`;

export async function installNodeCommand(
  commandDirectory: string,
  commandName: string,
  source: string,
): Promise<void> {
  const commandPath = join(commandDirectory, commandName);
  await writeFile(commandPath, `#!/usr/bin/env node\n${source}`);
  await chmod(commandPath, 0o755);
  if (process.platform === "win32") {
    await writeFile(`${commandPath}.cmd`, `@"${process.execPath}" "${commandPath}" %*\r\n`);
  }
}

export function pathWithCommandDirectory(commandDirectory: string): string {
  const currentPath = process.env["PATH"];
  return currentPath ? `${commandDirectory}${delimiter}${currentPath}` : commandDirectory;
}
