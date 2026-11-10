// llm.ts: the model, behind a small interface.
//
// The agent only needs "stream some text, then tell me which tools you want". Gemini sits
// behind `ChatModel`, so the agent loop is tested with a fake model and the provider can be
// swapped without touching it.
import { ApiError, GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";

export type { Content, FunctionDeclaration, Part };

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export type ModelEvent =
  | { type: "text"; text: string }
  /** End of one model step. `parts` is everything the model produced, echoed back verbatim. */
  | { type: "done"; parts: Part[]; calls: ToolCall[] };

export interface ModelRequest {
  system: string;
  contents: Content[];
  tools: FunctionDeclaration[];
}

export interface ChatModel {
  stream(req: ModelRequest): AsyncGenerator<ModelEvent>;
}

/** 429 (rate limit) and 5xx (overloaded) usually clear within seconds. */
export function isTemporary(e: unknown): boolean {
  return e instanceof ApiError && [429, 500, 503].includes(e.status);
}

export class GeminiModel implements ChatModel {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly retryWaitsMs = [1000, 3000, 8000],
    private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    for (let attempt = 0; ; attempt++) {
      let started = false; // once text reached the user, a retry would repeat it
      try {
        const stream = await this.ai.models.generateContentStream({
          model: this.model,
          contents: req.contents,
          config: {
            systemInstruction: req.system,
            tools: req.tools.length ? [{ functionDeclarations: req.tools }] : undefined,
          },
        });
        // Keep every part, including hidden thought signatures: Gemini requires them to be
        // sent back unchanged with the tool results, or the next call is rejected.
        const parts: Part[] = [];
        for await (const chunk of stream) {
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            parts.push(part);
            if (part.text && !part.thought) {
              started = true;
              yield { type: "text", text: part.text };
            }
          }
        }
        const calls = parts
          .filter((p) => p.functionCall)
          .map((p) => ({ id: p.functionCall!.id, name: p.functionCall!.name ?? "", args: (p.functionCall!.args ?? {}) as Record<string, unknown> }));
        yield { type: "done", parts, calls };
        return;
      } catch (e) {
        if (started || !isTemporary(e) || attempt >= this.retryWaitsMs.length) throw e;
        await this.sleep(this.retryWaitsMs[attempt]!);
      }
    }
  }
}
