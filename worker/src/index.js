// Toni's Jeans & Tees API Worker
// Public:
//   GET  /api/bags                 → { bags, settings }
//   GET  /img/:filename            → image binary (served from KV)
//   GET  /api/ig-fetch?url=        → IG single-post embed scrape (quick-add)
//   GET  /api/ig-proxy?url=        → CORS proxy for IG CDN images
//   GET  /api/ig-feed?user_id=     → IG profile feed (seed/backfill)
// Admin (Authorization: Bearer <ADMIN_TOKEN>):
//   POST /api/bulk                 → replace { bags, settings }
//   POST /api/image                → upload image, returns { path }
//   GET  /api/ig-discover          → preview new IG posts with AI classification
//   POST /api/ig-sync              → commit approved IG posts to catalog
//   GET  /api/ig-accept-license    → one-shot Llama 3.2 Vision EULA agree
//   GET  /api/ig-classify          → debug a single shortcode
//
// Storage (KV binding "BAGS"):
//   "data"        → JSON { bags, settings }
//   "img:<name>"  → base64 string of image binary
//   "mime:<name>" → mime type for the corresponding image

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });

const isAuthed = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.ADMIN_TOKEN && auth.slice(7).trim() === env.ADMIN_TOKEN;
};

// Master token = billing/agency only. Controls the suspend flag. The shop's
// ADMIN_TOKEN can NOT flip suspend, so the owner can't reactivate themselves.
const isMaster = (req, env) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return env.MASTER_TOKEN && auth.slice(7).trim() === env.MASTER_TOKEN.trim();
};

// Decode HTML entities IG slathers across og:description and the embed Caption
// div. Named entities + decimal (&#064;) + hex (&#x40;). Without this, captions
// contain literal "&#064;" instead of "@", which breaks admin's @<price> parser.
const decodeEntities = (s) => (s || "")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

// ---- Caption → brand/category/stock heuristics for IG sync ----
// Toni's stocks clothing only. NEVER classify anything as a shoe.
// Order matters: specific phrases before generic brand fallbacks.
const CLOTHING_BRANDS = [
  ["levi's",            "Levi's",            "Jeans"],
  ["levis",             "Levi's",            "Jeans"],
  ["diesel",            "Diesel",            "Jeans"],
  ["wrangler",          "Wrangler",          "Jeans"],
  ["tommy hilfiger",    "Tommy Hilfiger",    "Shirts"],
  [/\btommy\b/,         "Tommy Hilfiger",    "Shirts"],
  ["calvin klein",      "Calvin Klein",      "Tshirts"],
  [/\bck\b/,            "Calvin Klein",      "Tshirts"],
  ["polo ralph lauren", "Polo Ralph Lauren", "Polos"],
  ["ralph lauren",      "Polo Ralph Lauren", "Polos"],
  ["lacoste",           "Lacoste",           "Polos"],
  ["hugo boss",         "Hugo Boss",         "Shirts"],
  [/\bboss\b/,          "Hugo Boss",         "Shirts"],
  ["the north face",    "The North Face",    "Jackets"],
  ["north face",        "The North Face",    "Jackets"],
  [/\btnf\b/,           "The North Face",    "Jackets"],
  ["champion",          "Champion",          "Tshirts"],
  ["supreme",           "Supreme",           "Tshirts"],
  ["stussy",            "Stussy",            "Tshirts"],
  [/\bgap\b/,           "Gap",               "Tshirts"],
  ["puma",              "Puma",              "Sports Jerseys"],
  ["adidas",            "Adidas",            "Sports Jerseys"],
  ["nike",              "Nike",              "Sports Jerseys"],
  // Generic-keyword fallbacks (no brand): drive category only.
  ["long sleeve",       null,                "Long Sleeve Tees"],
  ["jersey",            null,                "Sports Jerseys"],
  ["hoodie",            null,                "Jackets"],
  ["sweatshirt",        null,                "Jackets"],
  ["sweater",           null,                "Jackets"],
  ["jacket",            null,                "Jackets"],
  ["khaki",             null,                "Khakis/Plaid Pants"],
  ["chinos",            null,                "Khakis/Plaid Pants"],
  ["chino",             null,                "Khakis/Plaid Pants"],
  ["plaid",             null,                "Khakis/Plaid Pants"],
  ["shorts",            null,                "Shorts"],
  [/\bcap\b/,           null,                "Caps"],
  [/\bhat\b/,           null,                "Caps"],
  ["beanie",            null,                "Caps"],
  ["polo",              null,                "Polos"],
  ["t-shirt",           null,                "Tshirts"],
  ["tshirt",            null,                "Tshirts"],
  [/\btee\b/,           null,                "Tshirts"],
  [/\btees\b/,          null,                "Tshirts"],
  ["denim",             null,                "Jeans"],
  ["jeans",             null,                "Jeans"],
  ["shirt",             null,                "Shirts"],
];

function deriveBrand(caption) {
  let text = (caption || "").toLowerCase().trim();
  text = text.replace(/^[a-z0-9._]+ /, "");  // strip leading "username "
  const padded = " " + text + " ";
  for (const [key, name, cat] of CLOTHING_BRANDS) {
    if (key instanceof RegExp) {
      if (key.test(padded)) return [name, cat];
    } else if (padded.includes(key)) {
      return [name, cat];
    }
  }
  return [null, null];
}

// Standard apparel sizes (XS through 3XL).
const STD_SIZES = ["xs", "s", "m", "l", "xl", "xxl", "3xl"];

function parseCaptionForBag(caption) {
  const text = (caption || "").trim();
  const lower = text.toLowerCase();
  const cleaned = text.split(/whastup|whatsapp|wa\.me|0746/i)[0].trim().replace(/[.\s]+$/, "");
  let [brand, category] = deriveBrand(caption);
  if (!brand) {
    const first = cleaned.split(/\.\.|,|\n/)[0].trim();
    brand = first ? first.slice(0, 40).replace(/\b\w/g, c => c.toUpperCase()) : "Pre-loved Piece";
    category = category || "Other";
  }
  const stock = {};
  // Standard letter sizes — match whole-word, case-insensitive.
  const sizeRegex = /\b(xs|s|m|l|xl|xxl|3xl)\b/gi;
  let mLetter;
  while ((mLetter = sizeRegex.exec(lower)) !== null) {
    const s = mLetter[1].toUpperCase();
    if (STD_SIZES.includes(s.toLowerCase())) stock[s] = 1;
  }
  // Numeric jeans waist sizes (28-44). Look for integers in that range,
  // typically following "waist" or "size" or alone.
  const waistRegex = /\b(2[89]|3\d|4[0-4])\b/g;
  let mWaist;
  while ((mWaist = waistRegex.exec(lower)) !== null) {
    const n = mWaist[1];
    stock[`W${n}`] = 1;
  }
  if (!Object.keys(stock).length) stock["One Size"] = 1;
  return {
    name: brand,
    category: category || "Other",
    stock,
    description: "Hand-picked. Inspected. Photographed exactly as it is. Pay on delivery within Nairobi.",
  };
}

function looksLikeProduct(caption) {
  if (!caption) return false;
  const lower = caption.toLowerCase();
  if (/\b(?:xs|s|m|l|xl|xxl|3xl)\b/i.test(lower)) return true;
  if (/\b(2[89]|3\d|4[0-4])\b/.test(lower)) return true;
  for (const [key] of CLOTHING_BRANDS) {
    if (key instanceof RegExp ? key.test(lower) : lower.includes(key)) return true;
  }
  return false;
}

// Vision-model classifier — looks at the actual photo + caption.
// Llama 3.2 Vision (Workers AI free tier) sees the image, so it can tell
// jeans from polos from jackets even when the caption is sparse.
// Returns { is_product, name, category, reason } or null on failure.
async function classifyPostWithVision(env, caption, imageUrl) {
  if (!env.AI || !imageUrl) return null;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return { _debug: `img fetch ${imgRes.status}` };
    const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
    const trimmed = (caption || "").replace(/\s+/g, " ").slice(0, 400);
    const prompt = `You sort Instagram posts from a thrift clothing shop (Toni's Jeans & Tees). You're given ONE photo + ONE caption. Decide:
1. Is this a single piece of clothing for sale? (is_product true|false)
2. What brand/model is it? (name — short, e.g. "Levi's 501 Jeans", or "Pre-loved Piece" if unknown)
3. What category? Pick exactly one: Jeans, Tshirts, Polos, Shirts, Long Sleeve Tees, Sports Jerseys, Jackets, Khakis/Plaid Pants, Shorts, Caps, Other. NEVER use Shoes, Sneakers, or Boots — Toni's only stocks clothing.

Category guide:
- Jeans: denim trousers, typically blue. Levi's, Diesel, Wrangler.
- Tshirts: short-sleeve cotton tee, crew or v-neck. No collar.
- Polos: collared knit pullover, short sleeves, 2-3 buttons. Ralph Lauren, Lacoste.
- Shirts: button-down dress or casual shirts (NOT t-shirts). Long or short sleeves, full button placket.
- Long Sleeve Tees: long-sleeve cotton tee, no collar, no buttons.
- Sports Jerseys: athletic/sports apparel — basketball jerseys, football kits, Nike/Adidas/Puma performance tops.
- Jackets: outerwear including hoodies, sweatshirts, sweaters, denim jackets, bombers, parkas, fleeces, coats.
- Khakis/Plaid Pants: chinos, khaki trousers, plaid/checked trousers.
- Shorts: any kind of shorts.
- Caps: hats, baseball caps, beanies, snapbacks.
- Other: anything genuinely unclassifiable. Use this rather than inventing a footwear category.

is_product=false ONLY for: shop intros, marketing slides, owner photos, announcements, or if the photo shows shoes/footwear (Toni's doesn't stock those). Posts with a size signal (S, M, L, XL, XXL, W32, etc.) AND clothing visible are ALWAYS products.

Caption: """${trimmed}"""

Reply with strict minified JSON, no prose, no code fences:
{"is_product":true|false,"name":"<brand+model or Pre-loved Piece>","category":"<one from the list>","reason":"<3-6 words>"}`;
    const result = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      prompt,
      image: Array.from(imgBytes),
      max_tokens: 200,
      temperature: 0.1,
    });
    let parsed = null;
    if (result?.response && typeof result.response === "object") {
      parsed = result.response;
    } else {
      let text = "";
      if (typeof result?.response === "string") text = result.response;
      else if (typeof result?.description === "string") text = result.description;
      else if (typeof result === "string") text = result;
      text = text.trim();
      if (text) {
        const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (_) {}
        }
        // Fallback: model sometimes returns markdown bullets instead of JSON.
        // Extract "key: value" pairs from "**is_product**: true" / "* is_product: true" etc.
        if (!parsed) {
          const grab = (key) => {
            const re = new RegExp(`[*_\\s]*${key}[*_\\s]*:?\\s*"?([^"\\n*]+?)"?\\s*(?:[*\\n]|$)`, "i");
            const r = cleaned.match(re);
            return r ? r[1].trim() : null;
          };
          const isProd = grab("is_product") || grab("is_shoe");
          const name = grab("name");
          const category = grab("category");
          const reason = grab("reason");
          if (isProd || name || category) {
            parsed = {
              is_product: /^true|^yes/i.test(isProd || ""),
              name: name || null,
              category: category || null,
              reason: reason || "",
            };
          }
        }
      }
    }
    if (!parsed) return { _debug: "could not parse vision output", raw: JSON.stringify(result).slice(0, 400) };
    return {
      is_product: !!(parsed.is_product ?? parsed.is_shoe),
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
      via: "vision",
    };
  } catch (err) {
    return { _debug: `vision throw: ${err.message}` };
  }
}

function arrayToB64(buf) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Text-only LLM classifier — fallback when the vision call fails.
// Returns { is_product, name, category, reason } or null.
async function classifyPostWithAi(env, caption) {
  if (!env.AI || !caption) return null;
  const trimmed = caption.replace(/\s+/g, " ").slice(0, 400);
  const prompt = `You sort Instagram posts from a thrift clothing shop (Toni's Jeans & Tees). Each post is either ONE specific piece of clothing for sale, OR a non-product post. Reply with strict minified JSON only, no prose, no code fences.

Schema:
{"is_product": true|false, "name": "<short brand + item OR generic descriptor>", "category": "<one of: Jeans, Tshirts, Polos, Shirts, Long Sleeve Tees, Sports Jerseys, Jackets, Khakis/Plaid Pants, Shorts, Caps, Other>", "reason": "<3-6 words>"}

NEVER use Shoes, Sneakers, or Boots — Toni's only stocks clothing.

Rules:
- The shop posts a SINGLE piece per listing. Captions are short, often only a brand + size + a WhatsApp number.
- is_product = true whenever there is a size signal (XS, S, M, L, XL, XXL, 3XL, or a waist size 28-44). Even if no brand is named, the post is a product. Use "Pre-loved Piece" as the name.
- is_product = false ONLY for: shop intros, owner photos, marketing slides, announcements, holiday posts, anything without any size or clothing brand.
- Decode common shorthand: "Tnf" or "Tn" in a clothing context = The North Face jacket (Toni's sells clothing, never shoes), "CK" = Calvin Klein, "Ralph" = Polo Ralph Lauren.
- name MUST be brand+item when known. Strip sizes, phone numbers, prices. If brand unknown but size exists, name = "Pre-loved Piece".
- category: pick the closest fit. Defaults: Levi's/Diesel/Wrangler/anything denim = Jeans; Ralph Lauren/Lacoste polos = Polos; Tommy Hilfiger button-down = Shirts; Calvin Klein tee/Champion/Supreme/Stussy/Gap = Tshirts; The North Face/hoodies/sweatshirts/jackets = Jackets; Nike/Adidas/Puma athletic tops = Sports Jerseys.

Caption: """${trimmed}"""`;
  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 120,
    });
    const text = (result?.response || "").trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      is_product: !!(parsed.is_product ?? parsed.is_shoe),
      name: parsed.name || null,
      category: parsed.category || null,
      reason: parsed.reason || "",
    };
  } catch (_) {
    return null;
  }
}

// Feed-fetch helper — module-level so /api/ig-feed AND /api/ig-discover share
// the same logic. Workers can't fetch() their own URL (error 1042), so the
// only way to share is via a plain function.
async function fetchIgFeed({ username, userId: directUserId, count = 50, maxId = "" } = {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
    "X-IG-App-ID": "936619743392459",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": `https://www.instagram.com/${username || ""}/`,
  };
  let userId, user = null, profile = null;
  if (directUserId) {
    userId = directUserId;
    profile = { id: userId, username: username || null };
  } else {
    const pRes = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { headers });
    if (!pRes.ok) return { error: `profile lookup ${pRes.status}` };
    const pData = await pRes.json();
    user = pData?.data?.user;
    if (!user?.id) return { error: "user id not found" };
    userId = user.id;
    profile = {
      id: userId,
      username: user.username,
      fullName: user.full_name,
      biography: user.biography,
      profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url,
      followers: user.edge_followed_by?.count,
    };
  }
  const qsTail = `?count=${count}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`;
  let items = [];
  let moreAvailable = false;
  let nextMaxId = null;
  const embedded = user?.edge_owner_to_timeline_media;
  if (!maxId && embedded?.edges?.length) {
    items = embedded.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl);
    moreAvailable = !!embedded.page_info?.has_next_page;
    nextMaxId = embedded.page_info?.end_cursor || null;
  }
  if (items.length < count && (maxId || moreAvailable || directUserId)) {
    const cursor = maxId || nextMaxId;
    const variables = encodeURIComponent(JSON.stringify({ id: userId, first: count, after: cursor || null }));
    const gqlRes = await fetch(`https://www.instagram.com/graphql/query/?query_hash=003056d32c2554def87228bc3fd9668a&variables=${variables}`, { headers });
    if (gqlRes.ok) {
      const gData = await gqlRes.json();
      const media = gData?.data?.user?.edge_owner_to_timeline_media;
      if (media?.edges?.length) {
        items = items.concat(media.edges.map(({ node }) => extractFromTimelineNode(node)).filter(it => it.imageUrl));
        moreAvailable = !!media.page_info?.has_next_page;
        nextMaxId = media.page_info?.end_cursor || null;
      }
    }
  }
  if (!items.length) {
    let fRes = await fetch(`https://www.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) fRes = await fetch(`https://i.instagram.com/api/v1/feed/user/${userId}/${qsTail}`, { headers });
    if (!fRes.ok) return { error: `feed fetch ${fRes.status}`, profile };
    const fData = await fRes.json();
    items = (fData.items || []).map(extractFromFeedItem).filter(it => it.imageUrl);
    moreAvailable = !!fData.more_available;
    nextMaxId = fData.next_max_id || null;
  }
  return { profile, items, count: items.length, more_available: moreAvailable, next_max_id: nextMaxId };
}

// IG response normalisers — kept module-level so /api/ig-feed can mix sources.
function extractFromTimelineNode(node) {
  const shortcode = node.shortcode || node.code;
  let imageUrls = [];
  const children = node.edge_sidecar_to_children?.edges || [];
  if (children.length) {
    imageUrls = children.map(({ node: c }) => c.display_url || c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (node.display_url) {
    imageUrls = [node.display_url];
  } else if (node.image_versions2?.candidates?.length) {
    imageUrls = [node.image_versions2.candidates[0].url];
  }
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : (node.taken_at ? new Date(node.taken_at * 1000).toISOString() : null),
  };
}

function extractFromFeedItem(m) {
  const carousel = m.carousel_media || [];
  let imageUrls = [];
  if (carousel.length) {
    imageUrls = carousel.map(c => c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
  } else if (m.image_versions2?.candidates?.length) {
    imageUrls = [m.image_versions2.candidates[0].url];
  }
  const shortcode = m.code;
  const caption = m.caption?.text || "";
  return {
    shortcode,
    imageUrl: imageUrls[0],
    imageUrls,
    caption,
    isCarousel: imageUrls.length > 1,
    postUrl: `https://www.instagram.com/p/${shortcode}/`,
    takenAt: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : null,
  };
}

// Server-side category coerce. Maps anything the model spits out that we don't
// stock to an adjacent allowed category. Footwear gets nulled — Toni's doesn't
// sell shoes, so a shoe-classified post should be treated as a non-product.
const TONI_CATEGORIES = new Set([
  "Jeans", "Tshirts", "Polos", "Shirts", "Long Sleeve Tees",
  "Sports Jerseys", "Jackets", "Khakis/Plaid Pants", "Shorts", "Caps", "Other",
]);
function coerceCategory(c) {
  if (!c) return c;
  const s = String(c).trim();
  if (/^(shoes|sneakers|boots|loafers|slides|sandals|heels|formal)$/i.test(s)) return null; // not a Toni's category
  if (TONI_CATEGORIES.has(s)) return s;
  // Common LLM variants → canonical.
  if (/^tee(?:s|-shirt|\s?shirt)?$/i.test(s)) return "Tshirts";
  if (/^t-?shirts?$/i.test(s)) return "Tshirts";
  if (/^hoodie$|^sweatshirt$|^sweater$/i.test(s)) return "Jackets";
  if (/^(pants|chinos|trousers)$/i.test(s)) return "Khakis/Plaid Pants";
  if (/^jersey$/i.test(s)) return "Sports Jerseys";
  if (/^(cap|hat|beanie)$/i.test(s)) return "Caps";
  if (/^polo$/i.test(s)) return "Polos";
  if (/^shirt$/i.test(s)) return "Shirts";
  if (/^long\s?sleeve(\s?tees?)?$/i.test(s)) return "Long Sleeve Tees";
  if (/^denim$|^jean$/i.test(s)) return "Jeans";
  if (/^short$/i.test(s)) return "Shorts";
  return "Other";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // --- Public reads ---
    if (request.method === "GET" && path === "/api/bags") {
      const raw = await env.BAGS.get("data");
      const data = raw ? JSON.parse(raw) : { bags: [], settings: {} };
      // Billing kill-switch: stored in its own KV key so the owner's admin
      // publishes (which only write "data") can never clear it.
      data.suspended = (await env.BAGS.get("suspended")) === "1";
      // PRIVACY: strip buyer PII (sales[].buyerName/buyerPhone/notes, soldTo) for
      // unauthed callers. The storefront only reads sold/price/salePrice/sales.length,
      // never buyer details. The admin sends a Bearer token and gets the full data.
      const admin = isAuthed(request, env);
      if (!admin && Array.isArray(data.bags)) {
        data.bags = data.bags.map(b => {
          if (!b || typeof b !== "object") return b;
          let nb = b;
          if ("soldTo" in nb) { const { soldTo, ...r } = nb; nb = r; }
          if (Array.isArray(nb.sales)) nb = { ...nb, sales: nb.sales.map(s => {
            if (!s || typeof s !== "object") return s;
            const { buyerName, buyerPhone, notes, name, phone, buyer, ...keep } = s;
            return keep;
          }) };
          return nb;
        });
      }
      if (!admin && data.clients) delete data.clients;
      return json(data, 200, admin ? { "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=10" });
    }

    // Billing only: flip the suspend flag. Authed by MASTER_TOKEN (not the shop admin token).
    if (request.method === "POST" && path === "/api/suspend") {
      if (!isMaster(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const suspended = !!body.suspended;
      await env.BAGS.put("suspended", suspended ? "1" : "0");
      return json({ ok: true, suspended });
    }

    const imgMatch = path.match(/^\/img\/(.+)$/);
    if (request.method === "GET" && imgMatch) {
      const name = decodeURIComponent(imgMatch[1]);
      const b64 = await env.BAGS.get(`img:${name}`);
      if (!b64) return new Response("Not found", { status: 404, headers: CORS });
      const mime = (await env.BAGS.get(`mime:${name}`)) || "image/jpeg";
      return new Response(b64ToBytes(b64), {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Cache-Control": "public, max-age=31536000, immutable",
          ...CORS,
        },
      });
    }

    // Per-item share page for WhatsApp/social link previews. The catalog Enquire
    // link ends with `${API_BASE}/p/<id>`; WhatsApp crawls this HTML, reads the OG
    // tags, and renders a preview card with the product photo + name + price.
    if (request.method === "GET" && path.startsWith("/p/")) {
      const SITE = "https://tonisjeans.essenceautomations.com";
      const esc = (s) => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const id = decodeURIComponent(path.slice(3));
      const raw = await env.BAGS.get("data");
      const bags = raw ? (JSON.parse(raw).bags || []) : [];
      const item = bags.find(b => b.id === id);
      if (!item) return Response.redirect(SITE + "/#shop", 302);
      const img = item.image || (item.images && item.images[0]) || `${SITE}/images/og-image.jpg`;
      const mime = /\.png$/i.test(img) ? "image/png" : /\.webp$/i.test(img) ? "image/webp" : "image/jpeg";
      const price = item.price > 0 ? ` · Ksh ${Number(item.price).toLocaleString("en-US")}` : "";
      const title = esc(item.name + price);
      const desc = esc((item.description || "Affordable denim & tees in Nairobi. Tap to view and check availability on WhatsApp.").slice(0, 160));
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Toni's Jeans & Tees">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:secure_url" content="${esc(img)}">
<meta property="og:image:type" content="${mime}">
<meta property="og:image:width" content="1080">
<meta property="og:image:height" content="1080">
<meta property="og:url" content="${SITE}/#shop">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:image" content="${esc(img)}">
<title>${title} · Toni's Jeans & Tees</title>
<meta http-equiv="refresh" content="0; url=${SITE}/#shop">
</head><body style="font-family:system-ui;background:#111;color:#fff;text-align:center;padding:40px">Opening Toni's Jeans & Tees…</body></html>`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
    }

    if (path === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // Buyer capture → forward to GHL form submit (server-side, no CORS or captcha popup)
    if (request.method === "POST" && path === "/api/buyer") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const { name, phone, notes, bag_name, bag_price, captchaV3 } = body;
      if (!name && !phone) return json({ error: "name or phone required" }, 400);
      const fd = new FormData();
      fd.append("formData", JSON.stringify({
        first_name: name || "",
        phone: phone || "",
        multi_line_280v: [notes, bag_name && `Bag: ${bag_name} (Ksh ${bag_price})`].filter(Boolean).join(" | "),
      }));
      fd.append("locationId", "aTZHRdo8ius6WBzGQ5GD");
      fd.append("formId", "BWrG36c6p56ATDThPdN7");
      fd.append("eventData", JSON.stringify({
        source: "thriftlux-admin",
        type: "page-visit",
        domain: "thriftlux-ke.pages.dev",
      }));
      if (captchaV3) fd.append("captchaV3", captchaV3);
      try {
        const r = await fetch("https://backend.leadconnectorhq.com/forms/submit", {
          method: "POST",
          headers: {
            "Origin": "https://link.essenceautomations.com",
            "Referer": "https://link.essenceautomations.com/widget/form/BWrG36c6p56ATDThPdN7",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          body: fd,
        });
        const text = await r.text().catch(() => "");
        return json({ ok: r.ok, status: r.status, body: text.slice(0, 500) });
      } catch (err) {
        return json({ ok: false, error: err.message }, 502);
      }
    }

    // ---- Insights: site-wide event tracking (aggregated in KV) ----
    // Public visitors POST events here; the admin reads the aggregate back.
    // Sums every visitor on every device into one shared "stats" tally.
    const TRACK_METRICS = new Set(["itemViews", "itemEnquiries", "itemWishlist", "itemIgClicks", "searchNoResults"]);
    if (request.method === "POST" && path === "/api/track") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const metric = String(body.metric || "");
      const key = String(body.key || "").slice(0, 80).trim();
      if (!TRACK_METRICS.has(metric) || !key) return json({ error: "bad metric/key" }, 400);
      let stats;
      try { stats = JSON.parse(await env.BAGS.get("stats")) || {}; } catch { stats = {}; }
      stats[metric] = stats[metric] || {};
      if (metric === "searchNoResults" && !(key in stats[metric]) && Object.keys(stats[metric]).length >= 800) {
        return json({ ok: true, capped: true });
      }
      stats[metric][key] = (stats[metric][key] || 0) + 1;
      stats._lastUpdated = new Date().toISOString();
      await env.BAGS.put("stats", JSON.stringify(stats));
      return json({ ok: true });
    }

    if (request.method === "GET" && path === "/api/insights") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let stats;
      try { stats = JSON.parse(await env.BAGS.get("stats")) || {}; } catch { stats = {}; }
      return json(stats);
    }

    if (request.method === "POST" && path === "/api/insights-reset") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      await env.BAGS.put("stats", JSON.stringify({ _lastUpdated: new Date().toISOString() }));
      return json({ ok: true });
    }

    // --- Admin ---
    if (request.method === "POST" && path === "/api/bulk") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!Array.isArray(body.bags)) return json({ error: "bags must be array" }, 400);
      // Empty-publish guard (mandated by CATALOG-STANDARDS): reject {bags:[]}
      // unless the caller passes force:true. Without this, a stray empty
      // payload silently nuked the live catalog (learned the hard way on Nzuri).
      if (body.bags.length === 0 && body.force !== true) {
        return json({ error: "empty publish blocked; pass force:true to confirm wipe" }, 400);
      }
      const payload = { bags: body.bags, settings: body.settings || {} };
      if (Array.isArray(body.clients)) payload.clients = body.clients;
      await env.BAGS.put("data", JSON.stringify(payload));
      return json({ ok: true, count: body.bags.length });
    }

    if (request.method === "POST" && path === "/api/image") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const { base64, ext } = body;
      if (!base64) return json({ error: "base64 required" }, 400);
      const safeExt = (ext || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const name = `bag_${Date.now()}.${safeExt}`;
      const mime = safeExt === "png" ? "image/png" : safeExt === "webp" ? "image/webp" : "image/jpeg";
      await env.BAGS.put(`img:${name}`, base64);
      await env.BAGS.put(`mime:${name}`, mime);
      return json({ path: `/img/${name}`, name });
    }

    // ---- IG image proxy: bypass CORS so the admin can download IG CDN images.
    // Allowlisted to cdninstagram.com + fbcdn.net only.
    if (request.method === "GET" && path === "/api/ig-proxy") {
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "url required" }, 400);
      let host;
      try { host = new URL(target).hostname; } catch { return json({ error: "bad url" }, 400); }
      if (!/(?:^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(host)) {
        return json({ error: "host not allowed" }, 403);
      }
      try {
        const r = await fetch(target);
        if (!r.ok) return json({ error: `upstream ${r.status}` }, 502);
        return new Response(r.body, {
          status: 200,
          headers: {
            "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG quick-add: server-side fetch of a public Instagram post ----
    if (request.method === "GET" && path === "/api/ig-fetch") {
      const igUrl = url.searchParams.get("url");
      if (!igUrl) return json({ error: "url required" }, 400);
      const m = igUrl.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
      if (!m) return json({ error: "not an Instagram post URL" }, 400);
      const code = m[1];

      const headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      };

      try {
        let caption = "", imageUrl = "", imageUrls = [];

        // 1. Embed page (most bot-friendly).
        const embedRes = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, { headers });
        if (embedRes.ok) {
          const html = await embedRes.text();
          const img = html.match(/<img[^>]+class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/i)
            || html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
          if (img) imageUrl = img[1].replace(/&amp;/g, "&");
          const capDiv = html.match(/<div[^>]+class=["'][^"']*Caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
          if (capDiv) caption = decodeEntities(capDiv[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
          if (!caption) {
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (desc) caption = decodeEntities(desc[1]);
          }
        }

        // 2. JSON endpoint (gives full carousel).
        try {
          const jsonRes = await fetch(`https://www.instagram.com/p/${code}/?__a=1&__d=dis`, {
            headers: { ...headers, "X-IG-App-ID": "936619743392459" },
          });
          if (jsonRes.ok) {
            const text = await jsonRes.text();
            if (text.trim().startsWith("{")) {
              const data = JSON.parse(text);
              const media = data?.graphql?.shortcode_media || data?.items?.[0] || data?.shortcode_media;
              if (media) {
                const children = media.edge_sidecar_to_children?.edges?.map(e => e.node) || media.carousel_media || [];
                if (children.length) {
                  imageUrls = children.map(c => c.display_url || c.image_versions2?.candidates?.[0]?.url).filter(Boolean);
                }
                if (!imageUrls.length) {
                  const single = media.display_url || media.image_versions2?.candidates?.[0]?.url;
                  if (single) imageUrls = [single];
                }
                if (!caption) {
                  const cap = media.edge_media_to_caption?.edges?.[0]?.node?.text || media.caption?.text;
                  if (cap) caption = cap;
                }
              }
            }
          }
        } catch (_) {}

        // 3. Final fallback: post-page OG tags.
        if (!imageUrl && !imageUrls.length) {
          const pageRes = await fetch(`https://www.instagram.com/p/${code}/`, { headers });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const img = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
            const desc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
            if (img) imageUrl = img[1].replace(/&amp;/g, "&");
            if (desc && !caption) {
              caption = decodeEntities(desc[1]);
              const m1 = caption.match(/^"(.+)"\s*-\s*@/s);
              if (m1) caption = m1[1];
            }
          }
        }

        if (!imageUrls.length && imageUrl) imageUrls = [imageUrl];
        if (!imageUrls.length) return json({ error: "Instagram blocked the request. Paste images manually instead." }, 502);

        return json({
          code,
          imageUrl: imageUrls[0],
          imageUrls,
          caption,
          postUrl: `https://www.instagram.com/p/${code}/`,
          isCarousel: imageUrls.length > 1,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG feed: server-side fetch of a profile's recent posts ----
    if (request.method === "GET" && path === "/api/ig-feed") {
      const username = url.searchParams.get("username");
      const count = Math.min(parseInt(url.searchParams.get("count") || "50", 10), 100);
      const maxId = url.searchParams.get("max_id") || "";
      const directUserId = url.searchParams.get("user_id") || "";
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);

      try {
        const result = await fetchIgFeed({ username, userId: directUserId, count, maxId });
        return json(result, result.error ? 502 : 200);
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // One-time Llama vision license acceptance.
    if (request.method === "GET" && path === "/api/ig-accept-license") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      try {
        const r = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree", max_tokens: 8 });
        return json({ ok: true, response: r });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // Debug: classify a single IG shortcode through both vision + text models.
    if (request.method === "GET" && path === "/api/ig-classify") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const sc = url.searchParams.get("shortcode");
      const capOverride = url.searchParams.get("caption");
      const directUserId = url.searchParams.get("user_id") || "50180633728";
      if (!sc) return json({ error: "shortcode required" }, 400);
      try {
        const feed = await fetchIgFeed({ userId: directUserId, count: 50 });
        const found = (feed.items || []).find(i => i.shortcode === sc);
        const imageUrl = found?.imageUrl || null;
        const caption = capOverride || found?.caption || "";
        const vision = await classifyPostWithVision(env, caption, imageUrl);
        const text = await classifyPostWithAi(env, caption);
        return json({ shortcode: sc, caption, imageUrl, vision, text_only: text });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG sync: discover new posts (admin-only preview) ----
    if (request.method === "GET" && path === "/api/ig-discover") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const username = url.searchParams.get("username");
      const directUserId = url.searchParams.get("user_id");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);
      if (!username && !directUserId) return json({ error: "username or user_id required" }, 400);

      try {
        const existingRaw = await env.BAGS.get("data");
        const existing = existingRaw ? JSON.parse(existingRaw) : { bags: [] };
        const existingIds = new Set((existing.bags || []).map(b => b.id));

        const feedData = await fetchIgFeed({ username, userId: directUserId, count: 50 });
        if (!feedData.items) return json({ error: feedData.error || "feed empty" }, 502);

        const fresh = feedData.items.filter(it => !existingIds.has(`ig_${it.shortcode}`)).slice(0, limit * 2);
        const classified = await Promise.all(fresh.map(async (it) => {
          const heuristic = looksLikeProduct(it.caption);
          const [vision, text] = await Promise.all([
            classifyPostWithVision(env, it.caption, it.imageUrl),
            classifyPostWithAi(env, it.caption),
          ]);
          const visionOk = vision && !vision._debug;
          const isProduct = heuristic || (visionOk && vision.is_product) || (text && text.is_product);
          if (!isProduct) return null;
          const heuristicSuggestion = parseCaptionForBag(it.caption);
          // Name: text LLM is best at brand shorthand; only fall back to vision
          // or heuristic if text didn't get a brand. Strip caption fragments.
          const looksLikeFragment = (n) => !n || /^(size|w?\d{2}|xs|s|m|l|xl|xxl|3xl)$/i.test(n.trim());
          let name = heuristicSuggestion.name;
          if (text?.is_product && !looksLikeFragment(text.name) && text.name !== "Pre-loved Piece") {
            name = text.name.trim();
          } else if (visionOk && vision.is_product && !looksLikeFragment(vision.name) && vision.name !== "Pre-loved Piece") {
            name = vision.name.trim();
          } else if (visionOk && vision.is_product && vision.name === "Pre-loved Piece") {
            name = "Pre-loved Piece";
          }
          // Category: vision wins (saw the photo). Then text. Heuristic last.
          let category = heuristicSuggestion.category;
          if (visionOk && vision.is_product && vision.category) {
            const coerced = coerceCategory(vision.category);
            if (coerced) category = coerced;
            else return null; // vision said it's footwear → not a Toni's product
          } else if (text?.is_product && text.category && text.category !== "Other") {
            const coerced = coerceCategory(text.category);
            if (coerced) category = coerced;
          }
          if (!category) category = "Other";
          const reason = visionOk ? vision.reason : (text?.reason || (heuristic ? "matched product heuristic" : ""));
          let classifier = "heuristic";
          if (visionOk && text) classifier = "vision+text";
          else if (visionOk) classifier = "vision";
          else if (text) classifier = "text";
          return {
            ...it,
            suggested: { name, category, stock: heuristicSuggestion.stock, description: heuristicSuggestion.description },
            ai_reason: reason,
            classifier,
          };
        }));
        const candidates = classified.filter(Boolean).slice(0, limit);

        return json({
          count: candidates.length,
          scanned: fresh.length,
          items: candidates,
          profile: feedData.profile,
          ai_enabled: !!env.AI,
        });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }

    // ---- IG sync: commit approved posts ----
    if (request.method === "POST" && path === "/api/ig-sync") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ error: "items required" }, 400);

      const existingRaw = await env.BAGS.get("data");
      const data = existingRaw ? JSON.parse(existingRaw) : { bags: [], settings: {} };
      const existingIds = new Set(data.bags.map(b => b.id));

      const added = [];
      const errors = [];
      const newBags = [];

      for (const it of items) {
        const id = `ig_${it.shortcode}`;
        if (existingIds.has(id)) { errors.push({ shortcode: it.shortcode, reason: "already in catalog" }); continue; }
        const urls = (it.imageUrls || []).slice(0, 4);
        if (!urls.length) { errors.push({ shortcode: it.shortcode, reason: "no images" }); continue; }
        const uploaded = [];
        for (const u of urls) {
          try {
            const r = await fetch(u);
            if (!r.ok) throw new Error(`fetch ${r.status}`);
            const buf = new Uint8Array(await r.arrayBuffer());
            const b64 = arrayToB64(buf);
            const name = `bag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`;
            await env.BAGS.put(`img:${name}`, b64);
            await env.BAGS.put(`mime:${name}`, "image/jpeg");
            uploaded.push(`${url.origin}/img/${name}`);
          } catch (e) {
            errors.push({ shortcode: it.shortcode, reason: `image fetch: ${e.message}` });
          }
        }
        if (!uploaded.length) continue;
        const bag = {
          id,
          name: (it.name || "Pre-loved Piece").slice(0, 80),
          category: coerceCategory(it.category) || "Other",
          description: it.description || "Hand-picked. Inspected. Photographed exactly as it is. Pay on delivery within Nairobi.",
          price: 0,
          stock: it.stock && typeof it.stock === "object" ? it.stock : { "One Size": 1 },
          sales: [],
          image: uploaded[0],
          createdAt: it.takenAt || new Date().toISOString(),
          instagramUrl: `https://www.instagram.com/p/${it.shortcode}/`,
        };
        if (uploaded.length > 1) bag.images = uploaded;
        newBags.push(bag);
        added.push({ shortcode: it.shortcode, id });
        existingIds.add(id);
      }

      // Newest posts go to the top of the catalog
      data.bags = newBags.concat(data.bags);
      await env.BAGS.put("data", JSON.stringify(data));
      return json({ ok: true, added: added.length, errors, items: added });
    }

    return json({ error: "not found" }, 404);
  },
};
