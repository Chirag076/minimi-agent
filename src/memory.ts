// memory.ts: every conversation and message, with exact timestamps, saved to one JSON file.
//
// A JSON file keeps `npm install && npm run dev` free of databases and native modules.
// It is fine for one user and thousands of messages; DESIGN.md covers the move to Postgres.
// Writes go to a temp file first and are then renamed, so a crash never leaves half a file.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Source {
  n: number;             // citation number shown to the user, [1], [2] ...
  title: string;
  url: string;
  published?: string | null;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;     // ISO timestamp, the source of truth for "what did I ask on ..."
  sources?: Source[];    // what an answer was based on, so it can be re-checked later
  searches?: string[];   // the queries the agent ran for this answer
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** A question and the answer given to it. Recall works on these pairs, not single messages. */
export interface Exchange {
  question: StoredMessage;
  answer?: StoredMessage;
}

interface Data {
  conversations: Conversation[];
  messages: StoredMessage[];
}

export class MemoryStore {
  private data: Data = { conversations: [], messages: [] };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    if (existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8")) as Data;
  }

  createConversation(title: string, at: Date): Conversation {
    const c: Conversation = { id: randomUUID(), title: title.slice(0, 80), createdAt: at.toISOString(), updatedAt: at.toISOString() };
    this.data.conversations.push(c);
    return c;
  }

  getConversation(id: string): Conversation | undefined {
    return this.data.conversations.find((c) => c.id === id);
  }

  /** Most recently active first. */
  listConversations(): Conversation[] {
    return [...this.data.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  messagesOf(conversationId: string): StoredMessage[] {
    return this.data.messages.filter((m) => m.conversationId === conversationId);
  }

  async addMessage(msg: Omit<StoredMessage, "id">): Promise<StoredMessage> {
    const stored: StoredMessage = { id: randomUUID(), ...msg };
    this.data.messages.push(stored);
    const c = this.getConversation(msg.conversationId);
    if (c) c.updatedAt = msg.createdAt;
    await this.save();
    return stored;
  }

  /** Every question with the answer that followed it, oldest first. */
  exchanges(): Exchange[] {
    const out: Exchange[] = [];
    const byConversation = new Map<string, StoredMessage[]>();
    for (const m of this.data.messages) {
      const list = byConversation.get(m.conversationId) ?? [];
      list.push(m);
      byConversation.set(m.conversationId, list);
    }
    for (const list of byConversation.values()) {
      list.forEach((m, i) => {
        if (m.role !== "user") return;
        const next = list[i + 1];
        out.push({ question: m, answer: next?.role === "assistant" ? next : undefined });
      });
    }
    return out.sort((a, b) => a.question.createdAt.localeCompare(b.question.createdAt));
  }

  /** Serialised so two quick messages can never interleave their writes. */
  private save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2));
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
