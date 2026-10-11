# Astral

A small always-on-top chat overlay for your desktop. Press **Ctrl+Shift+A** anywhere to show it, ask a question, and press **Esc** (or click away) to hide it again.

It talks to the AI you already pay for: a Claude or ChatGPT subscription, or an API key for Claude, OpenAI or Gemini.

## Using it

- **Show / hide:** Ctrl+Shift+A (literal Control on macOS too). Changeable in settings.
- **Send:** Enter. Shift+Enter adds a new line.
- **Attach:** the + button, or paste a file or screenshot into the message box.
- **Model:** the menu on the right of the message box changes the model for the current chat.
- **Settings:** the last entry in the model menu, or the Astral icon in the menu bar (macOS) or notification area (Windows). The same icon has **Quit Astral**.

## Connecting an AI

On first launch, pick a provider from the menu on the right.

| Provider | What you need |
| --- | --- |
| Claude subscription | The `claude` CLI, signed in with your Claude plan |
| ChatGPT subscription | The `codex` CLI, signed in with your ChatGPT plan |
| Claude API | An API key from the [Claude Console](https://console.anthropic.com/) |
| OpenAI API | An API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Gemini API | An API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

API keys are pasted into the app and checked before they are saved. They are stored unencrypted in the app's local data on your computer.

### Setting up a subscription

Subscriptions do not use an API key. Astral runs the official command-line tool for your plan and uses the login you set up there, so you need that tool installed and signed in once. Your login stays with the CLI; Astral never sees or stores it.

#### Claude subscription (Pro or Max)

1. Install Claude Code:

   ```sh
   # macOS or Linux
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   ```powershell
   # Windows (PowerShell)
   irm https://claude.ai/install.ps1 | iex
   ```

   If you already have Node.js, `npm install -g @anthropic-ai/claude-code` works on every platform.

2. Sign in. This opens your browser; log in with the account that has your Claude plan:

   ```sh
   claude auth login
   ```

3. In Astral, pick **Claude subscription**.

#### ChatGPT subscription (a plan that includes Codex, such as Plus or Pro)

1. Install the Codex CLI:

   ```sh
   npm install -g @openai/codex
   ```

   On macOS, `brew install --cask codex` also works.

2. Sign in and choose **Sign in with ChatGPT** when asked:

   ```sh
   codex login
   ```

3. In Astral, pick **ChatGPT subscription**.

#### If it does not connect

- **"Could not start `claude`"** (or `codex`): the CLI is not installed, or not on your `PATH`. Open a new terminal and check that `claude --version` or `codex --version` prints a version, then restart Astral.
- **"Not signed in"**: run the sign-in command from step 2 again, then pick the provider again.
- To check a login yourself: `claude auth status` or `codex login status`.

Subscriptions accept image attachments only (PNG, JPEG, GIF, WebP). Each message is sent as a plain chat: the CLI runs without tools and without saving the conversation to its own history.

## Settings

- **Shortcut to show and hide** – click it, then press the new combination. It needs Ctrl, Alt/Option or Cmd/Win in it.
- **Clear chat when away for** – starts a fresh chat when you come back after the chosen time. Off by default.
- **Default model** – the model a new chat starts with.
- **Effort** – how hard the model thinks before answering. "Provider default" sends nothing; if a model rejects a level, set it back to that.
- **AI connection** – switch provider or replace a key. The current connection stays until the new one checks out.

## Development

You need [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```sh
npm install
npm run tauri dev      # run the app with hot reload
npm run tauri build    # build an installer for this platform
```

Tests for the Rust side:

```sh
cd src-tauri
cargo test                 # unit tests
cargo test -- --ignored    # live test; needs both CLIs installed and signed in
```

Windows installers are built by the **Windows build** GitHub Actions workflow, which is run manually and uploads the `.exe` and `.msi` as a run artifact and a draft release.
