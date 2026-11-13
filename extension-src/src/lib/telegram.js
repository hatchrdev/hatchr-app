// Parses the public web preview of a Telegram channel (https://t.me/s/<channel>).
// No bot or API key needed, works for any public channel.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+|#39);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<i class="emoji"[^>]*>(.*?)<\/i>/gi, "$1")
      .replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function parseChannelHtml(html, channel) {
  const titleMatch = html.match(/<meta property="og:title" content="([^"]*)"/);
  const author = titleMatch ? decodeEntities(titleMatch[1]) : channel;
  const parts = html.split(/(?=<div class="tgme_widget_message_wrap)/);
  const posts = [];
  for (const block of parts) {
    const postMatch = block.match(/data-post="([^"]+)"/);
    if (!postMatch) continue;
    const dataPost = postMatch[1];
    const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const text = textMatch ? htmlToText(textMatch[1]) : "";
    const images = [];
    const re = /tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/g;
    let m;
    while ((m = re.exec(block))) images.push(m[1]);
    const timeMatch = block.match(/<time datetime="([^"]+)"/);
    const time = timeMatch ? Date.parse(timeMatch[1]) : null;
    if (!text && !images.length) continue;
    posts.push({
      source: "tg",
      postId: dataPost,
      handle: channel,
      author,
      text,
      url: `https://t.me/${dataPost}`,
      images,
      avatar: null,
      time,
    });
  }
  return posts;
}

export async function fetchChannel(channel) {
  const name = channel.replace(/^@/, "").replace(/^https?:\/\/t\.me\/(s\/)?/, "").replace(/\/.*$/, "");
  const res = await fetch(`https://t.me/s/${encodeURIComponent(name)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`t.me/${name}: HTTP ${res.status}`);
  return parseChannelHtml(await res.text(), name);
}
