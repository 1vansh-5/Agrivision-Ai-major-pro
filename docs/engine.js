// AgriVision built-in AI. Runs fully in the browser: no server, no API key, no internet needed.
// (Live weather is optional and comes straight from Open-Meteo.)
(() => {
const KB = window.AGRI_KB || [];
const CROPS = [["rice","Rice (धान)"],["wheat","Wheat (गेहूं)"],["maize","Maize (मक्का)"],["lentil","Lentil (मसूर)"],["chickpea","Chickpea (चना)"],["pigeonpea","Arhar (अरहर)"],["mustard","Mustard (सरसों)"],["potato","Potato (आलू)"],["tomato","Tomato (टमाटर)"],["brinjal","Brinjal (बैंगन)"],["chilli","Chilli (मिर्च)"],["okra","Okra (भिंडी)"],["cabbage","Cabbage / Cauliflower (गोभी)"],["onion","Onion (प्याज)"],["mango","Mango (आम)"],["litchi","Litchi (लीची)"],["banana","Banana (केला)"],["guava","Guava (अमरूद)"],["sugarcane","Sugarcane (गन्ना)"]];
const HI = {"धान":"rice","गेहूं":"wheat","गेहूँ":"wheat","मक्का":"maize","मसूर":"lentil","चना":"chickpea","अरहर":"pigeonpea","सरसों":"mustard","आलू":"potato","टमाटर":"tomato","बैंगन":"brinjal","मिर्च":"chilli","भिंडी":"okra","गोभी":"cabbage","प्याज":"onion","आम":"mango","लीची":"litchi","केला":"banana","अमरूद":"guava","गन्ना":"sugarcane"};
const forCrop = c => KB.filter(e => e.c.includes("any") || (c && e.c.some(x => c.includes(x) || x.includes(c))));
const matchEntries = (c, re) => forCrop(c).filter(e => re.test(e.n));
function findCrop(t) {
  t = String(t || "").toLowerCase();
  for (const k in HI) if (t.includes(k)) return HI[k];
  for (const e of KB) for (const a of e.c) if (a !== "any" && a.length > 2 && new RegExp("\\b" + a + "\\b").test(t)) return a;
  return "";
}

// ---- live weather (optional, direct from the browser) ----
async function weather(pos) {
  if (!pos) return null;
  try {
    const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pos.lat}&longitude=${pos.lon}&current=temperature_2m,relative_humidity_2m&daily=precipitation_sum&forecast_days=3`)).json();
    return { t: j.current.temperature_2m, h: j.current.relative_humidity_2m, rain: (j.daily.precipitation_sum || []).reduce((a, b) => a + b, 0) };
  } catch { return null; }
}
function wxNote(w, lang) {
  if (!w) return "";
  const hi = lang === "hi";
  let n = hi ? `${w.t}°C, नमी ${w.h}%, अगले 3 दिन बारिश ${w.rain.toFixed(0)} मिमी।` : `${w.t}°C, humidity ${w.h}%, rain in the next 3 days ${w.rain.toFixed(0)} mm.`;
  if (w.rain > 5) n += hi ? " बारिश से पहले छिड़काव न करें।" : " Do not spray before the rain.";
  else if (w.h > 80) n += hi ? " ज़्यादा नमी में फफूंद बढ़ती है, रोज़ खेत देखें।" : " High humidity favours fungus; check the field daily.";
  return n;
}

// ---- image analysis: colour of leaf tissue (green / yellow / brown / white) and brown spot count ----
function analysePixels(d, W, H) {
  let g = 0, y = 0, b = 0, wt = 0; const brown = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = d[i*4]/255, gg = d[i*4+1]/255, bl = d[i*4+2]/255, mx = Math.max(r, gg, bl), mn = Math.min(r, gg, bl), s = mx ? (mx - mn) / mx : 0;
    let h = 0; if (mx !== mn) { const dl = mx - mn; h = (mx === r ? ((gg - bl) / dl) % 6 : mx === gg ? (bl - r) / dl + 2 : (r - gg) / dl + 4) * 60; if (h < 0) h += 360; }
    if (s > .2 && mx > .15 && h >= 70 && h <= 170) g++;
    else if (s > .35 && mx > .4 && h >= 40 && h < 70) y++;
    else if (s > .25 && mx > .12 && mx < .75 && h >= 8 && h < 40) { b++; brown[i] = 1; }
    else if (s < .12 && mx > .72) wt++;
  }
  let spots = 0; const seen = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (brown[i] && !seen[i]) {
    let n = 0; const st = [i]; seen[i] = 1;
    while (st.length) { const p = st.pop(); n++; for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < W * H && brown[q] && !seen[q] && Math.abs(q % W - p % W) <= 1) { seen[q] = 1; st.push(q); } }
    if (n >= 3 && n <= W * H * .04) spots++;
  }
  const tissue = g + y + b || 1;
  return { tissue: (g + y + b) / (W * H), yellow: y / tissue, brown: b / tissue, white: wt / (tissue + wt), spots };
}
function classify(m) {
  if (m.tissue < .12) return "none";
  if (m.brown > .25) return "severe";
  if (m.white > .15 && m.brown < .1) return "mildew";
  if (m.yellow > .2 && m.brown < .1) return "yellow";
  if (m.brown > .04 || m.spots >= 4) return "spots";
  return "healthy";
}

// ---- turn a colour category into advice from the knowledge base ----
const L = {
  en: { none: "Plant not clearly visible", healthy: "Looks healthy", yellow: "Yellowing leaves", spots: "Leaf spots or blight", severe: "Severe leaf damage", mildew: "White powdery growth",
        generic: ["Remove badly affected leaves", "Avoid overhead watering and keep the field clean", "Show the plant to your local KVK before spraying anything"],
        retake: "I could not see enough leaf or fruit. Move closer, fill the frame with one leaf, and use daylight." },
  hi: { none: "पौधा साफ़ नहीं दिखा", healthy: "स्वस्थ दिखता है", yellow: "पत्तों का पीलापन", spots: "पत्तों पर धब्बे या झुलसा", severe: "पत्तों को गंभीर नुकसान", mildew: "सफेद चूर्ण जैसी परत",
        generic: ["बहुत खराब पत्ते हटा दें", "ऊपर से पानी न दें और खेत साफ रखें", "कुछ भी छिड़कने से पहले पौधा अपने KVK को दिखाएँ"],
        retake: "पत्ता या फल साफ़ नहीं दिखा। पास जाएँ, फ्रेम में एक पत्ता रखें और दिन की रोशनी में लें।" },
};
const PICK = { spots: /blast|blight|spot|rust|anthracnose|rot|alternaria|mildew|sigatoka|blotch/i, severe: /blast|blight|spot|rust|anthracnose|rot|alternaria|mildew|sigatoka|blotch/i, mildew: /mildew/i, yellow: /nitrogen|zinc|virus|wilt/i, healthy: /healthy/i };
const SEV = { none: "", healthy: "none", yellow: "mild", spots: "moderate", mildew: "moderate", severe: "severe" };
const uniq = a => [...new Set(a)];

function build(m, crop, wx, lang, ms) {
  const hi = lang === "hi", t = L[lang] || L.en, cat = classify(m), pct = n => Math.round(n * 100);
  const cands = cat === "none" ? [] : matchEntries(crop, PICK[cat]).slice(0, 4);
  const label = (CROPS.find(c => c[0] === crop) || [])[1] || "";
  const cure = cands.length ? cands.map(e => `${e.n}: ${e.cure[0]}`) : cat === "none" || cat === "healthy" ? [] : t.generic;
  const summary = cat === "none" ? t.retake : (hi
    ? `आपके फ़ोन पर रंग की त्वरित जाँच: ${pct(m.yellow)}% पीला, ${pct(m.brown)}% भूरा, ${m.spots} धब्बे। यह एक सरल संकेत है, प्रयोगशाला जाँच नहीं।${crop ? "" : " सटीक सलाह के लिए फसल चुनें।"}`
    : `Quick colour check on your device: ${pct(m.yellow)}% yellow, ${pct(m.brown)}% brown, ${m.spots} spots. This is a simple guide, not a lab test.${crop ? "" : " Choose your crop for specific advice."}`);
  return {
    builtin: true, crop: label, part: "leaf", severity: SEV[cat], confidence: cat === "none" ? 15 : cat === "healthy" ? 60 : 45,
    condition: cands.length && cat !== "healthy" ? `${t[cat]}: ${cands.map(e => e.n).join(", ")}` : t[cat],
    summary, cure, prevention: uniq(cands.flatMap(e => e.prev)).slice(0, 4), quality_tips: uniq(cands.flatMap(e => e.q)).slice(0, 2),
    weather_note: wxNote(wx, lang), see_expert: cat !== "healthy",
    trace: [{ stage: "Built-in: colour analysis", model: "on-device", ms, ok: true }, { stage: "Built-in: knowledge lookup", model: `${cands.length} entries matched`, ms: 0, ok: true }, ...(wx ? [{ stage: "Live weather", model: "open-meteo", ms: 0, ok: true }] : [])],
    checks: [{ ok: true, text: "Runs on your device, no AI server needed" }, { ok: !!crop, text: crop ? "Advice from your crop's knowledge base entries" : "No crop chosen, advice is general" }, { ok: false, text: "Basic colour method: confirm with your KVK" }],
  };
}

const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
async function diagnose(dataUrl, crop, pos, lang) {
  const t0 = performance.now(), img = await load(dataUrl), W = 160, H = Math.max(1, Math.round(W * img.height / img.width));
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0, W, H);
  const m = analysePixels(x.getImageData(0, 0, W, H).data, W, H), ms = Math.round(performance.now() - t0);
  return build(m, crop, await weather(pos), lang, ms);
}

// ---- built-in agent: picks a tool from the question (knowledge base, weather, latest scan, crop list) ----
async function agent(messages, scan, pos, lang) {
  const hi = lang === "hi", q = String(messages[messages.length - 1]?.content || "").toLowerCase(), steps = [], lines = [];
  const crop = findCrop(q) || findCrop(scan?.crop || ""), kvk = hi ? "किसी भी रसायन से पहले अपने नज़दीकी KVK से पुष्टि करें।" : "Confirm with your local KVK before using any chemical.";
  const want = { crops: /which crops|cover|कौन|फसलें/, wx: /spray|rain|weather|humid|irrigat|छिड़काव|बारिश|मौसम|सिंचाई/, prev: /prevent|next season|avoid|बचाव|रोक|अगले/, qual: /quality|rich|sweet|yield|healthier|गुणवत्ता|उपज|मीठ|बेहतर/, cause: /cause|why|reason|कारण|क्यों|वजह/ };
  if (want.crops.test(q)) { steps.push({ tool: "list_crops" }); return { reply: (hi ? "मैं इन फसलों पर सलाह दे सकता हूँ: " : "I can advise on: ") + CROPS.map(c => c[1]).join(", "), steps }; }
  if (want.wx.test(q)) { steps.push({ tool: "get_weather" }); const w = wxNote(await weather(pos), lang); lines.push(w || (hi ? "स्थान साझा नहीं है, इसलिए मौसम नहीं देख सका। नियम: बारिश से पहले छिड़काव न करें।" : "Location is not shared, so I could not check the weather. As a rule, do not spray before rain.")); }
  let es = [];
  if (crop) {
    const text = q + " " + (scan?.condition || "").toLowerCase();
    const all = forCrop(crop).filter(e => !e.c.includes("any") || /healthy|nitrogen/i.test(e.n));
    es = all.filter(e => e.k.some(k => text.includes(k)) || text.includes(e.n.toLowerCase()));
    if (!es.length) es = all.filter(e => !/healthy/i.test(e.n)).slice(0, 2);
  }
  if (es.length) {
    steps.push({ tool: "search_knowledge" }); if (scan) steps.push({ tool: "get_scan" });
    const e = es[0], pick = want.prev.test(q) || want.cause.test(q) ? e.prev : want.qual.test(q) ? e.q : e.cure;
    if (want.cause.test(q)) lines.push(hi ? "आम तौर पर नमी, घनी बुवाई या खराब सफाई से जुड़ा होता है। बचाव के ये कदम इसी ओर इशारा करते हैं:" : "Usually linked to humid weather, dense planting or poor field hygiene. These preventive steps point to the triggers:");
    lines.push(`${e.n}:`, ...pick.slice(0, 3).map(x => "• " + x));
  } else if (!lines.length) return { reply: hi ? "फसल का नाम बताइए या पौधे को स्कैन कीजिए, फिर मैं सटीक सलाह दूँगा।" : "Tell me the crop or scan a plant, and I will give specific advice.", steps };
  lines.push(kvk);
  return { reply: lines.join("\n"), steps };
}

window.AgriLocal = { crops: CROPS, diagnose, agent, weather, _px: analysePixels, _build: build };
})();
