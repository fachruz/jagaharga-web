/*
 * JagaHarga Web — shopping-list price-check assistant.
 *
 * Built on Firebase AI Logic HYBRID inference:
 *   getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE })
 * tries Gemini Nano on-device (Chrome's built-in Prompt API) first and
 * seamlessly falls back to a cloud-hosted Gemini model when the device
 * can't run it. Every answer is labelled with the route that ACTUALLY
 * served it — see showBadge() and the notes there.
 *
 * SDK: Firebase JavaScript SDK v12.5.0 (the first version that supports
 * hybrid inference and the `inferenceSource` response property),
 * loaded as ES modules from the official gstatic CDN. No build step.
 */

// ============================================================================
// FIREBASE CONFIG — project "jagaharga-web" (installed 27 Nov 2026 from the
// Firebase console registration of the "JagaHarga Web" app).
// If any value were missing/"PASTE_HERE", the app would run in "demo UI"
// mode: the page renders fully, but no AI request is made.
// ============================================================================
const firebaseConfig = {
  apiKey: "AIzaSyDegu9EdsJwJGJDOch-lyMODGfBaBGWKRI",
  authDomain: "jagaharga-web.firebaseapp.com",
  projectId: "jagaharga-web",
  storageBucket: "jagaharga-web.firebasestorage.app",
  messagingSenderId: "388898843237",
  appId: "1:388898843237:web:c590f0f1170cf38a21748c",
};

// App Check is ENFORCED for Firebase AI Logic in this project, so requests
// need an App Check token. Production uses the Fraud Defense (reCAPTCHA
// Enterprise) provider — Google deprecated new reCAPTCHA Classic
// registrations, so the console only offers Fraud Defense now. Paste its
// site key here after registering the provider in the Firebase console
// (App Check > Apps). Local testing instead uses a debug token: the QA
// harness sets self.FIREBASE_APPCHECK_DEBUG_TOKEN before the page loads
// (the token itself is registered in the console and is NOT kept in this
// file, so this repo stays safe to publish).
const APPCHECK_ENTERPRISE_KEY = "6LdLJDQuAAAAALDf6W_ECp_CR9BIAiyauU0wmX_B";

// Cloud model used when on-device inference is unavailable. Pinned
// explicitly so behaviour is deterministic. (Was gemini-2.5-flash until
// 27 Nov 2026, when the API answered 404 "no longer available to new
// users" and named gemini-3.8-flash as its replacement.)
const CLOUD_MODEL = "gemini-3.8-flash";

// Firebase JS SDK version pinned on the CDN (hybrid + inferenceSource need >= 12.5.0).
const SDK_VERSION = "12.5.0";
const CDN = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

// Gemini Nano's context window is small; keep prompts modest.
const MAX_INPUT_CHARS = 6000;

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  firebaseStatus: $("firebaseStatus"),
  nanoStatus: $("nanoStatus"),
  list: $("listInput"),
  budget: $("budgetInput"),
  btn: $("analyzeBtn"),
  progress: $("progressText"),
  error: $("errorText"),
  resultCard: $("resultCard"),
  badge: $("modeBadge"),
  verdict: $("verdictChip"),
  modeNote: $("modeNote"),
  answer: $("answerText"),
};

function setProgress(msg) {
  els.progress.hidden = !msg;
  els.progress.textContent = msg || "";
}
function setError(msg) {
  els.error.hidden = !msg;
  els.error.textContent = msg || "";
}

const isConfigured = () =>
  Object.values(firebaseConfig).every((v) => v && v !== "PASTE_HERE");

// ---------------------------------------------------------------------------
// On-device availability probe (Chrome's built-in Prompt API).
// This is ONLY a capability probe for the status line and for the honest
// fallback labelling described in showBadge(). The authoritative route of
// each answer comes from the SDK itself (response.inferenceSource).
// LanguageModel.availability() resolves to one of:
//   "available" | "downloadable" | "downloading" | "unavailable"
// ---------------------------------------------------------------------------
async function probeNano() {
  if (typeof LanguageModel === "undefined" || !LanguageModel.availability) {
    return { state: "no-api", label: "tidak ada (Prompt API tidak tersedia di browser ini)" };
  }
  try {
    const state = await LanguageModel.availability();
    const labels = {
      available: "tersedia — siap jalan di perangkat",
      downloadable: "bisa diunduh (unduhan mulai saat analisis pertama)",
      downloading: "sedang diunduh…",
      unavailable: "tidak tersedia di perangkat ini",
    };
    return { state, label: labels[state] || state };
  } catch (err) {
    return { state: "error", label: "gagal diperiksa (" + err.message + ")" };
  }
}

// ---------------------------------------------------------------------------
// The inference-mode badge.
//
// PRIMARY SOURCE OF TRUTH: Firebase AI Logic exposes which route served a
// response via `result.response.inferenceSource` ("ON_DEVICE" | "IN_CLOUD",
// JS SDK v12.5.0+). When present, the badge states the real route — no
// guessing.
//
// FALLBACK (only if a future/older SDK build omits inferenceSource): we
// label from the mode we requested (PREFER_ON_DEVICE) combined with the
// pre-flight LanguageModel probe, and the note under the badge says
// explicitly that this label is an approximation. We never silently
// present the approximation as a measured fact.
// ---------------------------------------------------------------------------
function showBadge(route, note) {
  els.badge.className = "badge";
  if (route === "ON_DEVICE") {
    els.badge.classList.add("on-device");
    els.badge.textContent = "ON DEVICE — Gemini Nano";
  } else if (route === "IN_CLOUD") {
    els.badge.classList.add("cloud");
    els.badge.textContent = "CLOUD — Gemini (" + CLOUD_MODEL + ")";
  } else {
    els.badge.classList.add("demo");
    els.badge.textContent = route; // e.g. "DEMO UI"
  }
  els.modeNote.textContent = note || "";
}

function badgeFromResult(result, nanoProbe) {
  const source = result?.response?.inferenceSource;
  if (source === "ON_DEVICE" || source === "IN_CLOUD") {
    showBadge(
      source,
      source === "ON_DEVICE"
        ? "Rute dilaporkan langsung oleh Firebase AI Logic (response.inferenceSource): jawaban ini dibuat Gemini Nano di perangkat ini — daftar belanjamu tidak meninggalkan perangkat."
        : "Rute dilaporkan langsung oleh Firebase AI Logic (response.inferenceSource): perangkat ini tidak menjalankan Gemini Nano (" +
            nanoProbe.label +
            "), jadi Firebase AI Logic otomatis memakai model cloud."
    );
    return;
  }
  // inferenceSource missing — honest approximation, labelled as such.
  const likelyOnDevice = nanoProbe.state === "available";
  showBadge(
    likelyOnDevice ? "ON_DEVICE" : "IN_CLOUD",
    "Catatan: SDK tidak melaporkan rute jawaban ini, jadi label di atas adalah perkiraan dari mode PREFER_ON_DEVICE + hasil probe Gemini Nano (" +
      nanoProbe.label +
      "), bukan laporan terukur."
  );
}

// ---------------------------------------------------------------------------
// Prompt. The assistant instructions are embedded in the prompt text itself
// (instead of a cloud-only systemInstruction) so the EXACT same instruction
// reaches Gemini Nano on-device and the cloud model — one code path, one
// behaviour, which is the point of hybrid inference.
// ---------------------------------------------------------------------------
function buildPrompt(listText, budgetRaw) {
  const budgetLine = budgetRaw
    ? `Anggaran belanja pengguna: Rp${Number(budgetRaw).toLocaleString("id-ID")}. Nilai juga apakah daftar ini muat di anggaran itu.`
    : "Pengguna tidak menyebut anggaran; lewati penilaian anggaran.";
  return [
    "Kamu adalah asisten belanja berbahasa Indonesia untuk aplikasi JagaHarga.",
    "Tugasmu: rapikan daftar belanja pengguna, tandai barang yang TERLIHAT kemahalan atau impulsif, sarankan alternatif yang lebih murah secara umum (tanpa menyebut merek/toko tertentu), lalu beri satu vonis akhir.",
    "",
    "Jawab PERSIS dengan format ini (Bahasa Indonesia, ringkas):",
    "VERDICT: <salah satu: BELI, TUNGGU, atau CAMPUR>",
    "ALASAN: <satu kalimat alasan vonis>",
    "DAFTAR RAPI:",
    "- <nama barang> — <catatan singkat: wajar / terlihat mahal / impulsif, dan kenapa>",
    "SARAN HEMAT:",
    "- <saran alternatif lebih murah, atau tulis: tidak ada>",
    "",
    "Aturan: jangan mengarang harga pasaran yang spesifik; kalau harga tidak ditulis pengguna, nilai dari jenis barangnya saja dan katakan itu perkiraan. Maksimal 250 kata.",
    "",
    budgetLine,
    "",
    "Daftar belanja pengguna:",
    listText,
  ].join("\n");
}

function showAnswer(text) {
  // Pull the VERDICT line out into a chip; show the full text as-is.
  const m = text.match(/VERDICT:\s*(BELI|TUNGGU|CAMPUR)/i);
  if (m) {
    const v = m[1].toUpperCase();
    els.verdict.hidden = false;
    els.verdict.className = "verdict " + v.toLowerCase();
    els.verdict.textContent = "Vonis: " + v;
  } else {
    els.verdict.hidden = true;
  }
  els.answer.textContent = text;
  els.resultCard.hidden = false;
}

// ---------------------------------------------------------------------------
// Firebase AI Logic — loaded lazily via dynamic import so the page (and its
// demo-UI mode) still renders even if the CDN or the network is unavailable.
// ---------------------------------------------------------------------------
let aiBackend = null; // { ai } once initialised
let aiInitPromise = null; // memoised so warm-up and click never init twice

function initFirebase() {
  if (!aiInitPromise) aiInitPromise = initFirebaseOnce();
  return aiInitPromise;
}

async function initFirebaseOnce() {
  const { initializeApp } = await import(CDN + "/firebase-app.js");
  const { getAI, GoogleAIBackend } = await import(CDN + "/firebase-ai.js");
  const app = initializeApp(firebaseConfig);
  // Attach App Check BEFORE any AI request (enforcement is on for AI Logic).
  // In debug mode (localhost QA) the debug token replaces attestation, so
  // the provider key is never actually used there. In production the Fraud
  // Defense (reCAPTCHA Enterprise) provider attests the deployed site.
  if (self.FIREBASE_APPCHECK_DEBUG_TOKEN) {
    const { initializeAppCheck, ReCaptchaV3Provider } = await import(
      CDN + "/firebase-app-check.js"
    );
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider("localhost-debug"),
      isTokenAutoRefreshEnabled: true,
    });
  } else if (APPCHECK_ENTERPRISE_KEY) {
    const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import(
      CDN + "/firebase-app-check.js"
    );
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(APPCHECK_ENTERPRISE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
  aiBackend = { ai: getAI(app, { backend: new GoogleAIBackend() }) };
  return aiBackend;
}

async function analyze() {
  setError("");
  const listText = els.list.value.trim();
  if (!listText) {
    setError("Isi dulu daftar belanjanya, ya.");
    els.resultCard.hidden = true;
    return;
  }
  if (listText.length > MAX_INPUT_CHARS) {
    setError(
      `Daftar terlalu panjang (${listText.length} karakter; batas ${MAX_INPUT_CHARS}). ` +
        "Gemini Nano punya jendela konteks kecil — persingkat dulu daftarnya."
    );
    els.resultCard.hidden = true;
    return;
  }

  els.resultCard.hidden = false;
  els.answer.textContent = "";
  els.verdict.hidden = true;

  // --- Demo UI mode: config not filled in yet. Render everything, call nothing.
  if (!isConfigured()) {
    showBadge(
      "DEMO UI",
      "Mode demo UI — konfigurasi Firebase belum diisi (lihat objek firebaseConfig di app.js). Halaman ini sudah lengkap; isi konfigurasi proyek Firebase untuk mengaktifkan analisis AI."
    );
    els.answer.textContent =
      "Contoh tampilan hasil: di sini jawaban asisten akan muncul, lengkap dengan lencana ON DEVICE / CLOUD di atasnya yang menunjukkan rute inferensi yang benar-benar dipakai.";
    return;
  }

  els.btn.disabled = true;
  try {
    setProgress("Menyiapkan Firebase AI Logic…");
    const { getGenerativeModel, InferenceMode } = await import(
      CDN + "/firebase-ai.js"
    );
    await initFirebase();
    const { ai } = aiBackend;

    const nanoProbe = await probeNano();

    // Hybrid model: prefer Gemini Nano on-device, fall back to cloud Gemini.
    const model = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      inCloudParams: { model: CLOUD_MODEL },
    });

    // Required by the hybrid guide: initialise the on-device model AFTER a
    // user interaction (this click) and BEFORE the first prompt request.
    // The callback reports Gemini Nano's model-download progress (0..1).
    setProgress("Menyiapkan model di perangkat (bila tersedia)…");
    try {
      await model.initializeDeviceModel((val) => {
        setProgress(
          "Mengunduh Gemini Nano ke perangkat… " +
            Math.round(val * 100) +
            "%"
        );
      });
    } catch (e) {
      // No on-device model on this browser/device — not fatal:
      // PREFER_ON_DEVICE will simply route to the cloud.
      console.info("initializeDeviceModel:", e?.message || e);
    }

    setProgress("Menganalisis daftar belanja…");
    const prompt = buildPrompt(listText, els.budget.value);
    let result;
    try {
      result = await model.generateContent(prompt);
    } catch (err) {
      // Known edge (also seen in other hybrid apps): for oversized inputs
      // Chrome can throw QuotaExceededError, which PREFER_ON_DEVICE does
      // not always catch. Retry once, explicitly in the cloud.
      if (/quota/i.test(err?.name + " " + err?.message)) {
        setProgress("Input terlalu besar untuk Gemini Nano — mencoba ulang lewat cloud…");
        const cloudModel = getGenerativeModel(ai, {
          mode: InferenceMode.ONLY_IN_CLOUD,
          inCloudParams: { model: CLOUD_MODEL },
        });
        result = await cloudModel.generateContent(prompt);
        badgeFromResult(result, nanoProbe);
        els.modeNote.textContent +=
          " (Catatan: Gemini Nano menolak input ini sebagai terlalu besar, jadi jawaban dibuat di cloud.)";
        showAnswer(result.response.text());
        return;
      }
      // Transient model overload, seen live from a real phone on
      // 27 Nov 2026 in two shapes: HTTP 500 "high demand" and HTTP 503
      // "Deadline expired before operation could complete". Both are the
      // cloud model being saturated, not an app error — wait and retry,
      // up to two extra attempts with growing delays.
      if (!/high demand|overloaded|temporarily|deadline expired|\b50[03]\b|unavailable/i.test(err?.message || "")) throw err;
      const delays = [3500, 8000];
      let lastErr = err;
      for (const wait of delays) {
        setProgress("Server AI sedang sibuk — mencoba lagi sebentar…");
        await new Promise((r) => setTimeout(r, wait));
        try {
          result = await model.generateContent(prompt);
          lastErr = null;
          break;
        } catch (e2) {
          lastErr = e2;
        }
      }
      if (lastErr) throw lastErr;
    }

    badgeFromResult(result, nanoProbe);
    showAnswer(result.response.text());
  } catch (err) {
    console.error(err);
    showBadge("CLOUD", "");
    els.modeNote.textContent = "";
    if (/high demand|overloaded|temporarily|deadline expired|\b50[03]\b/i.test(err?.message || "")) {
      setError(
        "Server AI Google sedang sangat sibuk saat ini — ini sementara dan bukan kesalahan aplikasinya. Tunggu sebentar, lalu ketuk Analisis lagi."
      );
    } else {
      setError(
        "Analisis gagal: " +
          (err?.message || err) +
          "\nPeriksa konfigurasi Firebase, koneksi internet, dan (untuk localhost) token debug App Check — lihat README.md."
      );
    }
    els.resultCard.hidden = true;
  } finally {
    setProgress("");
    els.btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Boot: status line + probe. No AI call happens until the user clicks.
// Warm-up (added 27 Nov 2026 after a real-phone test on a ~1 KB/s
// connection felt very slow): in configured mode, pre-load the Firebase
// SDK and initialise Firebase + App Check in the background shortly after
// the page opens, so the first Analisis click does not have to download
// several hundred KB before the analysis can even start. This spends a
// little data on page load; inference itself still waits for the click,
// and initialising the on-device model still happens at click time.
// ---------------------------------------------------------------------------
(async function boot() {
  els.firebaseStatus.textContent = isConfigured()
    ? "terkonfigurasi (proyek: " + firebaseConfig.projectId + ")"
    : "belum diisi — mode demo UI";
  const probe = await probeNano();
  els.nanoStatus.textContent = probe.label;
  if (isConfigured()) {
    const warm = () => {
      initFirebase().catch((e) => console.info("warm-up:", e?.message || e));
    };
    if ("requestIdleCallback" in window) {
      requestIdleCallback(warm, { timeout: 4000 });
    } else {
      setTimeout(warm, 1500);
    }
  }
})();

els.btn.addEventListener("click", analyze);
