import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { generate, listModels, type Attachment, type Message, type Model } from "./gemini";
import "./App.css";

const CHANGE_KEY = "__change_key";
const MAX_HEIGHT = 0.7 * window.screen.availHeight;

// localStorage can throw (private mode, blocked site data); never let that break rendering
const store = {
  get(name: string) {
    try {
      return localStorage.getItem(name) ?? "";
    } catch {
      return "";
    }
  },
  set(name: string, value: string) {
    try {
      if (value) localStorage.setItem(name, value);
      else localStorage.removeItem(name);
    } catch {
      /* state still holds the value for this session */
    }
  },
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function App() {
  const [apiKey, setApiKey] = useState(() => store.get("apiKey"));
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState(() => store.get("model"));
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The native file picker takes focus from the window; that must not count as clicking outside.
  const picking = useRef(false);

  const showError = (e: unknown) =>
    setMessages((m) => [...m, { role: "error", text: errorText(e) }]);

  // Window follows content height; the root is content-sized, so this covers long input and new messages.
  useEffect(() => {
    const el = rootRef.current!;
    const observer = new ResizeObserver(() => {
      const height = Math.max(64, Math.min(el.offsetHeight, MAX_HEIGHT));
      getCurrentWindow().setSize(new LogicalSize(720, height)).catch(console.error);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const focusInput = () =>
      rootRef.current?.querySelector<HTMLElement>("textarea, input[type=password]")?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      // Esc during IME composition cancels the composition, not the window
      if (e.key === "Escape" && !e.isComposing) getCurrentWindow().hide().catch(console.error);
    };
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) picking.current = false;
      else if (!picking.current) getCurrentWindow().hide().catch(console.error);
    });
    window.addEventListener("focus", focusInput);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unlisten.then((off) => off());
      window.removeEventListener("focus", focusInput);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    setModels([]);
    if (!apiKey) return;
    let stale = false;
    listModels(apiKey)
      .then((list) => {
        if (stale) return;
        setModels(list);
        setModel((current) => (list.some((m) => m.name === current) ? current : (list[0]?.name ?? "")));
      })
      .catch((e) => !stale && showError(e));
    return () => {
      stale = true;
    };
  }, [apiKey]);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input, apiKey]);

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [messages, busy]);

  // Safari/WKWebView fires the Enter that commits an IME composition with isComposing false but keyCode 229
  const isSubmit = (e: React.KeyboardEvent) =>
    e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229;

  function saveKey() {
    const value = input.trim();
    if (!value) return;
    // shortcut: the API key is stored in plaintext localStorage, move it to the OS keychain before shipping beyond personal use
    store.set("apiKey", value);
    setApiKey(value);
    setInput("");
  }

  function addFiles(files: FileList | null) {
    // shortcut: inline attachments are capped by Gemini's ~20 MB request size, switch to the Files API for larger files
    Array.from(files ?? []).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () =>
        setAttachments((a) => [
          ...a,
          {
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            data: String(reader.result).split(",")[1] ?? "",
          },
        ]);
      reader.onerror = () => showError(`Could not read ${file.name}`);
      reader.readAsDataURL(file);
    });
  }

  async function send() {
    const text = input.trim();
    if (busy || !model || (!text && !attachments.length)) return;
    const next: Message[] = [...messages, { role: "user", text, attachments }];
    setMessages(next);
    setInput("");
    setAttachments([]);
    setBusy(true);
    try {
      const reply = await generate(apiKey, model, next);
      setMessages((m) => [...m, { role: "model", text: reply }]);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  function onModelChange(value: string) {
    if (value === CHANGE_KEY) {
      store.set("apiKey", "");
      setApiKey("");
      setInput("");
      return;
    }
    store.set("model", value);
    setModel(value);
  }

  return (
    <main className="app" ref={rootRef} style={{ maxHeight: MAX_HEIGHT }}>
      {messages.length > 0 && (
        <div className="messages" ref={listRef} role="log" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={`message message-${m.role}`}>
              {m.role === "model" ? (
                <Markdown
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (href) openUrl(href).catch(showError);
                        }}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {m.text}
                </Markdown>
              ) : (
                <p className="message-text">{m.text}</p>
              )}
              {m.attachments && m.attachments.length > 0 && (
                <ul className="message-files">
                  {m.attachments.map((a, j) => (
                    <li key={j}>{a.name}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {busy && <div className="message message-thinking">Thinking…</div>}
        </div>
      )}

      {attachments.length > 0 && (
        <ul className="attachments">
          {attachments.map((a, i) => (
            <li key={i} className="chip">
              <span className="chip-name">{a.name}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))}
              >
                <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M2 2l6 6M8 2l-6 6" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      {apiKey ? (
        <div className="input-row">
          <button
            type="button"
            className="attach-button"
            aria-label="Attach files"
            onClick={() => {
              picking.current = true;
              fileRef.current?.click();
            }}
          >
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <path d="M10 3.5v13M3.5 10h13" />
            </svg>
          </button>
          <input
            ref={fileRef}
            className="file-input"
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = ""; // allow picking the same file again
            }}
          />
          <textarea
            ref={textRef}
            className="input"
            rows={1}
            autoFocus
            placeholder="Ask Gemini"
            aria-label="Message"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (!isSubmit(e)) return;
              e.preventDefault();
              send();
            }}
          />
          <select
            className="model-select"
            aria-label="Model"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {!models.some((m) => m.name === model) && (
              <option value={model} disabled>
                No model
              </option>
            )}
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.displayName}
              </option>
            ))}
            <hr />
            <option value={CHANGE_KEY}>Change API key</option>
          </select>
        </div>
      ) : (
        <div className="input-row">
          <input
            className="input key-input"
            type="password"
            autoFocus
            placeholder="Paste Gemini API key"
            aria-label="Gemini API key"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (!isSubmit(e)) return;
              e.preventDefault();
              saveKey();
            }}
          />
        </div>
      )}
    </main>
  );
}

export default App;
