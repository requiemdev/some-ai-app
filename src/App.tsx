import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Attachment, Effort, Message, Model } from "./gemini";
import { providers } from "./providers";
import "./App.css";

const SETTINGS = "__settings";
const BASE_EFFORTS: Effort[] = ["low", "medium", "high"];
const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const MAC = navigator.userAgent.includes("Mac");
const MAX_HEIGHT = 0.6 * window.screen.availHeight;

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
  // installs from before onboarding only stored a Gemini key
  const [provider, setProvider] = useState(() => store.get("provider") || (store.get("apiKey") && "gemini"));
  const [choice, setChoice] = useState(() => Object.keys(providers)[0]);
  const [apiKey, setApiKey] = useState(() => store.get("apiKey"));
  const [models, setModels] = useState<Model[]>([]);
  // the chat's picker changes the model for this chat only; the default in settings is the stored one
  const [defaultModel, setDefaultModel] = useState(() => store.get("model"));
  const [model, setModel] = useState(defaultModel);
  const [effort, setEffort] = useState(() => store.get("effort") as Effort);
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  // the format the Rust side parses: modifiers, then a KeyboardEvent.code
  const [shortcut, setShortcut] = useState(() => store.get("shortcut") || "Ctrl+Shift+KeyA");
  const [recording, setRecording] = useState(false);
  const [clearAfter, setClearAfter] = useState(() => store.get("clearAfter")); // minutes; "" is never

  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = providers[provider]; // undefined until onboarding is done
  const efforts = active?.efforts ?? BASE_EFFORTS;
  // The native file picker takes focus from the window; that must not count as clicking outside.
  const picking = useRef(false);

  const showError = (e: unknown) =>
    setMessages((m) => [...m, { role: "error", text: errorText(e) }]);

  // Window follows content height; the root is content-sized, so this covers long input and new messages.
  useEffect(() => {
    const el = rootRef.current!;
    const observer = new ResizeObserver(() => {
      const height = Math.max(64, Math.min(el.offsetHeight, MAX_HEIGHT));
      invoke("resize", { height }).catch(console.error);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const focusInput = () =>
      rootRef.current?.querySelector<HTMLElement>("textarea, input[type=password], .connect-button")?.focus();
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

  // Rust registers the default shortcut at launch; a saved one replaces it here.
  useEffect(() => {
    if (store.get("shortcut")) invoke("set_shortcut", { shortcut }).catch(showError);
  }, []);

  // The tray's Settings item. Before onboarding is done, the connection row is already what shows.
  useEffect(() => {
    if (!provider) return;
    const unlisten = listen("open-settings", () => toggleSettings(true));
    return () => {
      unlisten.then((off) => off());
    };
  }, [provider]);

  // Auto-clear: a chat left unfocused longer than the setting starts fresh. Waiting for a reply does not count.
  useEffect(() => {
    if (busy) return;
    let awaySince = document.hasFocus() ? 0 : Date.now();
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      const minutes = Number(store.get("clearAfter"));
      if (!focused) awaySince = Date.now();
      else if (minutes && awaySince && Date.now() - awaySince >= minutes * 60_000) {
        setMessages([]);
        setModel((current) => store.get("model") || current);
      }
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [busy]);

  useEffect(() => {
    setModels([]);
    if (!active) return;
    let stale = false;
    active
      .listModels(apiKey)
      .then((list) => {
        if (stale) return;
        setModels(list);
        setModel((current) => (list.some((m) => m.name === current) ? current : (list[0]?.name ?? "")));
      })
      .catch((e) => !stale && showError(e));
    return () => {
      stale = true;
    };
  }, [provider, apiKey]);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input, provider, settings]);

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [messages, busy]);

  // Safari/WKWebView fires the Enter that commits an IME composition with isComposing false but keyCode 229
  const isSubmit = (e: React.KeyboardEvent) =>
    e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229;

  async function connect(id = choice) {
    const key = providers[id].keyHint ? input.trim() : "";
    if (busy || (providers[id].keyHint && !key)) return;
    setBusy(true);
    try {
      await providers[id].listModels(key); // proves the key or CLI login works before leaving onboarding
      // shortcut: the API key is stored in plaintext localStorage, move it to the OS keychain before shipping beyond personal use
      store.set("apiKey", key);
      if (id !== provider) {
        // the default model belongs to the provider being left
        store.set("model", "");
        setDefaultModel("");
        if (!(providers[id].efforts ?? BASE_EFFORTS).includes(effort)) {
          store.set("effort", "");
          setEffort("");
        }
      }
      store.set("provider", id);
      setApiKey(key);
      setProvider(id);
      setInput("");
      setMessages((m) => m.filter((x) => x.role !== "error"));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  function addFiles(files: FileList | null) {
    // shortcut: inline attachments are capped by Gemini's ~20 MB request size, switch to the Files API for larger files
    Array.from(files ?? []).forEach((file) => {
      // the picker filters by itself; a paste does not
      if (active.accept && !active.accept.split(",").includes(file.type))
        return showError(`${active.label} takes PNG, JPEG, GIF or WebP images only, not ${file.name}`);
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
      const reply = await active.generate(apiKey, model, next, effort);
      setMessages((m) => [...m, { role: "model", text: reply }]);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  function toggleSettings(open: boolean) {
    setSettings(open);
    setChoice(provider);
    setInput(""); // the field doubles as the key input, so a draft or half-typed key must not cross over
  }

  function recordShortcut(e: React.KeyboardEvent) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation(); // Esc cancels the recording here, instead of hiding the window
    if (e.key === "Escape") return setRecording(false);
    // a global shortcut without one of these would swallow ordinary typing everywhere
    if (!(e.ctrlKey || e.altKey || e.metaKey) || ["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    const next = [
      e.ctrlKey && "Ctrl",
      e.altKey && (MAC ? "Option" : "Alt"),
      e.shiftKey && "Shift",
      e.metaKey && (MAC ? "Cmd" : "Super"),
      e.code,
    ]
      .filter(Boolean)
      .join("+");
    setRecording(false);
    invoke("set_shortcut", { shortcut: next }).then(() => {
      store.set("shortcut", next);
      setShortcut(next);
    }, showError);
  }

  function onModelChange(value: string) {
    if (value === SETTINGS) return toggleSettings(true);
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

      {active && !settings ? (
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
            accept={active.accept}
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
            placeholder="Ask anything"
            aria-label="Message"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              if (!e.clipboardData.files.length) return; // plain text pastes as usual
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }}
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
            <option value={SETTINGS}>Settings…</option>
          </select>
        </div>
      ) : (
        // onboarding is this same connection row, without the rest of the settings
        <>
          {active && (
            <>
              <div className="setting">
                Shortcut to show and hide
                <button
                  type="button"
                  className="model-select shortcut"
                  aria-label={`Shortcut: ${shortcut}. Activate to change`}
                  onClick={(e) => {
                    e.currentTarget.focus(); // WebKit does not focus a button on click, and the key presses go to the focused element
                    setRecording(!recording);
                  }}
                  onBlur={() => setRecording(false)}
                  onKeyDown={recordShortcut}
                >
                  {recording ? "Press new shortcut…" : shortcut.replace(/\+(Key|Digit)/, "+")}
                </button>
              </div>
              <label className="setting">
                Clear chat when away for
                <select
                  className="model-select"
                  value={clearAfter}
                  onChange={(e) => {
                    store.set("clearAfter", e.target.value);
                    setClearAfter(e.target.value);
                  }}
                >
                  <option value="">Never</option>
                  <option value="1">1 minute</option>
                  <option value="5">5 minutes</option>
                  <option value="15">15 minutes</option>
                  <option value="60">1 hour</option>
                </select>
              </label>
              <hr className="setting-divider" />
              <label className="setting">
                Default model
                <select
                  className="model-select"
                  disabled={choice !== provider} // these two rows follow the connected provider, not the one being picked
                  value={models.some((m) => m.name === defaultModel) ? defaultModel : models[0]?.name} // nothing saved means the first one
                  onChange={(e) => {
                    store.set("model", e.target.value);
                    setDefaultModel(e.target.value);
                    setModel(e.target.value);
                  }}
                >
                  {models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting">
                Effort
                <select
                  className="model-select"
                  disabled={choice !== provider}
                  value={effort}
                  onChange={(e) => {
                    store.set("effort", e.target.value);
                    setEffort(e.target.value as Effort);
                  }}
                >
                  <option value="">Provider default</option>
                  {efforts.map((e) => (
                    <option key={e} value={e}>
                      {EFFORT_LABELS[e]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <div className="input-row">
            {active && (
              <button type="button" className="attach-button" aria-label="Close settings" onClick={() => toggleSettings(false)}>
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              </button>
            )}
            {providers[choice].keyHint ? (
              <input
                className="input key-input"
                type="password"
                autoFocus
                placeholder={choice === provider ? `${providers[choice].keyHint} saved` : `Paste ${providers[choice].keyHint}`}
                aria-label={providers[choice].keyHint}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (!isSubmit(e)) return;
                  e.preventDefault();
                  connect();
                }}
              />
            ) : (
              <button type="button" className="input key-input connect-button" autoFocus disabled={busy} onClick={() => connect()}>
                {busy ? "Checking…" : choice === provider ? `${providers[choice].label} connected` : `Connect ${providers[choice].label}`}
              </button>
            )}
            <select
              className="model-select"
              aria-label="Provider"
              value={choice}
              onChange={(e) => {
                const id = e.target.value;
                setChoice(id);
                setInput("");
                // a subscription has nothing to enter, so picking it connects; the button is left for a retry
                if (!providers[id].keyHint && id !== provider) connect(id);
              }}
            >
              {Object.entries(providers).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </main>
  );
}

export default App;
