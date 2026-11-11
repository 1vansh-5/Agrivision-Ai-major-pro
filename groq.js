// One place for every Groq call: current models, parameter handling and readable errors.
const URL_ = "https://api.groq.com/openai/v1/chat/completions";
// llama-4-scout and llama-3.3-70b were retired by Groq in 2026. qwen3.8-27b reads images, uses tools and returns JSON.
export const models = () => ({
  vision: process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b",
  text: process.env.GROQ_TEXT_MODEL || "qwen/qwen3.8-27b",
});

export class GroqError extends Error {
  constructor(status, body, model) { super(`Groq ${status}`); this.status = status; this.body = body; this.model = model; }
}

// Switch reasoning off: faster, cheaper, and keeps JSON answers clean
const tune = m => m.startsWith("qwen/") ? { reasoning_effort: "none" } : m.startsWith("openai/gpt-oss") ? { include_reasoning: false } : {};

export async function complete(model, body) {
  const send = extra => fetch(URL_, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0.2, max_tokens: 1200, ...extra, ...body }),
  });
  let r = await send(tune(model));
  if (r.status === 400 && /reasoning|include_reasoning/i.test(await r.clone().text())) r = await send({}); // model rejects the option: retry plain
  if (!r.ok) throw new GroqError(r.status, (await r.text()).slice(0, 300), model);
  return r.json();
}

export function parseJSON(t) {
  const s = String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = /\{[\s\S]*\}/.exec(s);
  if (!m) throw new SyntaxError("no json");
  return JSON.parse(m[0]);
}

export function friendly(e) {
  const b = String(e.body || "");
  if (!process.env.GROQ_API_KEY) return { status: 500, message: "The server has no Groq key. Set GROQ_API_KEY in the server settings." };
  if (e.status === 401 || e.status === 403) return { status: 502, message: "Groq rejected the API key. Check that GROQ_API_KEY is correct and active." };
  if (e.status === 404 || /model_not_found|decommission|does not exist/i.test(b)) return { status: 502, message: `The AI model "${e.model}" is not available on Groq. Set GROQ_VISION_MODEL and GROQ_TEXT_MODEL to current models (console.groq.com/docs/models).` };
  if (e.status === 429) return { status: 429, message: "Groq's rate limit was reached. Wait a minute and try again." };
  if (e.status === 400 && /image/i.test(b)) return { status: 400, message: "The AI could not read that image. Try a clearer, smaller photo." };
  if (e instanceof SyntaxError) return { status: 502, message: "The AI returned an unreadable answer. Please scan again." };
  return { status: 500, message: "Something went wrong. Please try again." };
}
