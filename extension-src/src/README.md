# Hatchr – Memecoin Launcher

A Chrome extension that watches Axiom's X tracker, X itself and Telegram, and turns new posts into pump.fun coins.
It has two modes:

- **Manual:** a card with a pre-filled name, ticker and image pops up for every post. You click Launch.
- **Auto:** posts that pass your rules launch by themselves.

It starts in **Auto + Test mode**: everything runs for real, but every launch is simulated and spends nothing. Switch the **TEST** button to **LIVE** (it pulses red) when you're ready to spend real SOL.

## What it costs

| Thing | Cost |
|---|---|
| Axiom X tracker | Free with your Axiom account. Reads the Alerts panel you keep open |
| X feed | Free. Reads the X tab you keep open |
| Telegram feed | Free. Public channels via t.me/s/ |
| RPC | Free Helius account (the public Solana RPC blocks extensions) |
| IPFS (image + metadata) | Free Pinata account |
| AI naming | Optional: free Groq or Google Gemini key, or link any AI you like (OpenRouter, OpenAI, Claude, DeepSeek, Mistral, Grok, Ollama, or your own API) |
| AI images | Optional: Cloudflare Workers AI (free, ~230 images/day) or OpenAI GPT Image (paid per image, or ChatGPT Pro API credits) |
| **Each real launch** | A small amount of SOL in network/rent fees, plus your dev buy |

All the tools are free, so your budget only goes into SOL for launches. After your first real launch, the Launched tab shows its exact cost.

## Setup (10 minutes)

1. **Install.** Unzip this folder and open `chrome://extensions`. Turn on **Developer mode**, click **Load unpacked** and select this folder. Pin the extension and click its icon to open the side panel.
2. **Burner wallet.** Open **Settings → Account** and click **Create new wallet**. Copy the address and send it only what you'll spend (0.1 SOL is plenty to start). Click **Download key file** and keep it safe: with it you can open the same wallet in Phantom any time. You can also import a burner you already have, or make a **vanity address** that starts or ends with letters you pick (like `PEPE…`); every extra letter makes the search about 30-58 times slower, so 2-4 letters is practical. The search runs in the background: close it, keep working or even close the panel. When it's found you hear a chime, get a notification, and Hatchr shows "Vanity wallet found" with a button to use it. Your current wallet only changes when you press "Use this wallet". Never use your main wallet: the key sits in this browser unencrypted. Wallets you replace or remove are kept under **Previous wallets**, so money left in them is never lost.
3. **Pinata.** Sign up free at pinata.cloud, go to **API Keys → New key** (admin is simplest) and copy the **JWT**. Paste it in **Settings → Launch → Pinata JWT**. Pump.fun no longer hosts metadata itself, so this step is needed.
4. **RPC (required).** The default public Solana RPC refuses requests from browser extensions (you'd see "403 Access forbidden"). Sign up free at helius.dev and copy your **Mainnet RPC URL**, which looks like `https://mainnet.helius-rpc.com/?api-key=…`. Paste it into **Settings → Launch → Solana RPC URL** and click Save. The free plan is plenty.
5. **AI naming (optional).** In **Settings → AI**, pick a provider, paste its key and turn on **Use AI**. Groq and Gemini are free. **My own AI** links any other AI with an API: the OpenAI chat/completions format (almost every provider, plus LM Studio, vLLM and Ollama on your own computer) or the Anthropic messages format, with extra headers if your API needs them. **Test AI** checks it right away. AI also gives each post a 0–10 "memeability" score, which auto mode can filter on. Without AI, built-in rules pick names from cashtags, hashtags, quotes and key words.
6. **Pick your sources.**
   - **Axiom (best):** just keep an axiom.trade tab open. Axiom only streams tweets while its X tracker panel is open, so the extension keeps that panel open for you and hides it (Settings → Sources lets you show it again). The Feed tab shows "Axiom ● live" when it's connected. The extension reacts to every account in your Axiom tracker list, so add or remove accounts there. In Settings you can choose posts, quotes, replies and reposts. After installing or updating the extension, reload the Axiom tab once.
   - **X:** on x.com, make a **List** with the accounts you track and open the list. Put that tab in **its own window** and don't minimize it. Chrome slows down background tabs; a separate visible window keeps it fast. "Auto-click Show new posts" pulls fresh posts in by itself. **X accounts to react to** comes pre-filled with a preset of accounts traders commonly track; "load preset" restores it. Leave the box empty to react to everything in the tab. A tweet seen by both Axiom and your X tab only makes one card.
   - **Telegram:** add public channel usernames. They're checked every 30 seconds.
   Free AI keys have a daily token limit per model. To make it last, the AI only names posts that could actually launch: it skips posts blocked by your keywords, cooldown or launch limits. Press ↻ on any card for an AI name anyway. When one model hits its limit, the extension switches to another model your key can use, and back once the limit resets. The Feed tab shows how many AI tokens were used today.
   **Following the meta:** with AI naming on, Hatchr follows every pump.fun launch and every coin that graduates, live and for free (Settings → Sources → pump.fun; no account or Axiom needed). If you also keep an Axiom tab on **Pulse**, it reads New Pairs, Final Stretch and Migrated there every 15 seconds too. It remembers the last 3 hours. The AI sees what's running hot, which naming patterns are spreading ("___coin", "Fat ___") and which coins already use the post's words, and names new coins in that style. **Settings → AI → Meta right now** shows exactly what the AI sees.
6b. **AI images (optional).** In **Settings → Images**, pick a generator:
   - **Cloudflare (free):** sign up at dash.cloudflare.com, open **Workers AI → Use REST API**, copy your **Account ID** and create an API token with the "Workers AI" template.
   - **OpenAI:** create a key at platform.openai.com. OpenAI may ask you to verify your organization once before image models work.

   Choose when to use AI images: when the post has no picture, always, or only when you press 🎨 on a card. Click **Test AI image** to see a sample. If generation fails at launch, the coin uses the tweet screenshot, so launches never get stuck.
7. **Save settings, then click Test setup.** It checks your wallet, balance, RPC and Pinata, and simulates a full create transaction without spending anything.

## Using it

- **TEST / LIVE** (top right): in test mode, every launch is simulated. With a wallet set, Hatchr also builds and signs the real transaction and checks it on-chain without sending it. The coin then shows up in the **Launched** tab as a test coin: its picture, the tokens you'd hold and what it would have cost. **Preview coin** shows what would go on pump.fun, and **Sell all (test)** shows what you'd get back. Nothing is spent. Switch to **LIVE** (it pulses red) when Test setup passes.
- **ⓘ guides:** every key and URL in Settings has an ⓘ. Hover or click it for step-by-step instructions to get that key, with a button that opens the right site.
- **Language:** Settings → Language (English, Nederlands, Deutsch, Español, or your browser's language).
- **Manual mode:** edit the name, ticker or image on any card, then click Launch. ↻ makes a new name, and 📁 uploads your own image.
- **Paste box:** make a coin from anything, such as a headline, a tweet link or an article line.
- **Auto mode:** every new post goes through your rules in **Settings → Auto**:
  - include and exclude keywords
  - min AI score
  - cooldown
  - max launches per hour and per day
  - max SOL spent per day
  - minimum balance
  - no repeat names

  The card shows why a post was skipped. Run auto mode in test mode for a while first: the rules apply exactly the same, so you can see what *would* have launched.
- **Hatchr always starts paused**, also after every Chrome restart, so nothing launches by itself until you press **▶ Start**. **Pause** stops auto mode again instantly.
- **⇄ currency** (next to your balance): click it and pick USD, EUR or GBP to see every amount in that currency instead of SOL (live SOL price from CoinGecko). "Show in SOL" switches back.
- **PnL card** (Settings → Account, above your wallet): what your launches cost, what sells brought back and the creator rewards you claimed, for the last 24 hours, 7 days, 30 days or all time, for this wallet or all wallets you've used in Hatchr. In test mode it shows your test PnL. The share button makes a picture of it to copy, download or post on X.
- **Launched tab:** each live coin shows how many tokens your wallet still holds, with two buttons:
  - **Open in …** opens the coin on your trading site: Axiom, pump.fun, GMGN, BullX NEO, Padre or DEX Screener (Settings → Launch → Open coins in).
  - **Sell all** sells 100% of your tokens through PumpPortal; it also works after the coin has left the bonding curve. It's as cheap as possible: the lowest priority fee that usually lands, resent once with a slightly higher fee if it isn't confirmed within about 20 seconds, then the empty token account is closed to get its ~0.002 SOL rent back. Once sold, or if you hold nothing, the entry greys out and its buttons still work.
- **Settings → Launch → Open the coin right after a live launch** does that automatically, on the site you picked.

## Named animals and video posts

- **🐾 Named animals always launch** (Settings → Auto). "K9 Neo", "Moo Deng the hippo", "our dog Floki", "a cat named Luna": the coin is named after the animal as the post writes it (K9 Neo), with the animal's name as the ticker ($NEO). Auto mode launches it without needing an AI score, include keyword or cooldown. Your "never" keywords and hourly, daily and SOL limits still apply.
- **Video posts** get a frame from the video as the coin picture. The extension grabs 6 frames and skips black or blank ones. A vision AI picks the one that shows the subject (e.g. the dog) best; without it, the sharpest frame is used. Tall videos are fitted into a square over a blurred background so nothing is cut off. The card preview shows the frame before you launch.

## Creator rewards

The wallet that creates a coin earns a creator fee from every trade on it, from other people's buys and sells too. That's why a tiny dev buy works: you hold almost nothing, and you still earn if the coin gets traded. Rewards pile up across all your coins until you claim them.

- **Launched tab → Creator rewards:** shows what's waiting to be claimed. **Claim** collects everything in one transaction.
- **Settings → Launch → Auto-claim creator rewards:** claims by itself once the amount passes your minimum (default 0.02 SOL), checked every hour.
- Pump.fun has changed its fee rules several times. Check a coin's page on pump.fun to see that it's a "creator fees" coin and not a "cashback" coin.

## Backup and restore

**Settings → Account → Export backup** saves everything to one file: all settings, every API key, your wallet keys (current and previous) and your launch history. After reinstalling, **Import backup** restores it all. Set a backup password: the file contains your wallet private key, and a locked file is unreadable without the password. If you lose the password, the backup can't be opened.

## Good to know

- **Axiom stays running by itself:** the extension stops Chrome from putting the Axiom tab to sleep, reopens it as a pinned background tab within about a minute if you close it, and reloads it (never the tab you're looking at) if it stops sending. You can turn this off in Settings → Sources. You still need to be logged in to Axiom in Chrome.
- **Speed:** a post usually reaches the panel within a few seconds of appearing in your X tab. A launch takes about 3–10 seconds more, depending on your RPC.
- **Competition:** the big accounts get dozens of copycat coins within seconds, and sniper bots buy most new launches immediately. Most memecoins go to zero. Treat every launch as money spent, not invested.
- **Breakage:** X and Axiom change their pages sometimes. If posts stop showing up from one source, `content-x.js` or `content-axiom-main.js` needs an update.
- **Fees:** PumpPortal (which builds the transaction) charges a small fee on the dev buy. Creation itself has no extra fee.
- **Names:** launching coins named after real people or brands can break pump.fun's rules or trademark/publicity laws where you live.

## Files

- `background.js`: the engine (bundled). The readable source is in the `source/` folder.
- `content-x.js`: reads new posts from your X tab.
- `content-axiom-main.js` + `content-axiom.js`: read Axiom's X tracker panel.
- `sidepanel.*`: the UI. Translations are in `source/i18n/`.
