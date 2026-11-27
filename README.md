# JagaHarga Web — Hybrid AI Shopping-List Price Check

JagaHarga Web is a small Indonesian-language web app that reviews a shopping
list before you spend money on it: paste your list (optionally with prices and
a budget), and an AI assistant tidies the list, flags items that look
overpriced or impulsive, suggests cheaper generic alternatives, and ends with
one verdict — **BELI** (buy), **TUNGGU** (wait), or **CAMPUR** (mixed) — with a
one-line reason.

It is the web sibling of *Jaga Harga*, a personal Android price-watch
prototype, and an entry to the **Firebase #BuildHybridAI 2026** hackathon.

## Why hybrid inference is the point

Every analysis runs through **Firebase AI Logic in hybrid mode**
(`InferenceMode.PREFER_ON_DEVICE`):

```
                 ┌────────────────────────────────────────────┐
  shopping list  │           Firebase AI Logic                │
  ─────────────► │  getGenerativeModel({                      │
                 │    mode: PREFER_ON_DEVICE,                 │
                 │    inCloudParams: { model: cloud model }   │
                 │  })                                        │
                 └───────┬──────────────────────┬─────────────┘
                         │                      │
              on-device available?         not available /
                         │                 model not downloaded
                    YES  │                      │  (automatic fallback)
                         ▼                      ▼
              ┌────────────────────┐  ┌──────────────────────────┐
              │  Gemini Nano       │  │  Gemini in the cloud     │
              │  (Chrome Prompt    │  │  (Gemini Developer API   │
              │   API, on-device)  │  │   via Firebase AI Logic) │
              └────────────────────┘  └──────────────────────────┘
                         │                      │
                         └──────────┬───────────┘
                                    ▼
              answer + badge showing the route that REALLY served it
              (from the SDK's `response.inferenceSource`)
```

**The badge is not decoration.** Firebase AI Logic reports the actual route
of every response via `response.inferenceSource` (`"ON_DEVICE"` or
`"IN_CLOUD"`), and the UI badge is rendered from that value. On a desktop
Chrome with Gemini Nano ready, the badge reads **ON DEVICE — Gemini Nano**
(and your shopping list never leaves the machine). On any other browser or
device — phones included — the same code produces a **CLOUD** badge and says
so. If a hypothetical SDK build ever omitted `inferenceSource`, the code
falls back to a clearly-labelled approximation (requested mode + a
`LanguageModel.availability()` probe) and the UI note says it is an estimate.
See `showBadge()` / `badgeFromResult()` in `app.js`.

One prompt, both paths: the assistant instructions are embedded in the
prompt text itself rather than a cloud-only `systemInstruction`, so Gemini
Nano and the cloud model receive byte-identical instructions.

## Run it

No build step, no framework — plain HTML/CSS/JS ES modules.

1. Create a Firebase project, register a **Web app**, and in the console go to
   **AI Services → AI Logic → Get started**, choosing the **Gemini Developer
   API** provider (free tier; the Spark plan is enough — avoid the Vertex /
   Agent Platform provider, which requires billing).
2. Paste your web app's config values into the `firebaseConfig` object at the
   top of `app.js` (every value is currently `"PASTE_HERE"`).
   Until then the app runs in a clearly-labelled **demo UI mode**: the page
   renders completely, but no AI request is made.
3. Serve the folder over HTTP(S) — ES modules and the Prompt API do not work
   from `file://`. Any static server works, e.g.:

   ```bash
   npx serve .
   # or
   python3 -m http.server 8000
   ```

4. Open the page, paste a shopping list, click **Analisis**.

### Seeing the ON DEVICE path

On-device inference requires **Chrome on Desktop, version 139+**, with the
flag `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` enabled.
The first analysis may trigger the Gemini Nano model download;
`model.initializeDeviceModel()` progress is shown in the UI (it must be
called after a user interaction, before the first prompt — the code calls it
from the Analisis click handler, as the docs require). Everywhere else, the
app transparently answers from the cloud and the badge shows CLOUD.

### App Check note

The Firebase AI Logic console setup automatically enforces **App Check**.
For local development on `localhost`, configure the App Check **debug
provider** and register the debug token in the console (Firebase console →
App Check → Apps → Manage debug tokens). For a deployed site, this project
registers the **Fraud Defense** provider (formerly reCAPTCHA Enterprise —
Google has deprecated new reCAPTCHA Classic registrations, so Fraud
Defense is the only provider the console still accepts for web apps) and
the app initialises App Check with `ReCaptchaEnterpriseProvider`. The
project has no billing account, so it sits in the free Essentials tier
(10,000 assessments/month; beyond that, checks are refused, not charged).
If requests are rejected with App Check errors, this is the step to check.

## SDK / API notes (verified against official docs, 25 Nov 2026)

- Hybrid guide: <https://firebase.google.com/docs/ai-logic/hybrid/web/get-started>
- Configuration options (inference modes, `inferenceSource`, fallback model):
  <https://firebase.google.com/docs/ai-logic/hybrid/web/configuration-options>
- Get started (non-hybrid): <https://firebase.google.com/docs/ai-logic/get-started>
- JS API reference (`firebase/ai`): <https://firebase.google.com/docs/reference/js/ai>

Facts that shaped this code:

- Imports: `initializeApp` from `firebase/app`; `getAI`,
  `getGenerativeModel`, `GoogleAIBackend`, `InferenceMode` from
  `firebase/ai`. This project loads them as ES modules from the official CDN
  (`https://www.gstatic.com/firebasejs/<version>/firebase-app.js` and
  `.../firebase-ai.js`) pinned to **v12.5.0** — the first version with hybrid
  inference and `inferenceSource`.
- `InferenceMode` values: `PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`,
  `PREFER_IN_CLOUD`, `ONLY_IN_CLOUD`. (Note: the cloud-strict value is
  `ONLY_IN_CLOUD`, not `ONLY_CLOUD`.)
- A hybrid model instance takes `{ mode, inCloudParams, onDeviceParams }`
  instead of a plain `model` name. This app pins
  `inCloudParams: { model: "gemini-3.8-flash" }` for deterministic
  behaviour. (Originally pinned to `gemini-2.5-flash`; on 27 Nov 2026 the
  API answered 404 — that model is "no longer available to new users" —
  and named `gemini-3.8-flash` as its replacement, so the pin moved.)
- `result.response.inferenceSource` returns `"ON_DEVICE"` or `"IN_CLOUD"`
  (v12.5.0+) — the authoritative route, used for the badge.
- `model.initializeDeviceModel(progressCallback)` must be called after/on a
  user interaction and before the first `generateContent()`; the callback
  receives download progress as a 0–1 fraction.
- On-device inference is **single-turn text generation only** (no multi-turn
  chat, no tools/function calling); input images must be JPEG/PNG inline
  data. This app is deliberately single-turn text-only.
- On-device availability can be probed with Chrome's Prompt API:
  `await LanguageModel.availability()` →
  `"available" | "downloadable" | "downloading" | "unavailable"`.
- Known edge handled in code: for oversized inputs Chrome may throw
  `QuotaExceededError`, which `PREFER_ON_DEVICE` does not always catch — the
  app retries once with an `ONLY_IN_CLOUD` model and the badge/note say so.
- The Gemini Nano context window is small, so the app caps input at 6,000
  characters with an explanatory message.

## Files

| File         | Purpose                                             |
|--------------|-----------------------------------------------------|
| `index.html` | Page structure (Indonesian UI)                      |
| `style.css`  | Plain CSS, no framework                             |
| `app.js`     | All logic: config placeholder, probe, hybrid call, badge |
| `LICENSE`    | MIT                                                 |

No data leaves the browser except the Firebase AI Logic request itself
(on-device: nothing leaves at all). No analytics, no third-party APIs.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Fachruz.
