// Runs on x.com. Watches the timeline you have open (best: a List with the accounts you track)
// and sends every new post to the extension. Free, no API key — it just reads your own tab.
(() => {
  if (window.__t2cLoaded) return;
  window.__t2cLoaded = true;

  const seen = new Set();
  let enabled = true;
  let autoLoadNew = true;
  let alive = true;

  try { chrome.runtime.sendMessage({ type: "hello" }).catch(() => {}); } catch {}

  // Sharing a PnL card: the side panel saves the picture and opens X's post window with the text.
  // X's share link can't carry pictures, so we put it into the post's picture input here.
  attachSharedPicture();
  async function attachSharedPicture() {
    let share;
    try { ({ xShare: share } = await chrome.storage.local.get("xShare")); } catch { return; }
    if (!share || !share.image || Date.now() - share.at > 3 * 60_000) return;
    if (!/\/(intent|compose)\/(post|tweet)/.test(location.pathname)) return;
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      const input = document.querySelector('input[data-testid="fileInput"]') || document.querySelector('input[type="file"][accept*="image"]');
      if (input) {
        try {
          const bin = atob(share.image.split(",")[1]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const dt = new DataTransfer();
          dt.items.add(new File([bytes], "hatchr-pnl.png", { type: "image/png" }));
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await chrome.storage.local.remove("xShare");
        } catch {}
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  chrome.storage.local.get("settings").then(({ settings }) => {
    if (settings) {
      enabled = settings.xEnabled !== false;
      autoLoadNew = settings.xAutoLoadNew !== false;
    }
    scan();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.settings?.newValue) {
      enabled = ch.settings.newValue.xEnabled !== false;
      autoLoadNew = ch.settings.newValue.xAutoLoadNew !== false;
    }
  });

  function textOf(el) {
    if (!el) return "";
    let out = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
      else if (n.nodeName === "IMG") out += n.alt || "";
      else if (n.nodeName === "BR") out += "\n";
      else out += textOf(n);
    });
    return out;
  }

  function parse(article) {
    // promoted posts have no timestamp, so this also skips ads
    const timeEl = article.querySelector('a[href*="/status/"] time');
    if (!timeEl) return null;
    const link = timeEl.closest("a");
    const m = link.getAttribute("href").match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const [, handle, id] = m;

    // main post text = first tweetText that is not inside a quoted post
    let textEl = null;
    for (const t of article.querySelectorAll('[data-testid="tweetText"]')) {
      if (!t.closest('div[role="link"]')) { textEl = t; break; }
    }
    if (!textEl) textEl = article.querySelector('[data-testid="tweetText"]');

    let images = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .filter((img) => !img.closest('div[role="link"]'))
      .map((img) => img.src)
      .filter((src) => src.includes("pbs.twimg.com/media"));
    // video: X shows a preview frame (poster); use it like a photo
    if (!images.length) {
      for (const v of article.querySelectorAll("video[poster]")) {
        if (v.closest('div[role="link"]')) continue;
        const p = v.getAttribute("poster");
        if (p && p.includes("pbs.twimg.com")) images.push(p);
      }
    }

    const avatarImg = article.querySelector('[data-testid="Tweet-User-Avatar"] img');
    const nameEl = article.querySelector('[data-testid="User-Name"] span');

    return {
      source: "x",
      postId: id,
      dedupeKey: `tw:${id}`,
      handle,
      author: nameEl ? nameEl.textContent : handle,
      text: textOf(textEl).trim(),
      url: `https://x.com/${handle}/status/${id}`,
      images,
      avatar: avatarImg ? avatarImg.src : null,
      time: Date.parse(timeEl.getAttribute("datetime")) || Date.now(),
    };
  }

  function send(post) {
    if (!alive) return;
    try {
      chrome.runtime.sendMessage({ type: "post", post }).catch(() => {});
    } catch {
      // extension was reloaded; this old script is orphaned
      alive = false;
      observer.disconnect();
    }
  }

  function scan() {
    if (!enabled || !alive) return;
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const post = parse(article);
      if (!post || seen.has(post.postId)) continue;
      seen.add(post.postId);
      send(post);
    }
  }

  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Click X's "Show N posts" pill so new posts actually enter the page.
  setInterval(() => {
    if (!enabled || !autoLoadNew || !alive) return;
    const pill = document.querySelector('[data-testid="pillLabel"]');
    if (pill) { (pill.closest('[role="button"]') || pill).click(); return; }
    for (const el of document.querySelectorAll('[role="button"], button')) {
      const t = (el.innerText || "").trim();
      if (/^Show \d+ (new )?(post|posts|tweet|tweets)$/i.test(t)) { el.click(); return; }
    }
  }, 3000);
})();
