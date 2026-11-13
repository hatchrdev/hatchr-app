// Turns a post into { name, ticker, description, score, reason }.
// Heuristic mode works offline; AI mode uses any OpenAI-compatible endpoint
// (Groq / Gemini / OpenRouter free tiers work).
import { chat, listModelIds } from "./aiclient.js";
import { aiReady } from "./settings.js";

const STOP = new Set(
  (
    "a an the and or but if then so to of in on at by for with from up down out over under " +
    "is am are was were be been being have has had do does did will would should could can may might must " +
    "i me my we our you your he him his she her it its they them their this that these those there here " +
    "what which who whom whose when where why how all any both each few more most other some such no nor not " +
    "only own same than too very just now also into about again further once rt via amp lol lmao yes yeah ok okay " +
    "get got go going gonna like really much many well still even new one two great good big today tonight tomorrow " +
    "people thing things time way day year make made say said know think see look want need let us im dont cant wont thats"
  ).split(/\s+/)
);

export function sanitizeName(name) {
  let s = String(name || "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 32) {
    const cut = s.slice(0, 33);
    const sp = cut.lastIndexOf(" ");
    s = sp > 10 ? cut.slice(0, sp) : s.slice(0, 32);
  }
  return s.trim();
}

// keepCase: pump.fun allows lowercase tickers, and some metas use them ($tailinu, $scamsem)
export function sanitizeTicker(ticker, maxLen = 10, keepCase = false) {
  let t = String(ticker || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  if (!keepCase) t = t.toUpperCase();
  return t.replace(/[^A-Za-z0-9]/g, "").slice(0, Math.max(1, Math.min(10, maxLen)));
}

function titleCase(s) {
  return s
    .split(/\s+/)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

export function tickerFromName(name, maxLen = 10) {
  const words = name.split(/\s+/).filter(Boolean);
  const joined = words.join("").normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (joined.length <= maxLen) return joined;
  if (words.length > 1) {
    const initials = sanitizeTicker(words.map((w) => w[0]).join(""), maxLen);
    if (initials.length >= 3) return initials;
    const first = sanitizeTicker(words[0], 99);
    if (first.length >= 3 && first.length <= maxLen) return first;
  }
  return joined.slice(0, maxLen);
}

export function cleanText(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function heuristicName(post, maxLen = 10) {
  const animal = findNamedAnimal(post.text);
  if (animal) return { name: sanitizeName(animal.fullName || animal.name), ticker: tickerFromName(animal.name, maxLen), by: "heuristic:animal" };
  // a bare reply like "lol" names poorly; fall back to what it replies to
  const own = String(post.text || "");
  const meaningful = (cleanText(own).match(/[A-Za-z][A-Za-z0-9']*/g) || []).some((w) => w.length >= 3 && !STOP.has(w.toLowerCase()));
  const raw = meaningful || !post.context ? own : String(post.context).replace(/^[^:]*:\s*/, "");
  const text = cleanText(raw);

  // 1. explicit cashtag
  const cash = raw.match(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/);
  if (cash) {
    const ticker = sanitizeTicker(cash[1], maxLen);
    return { name: sanitizeName(titleCase(cash[1])), ticker, by: "heuristic:cashtag" };
  }
  // 2. hashtag
  const tag = raw.match(/#([A-Za-z][A-Za-z0-9_]{1,30})/);
  if (tag) {
    const name = sanitizeName(tag[1].replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"));
    return { name, ticker: tickerFromName(name, maxLen), by: "heuristic:hashtag" };
  }
  // 3. short quoted phrase
  const quoted = text.match(/["“”']([^"“”']{2,40})["“”']/);
  if (quoted && quoted[1].trim().split(/\s+/).length <= 4) {
    const full = titleCase(quoted[1].trim());
    return { name: sanitizeName(full), ticker: tickerFromName(full, maxLen), by: "heuristic:quote" };
  }
  // 4. score the words
  const tokens = text.match(/[A-Za-z][A-Za-z0-9']*/g) || [];
  let best = null;
  tokens.forEach((tok, i) => {
    const w = tok.replace(/'s$/i, "").replace(/'/g, "");
    const lw = w.toLowerCase();
    if (lw.length < 3 || STOP.has(lw)) return;
    let s = Math.min(w.length, 9) / 3;
    if (/^[A-Z0-9]{3,8}$/.test(w)) s += 3; // ALL CAPS shouting
    else if (/^[A-Z]/.test(w)) s += i > 0 ? 2 : 1; // capitalized; mid-sentence = likely proper noun
    if (tokens.length <= 4) s += 1; // short posts = the whole post is the meme
    if (!best || s > best.s) best = { w, i, s };
  });
  if (best) {
    let name = best.w;
    const isCapWord = (w) => w && /^[A-Z]/.test(w) && w.length >= 3 && !STOP.has(w.toLowerCase());
    const prev = tokens[best.i - 1];
    const next = tokens[best.i + 1];
    if (isCapWord(prev) && /^[A-Z]/.test(best.w) && (prev + name).length <= 20) name = `${prev} ${name}`;
    else if (isCapWord(next) && /^[A-Z]/.test(best.w) && (name + next).length <= 20) name = `${name} ${next}`;
    name = sanitizeName(titleCase(name));
    return { name, ticker: tickerFromName(name, maxLen), by: "heuristic:words" };
  }
  // 5. image-only post or no usable words
  const fallback = sanitizeName(titleCase(`${post.handle || "Based"} Post`));
  return { name: fallback, ticker: tickerFromName(fallback, maxLen), by: "heuristic:fallback" };
}

// Memecoins are named after the post's word, not "<word> Token". Also fixes cut-off tickers.
const SUFFIX = /\s+(token|coin|memecoin|meme\s*coin|inu|official|on\s+sol(ana)?)$/i;
export function tidyNaming(name, ticker, post, maxLen = 10) {
  const text = `${post.text || ""} ${post.context || ""}`.toLowerCase();
  // endings the current meta uses (e.g. "___coin" is running) are kept on purpose
  const metaEnds = new Set(((post.meta && post.meta.suffixes) || []).map((x) => String(x).toLowerCase()));
  let n = name;
  for (let i = 0; i < 2; i++) {
    const m = n.match(SUFFIX);
    if (!m) break;
    const base = n.slice(0, m.index).trim();
    const end = m[1].toLowerCase().replace(/\s+/g, "");
    if (base.length < 2 || text.includes(n.toLowerCase()) || metaEnds.has(end)) break;
    n = base;
  }
  const lower = ticker === ticker.toLowerCase() && /[a-z]/.test(ticker);
  let t = ticker.toUpperCase();
  if (n !== name) {
    const oldT = sanitizeTicker(name, 99);
    if (t === oldT.slice(0, t.length) || /(TOKEN|COIN|INU)$/.test(t)) t = tickerFromName(n, maxLen);
  }
  // NUCLEA -> NUCLEAR: complete a ticker that is a cut-off word from the name or post
  const words = `${n} ${post.text || ""}`.normalize("NFKD").toUpperCase().match(/[A-Z0-9]+/g) || [];
  if (t.length >= 3) {
    const full = words.find((w) => w.length > t.length && w.length <= maxLen && w.startsWith(t));
    if (full) t = full;
  }
  if (lower) t = t.toLowerCase();
  else if (t.toUpperCase() === ticker.toUpperCase()) t = ticker; // untouched: keep the AI's casing
  return { name: n, ticker: sanitizeTicker(t, maxLen, true) || ticker };
}

export function extractJson(str) {
  const s = String(str || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI reply had no JSON");
  return JSON.parse(s.slice(start, end + 1));
}

// Fallback order when a model is refused or out of quota. Fast, cheap, non-reasoning models first.
const FALLBACK_MODELS = [
  "llama-3.1-8b-instant", "llama-3.3-70b-versatile", "openai/gpt-oss-20b", "openai/gpt-oss-120b",
  "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct",
  "qwen/qwen3-32b", "moonshotai/kimi-k2-instruct",
  "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest",
];

// Asks the provider which models this key can use (GET /models).
export async function listModels(settings) {
  return (await listModelIds(settings))
    .filter((id) => !/whisper|tts|guard|embed|vision|playai|orpheus|distil|prompt-guard|compound|safeguard|image|audio/i.test(id));
}

export function orderModels(listed, current) {
  const ranked = FALLBACK_MODELS.filter((m) => listed.includes(m));
  const rest = listed.filter((m) => !ranked.includes(m));
  return [current, ...ranked, ...rest].filter((m, i, a) => m && a.indexOf(m) === i);
}

// "Please try again in 1h2m3.5s" / "in 7.2s" / retry-after header -> milliseconds
export function parseRetry(text, header) {
  const m = String(text || "").match(/try again in\s+((?:\d+(?:\.\d+)?h)?\s*(?:\d+(?:\.\d+)?m(?!s))?\s*(?:\d+(?:\.\d+)?s)?\s*(?:\d+(?:\.\d+)?ms)?)/i);
  if (m && m[1].trim()) {
    let ms = 0;
    const part = (re, mul) => { const x = m[1].match(re); if (x) ms += parseFloat(x[1]) * mul; };
    part(/(\d+(?:\.\d+)?)h/, 3600e3);
    part(/(\d+(?:\.\d+)?)m(?!s)/, 60e3);
    part(/(\d+(?:\.\d+)?)s/, 1e3);
    part(/(\d+(?:\.\d+)?)ms/, 1);
    if (ms > 0) return ms;
  }
  const h = Number(header);
  if (Number.isFinite(h) && h > 0) return h * 1000;
  return null;
}

export function fmtWait(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function userMessage(post) {
  const sourceLabel = post.source === "tg" ? "Telegram channel" : post.source === "axiom" ? "X / Twitter (via Axiom tracker)" : "X / Twitter";
  const text = String(post.text || "").replace(/https?:\/\/\S+/g, "").trim().slice(0, 700);
  return (
    `Source: ${sourceLabel} — ${post.author || ""} (@${post.handle || "unknown"})\n` +
    `Has image: ${post.images && post.images.length ? "yes" : post.videos && post.videos.length ? "yes (video; a frame from it can be the coin picture)" : "no"}\n` +
    (post.tweetType ? `Post type: ${post.tweetType}\n` : "") +
    (post.context ? `Context: ${String(post.context).slice(0, 240)}\n` : "") +
    `Post:\n${text || "(no text, image only)"}` +
    (post.meta && post.meta.text ? `\n\n${post.meta.text}` : "")
  );
}

const isReasoningModel = (m) => /gpt-oss|qwen3|deepseek-r1|o\d|reason/i.test(m);

// One request to one model. Never throws for HTTP errors; returns a status object.
async function callModel(post, settings, model) {
  const reasoning = isReasoningModel(model);
  const res = await chat(settings, {
    model,
    system: settings.aiPrompt,
    user: userMessage(post),
    temperature: 0.5,
    maxTokens: reasoning ? 700 : 300,
    json: true,
    reasoning,
  });
  if (!res.ok) {
    const text = res.text || "";
    const rateLimited = res.status === 429 || /rate limit|quota|exhausted/i.test(text);
    const notFound = !rateLimited && (res.status === 404 || /model_not_found|does not exist|not found|decommission|not have access/i.test(text));
    const daily = /per day|TPD|RPD|daily/i.test(text);
    const wait = parseRetry(text, res.retryAfter);
    return { ok: false, status: res.status, text, rateLimited, notFound, daily, wait };
  }
  const data = { usage: { total_tokens: res.usage } };
  const content = res.content;
  let j;
  try { j = extractJson(content); }
  catch { return { ok: false, status: 200, text: "AI reply had no JSON", bad: true, usage: data?.usage?.total_tokens || 0 }; }
  let name = sanitizeName(j.name);
  const keepCase = !!(post.meta && post.meta.text); // follow the meta's casing
  let ticker = sanitizeTicker(j.ticker || name, settings.tickerMaxLen, keepCase) || tickerFromName(name, settings.tickerMaxLen);
  if (settings.aiShortNames !== false) ({ name, ticker } = tidyNaming(name, ticker, post, settings.tickerMaxLen));
  if (!name || !ticker) return { ok: false, status: 200, text: "AI returned an empty name/ticker", bad: true, usage: data?.usage?.total_tokens || 0 };
  return {
    ok: true,
    usage: data?.usage?.total_tokens || 0,
    result: {
      name,
      ticker,
      description: String(j.description || "").slice(0, 200),
      score: Number.isFinite(Number(j.score)) ? Math.max(0, Math.min(10, Number(j.score))) : null,
      reason: String(j.reason || "").slice(0, 200),
      imagePrompt: String(j.image_prompt || j.imagePrompt || "").slice(0, 300),
      imageKind: ["tweet", "post", "ai", "avatar"].includes(String(j.image || "").toLowerCase()) ? String(j.image).toLowerCase() : null,
      avatarOk: typeof j.avatar_ok === "boolean" ? j.avatar_ok : (j.avatar_ok === "true" ? true : j.avatar_ok === "false" ? false : null),
      by: "ai",
      model,
    },
  };
}

/**
 * Names a post with AI. Rotates to other models the key can use when one is refused or
 * out of quota, and remembers cool-downs so exhausted models aren't retried until reset.
 * Optional hooks on settings: getAiCooldowns(), setAiCooldown(model, untilMs),
 * onAiUsage(model, tokens), onModelChange(model).
 */
export async function aiName(post, settings) {
  const now = Date.now();
  const cooldowns = (settings.getAiCooldowns ? await settings.getAiCooldowns() : null) || {};
  const cool = (m) => cooldowns[m] && cooldowns[m] > now;
  const tried = new Set();
  let candidates = [settings.aiModel];
  let listed = false;
  let calls = 0;
  let lastErr = null;
  let limited = 0;
  let soonest = Infinity;
  let savedModelMissing = false;
  // only free providers rotate models; on paid ones a fallback could pick an expensive model
  const canRotate = !settings.aiProvider || ["groq", "gemini"].includes(settings.aiProvider);

  while (calls < 4) {
    const model = candidates.find((m) => !tried.has(m) && !cool(m));
    if (!model) {
      if (listed || !canRotate) break;
      listed = true;
      try { candidates = orderModels(await listModels(settings), settings.aiModel); } catch { break; }
      continue;
    }
    tried.add(model);
    calls++;
    const r = await callModel(post, settings, model);
    if (r.usage && settings.onAiUsage) settings.onAiUsage(model, r.usage);
    if (r.ok) {
      if (model !== settings.aiModel && savedModelMissing && settings.onModelChange) {
        await settings.onModelChange(model); // saved model doesn't exist for this key: switch for good
      }
      return r.result;
    }
    lastErr = r;
    if (r.rateLimited) {
      limited++;
      const wait = r.wait ?? (r.daily ? 3600e3 : 60e3);
      soonest = Math.min(soonest, wait);
      cooldowns[model] = now + wait;
      if (settings.setAiCooldown) settings.setAiCooldown(model, now + wait);
    } else if (r.notFound) {
      if (model === settings.aiModel) savedModelMissing = true;
      cooldowns[model] = now + 24 * 3600e3;
      if (settings.setAiCooldown) settings.setAiCooldown(model, now + 24 * 3600e3);
    } else if (!r.bad) {
      break; // auth / server error: switching models won't help
    }
  }

  // nothing worked
  const pending = Object.entries(cooldowns).filter(([, t]) => t > now).map(([, t]) => t - now);
  if (limited || (!lastErr && pending.length)) {
    const next = Math.min(soonest, ...pending);
    throw new Error(`AI limit reached on every model your key can use. Next one frees up in ${fmtWait(next)}.`);
  }
  if (lastErr) throw new Error(`AI ${lastErr.status}: ${String(lastErr.text).slice(0, 200)}`);
  throw new Error("No AI model available for this key");
}

export async function nameForPost(post, settings) {
  if (aiReady(settings)) {
    try {
      return await aiName(post, settings);
    } catch (e) {
      const h = heuristicName(post, settings.tickerMaxLen);
      return { ...h, score: null, reason: "", aiError: String(e.message || e) };
    }
  }
  return { ...heuristicName(post, settings.tickerMaxLen), score: null, reason: "" };
}

export function renderDescription(template, post, naming) {
  const text = String(post.text || "").trim();
  const out = String(template || "{text}")
    .replaceAll("{text}", text)
    .replaceAll("{url}", post.url || "")
    .replaceAll("{handle}", post.handle ? `@${post.handle}` : "")
    .replaceAll("{author}", post.author || "")
    .replaceAll("{ai}", naming.description || "")
    .replaceAll("{name}", naming.name || "")
    .replaceAll("{ticker}", naming.ticker || "");
  return out.trim().slice(0, 500);
}

// ---------- named animals: always the meta ----------
const ANIMAL_WORDS = [
  "dog", "dogs", "doggo", "doggy", "pup", "puppy", "puppies", "k9", "k-9", "canine", "hound", "pug", "corgi", "shiba", "husky",
  "retriever", "labrador", "poodle", "beagle", "bulldog", "terrier", "dachshund", "chihuahua", "rottweiler", "malinois",
  "cat", "cats", "kitty", "kitten", "kittens", "feline", "horse", "pony", "foal", "donkey", "mule", "bear", "cub", "panda",
  "koala", "penguin", "monkey", "ape", "chimp", "chimpanzee", "gorilla", "orangutan", "hippo", "hippopotamus", "rhino",
  "pig", "piglet", "hog", "boar", "goat", "cow", "calf", "bull", "ox", "sheep", "lamb", "rabbit", "bunny", "hare", "hamster",
  "gerbil", "ferret", "mouse", "rat", "squirrel", "chipmunk", "beaver", "otter", "seal", "walrus", "dolphin", "whale", "orca",
  "shark", "octopus", "squid", "crab", "lobster", "goldfish", "turtle", "tortoise", "frog", "toad", "lizard", "gecko",
  "iguana", "snake", "crocodile", "alligator", "gator", "owl", "eagle", "hawk", "falcon", "parrot", "parakeet", "crow",
  "raven", "pigeon", "duck", "duckling", "goose", "swan", "chicken", "chick", "hen", "rooster", "turkey", "peacock",
  "flamingo", "pelican", "fox", "wolf", "coyote", "lion", "lioness", "tiger", "leopard", "cheetah", "jaguar", "panther",
  "lynx", "bobcat", "elephant", "giraffe", "zebra", "camel", "llama", "alpaca", "deer", "fawn", "moose", "elk", "reindeer",
  "raccoon", "skunk", "possum", "opossum", "badger", "hedgehog", "porcupine", "sloth", "kangaroo", "wallaby", "capybara",
  "armadillo", "manatee", "meerkat", "lemur", "puffin", "seagull", "bison", "buffalo", "yak", "mink", "weasel",
];
const ANIMAL_EMOJI = /[\u{1F400}-\u{1F43F}\u{1F981}-\u{1F99F}\u{1F9A3}-\u{1F9AE}\u{1F54A}\u{1F577}]/u;
// words after an animal word that mean it isn't a name ("bear market", "bull run", "K9 unit")
const NOT_NAMES = new Set(("the a an and or of in on at for to from with by is are was were has had have will can could "
  + "this that these those our my your his her their its it he she they we you i "
  + "market markets run runs case trap flag rally season cycle mode unit units team teams officer officers police dept "
  + "department squad patrol handler handlers day days week weeks month year years breed breeds rescue rescues adoption "
  + "show shows award awards food foods park parks coin coins token meme memes life lives lover lovers owner owners "
  + "news update video photo pic pics just now today tonight breaking official new big little baby good bad best "
  + "daddy mommy mama papa lady man guy boy girl king queen lord vibes energy").split(" "));
// animal words that work like a title and stay in the coin name: "K9 Neo" ($NEO)
const TITLE_WORDS = new Set(["k9", "k-9"]);

const NAME = "([A-Z][a-zA-Z'’\\-]{1,15}(?:\\s+[A-Z][a-zA-Z'’\\-]{1,15})?)";
const ANIMAL_ALT = ANIMAL_WORDS.map((w) => w.replace("-", "\\-")).sort((a, b) => b.length - a.length).join("|");
const RE_ANIMAL_THEN_NAME = new RegExp(`\\b(${ANIMAL_ALT}),?\\s+${NAME}`, "gi");
const RE_NAME_THE_ANIMAL = new RegExp(`${NAME},?\\s+(?:the|our|a|an|this|my|their|his|her)\\s+(?:[a-z\\-]+\\s+){0,2}(${ANIMAL_ALT})\\b`, "g");
const RE_NAMED = new RegExp(`\\b(?:named|called|name is|meet|say hi to|say hello to|welcome|introducing)\\s+${NAME}`, "gi");
const RE_HAS_ANIMAL = new RegExp(`\\b(${ANIMAL_ALT})\\b`, "i");

// words in front of a name that aren't part of it ("Meet Pnut", "RIP Pnut", "Justice for Peanut")
const LEADING = new Set(("meet introducing rip welcome hi hey hello congrats congratulations happy goodbye farewell thanks thank "
  + "shoutout say rest remember remembering justice free save sad breaking update omg wow look behold presenting").split(" "));

function cleanName(raw) {
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  while (parts.length && LEADING.has(parts[0].toLowerCase())) parts.shift();
  // keep words while they look like a name
  const keep = [];
  for (const p of parts) {
    const low = p.toLowerCase().replace(/[’']s$/, "");
    if (NOT_NAMES.has(low) || ANIMAL_WORDS.includes(low)) break;
    if (!/^[A-Z]/.test(p)) break;
    keep.push(p.replace(/[’']s$/, ""));
  }
  if (!keep.length) return null;
  const n = keep.join(" ");
  return n.length >= 2 ? n : null;
}

/** Finds an animal with a name in a post: "K9 Neo", "Moo Deng the hippo", "a cat named Luna". */
export function findNamedAnimal(text) {
  const t = String(text || "").replace(/https?:\/\/\S+/g, " ");
  if (!t.trim()) return null;
  const capsRatio = (t.match(/[A-Z]/g) || []).length / Math.max(1, (t.match(/[a-zA-Z]/g) || []).length);
  if (capsRatio > 0.6) return null; // ALL-CAPS posts: can't tell names from shouting
  let m;
  RE_ANIMAL_THEN_NAME.lastIndex = 0;
  while ((m = RE_ANIMAL_THEN_NAME.exec(t))) {
    const name = cleanName(m[2]);
    if (!name) continue;
    const word = m[1];
    const full = TITLE_WORDS.has(word.toLowerCase()) ? `${word.toUpperCase()} ${name}` : name;
    return { name, animal: word.toLowerCase(), fullName: full };
  }
  RE_NAME_THE_ANIMAL.lastIndex = 0;
  while ((m = RE_NAME_THE_ANIMAL.exec(t))) {
    const name = cleanName(m[1]);
    if (name) return { name, animal: m[2].toLowerCase(), fullName: name };
  }
  const hasAnimal = RE_HAS_ANIMAL.exec(t) || ANIMAL_EMOJI.test(t);
  if (hasAnimal) {
    RE_NAMED.lastIndex = 0;
    while ((m = RE_NAMED.exec(t))) {
      const name = cleanName(m[1]);
      if (name) return { name, animal: Array.isArray(hasAnimal) ? hasAnimal[1].toLowerCase() : "animal", fullName: name };
    }
  }
  return null;
}

/** Applies the named-animal rule to a naming result. */
// Coin name = the full name as the post writes it ("K9 Neo"), ticker = the animal's own name ($NEO).
export function applyAnimalRule(naming, animal, maxLen = 10) {
  if (!animal) return naming;
  const out = { ...naming, namedAnimal: animal };
  const full = animal.fullName || animal.name;
  const ai = String(naming.name || "").toLowerCase();
  if (!ai.includes(animal.name.toLowerCase())) {
    out.name = sanitizeName(full);
    out.ticker = tickerFromName(animal.name, maxLen);
    out.nameFixed = `named-animal rule (AI said ${naming.name || "?"})`;
  } else if (ai === animal.name.toLowerCase() && full !== animal.name) {
    out.name = sanitizeName(full); // "Neo" -> "K9 Neo", ticker stays $NEO
  }
  if (out.score != null) out.score = Math.max(out.score, 8);
  const kind = /^(k9|k-9|canine)$/.test(animal.animal) ? "police dog" : animal.animal === "animal" ? "animal" : animal.animal;
  if (!out.imagePrompt) out.imagePrompt = `a heroic, characterful ${kind} named ${animal.name}, mascot portrait`;
  return out;
}
