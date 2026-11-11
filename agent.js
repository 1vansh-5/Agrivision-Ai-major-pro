// AgriVision live agent: a tool-using chat agent over the crop health knowledge base.
// It decides for itself when to search the knowledge base, check live weather, or read the farmer's latest scan.
import fs from "fs";

const KB = JSON.parse(fs.readFileSync(new URL("./knowledge.json", import.meta.url), "utf8"));
const MODEL = () => process.env.GROQ_AGENT_MODEL || process.env.GROQ_TEXT_MODEL || "llama-3.3-70b-versatile";
const DOSE = /\b\d+(\.\d+)?\s?(mg|ml|g|gm|kg|l|litre|liter|ppm|%)(\s?\/\s?(l|ha|acre|litre|liter))?/i;
const scrub = t => String(t).split("\n").map(l => DOSE.test(l) ? "Use any chemical only as per label, on KVK advice." : l).join("\n");

const SYSTEM = `You are the AgriVision Agent, a live crop health assistant for farmers in Bihar and Jharkhand, India.
Scope: crop diseases, pests, nutrient problems, irrigation, spraying timing, harvest quality for local crops. Politely decline anything else.
Use tools BEFORE answering factual questions: search_knowledge for causes, cures and prevention; get_weather before advising on spraying, irrigation or fungal risk; get_scan to see the farmer's latest photo diagnosis.
Rules: base cures on tool results. Never invent chemical names or doses; say "as per label, on KVK advice". Prefer organic and cultural methods first.
If the farmer describes symptoms but the crop is unclear, ask ONE short question or suggest sending a photo. If tools find nothing, say so and send them to the local KVK.
Keep replies short, plain, and practical: at most 5 short lines or bullets. Reply in the farmer's language.`;

const tools = [
  { type: "function", function: { name: "search_knowledge", description: "Search vetted crop health practices by crop and problem or symptom.",
    parameters: { type: "object", properties: { crop: { type: "string" }, problem: { type: "string" } }, required: ["crop"] } } },
  { type: "function", function: { name: "list_crops", description: "List crops covered by the knowledge base.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_weather", description: "Current weather and 3-day rain forecast at the farmer's location.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_scan", description: "The farmer's latest photo diagnosis (crop, condition, severity).", parameters: { type: "object", properties: {} } } },
];

export function searchKnowledge(crop = "", problem = "") {
  const c = String(crop).toLowerCase(), p = String(problem).toLowerCase();
  const cropHit = e => e.c.includes("any") || (c && e.c.some(x => c.includes(x) || x.includes(c)));
  const score = e => (p ? e.k.filter(k => p.includes(k)).length + (p.includes(e.n.toLowerCase()) ? 2 : 0) : 0);
  const hits = KB.filter(cropHit).map(e => ({ e, s: score(e) })).filter(x => !p || x.s > 0 || !x.e.c.includes("any")).sort((a, b) => b.s - a.s).slice(0, 4);
  return hits.length ? hits.map(({ e }) => ({ problem: e.n, cure: e.cure, prevention: e.prev, quality: e.q })) : { note: "No vetted entry found." };
}

async function runTool(name, args, ctx) {
  if (name === "search_knowledge") return searchKnowledge(args.crop, args.problem);
  if (name === "list_crops") return [...new Set(KB.flatMap(e => e.c).filter(x => x !== "any"))];
  if (name === "get_scan") return ctx.scan || { note: "No scan yet. Ask the farmer to scan a plant." };
  if (name === "get_weather") {
    if (typeof ctx.lat !== "number" || typeof ctx.lon !== "number") return { note: "Location not shared by the farmer." };
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${ctx.lat}&longitude=${ctx.lon}&current=temperature_2m,relative_humidity_2m,rain&daily=precipitation_sum&forecast_days=3`;
    const j = await (await fetch(u)).json();
    return { current: j.current, rain_next_3_days_mm: j.daily?.precipitation_sum };
  }
  return { error: "unknown tool" };
}

async function chat(messages, withTools) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model: MODEL(), messages, temperature: 0.2, max_tokens: 700, ...(withTools ? { tools, tool_choice: "auto" } : {}) }),
  });
  if (!r.ok) { const e = new Error(`Groq ${r.status}`); e.body = await r.text(); throw e; }
  return (await r.json()).choices[0].message;
}

export async function runAgent({ messages, scan, lat, lon, lang }) {
  const ctx = { scan, lat, lon }, steps = [];
  const convo = [{ role: "system", content: `${SYSTEM}\nLanguage: ${lang === "hi" ? "Hindi" : "English"}.` },
    ...messages.slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 1500) }))];
  try {
    for (let i = 0; i < 5; i++) {
      const m = await chat(convo, true);
      convo.push(m);
      if (!m.tool_calls?.length) return { reply: scrub(m.content || ""), steps };
      for (const t of m.tool_calls) {
        let a = {}; try { a = JSON.parse(t.function.arguments || "{}"); } catch {}
        let out; try { out = await runTool(t.function.name, a, ctx); } catch (e) { out = { error: String(e) }; }
        steps.push({ tool: t.function.name, args: a });
        convo.push({ role: "tool", tool_call_id: t.id, content: JSON.stringify(out) });
      }
    }
    return { reply: "I could not finish that. Please rephrase your question.", steps };
  } catch (e) {
    // Fallback if the model emits a malformed tool call: answer from knowledge fetched by the server
    if (!/tool/i.test(e.body || "")) throw e;
    const last = messages[messages.length - 1]?.content || "";
    const facts = searchKnowledge(scan?.crop || "", `${scan?.condition || ""} ${last}`);
    steps.push({ tool: "search_knowledge", args: { fallback: true } });
    const m = await chat([...convo.slice(0, 1 + messages.slice(-10).length), { role: "system", content: `Vetted facts: ${JSON.stringify(facts)}\nLatest scan: ${JSON.stringify(scan || null)}` }], false);
    return { reply: scrub(m.content || ""), steps };
  }
}

const seen = new Map(); // 60 messages per hour per IP
export const agentLimited = ip => { const now = Date.now(), a = (seen.get(ip) || []).filter(t => now - t < 3.6e6); a.push(now); seen.set(ip, a); return a.length > 60; };
