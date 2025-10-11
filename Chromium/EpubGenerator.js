//  EpubGenerator.js
//  This file creates an EPUB from Kemono posts.

// CONFIGURATION
const KEMONO_API_BASE_URL = "https://kemono.cr/api/v1";
const KEMONO_SITE_BASE_URL = "https://kemono.cr";
const KEMONO_IMG_BASE_URL = "https://img.kemono.cr";
const KEMONO_DATA_BASE_URL = "https://kemono.cr/data";

const POSTS_PER_PAGE_FOR_LIST = 50;
const API_CALL_DELAY = 500;
const LARGE_OFFSET_FOR_COUNT = 100000;  // For reliable post count via error parsing

// SIMPLE RATE‑LIMITER (500ms between API calls)
let lastApiCallTime = 0;
async function ensureApiRateLimit() {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < API_CALL_DELAY) {
    await new Promise((r) => setTimeout(r, API_CALL_DELAY - elapsed));
  }
  lastApiCallTime = Date.now();
}

// HTTP HELPER – Kemono API requires `Accept: text/css`
const HttpClient = {
  async fetchJson(url) {
    await ensureApiRateLimit();
    const res = await fetch(url, { headers: { Accept: "text/css" } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "Failed to read error response.");
      console.error(`HTTP ${res.status} for ${url}: ${txt}`);
      throw new Error(
        `API request failed: ${res.status} - ${txt.substring(0, 200)}`
      );
    }
    return res.json();
  },

  async fetchBlob(url) {
    await ensureApiRateLimit();
    const res = await fetch(url, { headers: { Accept: "text/css" } });
    if (!res.ok) {
      console.error(`HTTP ${res.status} for asset ${url}`);
      throw new Error(`Asset request failed: ${res.status}`);
    }
    return res.blob();
  }
};

// Fetch tags list for filtering/bulk fetch optimization
export async function fetchTagsList(service, creatorId) {
  const url = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/tags`;
  try {
    const tags = await HttpClient.fetchJson(url);
    return Array.isArray(tags) ? tags.filter(t => t.tag && t.post_count > 0) : [];
  } catch (error) {
    console.warn(`Failed to fetch tags for ${service}/${creatorId}:`, error);
    return [];
  }
}

// FILENAME HELPERS
function sanitizeFilename(filename) {
  if (typeof filename !== "string") return "";
  const sanitized = filename
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/__+/g, "_");
  return sanitized.substring(0, 200);
}

function sanitizeBasenameForXhtmlStrict(basename) {
  if (!basename) return "chapter";
  let name = String(basename);
  name = name.replace(/\s+/g, "_");
  name = name.replace(/[^A-Za-z0-9._-]/g, "_");
  name = name.replace(/_+/g, "_");
  name = name.replace(/^[._-]+|[._-]+$/g, "");
  if (!name) name = "chapter";
  return name.substring(0, 120);
}

// XML / HTML HELPERS
function escapeXml(str) {
  if (str == null) return "";
  const s = String(str);
  if (typeof s.replaceAll === "function") {
    return s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
  return s
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

function replaceUnsupportedEntities(html) {
  if (!html) return "";
  return html.replace(/&nbsp;/gi, "&#160;");
}

function normalizeXhtmlVoidTags(html) {
  if (!html) return "";
  return html.replace(/<br(\s*)>/gi, "<br />");
}

function selfCloseVoidElements(html) {
  if (!html) return "";
  const voidEls = [
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "keygen", "link", "meta", "param", "source", "track", "wbr"
  ];
  voidEls.forEach((tag) => {
    const reNormal = new RegExp(`<${tag}([^>]*?)>(?!\\s*</${tag}>)`, "gi");
    html = html.replace(reNormal, `<${tag}$1/>`);

    const reExtra = new RegExp(
      `<${tag}([^>]*?)\\s*\\/\\/{2,}>`,
      "gi"
    );
    html = html.replace(reExtra, `<${tag}$1/>`);
  });

  html = html.replace(/<([a-z]+)([^>]*)\/\/+>/gi, "<$1$2/>");
  return html;
}

function sanitizeHtmlContent(htmlString) {
  if (!htmlString) return "";
  const SCRIPT_REGEX =
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
  let sanitized = htmlString.replace(SCRIPT_REGEX, "");
  sanitized = replaceUnsupportedEntities(sanitized);
  sanitized = normalizeXhtmlVoidTags(sanitized);
  sanitized = selfCloseVoidElements(sanitized);
  return sanitized;
}

// MIME-TYPE HELPER (covers the most common cases)
function mimeTypeFromExtension(ext) {
  ext = ext.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

// IMAGE CONVERSION – everything ends up as PNG (preserves transparency)
async function convertToPng(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const pngBlob = await canvas.convertToBlob({ type: "image/png" });
  return pngBlob;
}

// CONTENT PARSER – fetches a post, rewrites inline images, sanitises HTML
class KemonoContentParser {
  constructor(service, creatorId, progressReporter) {
    this.service = service;
    this.creatorId = creatorId;
    this.reportProgress = progressReporter;
    this.postCache = new Map();
  }

  async fetchPostFullData(postId) {
    postId = String(postId);
    if (this.postCache.has(postId)) {
      this.reportProgress(`Cache hit for post ${postId.substring(0, 10)}…`);
      return this.postCache.get(postId);
    }
    try {
      this.reportProgress(
        `Fetching post details: ${postId.substring(0, 10)}…`
      );
      const url = `${KEMONO_API_BASE_URL}/${this.service}/user/${this.creatorId}/post/${postId}`;
      const data = await HttpClient.fetchJson(url);
      const postDetail = data.post || data;
      if (!postDetail || !postDetail.id) {
        throw new Error(`Post data for ${postId} is malformed or missing.`);
      }
      this.postCache.set(postId, postDetail);  // Cache full data
      return postDetail;
    } catch (error) {
      console.error(`Error fetching post ${postId}:`, error);
      this.reportProgress(
        `Error fetching post ${postId.substring(0, 10)}…: ${error.message.substring(
          0,
          50
        )}…`
      );
      throw error;
    }
  }

  /* ------------------------------------------------------------------
  // BULK FETCH PREP – Uses q=<p> for broad full-content coverage
  // Overrides with UI tagFilter (if high post_count) or customQ.
  // Caches full post data from responses. Uses selected posts' offsets.
  // ------------------------------------------------------------------- */
  async prepareForBulkFetch(selectedPostStubs, { customQ, tagFilter } = {}) {
    if (!selectedPostStubs || selectedPostStubs.length === 0) {
      this.reportProgress("No selected posts for bulk fetch.");
      return;
    }

    let bulkParamType = 'q';
    let bulkValue = customQ || '<p>';
    let bulkTag = tagFilter || "";

    if (bulkTag) {
      try {
        const tags = await fetchTagsList(this.service, this.creatorId);
        const matchingTag = tags.find(t => t.tag === bulkTag && t.post_count >= selectedPostStubs.length);
        if (matchingTag) {
          bulkParamType = 'tag';
          bulkValue = bulkTag;
          this.reportProgress(`Using tag '${bulkValue}' for bulk fetch (covers ${matchingTag.post_count} posts).`);
        } else {
          console.warn(`Tag '${bulkTag}' post_count too low; falling back to q=<p>.`);
          bulkParamType = 'q';
          bulkValue = '<p';
        }
      } catch (e) {
        console.warn("Tag check failed, using q=<p>:", e);
        bulkParamType = 'q';
        bulkValue = '<p';
      }
    } else if (customQ && customQ.length < 3) {
      console.warn("Custom q too short; using default q=<p>.");
      bulkValue = '<p';
    }

    this.reportProgress(`Bulk fetching with ${bulkParamType}=${bulkValue} to cover ${selectedPostStubs.length} posts...`);

    const offsetsToFetch = new Set();
    for (const stub of selectedPostStubs) {
      if (stub.originalOffset !== undefined) {
        offsetsToFetch.add(stub.originalOffset);
        const prevOffset = stub.originalOffset - POSTS_PER_PAGE_FOR_LIST;
        if (prevOffset >= 0) offsetsToFetch.add(prevOffset);
      }
    }

    if (offsetsToFetch.size === 0) {
      this.reportProgress("No offsets from selected posts; fetching individually.");
      return;
    }

    const sortedOffsets = Array.from(offsetsToFetch).sort((a, b) => a - b);
    this.reportProgress(`Fetching ${sortedOffsets.length} pages via bulk...`);

    for (let i = 0; i < sortedOffsets.length; i++) {
      const offset = sortedOffsets[i];
      let url = `${KEMONO_API_BASE_URL}/${this.service}/user/${this.creatorId}/posts?o=${offset}`;
      if (bulkParamType === 'tag') {
        url += `&tag=${encodeURIComponent(bulkValue)}`;
      } else {
        url += `&q=${encodeURIComponent(bulkValue)}`;
      }

      try {
        this.reportProgress(`Bulk page ${i + 1}/${sortedOffsets.length} (offset ${offset})...`);
        const postsOnPage = await HttpClient.fetchJson(url);
        if (Array.isArray(postsOnPage)) {
          let cachedCount = 0;
          for (const fullPost of postsOnPage) {
            if (fullPost && fullPost.id) {
              this.postCache.set(String(fullPost.id), fullPost);
              cachedCount++;
            }
          }
          this.reportProgress(`Cached ${cachedCount} full posts from offset ${offset}.`);
        } else {
          console.warn(`Unexpected bulk response at offset ${offset}:`, postsOnPage);
        }
      } catch (error) {
        console.error(`Bulk fetch failed for offset ${offset}:`, error);
        this.reportProgress(`Bulk offset ${offset} error: ${error.message.substring(0, 50)}...`);
      }
    }

    const hitRate = (selectedPostStubs.filter(s => this.postCache.has(s.id)).length / selectedPostStubs.length) * 100;
    this.reportProgress(`Bulk complete. Cache hit rate for selected: ~${hitRate.toFixed(0)}%. Remaining will fetch individually.`);
  }

  /**
   * Parse raw HTML, download/rewrite inline images from content, 
   * PLUS handle attachments (fetch images, package, rewrite all references in HTML).
   * All images (inline + attachments) are converted to PNG.
   */
  async processPostImagesAndContent(postData) {
    const rawHtml = postData.content || "";
    const imagesToPackage = [];
    const attachmentsToPackage = [];

    const parser = new DOMParser();
    let doc = parser.parseFromString(rawHtml, "text/html");

    const imgElements = Array.from(doc.querySelectorAll("img"));
    for (let i = 0; i < imgElements.length; i++) {
      const img = imgElements[i];
      const originalSrc = img.getAttribute("src");
      if (!originalSrc) continue;

      let absoluteSrc = this._normalizeUrl(originalSrc);
      try {
        this.reportProgress(`Fetching inline image: ${originalSrc.substring(0, 30)}…`);
        let blob = await HttpClient.fetchBlob(absoluteSrc);
        blob = await convertToPng(blob);
        const mime = "image/png";
        const fileNameInEpub = sanitizeFilename(`inline_${postData.id}_${i}.png`);

        imagesToPackage.push({
          originalUrl: absoluteSrc,
          fileNameInEpub,
          localPathInEpub: `Images/${fileNameInEpub}`,
          blob,
          mimeType: mime
        });

        img.setAttribute("src", `../Images/${fileNameInEpub}`);
      } catch (e) {
        console.warn(`Failed to fetch inline image ${absoluteSrc}:`, e);
        const alt = img.getAttribute("alt") || "";
        img.setAttribute("alt", `${alt} (Image not available)`);
      }
    }

    if (postData.attachments && Array.isArray(postData.attachments)) {
      for (let j = 0; j < postData.attachments.length; j++) {
        const att = postData.attachments[j];
        if (!att.path || !att.name) continue;

        const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(att.name);
        if (!isImage) {
          console.log(`Skipping non-image attachment: ${att.name}`);
          continue;
        }

        let absolutePath = this._normalizeUrl(att.path);
        try {
          this.reportProgress(`Fetching attachment image: ${att.name.substring(0, 30)}…`);
          let blob = await HttpClient.fetchBlob(absolutePath);
          blob = await convertToPng(blob);
          const mime = "image/png";
          const fileNameInEpub = sanitizeFilename(att.name.replace(/\.[^/.]+$/, ".png"));

          attachmentsToPackage.push({
            originalUrl: absolutePath,
            fileNameInEpub,
            localPathInEpub: `Images/${fileNameInEpub}`,
            blob,
            mimeType: mime,
            originalName: att.name
          });
        } catch (e) {
          console.warn(`Failed to fetch attachment ${att.path}:`, e);
        }
      }
    }

    const allImagesToPackage = [...imagesToPackage, ...attachmentsToPackage];

    doc = this._rewriteAllImageReferences(doc, allImagesToPackage);

    const contentOut = doc.body.innerHTML;
    const xhtmlSafe = sanitizeHtmlContent(contentOut);

    return { updatedHtml: xhtmlSafe, imagesToPackage: allImagesToPackage };
  }

  _normalizeUrl(originalSrc) {
    let absoluteSrc = originalSrc;
    if (originalSrc.startsWith("//")) {
      absoluteSrc = `https:${originalSrc}`;
    } else if (originalSrc.startsWith("/")) {
      if (originalSrc.startsWith("/data/")) {
        absoluteSrc = `${KEMONO_DATA_BASE_URL}${originalSrc}`;
      } else {
        absoluteSrc = `${KEMONO_SITE_BASE_URL}${originalSrc}`;
      }
    } else if (!originalSrc.startsWith("http")) {
      absoluteSrc = `${KEMONO_SITE_BASE_URL}/${originalSrc}`;
    }
    if (absoluteSrc.includes("#") || absoluteSrc.includes("?")) {
      const cleanSrc = new URL(absoluteSrc, KEMONO_SITE_BASE_URL).origin + new URL(absoluteSrc, KEMONO_SITE_BASE_URL).pathname;
      absoluteSrc = cleanSrc;
    }
    return absoluteSrc;
  }

  _rewriteAllImageReferences(doc, imagesToPackage) {
    const urlToLocalMap = new Map();
    imagesToPackage.forEach(imgInfo => {
      urlToLocalMap.set(imgInfo.originalUrl, imgInfo.localPathInEpub);
      const partialPath = imgInfo.originalUrl.replace(KEMONO_SITE_BASE_URL, "").replace(KEMONO_DATA_BASE_URL.replace("https://", ""), "");
      if (partialPath) urlToLocalMap.set(partialPath, imgInfo.localPathInEpub);
    });

    const allImgElements = doc.querySelectorAll("img");
    allImgElements.forEach(img => {
      const src = img.getAttribute("src");
      if (src && urlToLocalMap.has(src)) {
        img.setAttribute("src", urlToLocalMap.get(src));
        if (!img.getAttribute("alt") && imagesToPackage.find(i => i.originalUrl === src)) {
          img.setAttribute("alt", `Attachment: ${imagesToPackage.find(i => i.originalUrl === src).originalName || "Image"}`);
        }
      }
    });

    const allLinks = doc.querySelectorAll("a[href]");
    allLinks.forEach(a => {
      let href = a.getAttribute("href");
      if (href && urlToLocalMap.has(href)) {
        const localHref = urlToLocalMap.get(href);
        a.setAttribute("href", localHref);
        const imgInfo = imagesToPackage.find(i => i.originalUrl === href);
        if (imgInfo) {
          if (a.textContent.trim().toLowerCase().includes("download")) {
            a.textContent = a.textContent.replace(/Download/i, "View");
          } else if (!a.textContent.trim()) {
            a.textContent = `View ${imgInfo.originalName}`;
          }
        }
      }
    });

    const allElementsWithStyle = doc.querySelectorAll("[style*='url(']");
    allElementsWithStyle.forEach(el => {
      let style = el.getAttribute("style");
      const urlMatch = style.match(/url\(['"]?([^'")]+)['"]?\)/gi);
      if (urlMatch) {
        urlMatch.forEach(match => {
          const urlStart = match.indexOf('(') + 1;
          const urlEnd = match.lastIndexOf(')');
          const cssUrl = match.substring(urlStart, urlEnd).replace(/^['"]|['"]$/g, '');
          if (urlToLocalMap.has(cssUrl)) {
            const localUrl = urlToLocalMap.get(cssUrl);
            const escapedCssUrl = cssUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            style = style.replace(new RegExp(escapedCssUrl, 'g'), localUrl);
          }
        });
        el.setAttribute("style", style);
      }
    });

    return doc;
  }
}

/* ------------------------------------------------------------------
// fetchPostListPage – Supports q/tag for full content in response,
// but always returns stubs (id, title, published, originalOffset) for UI.
// Full content is only cached during bulk/individual fetches.
// ------------------------------------------------------------------- */
export async function fetchPostListPage(
  service,
  creatorId,
  offset,
  limit = POSTS_PER_PAGE_FOR_LIST,
  { q, tag } = {}
) {
  let url = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/posts?o=${offset}`;
  if (limit) url += `&limit=${limit}`;
  if (tag) url += `&tag=${encodeURIComponent(tag)}`;
  if (q && q.length >= 3) url += `&q=${encodeURIComponent(q)}`;

  try {
    const data = await HttpClient.fetchJson(url);
    if (!Array.isArray(data)) throw new Error("Invalid response format.");

    const posts = data.map((p) => ({
      id: String(p.id),
      title: p.title || `Untitled Post ${p.id}`,
      published: p.published,
      originalOffset: offset
    }));
    return { posts };
  } catch (error) {
    console.error(`fetchPostListPage error (${service}/${creatorId}, offset ${offset}):`, error);
    throw error;
  }
}

export async function fetchCreatorProfile(service, creatorId) {
  const profileUrl = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/profile`;
  let postCount = 0;
  let creatorName = "";

  try {
    const profileData = await HttpClient.fetchJson(profileUrl);
    postCount = profileData.post_count || 0;
    creatorName = profileData.name || "";
    console.log(`Profile fetch: count=${postCount}, name="${creatorName}"`);
  } catch (error) {
    console.error(`Profile fetch failed for ${service}/${creatorId}:`, error);
    return { postCount: 0, creatorName: "" };
  }

  // Use large offset trick for reliable count (ignores sometimes stale profile count)
  const largeOffsetUrl = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/posts?o=${LARGE_OFFSET_FOR_COUNT}`;
  try {
    await ensureApiRateLimit();
    const response = await fetch(largeOffsetUrl, { headers: { Accept: "text/css" } });
    const text = await response.text();
    console.log(`Large offset response (${response.status}):`, text.substring(0, 100));

    if (response.status === 400) {
      // Expected error with total count in message
      try {
        const errorData = JSON.parse(text);
        const errorMsg = errorData.error || "";
        const parts = errorMsg.split(/\s+/);
        const lastPart = parts[parts.length - 1];
        const candidate = lastPart.replace(/\.$/, "");
        const parsedCount = parseInt(candidate, 10);
        if (!isNaN(parsedCount) && parsedCount >= 0) {
          postCount = parsedCount;
          console.log(`Parsed reliable count from error: ${postCount}`);
          return { postCount, creatorName };
        } else {
          console.warn(`Could not parse count from error: "${errorMsg}"`);
        }
      } catch (jsonError) {
        console.warn(`JSON parse failed for large offset response:`, jsonError);
      }
    } else if (response.status === 200) {
      const data = JSON.parse(text);
      postCount = Array.isArray(data) ? data.length : 0;
      console.log(`Unexpected 200 for large offset; using len=${postCount}`);
    } else {
      console.warn(`Unexpected status ${response.status} for large offset; using profile count=${postCount}`);
    }
  } catch (fetchError) {
    console.error(`Large offset fetch failed:`, fetchError);
    console.log(`Falling back to profile count: ${postCount}`);
  }

  return { postCount, creatorName };
}

// Generate an EPUB from the selected posts and trigger a download.
export async function generateKemonoEpub(
  creatorInfo,
  selectedPostStubs,
  options,
  progressCallback
) {
  if (typeof JSZip === "undefined")
    throw new Error("JSZip library not found.");
  if (typeof saveAs === "undefined")
    throw new Error("FileSaver.js library not found.");

  const parserProgress = (msg) => progressCallback(-1, msg);
  const parser = new KemonoContentParser(
    creatorInfo.service,
    creatorInfo.creatorId,
    parserProgress
  );

  const displayName =
    creatorInfo.creatorName && creatorInfo.creatorName.trim()
      ? creatorInfo.creatorName.trim()
      : "Unknown";

  // Generate a proper UUID (v4) – required for dc:identifier.
  const uuid = (() => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    const hex = [...Array(16)]
      .map(() => Math.floor(Math.random() * 256))
      .map((b) => b.toString(16).padStart(2, "0"));
    hex[6] = (parseInt(hex[6], 16) & 0x0f | 0x40).toString(16);
    hex[8] = (parseInt(hex[8], 16) & 0x3f | 0x80).toString(16);
    return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
  })();

  const packer = new EpubPacker({
    title: displayName,
    author: displayName,
    uuid: `urn:uuid:${uuid}`,
    language: "en"
  });

  // Minimalist stylesheet inspired by Calibre: Neutral, book-like, no explicit fonts/colors for e-reader defaults
  const stylesheet = `body{font-size:1.29em;line-height:1.2;margin:0 5pt;padding:0}
.calibre{display:block;font-size:1.29em;line-height:1.2;padding:0;margin:0 5pt;text-indent:0}
.calibre1{display:block;margin:0.5em 0;padding:0;text-indent:1.5em}
.calibre2{display:block;margin:0.5em 0;padding:0;text-indent:1.5em}
h1{font-size:1.8em;margin:0.5em 0;padding:0}
h2{font-size:1.5em;margin:0.5em 0;padding:0}
p{display:block;margin:0.5em 0;padding:0;text-indent:1.5em}
img{max-width:100%;height:auto;display:block;margin:1em auto}
.calibre3{vertical-align:super;font-size:0.65em;line-height:1.2}
.none{font-weight:bold;font-size:0.77em;font-style:normal;text-decoration:none}
.none1{font-style:italic;font-size:0.77em;font-weight:normal;text-decoration:none}
.none2{font-style:italic;font-size:1.2em;line-height:1.2;text-decoration:none}
.none3{font-size:0.77em;font-style:normal;font-weight:normal;text-decoration:none}
.none4{font-size:1.2em;line-height:1.2;text-decoration:none}
.s{display:block;margin:0.5em 0;padding:0;text-align:center}
.s1{display:block;margin:0.5em 0;padding:0;text-align:left;text-indent:1.5em}
.epub-cover-image-container{text-align:center;page-break-after:always}
.epub-cover-image-container img{max-height:95vh;width:auto;display:block;margin:1em auto}
.toc-page{padding:1em}
.toc-list{list-style-type:none;padding-left:0;margin:0}
.toc-list li{margin:0.5em 0;padding:0}
.toc-list a{text-decoration:none}`;
  packer.addStylesheet(stylesheet);

  if (options.coverImageUrl) {
    try {
      const rawBlob = await HttpClient.fetchBlob(options.coverImageUrl);
      await packer.addCoverImage(rawBlob, "cover.png", rawBlob.type);
      progressCallback(5, "Cover image processed.");
    } catch (e) {
      console.warn("Cover image error:", e);
      progressCallback(0, "Cover image skipped (error).");
    }
  }

  if (selectedPostStubs.length > 0) {
    progressCallback(
      10,
      `Preparing for bulk fetch (${selectedPostStubs.length} posts) with filters...`
    );
    try {
      await parser.prepareForBulkFetch(selectedPostStubs, {
        customQ: options.customQ,
        tagFilter: options.tagFilter
      });
      progressCallback(15, "Bulk fetch preparation complete.");
    } catch (error) {
      console.error("Error during bulk fetch preparation phase:", error);
      progressCallback(
        10,
        `Bulk fetch prep failed (individual fetches will be used): ${error.message.substring(0, 50)}`
      );
    }
  }

  const numPosts = selectedPostStubs.length;
  const processedPosts = [];
  
  for (let i = 0; i < numPosts; i++) {
    const stub = selectedPostStubs[i];
    const postProgress = 15 + ((i / numPosts) * 70);
    progressCallback(
      postProgress,
      `Processing post ${i + 1}/${numPosts}: ${stub.title.substring(0, 30)}…`
    );

    const post = await parser.fetchPostFullData(stub.id);
    if (!post) {
      console.warn(`Skipping post ${stub.id}: No data available.`);
      continue;
    }

    const { updatedHtml, imagesToPackage } =
      await parser.processPostImagesAndContent(post);

    for (const imgInfo of imagesToPackage) {
      await packer.addImageToManifest(imgInfo);
    }

    // Store processed post info for ToC
    processedPosts.push({
      title: post.title || "Untitled Post",
      id: stub.id
    });

    // Generate chapter ID and filename based on title
    const baseStrict = sanitizeBasenameForXhtmlStrict(post.title || `Chapter_${i}`);
    const chapterId = `ch-${baseStrict}`;
    packer.addChapter(post.title || "Untitled Post", updatedHtml, chapterId);
  }

  // Add ToC page at the beginning
  if (processedPosts.length > 0) {
    packer.addTableOfContents(processedPosts);
  }

  progressCallback(90, "Building EPUB structure...");
  const epubBlob = await packer.packToBlob();
  progressCallback(100, "EPUB generated – download started!");
  const fileName = sanitizeFilename(
    options.fileName || `${displayName}.epub`
  );
  saveAs(epubBlob, fileName);
}

// EPUB PACKER – builds the ZIP structure, OPF, NCX, etc.
class EpubPacker {
  constructor(metadata) {
    if (typeof JSZip === "undefined") {
      throw new Error(
        "JSZip library not found. Make sure jszip.min.js is loaded."
      );
    }

    this.zip = new JSZip();
    this.zip.file("mimetype", "application/epub+zip", {
      compression: "STORE"
    });

    this.metadata = {
      language: "en",
      epubVersion: "3.0",
      ...metadata
    };
    this.oebps = this.zip.folder("OEBPS");
    this.textFolder = this.oebps.folder("Text");
    this.imagesFolder = this.oebps.folder("Images");
    this.stylesFolder = this.oebps.folder("Styles");

    this.manifestItems = [];
    this.spineOrder = [];
    this.tocEntries = [];
    this.fileCounter = 0;
    this.imageIdCounter = 0; // Counter for unique image IDs
    this.usedImageIds = new Set(); // Track used image IDs to avoid duplicates
    this.usedImagePaths = new Set(); // Track used image paths to avoid duplicates
  }

  addContainerXml() {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0"
  xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf"
      media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
    this.zip.folder("META-INF").file("container.xml", xml);
  }

  addStylesheet(content, fileName = "stylesheet.css") {
    this.stylesFolder.file(fileName, content);
    this.manifestItems.push({
      id: "css",
      href: `Styles/${fileName}`,
      mediaType: "text/css"
    });
  }

  async addCoverImage(imageBlob, fileNameInEpub, mimeType) {
    try {
      const pngBlob = await convertToPng(imageBlob);
      const pngName = fileNameInEpub.replace(/\.[^.]+$/, ".png");

      const imageId = "cover-image";
      const imagePath = `Images/${pngName}`;
      this.imagesFolder.file(pngName, pngBlob);
      this.manifestItems.push({
        id: imageId,
        href: imagePath,
        mediaType: "image/png",
        properties: "cover-image"
      });
      this.metadata.coverImageId = imageId;

      const coverXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops"
      xml:lang="${this.metadata.language}"
      lang="${this.metadata.language}">
<head>
  <title>Cover</title>
  <link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/>
</head>
<body>
  <div style="text-align:center;padding:0;margin:0;">
    <img src="../${imagePath}"
         alt="${escapeXml(this.metadata.title)} Cover"
         style="max-width:100%;max-height:100vh;height:auto;"/>
  </div>
</body>
</html>`;
      this.textFolder.file("cover.xhtml", coverXhtml);
      this.manifestItems.push({
        id: "cover-xhtml",
        href: "Text/cover.xhtml",
        mediaType: "application/xhtml+xml"
      });
      this.spineOrder.unshift("cover-xhtml");
    } catch (error) {
      console.error("Error adding cover image:", error);
      throw error;
    }
  }

  addTableOfContents(posts) {
    if (!posts || posts.length === 0) return;

    const tocHtml = posts.map((post, index) => {
      // Find the matching chapter file name
      const baseStrict = sanitizeBasenameForXhtmlStrict(post.title);
      const chapterFileName = `${baseStrict}.xhtml`;
      return `
          <li>
            <a href="${chapterFileName}">${escapeXml(post.title)}</a>
          </li>
        `;
    }).join("");

    const tocXhtml = `<?xml version="1.0" encoding="UTF-8"?>
  <html xmlns="http://www.w3.org/1999/xhtml"
        xmlns:epub="http://www.idpf.org/2007/ops"
        xml:lang="${this.metadata.language}"
        lang="${this.metadata.language}">
  <head>
    <title>Table of Contents</title>
    <link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/>
  </head>
  <body class="toc-page">
    <nav epub:type="toc" id="toc">
      <h1>Table of Contents</h1>
      <ol class="toc-list">
        ${tocHtml}
      </ol>
    </nav>
  </body>
  </html>`;

    this.textFolder.file("toc.xhtml", tocXhtml);
    this.manifestItems.push({
      id: "toc",
      href: "Text/toc.xhtml",
      mediaType: "application/xhtml+xml",
      properties: "nav"
    });
    
    // Make sure ToC is in the spine after cover if it exists, otherwise at the beginning
    if (!this.spineOrder.includes("toc")) {
      if (this.spineOrder.includes("cover-xhtml")) {
        const coverIndex = this.spineOrder.indexOf("cover-xhtml");
        this.spineOrder.splice(coverIndex + 1, 0, "toc");
      } else {
        this.spineOrder.unshift("toc");
      }
    }
    
    // Reorder spine to ensure correct order: cover, toc, chapters in order
    const chapters = [];
    const nonChapters = [];
    
    this.spineOrder.forEach(id => {
      if (id.startsWith("ch-")) {
        chapters.push(id);
      } else {
        nonChapters.push(id);
      }
    });
    
    // Sort chapters by their order in the posts array
    const sortedChapters = [];
    posts.forEach((post, index) => {
      const baseStrict = sanitizeBasenameForXhtmlStrict(post.title);
      const chapterId = `ch-${baseStrict}`;
      if (chapters.includes(chapterId)) {
        sortedChapters.push(chapterId);
      }
    });
    
    // Rebuild spine in correct order
    this.spineOrder = [...nonChapters, ...sortedChapters];
    
    // Update ToC entries to match the new order
    this.tocEntries = [];
    posts.forEach((post, index) => {
      const baseStrict = sanitizeBasenameForXhtmlStrict(post.title);
      const chapterFileName = `${baseStrict}.xhtml`;
      this.tocEntries.push({
        rawTitle: post.title,
        href: `Text/${chapterFileName}`
      });
    });
  }

  addChapter(title, htmlContent, chapterId) {
    this.fileCounter++;
    
    const baseStrict = sanitizeBasenameForXhtmlStrict(
      title || `Chapter_${this.fileCounter}`
    );
    
    const fileName = `${baseStrict}.xhtml`;
    const pathInEpub = `Text/${fileName}`;

    const safeTitle = escapeXml(title || "Untitled");
    const safeBody = sanitizeHtmlContent(htmlContent);

    const chapterXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops"
      xml:lang="${this.metadata.language}"
      lang="${this.metadata.language}">
<head>
  <title>${safeTitle}</title>
  <link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/>
</head>
<body>
  <h1>${safeTitle}</h1>
  ${safeBody}
</body>
</html>`;
    this.textFolder.file(fileName, chapterXhtml);

    this.manifestItems.push({
      id: chapterId,
      href: pathInEpub,
      mediaType: "application/xhtml+xml"
    });
    
    // Insert after cover if it exists, otherwise after ToC if it exists, otherwise at the beginning
    if (this.spineOrder.includes("cover-xhtml")) {
      const coverIndex = this.spineOrder.indexOf("cover-xhtml");
      this.spineOrder.splice(coverIndex + 1, 0, chapterId);
    } else if (this.spineOrder.includes("toc")) {
      const tocIndex = this.spineOrder.indexOf("toc");
      this.spineOrder.splice(tocIndex + 1, 0, chapterId);
    } else {
      this.spineOrder.push(chapterId);
    }
  }

  async addImageToManifest(imageInfo) {
    try {
      const { blob, fileNameInEpub } = imageInfo;
      
      // Skip if this image path is already used
      if (this.usedImagePaths.has(fileNameInEpub)) {
        console.warn(`Skipping duplicate image: ${fileNameInEpub}`);
        return;
      }
      
      this.usedImagePaths.add(fileNameInEpub);
      
      // Create a unique ID for this image
      let imageId = `img-${this.imageIdCounter++}`;
      
      // Ensure the ID is unique
      while (this.usedImageIds.has(imageId)) {
        imageId = `img-${this.imageIdCounter++}`;
      }
      
      this.usedImageIds.add(imageId);
      
      this.imagesFolder.file(fileNameInEpub, blob);
      this.manifestItems.push({
        id: imageId,
        href: `Images/${fileNameInEpub}`,
        mediaType: "image/png"
      });
    } catch (error) {
      console.error("Error adding image to manifest:", error);
      // Continue processing even if one image fails
    }
  }

  buildContentOpf() {
    const dc = "http://purl.org/dc/elements/1.1/";
    const opfNs = "http://www.idpf.org/2007/opf";
    const modified = new Date()
      .toISOString()
      .substring(0, 19) + "Z";

    const manifestXml = this.manifestItems
      .map(
        (it) =>
          `<item id="${it.id}" href="${it.href}" media-type="${it.mediaType}"${
            it.properties ? ` properties="${it.properties}"` : ""
          }/>`
      )
      .join("\n    ");

    const spineXml = this.spineOrder
      .map((idref) => `<itemref idref="${idref}"/>`)
      .join("\n    ");

    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="${opfNs}" unique-identifier="BookId" version="${this.metadata.epubVersion}">
  <metadata xmlns:dc="${dc}" xmlns:opf="${opfNs}">
    <dc:title>${escapeXml(this.metadata.title)}</dc:title>
    <dc:creator id="author">${escapeXml(this.metadata.author)}</dc:creator>
    <meta refines="#author" property="role" scheme="marc:relators">aut</meta>
    <dc:language>${escapeXml(this.metadata.language)}</dc:language>
    <dc:identifier id="BookId">${escapeXml(this.metadata.uuid)}</dc:identifier>
    <meta property="dcterms:modified">${modified}</meta>
    ${this.metadata.coverImageId ? `<meta name="cover" content="${this.metadata.coverImageId}"/>` : ""}
  </metadata>
  <manifest>
    ${manifestXml}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    ${spineXml}
  </spine>
</package>`;
  }

  buildTocNcx() {
    const navPoints = this.tocEntries
      .map(
        (e, i) => `
    <ns:navPoint id="navpoint-${i + 1}" playOrder="${i + 1}">
      <ns:navLabel><ns:text>${escapeXml(e.rawTitle)}</ns:text></ns:navLabel>
      <ns:content src="${e.href}"/>
    </ns:navPoint>`
      )
      .join("");

    return `<?xml version="1.0" encoding="UTF-8"?>
<ns:ncx xmlns:ns="http://www.daisy.org/z3986/2005/ncx/"
        version="2005-1"
        xml:lang="${escapeXml(this.metadata.language)}">
  <ns:head>
    <ns:meta name="dtb:uid" content="${escapeXml(this.metadata.uuid)}"/>
    <ns:meta name="dtb:depth" content="1"/>
    <ns:meta name="dtb:totalPageCount" content="0"/>
    <ns:meta name="dtb:maxPageNumber" content="0"/>
  </ns:head>
  <ns:docTitle><ns:text>${escapeXml(this.metadata.title)}</ns:text></ns:docTitle>
  <ns:navMap>
    ${navPoints}
  </ns:navMap>
</ns:ncx>`.trimStart();
  }

  async packToBlob() {
    this.addContainerXml();
    this.oebps.file("content.opf", this.buildContentOpf());
    this.oebps.file("toc.ncx", this.buildTocNcx());
    return this.zip.generateAsync({
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
  }
}


