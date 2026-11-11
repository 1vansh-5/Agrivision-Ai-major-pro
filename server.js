import express from "express";
import cors from "cors";
import fs from "fs";

const app = express();
const origins = (process.env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins }));
app.use(express.json({ limit: "8mb" }));
app.use(express.static("docs")); // optional: serve the frontend from the same server

const KEY = process.env.GROQ_API_KEY;
const VISION = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const TEXT = process.env.GROQ_TEXT_MODEL || "llama-3.3-70b-versatile";
const KB = JSON.parse(fs.readFileSync("knowledge.json", "utf8"));
const REGION_CROPS = "rice, wheat, maize, lentil (masoor), chickpea, pigeonpea (arhar), mustard, potato, tomato, brinjal, chilli, okra, cabbage, cauliflower, onion, mango, litchi, banana, guava, sugarcane, jute, makhana";

const SEE = `You are the vision stage of AgriVision, used by farmers in Bihar and Jharkhand, India.
Look at the photo of a crop, leaf, fruit or plant. Likely crops: ${REGION_CROPS}; others are possible.
Identify the crop yourself. Reply with ONLY JSON:
{"crop":"","crop_confidence":0-100,"alternatives":["other possible crops"],"part":"leaf|fruit|stem|whole plant|other",
"condition":"specific disease, pest, deficiency, stress, or healthy","severity":"none|mild|moderate|severe","confidence":0-100,"visible_signs":"what you see"}
If the image is not a plant, or is blurry or too far, set crop to "unknown" and confidence under 30.`;

const ADVISE = `You are the advice stage of AgriVision for farmers in Bihar and Jharkhand.
You get a diagnosis, vetted practices from our knowledge base (may be empty), and live weather (may be missing).
Reply with ONLY JSON: {"summary":"1-2 plain sentences","cure":[],"prevention":[],"quality_tips":[],"weather_note":"","see_expert":true|false}
Rules: use the vetted practices for cure steps when they exist. If none exist, give only general, safe, organic-first steps and set see_expert true.
Never invent chemical names or doses: say "as per label, on KVK advice". Use the weather to time actions (no spraying before rain; humid spells favour fungus).
Keep each item to one short sentence. Be honest about uncertainty. Write ALL text in the requested language.`;

async function groq(model, messages) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 1200, response_format: { type: "json_object" } }),
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return JSON.parse((await r.json()).choices[0].message.content);
}

function lookup(crop, condition) {
  const c = String(crop || "").toLowerCase(), d = String(condition || "").toLowerCase();
  return KB.filter(e => (e.c.includes("any") || e.c.some(x => c.includes(x))) && e.k.some(k => d.includes(k)));
}
async function weather(lat, lon) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,rain&daily=precipitation_sum&forecast_days=3`;
  const j = await (await fetch(u)).json();
  return { current: j.current, rain_next_3_days_mm: j.daily?.precipitation_sum };
}

const hits = new Map(); // 20 scans per hour per IP, protects your key
const limited = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 3.6e6); a.push(now); hits.set(ip, a); return a.length > 20; };

app.get("/api/health", (_, res) => res.json({ ok: true, vision: VISION, text: TEXT, crops_in_kb: new Set(KB.flatMap(e => e.c)).size }));

app.post("/api/diagnose", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "Server has no GROQ_API_KEY set." });
    if (limited(req.ip)) return res.status(429).json({ error: "Too many scans. Try again in an hour." });
    const { image, lat, lon, lang = "en" } = req.body;
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(image || "")) return res.status(400).json({ error: "Send a JPEG, PNG or WebP image." });
    const language = lang === "hi" ? "Hindi" : "English";

    // 1. Perceive: identify crop and condition from the photo
    const seen = await groq(VISION, [{ role: "system", content: SEE }, { role: "user", content: [
      { type: "image_url", image_url: { url: image } }, { type: "text", text: "Identify this crop and its condition." }] }]);

    // 2. Retrieve: vetted practices and live weather
    const used = ["lookup_practices"], vetted = lookup(seen.crop, seen.condition);
    let wx = null;
    if (typeof lat === "number" && typeof lon === "number") { try { wx = await weather(lat, lon); used.push("get_weather"); } catch {} }

    // 3. Advise: write the plan from the retrieved facts only
    const plan = await groq(TEXT, [{ role: "system", content: ADVISE }, { role: "user", content:
      `Language: ${language}\nDiagnosis: ${JSON.stringify(seen)}\nVetted practices: ${JSON.stringify(vetted)}\nWeather: ${JSON.stringify(wx)}` }]);

    const low = seen.crop === "unknown" || (+seen.confidence || 0) < 60;
    res.json({ ...seen, ...plan, see_expert: plan.see_expert || low, tools_used: used });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Diagnosis failed. Please try again." });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("AgriVision API on port " + (process.env.PORT || 3000)));
