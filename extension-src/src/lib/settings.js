// Default settings + storage helpers shared by background and side panel.

export const DEFAULT_PROMPT = `You name pump.fun memecoins for breaking posts. Traders launch these seconds after a post, so the coin must be named exactly what people will search for and repeat.

HOW MEMECOINS ARE NAMED
- Pick the ONE word (or short phrase) everyone will repeat from the post: the key noun, slogan, new name, nickname, animal or invented word. Usually 1 word, max 3.
- Use the post's own words. Do not invent extra words, do not describe the post.
- name: that word as people say it, e.g. "Nuclear", "Grokipedia", "Kekius Maximus". Don't add "Token", "Coin", "Inu", "AI", "Meme", "Official" or similar unless the post itself uses it or the current meta names coins that way (see META).
- ticker: the same word in capitals when it fits in 10 characters (NUCLEAR, GROKIPEDIA). Never cut a word short (NUCLEAR, not NUCLEA). Only if it's longer than 10, use the short form people would type (DOGE, KEKIUS). A-Z and 0-9 only.

NAMED ANIMALS (always a strong meta)
Any post featuring an animal with a name (a pet, police K9, zoo animal, rescue, office dog, mascot) is a top memecoin. Name the coin after the animal the way the post writes it, ticker = the animal's own name: "K9 Neo" -> {"name":"K9 Neo","ticker":"NEO"}, "Moo Deng the hippo" -> {"name":"Moo Deng","ticker":"MOODENG"}. Never name it after the species or the organisation ("K9", "Dog", "CBP"). Score 8-10. Image: "post" if the post has a photo, otherwise "ai" with the animal as the mascot.

META (ride what's running)
The user message may include the current pump.fun meta: coins running hot, naming patterns that are spreading, and coins already launched with this post's words. Memecoins move in metas: once Dickcoin and Asscoin run, the next spicy word becomes Pussycoin; once "Fat Shane" runs, people launch "Fat <name>".
- If the post fits a running meta (same theme, same kind of word, a sequel to a hot coin), name it in that meta's exact pattern: same ending/prefix, same spelling style, same ticker style (lowercase tickers if that's what's running). E.g. meta "___coin" is hot and the post is about pussy -> {"name":"Pussycoin","ticker":"PUSSYCOIN"}.
- If a coin with this exact word is already running hot, still use the name people will search for; the post is the fresh catalyst.
- If nothing in the meta fits, ignore it and name the coin normally. Don't force a meta onto an unrelated post.
- Score higher when the post fits a hot meta. Say "meta: <pattern>" in reason when you followed one.

IMAGE
- "tweet": a dark-mode screenshot of the post. Best for news, headlines, statements, quotes and announcements, where the post itself is the meme. This is the usual choice.
- "post": the post's own picture or a frame from its video, if it has one and it shows the subject well.
- "avatar": the author's profile picture. Only when the author is a famous individual whose face people instantly recognise and the coin is about them or their words.
- "ai": a drawn mascot. Only when the coin is a concrete character, animal, object or invented thing that works as a logo.
- avatar_ok: true ONLY if the author is a famous individual person (e.g. Elon Musk, Donald Trump, CZ). false for news outlets, companies, brands, logos, bots and small or anonymous accounts.
- image_prompt: only for "ai": one vivid, original mascot/object (not an existing cartoon character or logo), no text in the image.

EXAMPLES
"The U.S. is offering $20 MILLION to anyone who can help expose Iran's nuclear program" -> {"name":"Nuclear","ticker":"NUCLEAR","image":"tweet"}
"Introducing Grokipedia, the encyclopedia of everything" -> {"name":"Grokipedia","ticker":"GROKIPEDIA","image":"tweet"}
"Kekius Maximus" (new profile name) -> {"name":"Kekius Maximus","ticker":"KEKIUS","image":"ai","image_prompt":"a smug green frog dressed as a Roman gladiator general"}
"Meet Floki, our new office dog" + photo -> {"name":"Floki","ticker":"FLOKI","image":"post","score":9}
"K9 Neo has the coastline locked down." (by a border agency) -> {"name":"K9 Neo","ticker":"NEO","image":"ai","image_prompt":"a heroic police dog in a tactical vest guarding a coastline","score":8}
"BREAKING: Fed cuts rates by 50 bps" (by a news account) -> {"name":"Rate Cut","ticker":"RATECUT","image":"tweet","avatar_ok":false}
"I am the Dogefather" (by Elon Musk) -> {"name":"Dogefather","ticker":"DOGEFATHER","image":"avatar","avatar_ok":true}

Also give:
- description: max 200 characters, one punchy line about the post
- score: 0-10, how likely this post is to spark a memecoin frenzy right now (new meme word, viral name, funny image, huge announcement = high; generic reply, link, routine politics = low)
- reason: a few words why

Reply ONLY with JSON: {"name":"","ticker":"","image":"tweet","avatar_ok":false,"image_prompt":"","description":"","score":0,"reason":""}`;

// previous default, so saved settings that still use it get upgraded
export const OLD_PROMPTS = [`You name pump.fun memecoins for breaking posts. Traders launch these seconds after a post, so the coin must be named exactly what people will search for and repeat.

HOW MEMECOINS ARE NAMED
- Pick the ONE word (or short phrase) everyone will repeat from the post: the key noun, slogan, new name, nickname, animal or invented word. Usually 1 word, max 3.
- Use the post's own words. Do not invent extra words, do not describe the post.
- name: that word as people say it, e.g. "Nuclear", "Grokipedia", "Kekius Maximus". Don't add "Token", "Coin", "Inu", "AI", "Meme", "Official" or similar unless the post itself uses it or the current meta names coins that way (see META).
- ticker: the same word in capitals when it fits in 10 characters (NUCLEAR, GROKIPEDIA). Never cut a word short (NUCLEAR, not NUCLEA). Only if it's longer than 10, use the short form people would type (DOGE, KEKIUS). A-Z and 0-9 only.

META (ride what's running)
The user message may include the current pump.fun meta: coins running hot, naming patterns that are spreading, and coins already launched with this post's words. Memecoins move in metas: once Dickcoin and Asscoin run, the next spicy word becomes Pussycoin; once "Fat Shane" runs, people launch "Fat <name>".
- If the post fits a running meta (same theme, same kind of word, a sequel to a hot coin), name it in that meta's exact pattern: same ending/prefix, same spelling style, same ticker style (lowercase tickers if that's what's running). E.g. meta "___coin" is hot and the post is about pussy -> {"name":"Pussycoin","ticker":"PUSSYCOIN"}.
- If a coin with this exact word is already running hot, still use the name people will search for; the post is the fresh catalyst.
- If nothing in the meta fits, ignore it and name the coin normally. Don't force a meta onto an unrelated post.
- Score higher when the post fits a hot meta. Say "meta: <pattern>" in reason when you followed one.

IMAGE
- "tweet": a dark-mode screenshot of the post. Best for news, headlines, statements, quotes and announcements, where the post itself is the meme. This is the usual choice.
- "post": the post's own picture, if it has one and it's a good coin picture.
- "avatar": the author's profile picture. Only when the author is a famous individual whose face people instantly recognise and the coin is about them or their words.
- "ai": a drawn mascot. Only when the coin is a concrete character, animal, object or invented thing that works as a logo.
- avatar_ok: true ONLY if the author is a famous individual person (e.g. Elon Musk, Donald Trump, CZ). false for news outlets, companies, brands, logos, bots and small or anonymous accounts.
- image_prompt: only for "ai": one vivid, original mascot/object (not an existing cartoon character or logo), no text in the image.

EXAMPLES
"The U.S. is offering $20 MILLION to anyone who can help expose Iran's nuclear program" -> {"name":"Nuclear","ticker":"NUCLEAR","image":"tweet"}
"Introducing Grokipedia, the encyclopedia of everything" -> {"name":"Grokipedia","ticker":"GROKIPEDIA","image":"tweet"}
"Kekius Maximus" (new profile name) -> {"name":"Kekius Maximus","ticker":"KEKIUS","image":"ai","image_prompt":"a smug green frog dressed as a Roman gladiator general"}
"Meet Floki, our new office dog" + photo -> {"name":"Floki","ticker":"FLOKI","image":"post"}
"BREAKING: Fed cuts rates by 50 bps" (by a news account) -> {"name":"Rate Cut","ticker":"RATECUT","image":"tweet","avatar_ok":false}
"I am the Dogefather" (by Elon Musk) -> {"name":"Dogefather","ticker":"DOGEFATHER","image":"avatar","avatar_ok":true}

Also give:
- description: max 200 characters, one punchy line about the post
- score: 0-10, how likely this post is to spark a memecoin frenzy right now (new meme word, viral name, funny image, huge announcement = high; generic reply, link, routine politics = low)
- reason: a few words why

Reply ONLY with JSON: {"name":"","ticker":"","image":"tweet","avatar_ok":false,"image_prompt":"","description":"","score":0,"reason":""}`, `You name pump.fun memecoins for breaking posts. Traders launch these seconds after a post, so the coin must be named exactly what people will search for and repeat.

HOW MEMECOINS ARE NAMED
- Pick the ONE word (or short phrase) everyone will repeat from the post: the key noun, slogan, new name, nickname, animal or invented word. Usually 1 word, max 3.
- Use the post's own words. Do not invent extra words, do not describe the post.
- name: that word as people say it, e.g. "Nuclear", "Grokipedia", "Kekius Maximus". NEVER add "Token", "Coin", "Inu", "AI", "Meme", "Official" or similar unless the post itself uses it.
- ticker: the same word in capitals when it fits in 10 characters (NUCLEAR, GROKIPEDIA). Never cut a word short (NUCLEAR, not NUCLEA). Only if it's longer than 10, use the short form people would type (DOGE, KEKIUS). A-Z and 0-9 only.

IMAGE
- "tweet": a dark-mode screenshot of the post. Best for news, headlines, statements, quotes and announcements, where the post itself is the meme. This is the usual choice.
- "post": the post's own picture, if it has one and it's a good coin picture.
- "avatar": the author's profile picture. Only when the author is a famous individual whose face people instantly recognise and the coin is about them or their words.
- "ai": a drawn mascot. Only when the coin is a concrete character, animal, object or invented thing that works as a logo.
- avatar_ok: true ONLY if the author is a famous individual person (e.g. Elon Musk, Donald Trump, CZ). false for news outlets, companies, brands, logos, bots and small or anonymous accounts.
- image_prompt: only for "ai": one vivid, original mascot/object (not an existing cartoon character or logo), no text in the image.

EXAMPLES
"The U.S. is offering $20 MILLION to anyone who can help expose Iran's nuclear program" -> {"name":"Nuclear","ticker":"NUCLEAR","image":"tweet"}
"Introducing Grokipedia, the encyclopedia of everything" -> {"name":"Grokipedia","ticker":"GROKIPEDIA","image":"tweet"}
"Kekius Maximus" (new profile name) -> {"name":"Kekius Maximus","ticker":"KEKIUS","image":"ai","image_prompt":"a smug green frog dressed as a Roman gladiator general"}
"Meet Floki, our new office dog" + photo -> {"name":"Floki","ticker":"FLOKI","image":"post"}
"BREAKING: Fed cuts rates by 50 bps" (by a news account) -> {"name":"Rate Cut","ticker":"RATECUT","image":"tweet","avatar_ok":false}
"I am the Dogefather" (by Elon Musk) -> {"name":"Dogefather","ticker":"DOGEFATHER","image":"avatar","avatar_ok":true}

Also give:
- description: max 200 characters, one punchy line about the post
- score: 0-10, how likely this post is to spark a memecoin frenzy right now (new meme word, viral name, funny image, huge announcement = high; generic reply, link, routine politics = low)
- reason: a few words why

Reply ONLY with JSON: {"name":"","ticker":"","image":"tweet","avatar_ok":false,"image_prompt":"","description":"","score":0,"reason":""}`, `You name pump.fun memecoins for breaking posts. Traders launch these seconds after a post, so the coin must be named exactly what people will search for and repeat.

HOW MEMECOINS ARE NAMED
- Pick the ONE word (or short phrase) everyone will repeat from the post: the key noun, slogan, new name, nickname, animal or invented word. Usually 1 word, max 3.
- Use the post's own words. Do not invent extra words, do not describe the post.
- name: that word as people say it, e.g. "Nuclear", "Grokipedia", "Kekius Maximus". NEVER add "Token", "Coin", "Inu", "AI", "Meme", "Official" or similar unless the post itself uses it.
- ticker: the same word in capitals when it fits in 10 characters (NUCLEAR, GROKIPEDIA). Never cut a word short (NUCLEAR, not NUCLEA). Only if it's longer than 10, use the short form people would type (DOGE, KEKIUS). A-Z and 0-9 only.

IMAGE
- "tweet": a dark-mode screenshot of the post. Best for news, headlines, statements, quotes and announcements, where the post itself is the meme. This is the usual choice.
- "post": the post's own picture, if it has one and it's a good coin picture.
- "ai": a drawn mascot. Only when the coin is a concrete character, animal, object or invented thing that works as a logo.
- image_prompt: only for "ai": one vivid, original mascot/object (not an existing cartoon character or logo), no text in the image.

EXAMPLES
"The U.S. is offering $20 MILLION to anyone who can help expose Iran's nuclear program" -> {"name":"Nuclear","ticker":"NUCLEAR","image":"tweet"}
"Introducing Grokipedia, the encyclopedia of everything" -> {"name":"Grokipedia","ticker":"GROKIPEDIA","image":"tweet"}
"Kekius Maximus" (new profile name) -> {"name":"Kekius Maximus","ticker":"KEKIUS","image":"ai","image_prompt":"a smug green frog dressed as a Roman gladiator general"}
"Meet Floki, our new office dog" + photo -> {"name":"Floki","ticker":"FLOKI","image":"post"}
"BREAKING: Fed cuts rates by 50 bps" -> {"name":"Rate Cut","ticker":"RATECUT","image":"tweet"}

Also give:
- description: max 200 characters, one punchy line about the post
- score: 0-10, how likely this post is to spark a memecoin frenzy right now (new meme word, viral name, funny image, huge announcement = high; generic reply, link, routine politics = low)
- reason: a few words why

Reply ONLY with JSON: {"name":"","ticker":"","image":"tweet","image_prompt":"","description":"","score":0,"reason":""}`, `You turn breaking posts into pump.fun memecoin launches.
Given a post, invent the coin a degen trader would launch in the next 10 seconds.
Rules:
- name: max 32 characters, catchy, usually the key word/phrase/meme of the post
- ticker: max 10 characters, only A-Z and 0-9, no $ sign
- description: max 200 characters, one punchy line referencing the post
- image_prompt: max 200 characters, a vivid description of ONE iconic mascot/object for the coin logo (no text in the image)
- score: 0-10, how likely this post is to spark a memecoin frenzy right now
  (new meme word, funny image, big announcement = high; generic reply, link, politics rant = low)
Reply ONLY with JSON: {"name":"","ticker":"","description":"","image_prompt":"","score":0,"reason":""}`, `You turn breaking posts into pump.fun memecoin launches.
Given a post, invent the coin a degen trader would launch in the next 10 seconds.
Rules:
- name: max 32 characters, catchy, usually the key word/phrase/meme of the post
- ticker: max 10 characters, only A-Z and 0-9, no $ sign
- description: max 200 characters, one punchy line referencing the post
- score: 0-10, how likely this post is to spark a memecoin frenzy right now
  (new meme word, funny image, big announcement = high; generic reply, link, politics rant = low)
Reply ONLY with JSON: {"name":"","ticker":"","description":"","score":0,"reason":""}`];

// Accounts memecoin traders commonly track. Editable in Settings.
export const PRESET_HANDLES = [
  "elonmusk", "realDonaldTrump", "POTUS", "WhiteHouse", "FLOTUS",
  "cz_binance", "VitalikButerin", "aeyakovenko", "a1lon9", "pumpdotfun", "solana",
  "Polymarket", "WatcherGuru", "tier10k", "unusual_whales", "MarioNawfal", "Cointelegraph",
  "Tesla", "SpaceX", "xai", "grok", "nypost", "TMZ", "DailyMail", "blknoiz06",
].join("\n");

export const DEFAULTS = {
  // modes
  mode: "auto", // "manual" | "auto" (new installs start in auto + test mode)
  paused: true, // always starts paused (also after every Chrome restart); "Start" begins auto mode
  dryRun: true, // "Test mode" in the UI: launches are simulated, nothing is spent
  currency: "sol", // how amounts are shown: "sol" | "usd" | "eur" (the SOL/$/€ button)
  pnlScope: "wallet", // PnL card: "wallet" (current wallet) | "all" (every wallet used in Hatchr)
  pnlRange: "all", // "day" | "week" | "month" | "all"
  language: "auto", // "auto" (browser language) | "en" | "nl" | "de" | "es"

  // $HATCHR holder perks
  goldTheme: false, // gold look for the panel (holders)
  goldCard: true, // gold PnL share card (Gold tier)
  tokenPreview: "off", // preview build only: "off" | "holder" | "gold" shows the panel as that tier

  // sources
  watching: true, // the main switch. false = Hatchr reads no posts and does nothing in the background (as if it were disabled);
  // the wallet, the Launched tab, selling and making a coin from pasted text keep working
  axiomEnabled: true,
  keepAxiomOpen: true,
  axiomKeepTracker: true,
  axiomHideTracker: true,
  axiomOriginal: true,
  axiomQuotes: true,
  axiomReplies: true,
  axiomReposts: true,
  axiomFilterHandles: false,
  xEnabled: true,
  xHandles: PRESET_HANDLES,
  xAutoLoadNew: true,
  maxPostAgeSec: 180,
  tgEnabled: false,
  tgChannels: "",
  tgPollSec: 30,

  // filters (auto mode)
  includeKeywords: "",
  excludeKeywords: "rip\ndied\ndeath\nkilled\nshooting\nfuneral\ncondolences",

  // naming
  aiEnabled: false,
  aiFor: "candidates", // "candidates" | "all" | "manual"
  aiFallback: "skip", // "skip" | "rules"
  namedAnimals: true, // animals with a name always launch (auto mode), named after the animal
  aiMeta: true, // feed the current pump.fun meta to the AI
  pumpMeta: true, // follow every pump.fun launch + graduation live (PumpPortal, free) for the meta
  metaWindowMin: 180,
  aiShortNames: true, // strip "Token"/"Coin" the AI adds, complete cut-off tickers
  imageLetAiChoose: true,
  aiPickFrame: true, // vision AI picks the video frame that shows the subject best
  aiVisionModel: "meta-llama/llama-4-scout-17b-16e-instruct", // AI picks tweet screenshot / post image / AI image per post
  aiProvider: "groq", // see AI_PROVIDERS; "custom" = any API you link yourself
  aiFormat: "openai", // "openai" (chat/completions) | "anthropic" (messages)
  aiHeaders: "", // extra request headers for custom APIs, one "Name: value" per line
  aiUrl: "https://api.groq.com/openai/v1/chat/completions",
  aiKey: "",
  aiModel: "llama-3.3-70b-versatile",
  aiPrompt: DEFAULT_PROMPT,
  tickerMaxLen: 10,

  // image
  imageMode: "post-or-tweet", // "post-or-tweet" | "tweet" | "post-or-card" | "card" | "avatar-or-card"
  imageAiProvider: "off", // "off" | "cloudflare" | "openai"
  imageAiWhen: "no-post-image", // "no-post-image" | "always" | "manual"
  imageAiStyle: "",
  cfAccountId: "",
  cfToken: "",
  cfSteps: 4,
  openaiKey: "",
  openaiImageModel: "auto",
  openaiImageQuality: "low",
  cardColor1: "#86EFAC",
  cardColor2: "#14532D",

  // metadata
  descriptionTemplate: "{text}",
  linkSourceAsTwitter: true,
  website: "",
  telegram: "",

  // callouts
  calloutWallet: "", // public address of the wallet you use on pump.fun, if it is not the Hatchr wallet: its coins are listed for callouts too

  // deploy
  rpcUrl: "https://api.mainnet-beta.solana.com",
  pinataJwt: "",
  devBuySol: 0.0001,
  slippage: 15,
  priorityFee: 0.00005,
  boostFee: false, // ⚡ Boost: a live launch pays the priority fee the network asks right now (capped), not priorityFee
  skipPreflight: false,
  confirmManual: false,
  openAxiomAfterLaunch: false, // open the coin right after a live launch (in openIn)
  openIn: "axiom", // trading site for "Open in …": axiom | pumpfun | gmgn | bullx | padre | dexscreener
  sellSlippage: 15,
  sellPriorityFee: 0.000001, // cheapest that usually lands; resent once at 10x if not confirmed
  sellCloseAccount: true, // close the empty token account after selling: ~0.002 SOL rent back
  confirmSell: true,
  autoClaimRewards: false,
  autoClaimMinSol: 0.02,
  autoClaimEveryMin: 60,

  // auto rules
  autoMinScore: 6,
  autoCooldownSec: 300,
  autoMaxPerHour: 2,
  autoMaxPerDay: 5,
  autoMaxSolPerDay: 0.05,
  minBalanceSol: 0.03,
  dedupeHours: 24,

  // notifications
  notifyNewPosts: false,
  notifyDeploys: true,
  soundEnabled: true,
  soundOnDryRun: true,
  soundOnSell: true,
  soundVolume: 70,
};

// AI providers. All but "anthropic" speak the OpenAI chat/completions format.
// rotate: may switch to another model the key can use when one is out of quota.
export const AI_PROVIDERS = {
  groq: { label: "Groq (free)", url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile", vision: "meta-llama/llama-4-scout-17b-16e-instruct", guide: "groq", rotate: true },
  gemini: { label: "Google Gemini (free)", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.5-flash", vision: "gemini-2.5-flash", guide: "gemini", rotate: true },
  openrouter: { label: "OpenRouter (many models, some free)", url: "https://openrouter.ai/api/v1/chat/completions", model: "meta-llama/llama-3.3-70b-instruct:free", vision: "meta-llama/llama-4-scout:free", guide: "openrouter" },
  openai: { label: "OpenAI (paid)", url: "https://api.openai.com/v1/chat/completions", model: "gpt-4.1-mini", vision: "gpt-4.1-mini", guide: "openai" },
  anthropic: { label: "Anthropic Claude (paid)", url: "https://api.anthropic.com/v1/messages", model: "claude-haiku-5-5", vision: "claude-haiku-5-5", format: "anthropic", guide: "anthropic" },
  deepseek: { label: "DeepSeek (cheap)", url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", vision: "", guide: "deepseek" },
  mistral: { label: "Mistral", url: "https://api.mistral.ai/v1/chat/completions", model: "mistral-small-latest", vision: "mistral-small-latest", guide: "mistral" },
  xai: { label: "xAI Grok", url: "https://api.x.ai/v1/chat/completions", model: "grok-3-mini", vision: "", guide: "xai" },
  together: { label: "Together AI", url: "https://api.together.xyz/v1/chat/completions", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", vision: "", guide: "together" },
  ollama: { label: "Ollama (on your own computer, free)", url: "http://localhost:11434/v1/chat/completions", model: "llama3.2", vision: "", guide: "ollama", noKey: true },
  custom: { label: "My own AI (any API)", url: "", model: "", vision: "", guide: "customai", noKey: true },
};

/** Which provider an endpoint belongs to (for settings saved before providers existed). */
export function providerForUrl(url) {
  const u = String(url || "");
  for (const [id, p] of Object.entries(AI_PROVIDERS)) if (p.url && u.startsWith(new URL(p.url).origin)) return id;
  return "custom";
}

/** AI is on and has what it needs to make calls. */
export function aiReady(s) {
  if (!s || !s.aiEnabled || !s.aiUrl) return false;
  const p = AI_PROVIDERS[s.aiProvider] || {};
  return !!(s.aiKey || p.noKey);
}

// Rough cost of one launch on top of the dev buy (rent + network fees).
// Only used to decide whether the daily SOL cap would be exceeded.
export const EST_LAUNCH_OVERHEAD_SOL = 0.025;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

// Saves run one after another. Each one reads all settings, merges its change and writes all settings back, so two
// that overlapped used to overwrite each other: a Pause click could be undone by another setting saved at the same moment.
let saveQueue = Promise.resolve();
export function saveSettings(patch) {
  const run = saveQueue.then(async () => {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  });
  saveQueue = run.catch(() => {});
  return run;
}

export function lines(str) {
  return String(str || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
