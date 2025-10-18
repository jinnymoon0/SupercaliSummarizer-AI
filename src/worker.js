// SupercaliSummarizer AI — Worker (robust translation, no errors)
import { Ai } from '@cloudflare/ai';

const MODELS = {
  translate: "@cf/meta/m2m100-1.2b",
  summarize: "@cf/meta/llama-3.1-8b-instruct",
};

const LIMITS = {
  maxChars: 15000,
  maxBullets: 8,
  maxSummaryTokens: 1000,
  maxTranslateTokens: 4000,
};

export default {
  async fetch(request, env) {
    const reqOrigin = request.headers.get('origin');
    const corsHeaders = buildCors(env.ALLOWED_ORIGINS, reqOrigin);


    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return json(
        {
          ok: true,
          service: "SupercaliSummarizer AI",
          routes: ["/summarize (POST)"],
          models: MODELS,
          limits: LIMITS,
          note: "Send JSON: { text, targetLang: 'auto|ko|en', style: 'auto|paragraph|bullets' }",
        },
        200,
        corsHeaders
      );
    }

    // Main route
    if (request.method === "POST" && url.pathname === "/summarize") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, corsHeaders);
      }

      const { text, targetLang = "auto", style = "auto" } = payload || {};
      if (!text || typeof text !== "string" || !text.trim()) {
        return json({ error: 'Missing "text" (string)' }, 400, corsHeaders);
      }
      if (text.length > LIMITS.maxChars) {
        return json(
          { error: "Text too long", maxChars: LIMITS.maxChars, received: text.length },
          413,
          corsHeaders
        );
      }

      // Decide dominant language (ko/en) by heuristic or user override
      const dominant = resolveTargetLang(text, targetLang);

      // Translate whole note into dominant language (robust; never throws)
      const translated = await translateWhole(env, text, dominant);

      // Summarize into paragraph + bullets
      try {
        const { paragraph, bullets } = await summarize(env, translated, dominant, style);
        return json(
          {
            dominant,
            paragraph,
            bullets,
            translatedPreview: translated.slice(0, 400),
          },
          200,
          corsHeaders
        );
      } catch (e) {
        // If the model misbehaves, still respond JSON with a graceful message
        return json(
          {
            error: "Summarization failed",
            details: String(e),
            tip: "Try shortening the input or retry.",
          },
          500,
          corsHeaders
        );
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

/* ---------------- helpers ---------------- */

// replace your buildCors with this version:
function buildCors(allowedList, requestOrigin) {
  // allowedList: comma-separated or "*"
  const allowed = (allowedList || "*")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  // If wildcard, allow all
  if (allowed.includes("*")) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
      "Access-Control-Allow-Headers": "content-type",
    };
  }

  // If the request origin is in our allow-list, echo it back
  const origin = requestOrigin && allowed.includes(requestOrigin)
    ? requestOrigin
    : allowed[0]; // fallback (still enables navigations/tests)

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
    "Access-Control-Allow-Headers": "content-type",
  };
}


function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}

// Chooses output language: explicit target wins; otherwise by heuristic majority
function resolveTargetLang(text, targetLang) {
  if (targetLang === "ko" || targetLang === "en") return targetLang;
  const hangul = (text.match(/[\uac00-\ud7a3]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return hangul >= latin ? "ko" : "en";
}

// Detects source language by heuristic (ko/en only)
function detectSourceLang(text) {
  const hangul = (text.match(/[\uac00-\ud7a3]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return hangul >= latin ? "ko" : "en";
}

async function translateWhole(env, text, targetLang) {
  // If already the target language, skip translation
  const sourceLang = detectSourceLang(text);
  if (sourceLang === targetLang) return text;

  try {
    const ai = new Ai(env.AI);
    const run = await ai.run(MODELS.translate, {
      // m2m100 expects this direct schema (NOT chat messages)
      text,
      source_lang: sourceLang, // 'ko' or 'en'
      target_lang: targetLang, // 'ko' or 'en'
    });

    // Normalize possible outputs
    const out =
      run?.translated_text ??
      run?.response ??
      run?.result ??
      run?.text ??
      "";

    if (typeof out === "string" && out.trim()) {
      return out.trim();
    }
    // Some SDKs return arrays like { translations: [{ text: "..." }] }
    if (Array.isArray(run?.translations) && run.translations[0]?.text) {
      return String(run.translations[0].text).trim();
    }

    // Fallback to original text if nothing usable returned
    return text;
  } catch {
    // Never hard-fail on translation; return original to keep the app working
    return text;
  }
}

async function summarize(env, text, lang, style) {
  const languageLabel = lang === "ko" ? "Korean" : "English";
  const instruction =
    lang === "ko"
      ? `너는 강의노트를 요약하는 도우미야. 다음 텍스트를 ${languageLabel}(으)로 먼저 짧은 단락 요약과 핵심 불릿 포인트로 정리해줘. 꼭 아래 형식을 지켜줘. 불릿은 최대 ${LIMITS.maxBullets}개.\n\n<<PARAGRAPH>>\n(문단형 요약)\n<<BULLETS>>\n- (핵심 불릿)\n- ...`
      : `You are a lecture-notes summarizer. In ${languageLabel}, produce a short paragraph summary first, then key bullet points. Strictly follow this format. Bullets: up to ${LIMITS.maxBullets}.\n\n<<PARAGRAPH>>\n(paragraph summary)\n<<BULLETS>>\n- (key bullet)\n- ...`;

  const styleHint =
    style === "bullets"
      ? lang === "ko"
        ? "불릿을 더 자세히."
        : "Emphasize bullets."
      : style === "paragraph"
      ? lang === "ko"
        ? "문단 요약을 더 자세히."
        : "Emphasize paragraph."
      : "";

  const system =
    lang === "ko"
      ? "형식을 반드시 지켜. 허구 추가 금지. 수식/용어는 그대로 유지."
      : "Follow the exact format. Do not hallucinate. Keep formulas/terms as-is.";

  const ai = new Ai(env.AI);
  const run = await ai.run(MODELS.summarize, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: `${instruction}\n\n${styleHint}\n\nTEXT:\n${text}` },
    ],
    temperature: 0.2,
    max_output_tokens: LIMITS.maxSummaryTokens,
  });

  const raw = (run?.response || run?.result || run?.text || "").trim();
  return splitSummary(raw);b
}

function splitSummary(raw) {
  let paragraph = "";
  let bullets = [];

  const pIdx = raw.indexOf("<<PARAGRAPH>>");
  const bIdx = raw.indexOf("<<BULLETS>>");

  if (pIdx !== -1 && bIdx !== -1) {
    paragraph = raw.slice(pIdx + "<<PARAGRAPH>>".length, bIdx).trim();
    const bulletsText = raw.slice(bIdx + "<<BULLETS>>".length).trim();
    bullets = bulletsText
      .split(/\n\s*[-•]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    const lines = raw.split("\n");
    bullets = lines
      .filter((l) => /^\s*[-•]/.test(l))
      .map((l) => l.replace(/^\s*[-•]\s*/, "").trim());
    paragraph = lines.filter((l) => !/^\s*[-•]/.test(l)).join(" ").trim();
  }

  if (bullets.length > LIMITS.maxBullets) bullets = bullets.slice(0, LIMITS.maxBullets);
  return { paragraph, bullets };
}
