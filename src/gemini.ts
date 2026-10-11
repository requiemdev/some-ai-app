const BASE = "https://generativelanguage.googleapis.com/v1beta";

export type Attachment = { name: string; mimeType: string; data: string };
export type Message = {
  role: "user" | "model" | "error";
  text: string;
  attachments?: Attachment[];
};
// "" leaves the level to the provider's default
export type Effort = "" | "low" | "medium" | "high" | "xhigh" | "max";
export type Model = {
  name: string; // "models/gemini-..."
  displayName: string;
  supportedGenerationMethods?: string[];
};

async function call(key: string, path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `Gemini request failed (${res.status})`);
  }
  return body;
}

// The API lists every model that can generate content; the picker offers only Gemini 3 and later, Flash and Pro.
export function isChatModel(name: string) {
  return (
    /^models\/gemini-([3-9]|\d\d)(\.\d+)?-(flash|pro)/.test(name) &&
    !/tts|image|audio|live|embedding|robotics|computer-use|deep-research|customtools/.test(name) && // other jobs than chat
    !/-\d{3}$|-\d{2}-\d{2,4}$|-exp|-latest$/.test(name) // pinned, dated and alias duplicates of a listed model
  );
}

export async function listModels(key: string): Promise<Model[]> {
  const models: Model[] = [];
  let pageToken = "";
  do {
    const body = await call(key, `models?pageSize=1000&pageToken=${encodeURIComponent(pageToken)}`);
    models.push(...(body?.models ?? []));
    pageToken = body?.nextPageToken ?? "";
  } while (pageToken);
  return models.filter((m) => m.supportedGenerationMethods?.includes("generateContent") && isChatModel(m.name));
}

export function toContents(messages: Message[]) {
  return messages
    .filter((m) => m.role !== "error")
    .map((m) => ({
      role: m.role,
      parts: [
        ...(m.text ? [{ text: m.text }] : []),
        ...(m.attachments ?? []).map((a) => ({
          inline_data: { mime_type: a.mimeType, data: a.data },
        })),
      ],
    }));
}

if (import.meta.env.DEV) {
  const got = toContents([
    { role: "user", text: "hi", attachments: [{ name: "a.png", mimeType: "image/png", data: "QQ==" }] },
    { role: "error", text: "boom" },
    { role: "model", text: "yo" },
  ]);
  const want = [
    { role: "user", parts: [{ text: "hi" }, { inline_data: { mime_type: "image/png", data: "QQ==" } }] },
    { role: "model", parts: [{ text: "yo" }] },
  ];
  console.assert(JSON.stringify(got) === JSON.stringify(want), "toContents self-check failed", got);
  const kept = [
    "gemini-3-pro-preview",
    "gemini-3.1-flash-lite",
    "gemini-10-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-3-pro-image-preview",
    "gemini-3-flash-preview-12-2025",
    "gemini-3.1-pro-preview-customtools",
    "gemini-3.5-flash-preview-tts",
    "gemini-flash-latest",
    "gemini-robotics-er-3-preview",
    "gemma-3-27b-it",
  ].filter((n) => isChatModel(`models/${n}`));
  console.assert(kept.join() === "gemini-3-pro-preview,gemini-3.1-flash-lite,gemini-10-flash", "isChatModel self-check failed", kept);
}

export async function generate(key: string, model: string, messages: Message[], effort: Effort): Promise<string> {
  // model is the full resource name from listModels ("models/...")
  const body = await call(key, `${model}:generateContent`, {
    method: "POST",
    body: JSON.stringify({
      contents: toContents(messages),
      ...(effort && { generationConfig: { thinkingConfig: { thinkingLevel: effort } } }),
    }),
  });
  const parts: { text?: string }[] | undefined = body?.candidates?.[0]?.content?.parts;
  if (!parts) {
    const reason = body?.promptFeedback?.blockReason ?? body?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Gemini returned no answer (${reason})` : "Gemini returned no answer");
  }
  return parts.map((p) => p.text ?? "").join("");
}
