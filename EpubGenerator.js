const POSTS_PER_PAGE_FOR_LIST = 50;
const API_CALL_DELAY = 500;
const ASSET_FETCH_TIMEOUT_MS = 45_000;
const MAX_SINGLE_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 250 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_POSTS_PER_EPUB = 5_000;
const MAX_TOTAL_CONTENT_CHARACTERS = 50_000_000;

const rateLimiters = new Map();

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Operation cancelled.", "AbortError");
  }
}

function requestSignal(externalSignal, timeoutMs = ASSET_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(
    externalSignal.reason instanceof Error
      ? externalSignal.reason
      : new DOMException("Operation cancelled.", "AbortError")
  );
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out.", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}

async function fetchWithTimeout(url, options = {}, externalSignal) {
  const request = requestSignal(externalSignal);
  try {
    return await fetch(url, { ...options, signal: request.signal });
  } catch (error) {
    if (request.didTimeOut()) {
      throw new Error(`Request timed out after ${ASSET_FETCH_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  } finally {
    request.cleanup();
  }
}

function saveBlobAs(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
}

async function ensureApiRateLimit(siteKey, signal) {
  throwIfAborted(signal);
  const state = rateLimiters.get(siteKey) || { queue: Promise.resolve(), lastCall: 0 };
  const nextCall = state.queue.then(async () => {
    throwIfAborted(signal);
    const now = Date.now();
    const timeSinceLast = now - state.lastCall;
    if (timeSinceLast < API_CALL_DELAY) {
      await new Promise(r => setTimeout(r, API_CALL_DELAY - timeSinceLast));
    }
    throwIfAborted(signal);
    state.lastCall = Date.now();
  });
  state.queue = nextCall.catch(() => {});
  rateLimiters.set(siteKey, state);
  return nextCall;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const HttpClient = {
  async fetchJson(siteKey, url, { signal } = {}) {
    const site = ExtensionSites.get(siteKey);
    await ensureApiRateLimit(siteKey, signal);
    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: site.apiAccept } },
      signal
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "Failed to read error response.");
      throw new HttpError(
        res.status,
        `${site.name} API request failed: ${res.status} - ${txt.substring(0, 200)}`
      );
    }
    return res.json();
  },

  async fetchBlob(siteKey, url, { signal } = {}) {
    await ensureApiRateLimit(siteKey, signal);
    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: "image/*,*/*;q=0.8" } },
      signal
    );
    if (!res.ok) {
      throw new Error(`Asset request failed: ${res.status}`);
    }
    const declaredSize = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_SINGLE_ASSET_BYTES) {
      await res.body?.cancel();
      throw new Error(`Asset exceeds the ${MAX_SINGLE_ASSET_BYTES / 1024 / 1024} MiB limit.`);
    }
    const blob = await res.blob();
    if (blob.size > MAX_SINGLE_ASSET_BYTES) {
      throw new Error(`Asset exceeds the ${MAX_SINGLE_ASSET_BYTES / 1024 / 1024} MiB limit.`);
    }
    return blob;
  }
};

async function fetchPostPageData(
  siteKey,
  service,
  creatorId,
  offset,
  { q, tag, signal } = {}
) {
  const urls = ExtensionSites.postListUrls(siteKey, service, creatorId, { offset, q, tag });
  try {
    return await HttpClient.fetchJson(siteKey, urls[0], { signal });
  } catch (error) {
    const mayUseAlternate =
      error?.name !== "AbortError" &&
      (
        !(error instanceof HttpError) ||
        error.status === 404 ||
        error.status === 405 ||
        error.status >= 500
      );
    if (
      siteKey === "pawchive" &&
      urls[1] &&
      mayUseAlternate
    ) {
      return HttpClient.fetchJson(siteKey, urls[1], { signal });
    }
    throw error;
  }
}

function unwrapTags(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.tags) ? data.tags : [];
}

function isCompletePost(siteKey, post) {
  if (!post || typeof post !== "object" || !Object.hasOwn(post, "content")) return false;
  if (siteKey === "pawchive" && post.has_full === false && post.detail_fetched === false) {
    return false;
  }
  return true;
}

export async function fetchTagsList(siteKey, service, creatorId, { signal } = {}) {
  const site = ExtensionSites.get(siteKey);
  if (!site.supportsTags) return [];
  const url = `${site.apiOrigin}${ExtensionSites.creatorPath(service, creatorId)}/tags`;
  try {
    const tags = unwrapTags(await HttpClient.fetchJson(siteKey, url, { signal }));
    return tags.filter(t => t.tag && Number(t.post_count) > 0);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.warn(`Failed to fetch ${site.name} tags:`, error);
    return [];
  }
}

// FILENAME HELPERS
function truncateCodePoints(value, maxLength) {
  return Array.from(String(value || "")).slice(0, maxLength).join("");
}

export function sanitizeDownloadFilename(filename, fallback = "kemono-ebook.epub") {
  const source = typeof filename === "string" ? filename : "";
  let sanitized = source
    .replace(/[\u0000-\u001F\u007F\/\\?%*:|"<>]/g, "_")
    .replace(/__+/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!sanitized) sanitized = fallback;
  if (!/\.epub$/i.test(sanitized)) sanitized += ".epub";

  const extension = ".epub";
  let basename = sanitized.slice(0, -extension.length).replace(/[. ]+$/g, "");
  if (!basename) basename = "kemono-ebook";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(basename)) {
    basename = `_${basename}`;
  }
  basename = truncateCodePoints(basename, 200 - extension.length);
  return `${basename}${extension}`;
}

function sanitizeArchiveFilename(filename, fallback = "asset") {
  const sanitized = String(filename || "")
    .replace(/[\u0000-\u001F\u007F\/\\?%*:|"<>]/g, "_")
    .replace(/__+/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  return truncateCodePoints(sanitized || fallback, 160);
}

function sanitizeBasenameForXhtmlStrict(basename) {
  if (!basename) return "chapter";
  let name = String(basename);
  name = name.replace(/\s+/g, "_");
  name = name.replace(/[^A-Za-z0-9._-]/g, "_");
  name = name.replace(/_+/g, "_");
  name = name.replace(/^[._-]+|[._-]+$/g, "");
  if (!name) name = "chapter";
  return truncateCodePoints(name, 120);
}

// XML / HTML HELPERS
function escapeXml(str) {
  if (str == null) return "";
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, c => map[c]);
}

function isKnownHtmlTag(tagName) {
  if (typeof document === "undefined") return false;
  const element = document.createElement(tagName);
  return element.constructor.name !== "HTMLUnknownElement";
}

export function escapePawchiveUnknownTags(html, knownTagChecker = isKnownHtmlTag) {
  return String(html || "").replace(/<([^<>]+)>/g, (match, inner) => {
    const candidate = inner.trim();
    if (
      candidate.startsWith("!--") ||
      /^!doctype\b/i.test(candidate) ||
      candidate.startsWith("?")
    ) {
      return match;
    }

    const tag = candidate.match(/^\/?\s*([A-Za-z][\w:-]*)/);
    if (tag && knownTagChecker(tag[1])) return match;
    return `&lt;${inner}&gt;`;
  });
}

const EPUB_ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote",
  "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details",
  "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1",
  "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins",
  "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt",
  "ruby", "s", "samp", "section", "small", "span", "strong", "sub", "summary",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u",
  "ul", "var", "wbr"
]);
const EPUB_REMOVE_WITH_CONTENT = new Set([
  "base", "canvas", "embed", "iframe", "link", "math", "meta", "object",
  "script", "style", "svg", "template"
]);
const EPUB_GLOBAL_ATTRIBUTES = new Set(["class", "dir", "id", "lang", "title"]);
const EPUB_TAG_ATTRIBUTES = {
  a: new Set(["href"]),
  blockquote: new Set(["cite"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  del: new Set(["cite", "datetime"]),
  img: new Set(["alt", "height", "src", "title", "width"]),
  ins: new Set(["cite", "datetime"]),
  ol: new Set(["reversed", "start", "type"]),
  q: new Set(["cite"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["abbr", "colspan", "rowspan", "scope"]),
  time: new Set(["datetime"])
};

function unwrapElement(element) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  element.remove();
}

function sanitizeLink(value, siteOrigin, { image = false } = {}) {
  const source = String(value || "").trim();
  if (!source) return null;
  if (!image && source.startsWith("#")) return source;
  try {
    const url = new URL(source, `${siteOrigin}/`);
    if (image) {
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    }
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function sanitizePostDocument(doc, siteKey) {
  const site = ExtensionSites.get(siteKey);
  const comments = [];
  const commentWalker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  while (commentWalker.nextNode()) comments.push(commentWalker.currentNode);
  comments.forEach(comment => comment.remove());

  const elements = Array.from(doc.body.querySelectorAll("*"));
  for (const element of elements) {
    if (!element.parentNode) continue;
    const tag = element.localName.toLowerCase();

    if (EPUB_REMOVE_WITH_CONTENT.has(tag)) {
      element.remove();
      continue;
    }
    if (!EPUB_ALLOWED_TAGS.has(tag)) {
      unwrapElement(element);
      continue;
    }

    const tagAttributes = EPUB_TAG_ATTRIBUTES[tag] || new Set();
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const allowed =
        EPUB_GLOBAL_ATTRIBUTES.has(name) ||
        tagAttributes.has(name) ||
        name.startsWith("aria-");
      if (!allowed || name.startsWith("on") || name === "style") {
        element.removeAttribute(attribute.name);
      }
    }

    if (tag === "a" && element.hasAttribute("href")) {
      const safeHref = sanitizeLink(element.getAttribute("href"), site.siteOrigin);
      if (safeHref) element.setAttribute("href", safeHref);
      else element.removeAttribute("href");
    }
    if (tag === "img") {
      const safeSrc = sanitizeLink(
        element.getAttribute("src"),
        site.siteOrigin,
        { image: true }
      );
      element.removeAttribute("srcset");
      if (safeSrc) element.setAttribute("src", safeSrc);
      else element.removeAttribute("src");
    }
  }
  return doc;
}

export function buildPawchiveAttachmentUrl(path) {
  const source = String(path || "").trim();
  if (!source) return null;

  try {
    if (/^https?:\/\//i.test(source)) {
      const url = new URL(source);
      if (
        url.hostname === "img.pawchive.pw" &&
        url.pathname.startsWith("/thumbnail/data/")
      ) {
        url.hostname = "file.pawchive.pw";
        url.pathname = url.pathname.replace(/^\/thumbnail/, "");
      } else if (url.hostname === "pawchive.pw" && url.pathname.startsWith("/data/")) {
        url.hostname = "file.pawchive.pw";
      } else if (
        url.hostname !== "file.pawchive.pw" ||
        !url.pathname.startsWith("/data/")
      ) {
        return null;
      }
      url.hash = "";
      return url.href;
    }

    const normalizedPath = source
      .replace(/\\/g, "/")
      .replace(/^\/?data\//i, "/");
    return new URL(
      `/data${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`,
      "https://file.pawchive.pw"
    ).href;
  } catch {
    return null;
  }
}

export function isImageAttachment(attachment) {
  const candidate = String(attachment?.name || attachment?.path || "")
    .split(/[?#]/, 1)[0]
    .toLowerCase();
  return /\.(?:jpe?g|png|gif|webp|bmp|svg)$/.test(candidate);
}

// IMAGE PROCESSING
function getMimeType(blob, url) {
  if (blob.type && blob.type !== 'application/octet-stream') {
    return blob.type;
  }
  let pathname = String(url);
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = pathname.split(/[?#]/, 1)[0];
  }
  const ext = pathname.split('.').pop().toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

class AssetBudget {
  constructor(limit = MAX_TOTAL_ASSET_BYTES) {
    this.limit = limit;
    this.used = 0;
  }

  reserve(size) {
    if (!Number.isFinite(size) || size < 0) return;
    if (this.used + size > this.limit) {
      throw new Error(
        `EPUB assets exceed the ${Math.round(this.limit / 1024 / 1024)} MiB total limit.`
      );
    }
    this.used += size;
  }
}

async function processImageBlob(blob, url, signal) {
  throwIfAborted(signal);
  const mime = getMimeType(blob, url);
  const bitmap = await createImageBitmap(blob);
  throwIfAborted(signal);
  const pixelCount = bitmap.width * bitmap.height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_IMAGE_PIXELS) {
    bitmap.close?.();
    throw new Error(
      `Image exceeds the ${MAX_IMAGE_PIXELS.toLocaleString()} pixel limit.`
    );
  }

  if (['image/jpeg', 'image/png', 'image/gif'].includes(mime)) {
    bitmap.close?.();
    return { blob, mimeType: mime, extension: mime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg') };
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("Could not create an image conversion canvas.");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const pngBlob = await canvas.convertToBlob({ type: "image/png" });
  throwIfAborted(signal);
  
  return { blob: pngBlob, mimeType: "image/png", extension: "png" };
}

// CONTENT PARSER
export class KemonoContentParser {
  constructor(siteKey, service, creatorId, progressReporter, {
    signal,
    assetBudget
  } = {}) {
    this.siteKey = siteKey;
    this.site = ExtensionSites.get(siteKey);
    this.service = service;
    this.creatorId = creatorId;
    this.reportProgress = progressReporter;
    this.signal = signal;
    this.assetBudget = assetBudget || new AssetBudget();
    this.postCache = new Map();
    this.domParser = new DOMParser(); 
    this.xmlSerializer = new XMLSerializer();
  }

  async fetchPostFullData(postId) {
    throwIfAborted(this.signal);
    postId = String(postId);
    if (this.postCache.has(postId)) {
      return this.postCache.get(postId);
    }
    try {
      this.reportProgress(`Fetching post details: ${postId.substring(0, 10)}…`);
      const url = `${this.site.apiOrigin}${ExtensionSites.creatorPath(this.service, this.creatorId)}/post/${encodeURIComponent(postId)}`;
      const data = await HttpClient.fetchJson(this.siteKey, url, {
        signal: this.signal
      });
      const postDetail = this.siteKey === "kemono" ? data?.post : data;
      if (!postDetail || !postDetail.id) {
        throw new Error(`Post data for ${postId} is malformed or missing.`);
      }
      this.postCache.set(postId, postDetail); 
      return postDetail;
    } catch (error) {
      console.error(`Error fetching post ${postId}:`, error);
      this.reportProgress(`Error fetching post ${postId}…`);
      throw error;
    }
  }

  async prepareForBulkFetch(selectedPostStubs, { customQ, tagFilter } = {}) {
    if (!selectedPostStubs || selectedPostStubs.length === 0) return;

    const query = tagFilter
      ? { tag: tagFilter }
      : customQ && customQ.length >= 3
        ? { q: customQ }
        : this.siteKey === "kemono"
          ? { q: "<p>" }
          : {};

    const offsetsToFetch = new Set();
    for (const stub of selectedPostStubs) {
      if (stub.originalOffset !== undefined) {
        offsetsToFetch.add(stub.originalOffset);
        const prevOffset = stub.originalOffset - POSTS_PER_PAGE_FOR_LIST;
        if (prevOffset >= 0) offsetsToFetch.add(prevOffset);
      }
    }

    if (offsetsToFetch.size === 0) return;
    const sortedOffsets = Array.from(offsetsToFetch).sort((a, b) => a - b);
    
    for (let i = 0; i < sortedOffsets.length; i++) {
      throwIfAborted(this.signal);
      const offset = sortedOffsets[i];
      try {
        this.reportProgress(`Bulk page ${i + 1}/${sortedOffsets.length} (offset ${offset})...`);
        const postsOnPage = await fetchPostPageData(
          this.siteKey,
          this.service,
          this.creatorId,
          offset,
          { ...query, signal: this.signal }
        );
        if (Array.isArray(postsOnPage)) {
          for (const fullPost of postsOnPage) {
            if (fullPost?.id && isCompletePost(this.siteKey, fullPost)) {
              this.postCache.set(String(fullPost.id), fullPost);
            }
          }
        }
      } catch (error) {
        console.error(`Bulk fetch failed for offset ${offset}:`, error);
      }
    }
  }

  async processPostImagesAndContent(postData) {
    throwIfAborted(this.signal);
    const rawHtml = postData.content || "";
    const imagesToPackage = [];
    const htmlForParsing = this.siteKey === "pawchive"
      ? escapePawchiveUnknownTags(rawHtml)
      : rawHtml;

    let doc = this.domParser.parseFromString(htmlForParsing, "text/html");
    doc.querySelectorAll(".ad-container").forEach(element => element.remove());
    doc = sanitizePostDocument(doc, this.siteKey);

    if (this.siteKey === "pawchive") {
      this._appendPawchiveAttachments(
        doc,
        postData.attachments,
        postData.file
      );
    }

    const packagedImageByUrl = new Map();
    const imgElements = Array.from(doc.querySelectorAll("img"));
    const replaceUnavailableImage = (img) => {
      const alt = img.getAttribute("alt") || "";
      const fallback = doc.createElement("span");
      fallback.className = "epub-image-unavailable";
      fallback.textContent = alt
        ? `[Image unavailable: ${alt}]`
        : "[Image unavailable]";
      img.replaceWith(fallback);
    };
    for (let i = 0; i < imgElements.length; i++) {
      throwIfAborted(this.signal);
      const img = imgElements[i];
      const originalSrc = img.getAttribute("src");
      if (!originalSrc) {
        replaceUnavailableImage(img);
        continue;
      }

      let absoluteSrc = this._normalizeUrl(originalSrc);
      if (!absoluteSrc) {
        replaceUnavailableImage(img);
        continue;
      }

      const existingImage = packagedImageByUrl.get(absoluteSrc);
      if (existingImage) {
        img.setAttribute("src", `../${existingImage.localPathInEpub}`);
        continue;
      }

      try {
        const rawBlob = await HttpClient.fetchBlob(this.siteKey, absoluteSrc, {
          signal: this.signal
        });
        this.assetBudget.reserve(rawBlob.size);
        const { blob, mimeType, extension } = await processImageBlob(
          rawBlob,
          absoluteSrc,
          this.signal
        );
        this.assetBudget.reserve(Math.max(0, blob.size - rawBlob.size));
        const fileNameInEpub = sanitizeArchiveFilename(
          `inline_${postData.id}_${i}.${extension}`
        );

        const imageInfo = {
          originalUrl: absoluteSrc,
          fileNameInEpub,
          localPathInEpub: `Images/${fileNameInEpub}`,
          blob,
          mimeType,
        };
        imagesToPackage.push(imageInfo);
        packagedImageByUrl.set(absoluteSrc, imageInfo);

        img.setAttribute("src", `../Images/${fileNameInEpub}`);
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        replaceUnavailableImage(img);
      }
    }

    doc = this._rewriteAllImageReferences(doc, imagesToPackage);

    let contentOut = "";
    for (let node of doc.body.childNodes) {
        contentOut += this.xmlSerializer.serializeToString(node);
    }
    
    if (!contentOut) contentOut = "";
    contentOut = contentOut.replace(/ xmlns="http:\/\/www.w3.org\/1999\/xhtml"/g, "");

    return { updatedHtml: contentOut, imagesToPackage };
  }

  _normalizeUrl(originalSrc) {
    return ExtensionSites.normalizeAssetUrl(this.siteKey, originalSrc);
  }

  _appendPawchiveAttachments(doc, attachments, primaryFile) {
    const candidates = [
      ...(primaryFile && typeof primaryFile === "object" ? [primaryFile] : []),
      ...(Array.isArray(attachments) ? attachments : [])
    ];
    const seenUrls = new Set();
    const validAttachments = candidates
      .map((attachment) => ({
        name: String(attachment?.name || "").trim(),
        url: buildPawchiveAttachmentUrl(attachment?.path)
      }))
      .filter((attachment) => {
        if (
          !attachment.name ||
          !attachment.url ||
          seenUrls.has(attachment.url)
        ) {
          return false;
        }
        seenUrls.add(attachment.url);
        return true;
      });

    if (validAttachments.length === 0) return;

    const section = doc.createElement("section");
    section.className = "epub-attachments";

    const heading = doc.createElement("h2");
    heading.textContent = "Attachments";
    section.appendChild(heading);

    let fileList = null;
    for (const attachment of validAttachments) {
      if (isImageAttachment(attachment)) {
        const figure = doc.createElement("figure");
        figure.className = "epub-attachment-image";

        const img = doc.createElement("img");
        img.src = attachment.url;
        img.alt = attachment.name;
        figure.appendChild(img);

        const caption = doc.createElement("figcaption");
        caption.textContent = attachment.name;
        figure.appendChild(caption);
        section.appendChild(figure);
      } else {
        if (!fileList) {
          fileList = doc.createElement("ul");
          fileList.className = "epub-attachment-files";
          section.appendChild(fileList);
        }

        const item = doc.createElement("li");
        const link = doc.createElement("a");
        link.href = attachment.url;
        link.textContent = attachment.name;
        item.appendChild(link);
        fileList.appendChild(item);
      }
    }

    doc.body.appendChild(section);
  }

  _rewriteAllImageReferences(doc, imagesToPackage) {
    const urlToLocalMap = new Map();
    imagesToPackage.forEach((imgInfo) => {
      const chapterPath = `../${imgInfo.localPathInEpub}`;
      urlToLocalMap.set(imgInfo.originalUrl, chapterPath);
      try {
        const partialPath = new URL(imgInfo.originalUrl).pathname;
        if (partialPath) urlToLocalMap.set(partialPath, chapterPath);
      } catch {}
    });

    const rewriteAttr = (el, attr) => {
        const val = el.getAttribute(attr);
        if(!val) return;
        const absVal = this._normalizeUrl(val);
        if(!absVal) return; 

        if(urlToLocalMap.has(absVal)) el.setAttribute(attr, urlToLocalMap.get(absVal));
        else if(urlToLocalMap.has(val)) el.setAttribute(attr, urlToLocalMap.get(val));
    };

    doc.querySelectorAll("img").forEach(img => rewriteAttr(img, "src"));
    doc.querySelectorAll("a[href]").forEach(a => {
        rewriteAttr(a, "href");
        const href = a.getAttribute("href");
        if(href && href.startsWith("../Images/") && (a.textContent.includes("Download") || !a.textContent.trim())) {
            a.textContent = a.textContent.replace(/Download/i, "View") || "View Image";
        }
    });

    return doc;
  }
}

export async function fetchPostListPage(
  siteKey,
  service,
  creatorId,
  offset,
  { q, tag, signal } = {}
) {
  const data = await fetchPostPageData(siteKey, service, creatorId, offset, {
    q: q && q.length >= 3 ? q : "",
    tag,
    signal
  });
  if (!Array.isArray(data)) throw new Error("Invalid post-list response.");
  return {
    posts: data.map((p) => ({
      ...p,
      id: String(p.id),
      title: p.title || `Untitled Post ${p.id}`,
      published: p.published,
      originalOffset: offset,
      _epubComplete: isCompletePost(siteKey, p)
    }))
  };
}

export async function fetchCreatorProfile(siteKey, service, creatorId, { signal } = {}) {
  const site = ExtensionSites.get(siteKey);
  const profileUrl = `${site.apiOrigin}${ExtensionSites.creatorPath(service, creatorId)}/profile`;
  const profileData = await HttpClient.fetchJson(siteKey, profileUrl, { signal });
  if (!profileData || typeof profileData !== "object") {
    throw new Error(`${site.name} returned an invalid creator profile.`);
  }
  return {
    postCount: site.profileHasPostCount && Number.isFinite(Number(profileData.post_count))
      ? Number(profileData.post_count)
      : null,
    creatorName: profileData.name || ""
  };
}

export function parsePawchivePostCount(html) {
  const text = String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const match = text.match(/Showing\s+\d+\s*-\s*\d+\s+of\s+([\d,]+)/i);
  if (!match) return null;
  const count = Number(match[1].replace(/,/g, ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export async function fetchPawchivePostCount(service, creatorId, q = "", { signal } = {}) {
  const path = ExtensionSites.creatorPath(service, creatorId);
  const url = new URL(path, "https://pawchive.pw");
  if (q && q.length >= 3) url.searchParams.set("q", q);
  const response = await fetchWithTimeout(
    url,
    { headers: { Accept: "text/html,application/xhtml+xml" } },
    signal
  );
  if (!response.ok) throw new Error(`Pawchive count page failed: ${response.status}`);
  return parsePawchivePostCount(await response.text());
}

// MAIN GENERATOR
export async function generateKemonoEpub(
  creatorInfo,
  selectedPostStubs,
  options = {},
  progressCallback = () => {}
) {
  const signal = options.signal;
  throwIfAborted(signal);
  if (!Array.isArray(selectedPostStubs) || selectedPostStubs.length === 0) {
    throw new Error("No posts were selected.");
  }
  if (selectedPostStubs.length > MAX_POSTS_PER_EPUB) {
    throw new Error(
      `Select at most ${MAX_POSTS_PER_EPUB.toLocaleString()} posts per EPUB.`
    );
  }
  let ZipLib = globalThis.JSZip;
  if (!ZipLib && globalThis.chrome?.runtime?.getURL) {
    await import(chrome.runtime.getURL("libs/jszip.min.js"));
    ZipLib = globalThis.JSZip;
  }
  if (!ZipLib) throw new Error("JSZip library not found.");
  const SaverLib = options.saveAs || saveBlobAs;

  const parserProgress = (msg) => progressCallback(-1, msg);
  const assetBudget = new AssetBudget();
  const parser = new KemonoContentParser(
    creatorInfo.site,
    creatorInfo.service,
    creatorInfo.creatorId,
    parserProgress,
    { signal, assetBudget }
  );

  selectedPostStubs.forEach(stub => {
    if (stub._epubComplete || isCompletePost(creatorInfo.site, stub)) {
      parser.postCache.set(String(stub.id), stub);
    }
  });

  const displayName = (creatorInfo.creatorName || "Unknown").trim();
  const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const packer = new EpubPacker({
    title: displayName,
    author: displayName,
    uuid: `urn:uuid:${uuid}`,
    language: "und"
  }, ZipLib); 

  packer.addStylesheet(`
.epub-cover-image-container { text-align: center; }
img { max-width: 100%; height: auto; }
.epub-attachments { margin-top: 2em; }
.epub-attachment-image { margin: 1.5em 0; text-align: center; }
.epub-attachment-image figcaption { margin-top: 0.35em; font-size: 0.9em; }
.epub-attachment-files { padding-left: 1.5em; }
.epub-image-unavailable { font-style: italic; color: #666; }
`);

  if (options.coverImageUrl) {
    try {
      const rawBlob = await HttpClient.fetchBlob(
        creatorInfo.site,
        options.coverImageUrl,
        { signal }
      );
      assetBudget.reserve(rawBlob.size);
      const { blob, mimeType, extension } = await processImageBlob(
        rawBlob,
        options.coverImageUrl,
        signal
      );
      assetBudget.reserve(Math.max(0, blob.size - rawBlob.size));
      await packer.addCoverImage(blob, `cover.${extension}`, mimeType);
      progressCallback(5, "Cover image processed.");
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      console.warn("Cover image error:", e);
    }
  }

  const postsNeedingFetch = selectedPostStubs.filter(
    (stub) => !parser.postCache.has(String(stub.id))
  );
  if (postsNeedingFetch.length > 0) {
    progressCallback(10, `Preparing for bulk fetch (${postsNeedingFetch.length} posts)...`);
    try {
      await parser.prepareForBulkFetch(postsNeedingFetch, {
        customQ: options.customQ,
        tagFilter: options.tagFilter
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      console.error("Bulk fetch prep failed:", error);
    }
  }

  const numPosts = selectedPostStubs.length;
  const processedPosts = [];
  const skippedPosts = [];
  let totalContentCharacters = 0;
  const updateFrequency = Math.min(50, Math.max(10, Math.floor(numPosts / 100)));
  
  // TRACKER FOR FILENAME UNIQUENESS
  // Set contains lowercase versions of all filenames used so far
  const usedFilenames = new Set();

  for (let i = 0; i < numPosts; i++) {
    throwIfAborted(signal);
    if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      throwIfAborted(signal);
    }

    const stub = selectedPostStubs[i];

    if (i === 0 || i === numPosts - 1 || i % updateFrequency === 0) {
      const percent = 15 + ((i / numPosts) * 70);
      progressCallback(
        percent,
        `Processing: ${i + 1}/${numPosts} - ${String(stub.title || "Untitled").substring(0, 20)}…`
      );
    }

    let post;
    try {
      post = await parser.fetchPostFullData(stub.id);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      skippedPosts.push({
        id: String(stub.id),
        title: stub.title || `Post ${stub.id}`,
        error: error.message
      });
      continue;
    }
    totalContentCharacters += String(post.content || "").length;
    if (totalContentCharacters > MAX_TOTAL_CONTENT_CHARACTERS) {
      throw new Error(
        `Post content exceeds the ${MAX_TOTAL_CONTENT_CHARACTERS.toLocaleString()} character EPUB limit.`
      );
    }

    let processedPost;
    try {
      processedPost = await parser.processPostImagesAndContent(post);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      skippedPosts.push({
        id: String(stub.id),
        title: stub.title || `Post ${stub.id}`,
        error: error.message
      });
      continue;
    }
    const { updatedHtml, imagesToPackage } = processedPost;

    for (const imgInfo of imagesToPackage) {
      await packer.addImageToManifest(imgInfo);
    }

    // --- ROBUST FILENAME GENERATION START ---
    let baseStrict = sanitizeBasenameForXhtmlStrict(post.title || `Chapter_${i}`);
    let candidate = baseStrict;
    let counter = 1;
    
    // Check against lowercase set to ensure case-insensitive uniqueness
    while (usedFilenames.has(candidate.toLowerCase())) {
        const suffix = counter.toString().padStart(2, '0');
        candidate = `${baseStrict}_${suffix}`;
        counter++;
    }
    
    baseStrict = candidate;
    usedFilenames.add(baseStrict.toLowerCase());
    // --- ROBUST FILENAME GENERATION END ---
    
    processedPosts.push({ 
        title: post.title || "Untitled Post", 
        id: stub.id,
        filename: baseStrict 
    });

    packer.addChapter(post.title || "Untitled Post", updatedHtml, `ch-${baseStrict}`);
  }

  if (processedPosts.length === 0) {
    throw new Error("None of the selected posts could be fetched.");
  }
  packer.addTableOfContents(processedPosts);

  progressCallback(90, "Building EPUB structure...");
  await new Promise(r => setTimeout(r, 50)); 
  throwIfAborted(signal);
  
  const epubBlob = await packer.packToBlob(signal);
  throwIfAborted(signal);
  progressCallback(100, "EPUB generated – download started!");
  const fileName = sanitizeDownloadFilename(
    options.fileName || `${displayName}.epub`
  );
  
  SaverLib(epubBlob, fileName);
  return { processedCount: processedPosts.length, skippedPosts };
}

// EPUB PACKER
class EpubPacker {
  constructor(metadata, JSZipClass) {
    this.zip = new JSZipClass();
    this.zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    this.metadata = { language: "und", epubVersion: "3.0", ...metadata };
    this.oebps = this.zip.folder("OEBPS");
    this.textFolder = this.oebps.folder("Text");
    this.imagesFolder = null;
    this.stylesFolder = this.oebps.folder("Styles");
    this.manifestItems = [];
    this.spineOrder = [];
    this.tocEntries = [];
    this.fileCounter = 0;
    this.imageIdCounter = 0; 
    this.usedImageIds = new Set();
    this.usedImagePaths = new Set();
  }

  getImagesFolder() {
    if (!this.imagesFolder) this.imagesFolder = this.oebps.folder("Images");
    return this.imagesFolder;
  }

  addStylesheet(content) {
      this.stylesFolder.file("stylesheet.css", content);
      this.manifestItems.push({ id: "css", href: "Styles/stylesheet.css", mediaType: "text/css" });
  }

  addCoverImage(imageBlob, fileNameInEpub, mimeType) {
    const imageId = "cover-image";
    const imagePath = `Images/${fileNameInEpub}`;
    this.getImagesFolder().file(fileNameInEpub, imageBlob);
    this.manifestItems.push({
      id: imageId,
      href: imagePath,
      mediaType: mimeType,
      properties: "cover-image"
    });
    this.metadata.coverImageId = imageId;
    const coverXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Cover</title><link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/></head>
<body><div class="epub-cover-image-container"><img src="../${imagePath}" alt="Cover"/></div></body></html>`;
    this.textFolder.file("cover.xhtml", coverXhtml);
    this.manifestItems.push({id: "cover-xhtml", href: "Text/cover.xhtml", mediaType: "application/xhtml+xml"});
    this.spineOrder.unshift("cover-xhtml");
  }

  addImageToManifest(imageInfo) {
    const { blob, fileNameInEpub, mimeType } = imageInfo;
    if (this.usedImagePaths.has(fileNameInEpub)) return;
    this.usedImagePaths.add(fileNameInEpub);
    
    let imageId = `img-${this.imageIdCounter++}`;
    while (this.usedImageIds.has(imageId)) imageId = `img-${this.imageIdCounter++}`;
    this.usedImageIds.add(imageId);
    
    this.getImagesFolder().file(fileNameInEpub, blob);
    this.manifestItems.push({ id: imageId, href: `Images/${fileNameInEpub}`, mediaType: mimeType });
  }

  addContainerXml(){
      this.zip.folder("META-INF").file("container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  }

  addChapter(title, htmlContent, chapterId) {
      this.fileCounter++;
      const fileName = `${chapterId.replace(/^ch-/, "")}.xhtml`;
      const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/></head>
<body><h1>${escapeXml(title)}</h1>${htmlContent}</body></html>`;
      this.textFolder.file(fileName, xhtml);
      this.manifestItems.push({ id: chapterId, href: `Text/${fileName}`, mediaType: "application/xhtml+xml" });
      
      // FIX: Always push to the end of the array to preserve chronological order.
      // The TOC injection logic in addTableOfContents handles the correct ordering for the start of the book.
      this.spineOrder.push(chapterId);
  }

  addTableOfContents(posts) {
     const tocXhtml = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Table of Contents</title><link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/></head><body class="toc-page"><nav epub:type="toc" id="toc"><h1>Table of Contents</h1><ol class="toc-list">${posts.map(p=>`<li><a href="${p.filename}.xhtml">${escapeXml(p.title)}</a></li>`).join("")}</ol></nav></body></html>`;
     this.textFolder.file("toc.xhtml", tocXhtml);
     this.manifestItems.push({ id: "toc", href: "Text/toc.xhtml", mediaType: "application/xhtml+xml", properties: "nav" });
     if(this.spineOrder.includes("cover-xhtml")) this.spineOrder.splice(this.spineOrder.indexOf("cover-xhtml")+1, 0, "toc");
     else this.spineOrder.unshift("toc");
     
     this.tocEntries = posts.map(p => ({ rawTitle: p.title, href: `Text/${p.filename}.xhtml` }));
  }

  buildContentOpf() {
      const now = new Date().toISOString().substring(0, 19) + "Z";
      return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(this.metadata.title)}</dc:title>
<dc:creator id="author">${escapeXml(this.metadata.author)}</dc:creator>
<dc:language>${this.metadata.language}</dc:language>
<dc:identifier id="BookId">${this.metadata.uuid}</dc:identifier>
<meta property="dcterms:modified">${now}</meta>
${this.metadata.coverImageId ? `<meta name="cover" content="${this.metadata.coverImageId}"/>` : ""}
</metadata>
<manifest>${this.manifestItems.map(i => `<item id="${i.id}" href="${i.href}" media-type="${i.mediaType}"${i.properties?` properties="${i.properties}"`:""}/>`).join("\n")}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>
<spine toc="ncx">${this.spineOrder.map(id => `<itemref idref="${id}"/>`).join("\n")}</spine>
</package>`;
  }

  async packToBlob(signal) {
    this.addContainerXml();
    this.oebps.file("content.opf", this.buildContentOpf());
    this.oebps.file("toc.ncx", `<?xml version="1.0" encoding="UTF-8"?><ns:ncx xmlns:ns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><ns:head><ns:meta name="dtb:uid" content="${this.metadata.uuid}"/></ns:head><ns:docTitle><ns:text>${escapeXml(this.metadata.title)}</ns:text></ns:docTitle><ns:navMap>${this.tocEntries.map((e,i)=>`<ns:navPoint id="navpoint-${i+1}" playOrder="${i+1}"><ns:navLabel><ns:text>${escapeXml(e.rawTitle)}</ns:text></ns:navLabel><ns:content src="${e.href}"/></ns:navPoint>`).join("")}</ns:navMap></ns:ncx>`);
    
    return this.zip.generateAsync(
      {
        type: "blob",
        mimeType: "application/epub+zip",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      },
      () => throwIfAborted(signal)
    );
  }
}
