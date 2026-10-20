// Minimal MCP client for VectorCraft's headless engine (`vectorcraft-cli mcp --headless`).
// Newline-delimited JSON-RPC 2.0 over stdio.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CANDIDATES = [
  process.env.VECTORCRAFT_CLI,
  "C:\\Program Files\\VectorCraft\\vectorcraft-cli.exe",
  path.join(process.env.LOCALAPPDATA || "", "Programs", "VectorCraft", "vectorcraft-cli.exe"),
  "/usr/bin/vectorcraft-cli",
  "/usr/local/bin/vectorcraft-cli",
].filter(Boolean);

export function findCli() {
  const hit = CANDIDATES.find((p) => fs.existsSync(p));
  if (!hit) throw new Error("vectorcraft-cli not found; set VECTORCRAFT_CLI");
  return hit;
}

export class VectorCraft {
  constructor({ root }) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.proc = spawn(findCli(), ["mcp", "--automation-read-root", this.root, "--automation-write-root", this.root], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.id = 0;
    this.pending = new Map();
    let buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      }
    });
    this.stderr = "";
    this.proc.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
  }

  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async init() {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "biocanvas-originals", version: "0.1" } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return this;
  }

  /** Call a tool; returns parsed JSON of the first text block (or the raw result). */
  async tool(name, args = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    const text = res?.content?.find((c) => c.type === "text")?.text;
    if (res?.isError) throw new Error(`${name}: ${text || JSON.stringify(res)}`);
    if (text == null) return res;
    try { return JSON.parse(text); } catch { return text; }
  }

  cmd(command, params = {}) {
    return this.tool("run_command", { command, params });
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}
