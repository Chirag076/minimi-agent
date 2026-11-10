// server.ts: the HTTP server. No framework: four routes do not need one.
//
//   GET  /                        the chat page
//   GET  /api/conversations       list, most recent first
//   GET  /api/conversations/:id   one conversation's messages
//   POST /api/chat                { conversationId?, message } -> Server-Sent Events
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Agent } from "./agent.js";
import type { MemoryStore } from "./memory.js";

const PAGE = fileURLToPath(new URL("../public/index.html", import.meta.url));
const MAX_MESSAGE_CHARS = 4000;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("body too large");
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export function createApp(agent: Agent, store: MemoryStore): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await readFile(PAGE));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/conversations") {
        return json(res, 200, store.listConversations());
      }
      const match = url.pathname.match(/^\/api\/conversations\/([\w-]+)$/);
      if (req.method === "GET" && match) {
        const c = store.getConversation(match[1]!);
        return c ? json(res, 200, { ...c, messages: store.messagesOf(c.id) }) : json(res, 404, { error: "not found" });
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJson(req).catch(() => null);
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) return json(res, 400, { error: "message is required" });
        if (message.length > MAX_MESSAGE_CHARS) return json(res, 400, { error: `keep messages under ${MAX_MESSAGE_CHARS} characters` });

        // Server-Sent Events: tokens reach the browser as the model writes them.
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const conversationId = typeof body?.conversationId === "string" ? body.conversationId : undefined;
        for await (const event of agent.chat({ conversationId, message })) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    }
  });
}
