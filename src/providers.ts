import Anthropic from "@anthropic-ai/sdk";
import { invoke } from "@tauri-apps/api/core";
import * as gemini from "./gemini";
import type { Effort, Message, Model } from "./gemini";

export type Provider = {
  label: string;
  // API-key providers only; subscription providers reuse the login of the user's installed CLI
  keyHint?: string;
  // file types the attach picker offers; unset means any
  accept?: string;
  // levels the effort setting offers; unset means low, medium and high
  efforts?: Effort[];
  listModels(key: string): Promise<Model[]>;
  generate(key: string, model: string, messages: Message[], effort: Effort): Promise<string>;
};

const turns = (messages: Message[]) => messages.filter((m) => m.role !== "error");
const dataUrl = (a: { mimeType: string; data: string }) => `data:${a.mimeType};base64,${a.data}`;

// ---------- OpenAI API ----------

async function openai(key: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.openai.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `OpenAI request failed (${res.status})`);
  return json;
}

export function toOpenAIInput(messages: Message[]) {
  return turns(messages).map((m) =>
    m.role === "model"
      ? { role: "assistant", content: m.text }
      : {
          role: "user",
          content: [
            ...(m.attachments ?? []).map((a) =>
              a.mimeType.startsWith("image/")
                ? { type: "input_image", image_url: dataUrl(a) }
                : { type: "input_file", filename: a.name, file_data: dataUrl(a) },
            ),
            ...(m.text ? [{ type: "input_text", text: m.text }] : []),
          ],
        },
  );
}

// ---------- Claude API ----------

const claude = (key: string) => new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });

// shortcut: only images and PDFs are sent as attachments (the API rejects other types), add text documents when needed
export function toClaudeMessages(messages: Message[]): Anthropic.MessageParam[] {
  return turns(messages).map((m) => ({
    role: m.role === "model" ? "assistant" : "user",
    content: [
      ...(m.attachments ?? []).map(
        (a): Anthropic.ContentBlockParam =>
          a.mimeType === "application/pdf"
            ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } }
            : {
                type: "image",
                source: {
                  type: "base64",
                  media_type: a.mimeType as Anthropic.Base64ImageSource["media_type"],
                  data: a.data,
                },
              },
      ),
      ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
    ],
  }));
}

// ---------- subscriptions, through the user's own CLI login ----------

// shortcut: the CLIs get the chat as one flattened prompt with every image of the chat attached to it, switch to their session resume when long chats matter
export function toTranscript(messages: Message[]) {
  const list = turns(messages);
  // the marker ties each image to its turn, and keeps an image-only prompt from being empty
  const said = (m: Message) =>
    [m.text, ...(m.attachments ?? []).map((a) => `[attached image: ${a.name}]`)].filter(Boolean).join("\n");
  if (list.length === 1) return said(list[0]);
  return (
    "Continue this conversation. Reply only with the next assistant message.\n\n" +
    list.map((m) => `${m.role === "model" ? "Assistant" : "User"}: ${said(m)}`).join("\n\n")
  );
}

const CLAUDE_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

function cli(name: "claude" | "codex", label: string, models: () => Promise<Model[]>, efforts?: Effort[]): Provider {
  return {
    label,
    efforts,
    accept: "image/png,image/jpeg,image/gif,image/webp",
    async listModels() {
      await invoke("cli_status", { cli: name }); // rejects when the CLI is missing or signed out
      return [{ name: "default", displayName: "Default" }, ...(await models())];
    },
    generate: (_key, model, messages, effort) =>
      invoke<string>("cli_ask", {
        cli: name,
        model,
        effort,
        prompt: toTranscript(messages),
        images: turns(messages).flatMap((m) => m.attachments ?? []),
      }),
  };
}

type CodexModel = { slug: string; display_name: string; visibility: string; priority: number };

// codex ships its own model catalog, so the list follows the installed CLI
export function toCodexModels(catalog: string): Model[] {
  const { models } = JSON.parse(catalog) as { models: CodexModel[] };
  return models
    .filter((m) => m.visibility === "list")
    .sort((a, b) => a.priority - b.priority)
    .map((m) => ({ name: m.slug, displayName: m.display_name }));
}

export const providers: Record<string, Provider> = {
  "claude-cli": cli(
    "claude",
    "Claude subscription",
    async () => ["Fable", "Opus", "Sonnet", "Haiku"].map((m) => ({ name: m.toLowerCase(), displayName: m })),
    CLAUDE_EFFORTS,
  ),
  // "default" follows the user's codex config; an older codex without the catalog command offers only that
  "codex-cli": cli("codex", "ChatGPT subscription", () =>
    invoke<string>("codex_models").then(toCodexModels, () => []),
  ),
  anthropic: {
    label: "Claude API",
    keyHint: "Claude API key",
    efforts: CLAUDE_EFFORTS,
    async listModels(key) {
      const models: Model[] = [];
      for await (const m of claude(key).models.list()) models.push({ name: m.id, displayName: m.display_name });
      return models;
    },
    async generate(key, model, messages, effort) {
      const res = await claude(key).messages.create({
        model,
        max_tokens: 16000,
        messages: toClaudeMessages(messages),
        ...(effort && { output_config: { effort } }),
      });
      if (res.stop_reason === "refusal") throw new Error("Claude declined to answer");
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    },
  },
  openai: {
    label: "OpenAI API",
    keyHint: "OpenAI API key",
    async listModels(key) {
      const body = await openai(key, "models");
      const data: { id: string; created: number }[] = body?.data ?? [];
      // /models also lists embedding, audio and image models, which cannot chat
      return data
        .filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !/audio|realtime|image|tts|transcribe|search|instruct/.test(m.id))
        .sort((a, b) => b.created - a.created)
        .map((m) => ({ name: m.id, displayName: m.id }));
    },
    async generate(key, model, messages, effort) {
      const body = await openai(key, "responses", {
        model,
        input: toOpenAIInput(messages),
        ...(effort && { reasoning: { effort } }),
      });
      const parts: { text?: string; refusal?: string }[] = (body?.output ?? []).flatMap(
        (item: { type: string; content?: unknown[] }) => (item.type === "message" ? (item.content ?? []) : []),
      );
      if (!parts.length) throw new Error("OpenAI returned no answer");
      return parts.map((p) => p.text ?? p.refusal ?? "").join("");
    },
  },
  gemini: { label: "Gemini API", keyHint: "Gemini API key", listModels: gemini.listModels, generate: gemini.generate },
};

if (import.meta.env.DEV) {
  const chat: Message[] = [
    { role: "user", text: "hi", attachments: [{ name: "a.png", mimeType: "image/png", data: "QQ==" }] },
    { role: "error", text: "boom" },
    { role: "model", text: "yo" },
  ];
  const same = (got: unknown, want: unknown, name: string) =>
    console.assert(JSON.stringify(got) === JSON.stringify(want), `${name} self-check failed`, got);
  same(
    toOpenAIInput(chat),
    [
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,QQ==" }, { type: "input_text", text: "hi" }] },
      { role: "assistant", content: "yo" },
    ],
    "toOpenAIInput",
  );
  same(
    toClaudeMessages(chat),
    [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } }, { type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "yo" }] },
    ],
    "toClaudeMessages",
  );
  same(toTranscript(chat.slice(0, 1)), "hi\n[attached image: a.png]", "toTranscript");
  same(toTranscript(chat).split("\n\n").slice(1), ["User: hi\n[attached image: a.png]", "Assistant: yo"], "toTranscript");
  same(
    toCodexModels('{"models":[{"slug":"b","display_name":"B","visibility":"list","priority":2},{"slug":"x","display_name":"X","visibility":"hide","priority":0},{"slug":"a","display_name":"A","visibility":"list","priority":1}]}'),
    [{ name: "a", displayName: "A" }, { name: "b", displayName: "B" }],
    "toCodexModels",
  );
}
