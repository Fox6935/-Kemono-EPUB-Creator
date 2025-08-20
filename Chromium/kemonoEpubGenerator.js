// kemonoEpubGenerator.js
// ---------------------------------------------------------------------
//  This file creates EPUB from Kemono posts.
// ---------------------------------------------------------------------

/* ------------------------------------------------------------------
// 1️⃣  CONFIGURATION
------------------------------------------------------------------- */
const KEMONO_API_BASE_URL = "https://kemono.cr/api/v1";
const KEMONO_SITE_BASE_URL = "https://kemono.cr";
const KEMONO_IMG_BASE_URL = "https://img.kemono.cr";
const KEMONO_DATA_BASE_URL = "https://kemono.cr/data";

const POSTS_PER_PAGE_FOR_LIST = 50;
const API_CALL_DELAY = 500;

/* ------------------------------------------------------------------
// 2️⃣  SIMPLE RATE‑LIMITER (500 ms between API calls)
// ------------------------------------------------------------------- */
let lastApiCallTime = 0;
async function ensureApiRateLimit() {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < API_CALL_DELAY) {
    await new Promise((r) => setTimeout(r, API_CALL_DELAY - elapsed));
  }
  lastApiCallTime = Date.now();
}

/* ------------------------------------------------------------------
// 3️⃣  HTTP HELPER – Kemono API requires `Accept: text/css`
// ------------------------------------------------------------------- */
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

/* ------------------------------------------------------------------
// 4️⃣  FILENAME HELPERS
------------------------------------------------------------------- */
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

/* ------------------------------------------------------------------
// 5️⃣  XML / HTML HELPERS (sanitise to well‑formed XHTML)
// ------------------------------------------------------------------- */
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

/* replace named entities that are not defined in XML */
function replaceUnsupportedEntities(html) {
  if (!html) return "";
  return html.replace(/&nbsp;/gi, "&#160;");
}

/* turn <br> into <br /> */
function normalizeXhtmlVoidTags(html) {
  if (!html) return "";
  return html.replace(/<br(\s*)>/gi, "<br />");
}

/* self‑close all HTML5 void elements – note the lack of a space before "/>" */
function selfCloseVoidElements(html) {
  if (!html) return "";
  const voidEls = [
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "keygen",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr"
  ];
  voidEls.forEach((tag) => {
    const re = new RegExp(`<${tag}([^>]*?)>(?!\\s*</${tag}>)`, "gi");
    html = html.replace(re, `<${tag}$1/>`);
  });
  // Fix stray "//>" that sometimes appears after img tags
  html = html.replace(/<img([^>]*?)\/\/>/gi, "<img$1/>");
  return html;
}

/* full sanitisation pipeline */
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

/* ------------------------------------------------------------------
// 6️⃣  MIME‑TYPE HELPER (covers the most common cases)
// ------------------------------------------------------------------- */
function mimeTypeFromExtension(ext) {
  ext = ext.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

/* ------------------------------------------------------------------
// 7️⃣  IMAGE CONVERSION – everything ends up as PNG (preserves transparency)
// ------------------------------------------------------------------- */
async function convertToPng(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const pngBlob = await canvas.convertToBlob({ type: "image/png" });
  return pngBlob;
}

/* ------------------------------------------------------------------
// 8️⃣  CONTENT PARSER – fetches a post, rewrites inline images, sanitises HTML
// ------------------------------------------------------------------- */
class KemonoContentParser {
  constructor(service, creatorId, progressReporter) {
    this.service = service;
    this.creatorId = creatorId;
    this.reportProgress = progressReporter;
    this.postCache = new Map();
  }

  async fetchPostFullData(postId) {
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
      this.postCache.set(postId, postDetail);
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

  async prepareForBulkFetch() {
    this.reportProgress(
      "Bulk fetching is no longer available with the new API. Posts will be fetched individually."
    );
  }

  /**
   * Parse raw HTML, download any inline images, rewrite <img> src to a
   * relative path inside the EPUB, then sanitise the HTML.
   */
  async processPostImagesAndContent(postData) {
    const rawHtml = postData.content || "";
    const imagesToPackage = [];

    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, "text/html");

    const imgElements = Array.from(doc.querySelectorAll("img"));
    for (let i = 0; i < imgElements.length; i++) {
      const img = imgElements[i];
      const originalSrc = img.getAttribute("src");
      if (!originalSrc) continue;

      let absoluteSrc = originalSrc;
      if (originalSrc.startsWith("//")) {
        absoluteSrc = `https:${originalSrc}`;
      } else if (originalSrc.startsWith("/")) {
        absoluteSrc = `${KEMONO_SITE_BASE_URL}${originalSrc}`;
      }

      try {
        this.reportProgress(
          `Fetching content image: ${originalSrc.substring(0, 30)}…`
        );
        let blob = await HttpClient.fetchBlob(absoluteSrc);
        // Convert **everything** to PNG
        blob = await convertToPng(blob);
        const mime = "image/png";
        const fileNameInEpub = sanitizeFilename(
          `content_${postData.id}_${i}.png`
        );

        imagesToPackage.push({
          originalUrl: absoluteSrc,
          fileNameInEpub,
          localPathInEpub: `Images/${fileNameInEpub}`,
          blob,
          mimeType: mime
        });

        img.setAttribute("src", `../Images/${fileNameInEpub}`);
      } catch (e) {
        console.warn(`Failed to fetch content image ${absoluteSrc}:`, e);
        const alt = img.getAttribute("alt") || "";
        img.setAttribute(
          "alt",
          `${alt} (Image not available: ${originalSrc})`
        );
      }
    }

    const contentOut = doc.body.innerHTML;
    const xhtmlSafe = sanitizeHtmlContent(contentOut);
    return { updatedHtml: xhtmlSafe, imagesToPackage };
  }
}

/* ------------------------------------------------------------------
// 9️⃣  EPUB PACKER – builds the ZIP structure, OPF, NCX, etc.
// ------------------------------------------------------------------- */
class EpubPacker {
  constructor(metadata) {
    if (typeof JSZip === "undefined") {
      throw new Error(
        "JSZip library not found. Make sure jszip.min.js is loaded."
      );
    }

    // -------------------------------------------------------------
    // 1️⃣  MIMETYPE – first entry, stored (no compression)
    // -------------------------------------------------------------
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
    this.tocEntries = []; // { rawTitle, href }
    this.fileCounter = 0;
  }

  // -----------------------------------------------------------------
  // Container XML (META‑INF/container.xml)
  // -----------------------------------------------------------------
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

  // -----------------------------------------------------------------
  // Stylesheet
  // -----------------------------------------------------------------
  addStylesheet(content, fileName = "stylesheet.css") {
    this.stylesFolder.file(fileName, content);
    this.manifestItems.push({
      id: "css",
      href: `Styles/${fileName}`,
      mediaType: "text/css"
    });
  }

  // -----------------------------------------------------------------
  // Cover handling – async, converts everything to PNG.
  // -----------------------------------------------------------------
  async addCoverImage(imageBlob, fileNameInEpub, mimeType) {
    // Convert to PNG (covers may be WebP, JPEG, etc.)
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

    // No DOCTYPE – only XML declaration.
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
  }

  // -----------------------------------------------------------------
  // Chapter handling – no DOCTYPE, unique manifest IDs.
  // -----------------------------------------------------------------
  addChapter(title, htmlContent) {
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

    // ---- ensure a unique manifest id ----
    const baseId = baseStrict
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "_");
    let chapterId = `ch-${baseId || this.fileCounter}`;
    if (this.manifestItems.some((it) => it.id === chapterId)) {
      chapterId = `ch-${baseId}_${this.fileCounter}`;
    }

    this.manifestItems.push({
      id: chapterId,
      href: pathInEpub,
      mediaType: "application/xhtml+xml"
    });
    this.spineOrder.push(chapterId);

    this.tocEntries.push({
      rawTitle: title || "Untitled",
      href: pathInEpub
    });
  }

  // -----------------------------------------------------------------
  // Image handling – adds image to manifest (already PNG).
  // -----------------------------------------------------------------
  async addImageToManifest(imageInfo) {
    // imageInfo already contains a PNG blob and correct mime type
    const { blob, fileNameInEpub } = imageInfo;
    const imageId = `img-${fileNameInEpub.split(".").shift()}`;
    this.imagesFolder.file(fileNameInEpub, blob);
    this.manifestItems.push({
      id: imageId,
      href: `Images/${fileNameInEpub}`,
      mediaType: "image/png"
    });
  }

  // -----------------------------------------------------------------
  // OPF (package document)
  // -----------------------------------------------------------------
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
    ${this.metadata.epubVersion === "3.0"
        ? '<item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        : ""
    }
  </manifest>
  <spine toc="ncx">
    ${spineXml}
  </spine>
</package>`;
  }

  // -----------------------------------------------------------------
  // NCX (legacy navigation) – **ns:ncx** with the correct namespace URL.
  // -----------------------------------------------------------------
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

  // -----------------------------------------------------------------
  // Navigation document for EPUB 3 (toc.xhtml) – no DOCTYPE.
  // -----------------------------------------------------------------
  buildTocXhtml() {
    const listItems = this.tocEntries
      .map(
        (e) => `<li><a href="${e.href}">${escapeXml(e.rawTitle)}</a></li>`
      )
      .join("\n      ");

    return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops"
      xml:lang="${escapeXml(this.metadata.language)}"
      lang="${escapeXml(this.metadata.language)}">
<head>
  <title>Table of Contents</title>
  <link rel="stylesheet" type="text/css" href="Styles/stylesheet.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h2>Table of Contents</h2>
    <ol>
      ${listItems}
    </ol>
  </nav>
</body>
</html>`;
  }

  // -----------------------------------------------------------------
  // Final packaging – returns a Blob (application/epub+zip)
  // -----------------------------------------------------------------
  async packToBlob() {
    this.addContainerXml();
    this.oebps.file("content.opf", this.buildContentOpf());
    this.oebps.file("toc.ncx", this.buildTocNcx());
    if (this.metadata.epubVersion === "3.0") {
      this.oebps.file("toc.xhtml", this.buildTocXhtml());
    }
    // All content files have already been added to the zip.
    return this.zip.generateAsync({
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
  }

  // -----------------------------------------------------------------
  // Compatibility shim – old code called this; now a no‑op.
  // -----------------------------------------------------------------
  packContentFiles(/* zipWriter, epubItemSupplier */) {
    // no‑op
  }
}

/* ------------------------------------------------------------------
// 10️⃣  API EXPORTS – fetch creator profile, post list, generate EPUB
// ------------------------------------------------------------------- */
export async function fetchCreatorProfile(service, creatorId) {
  const url = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/profile`;
  const data = await HttpClient.fetchJson(url);
  return {
    postCount: data.post_count || 0,
    creatorName: data.name || ""
  };
}

export async function fetchPostListPage(
  service,
  creatorId,
  offset,
  limit = POSTS_PER_PAGE_FOR_LIST
) {
  const url = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/posts?o=${offset}`;
  const data = await HttpClient.fetchJson(url);
  const posts = data.map((p) => ({
    id: String(p.id),
    title: p.title || `Untitled Post ${p.id}`,
    published: p.published,
    originalOffset: offset
  }));
  return { posts };
}

/**
 * Generate an EPUB from the selected posts and trigger a download.
 */
export async function generateKemonoEpub(
  creatorInfo,
  selectedPostStubs,
  options,
  progressCallback
) {
  if (typeof JSZip === "undefined")
    throw new Error("JSZip library not found.");
  if (typeof saveAs === "undefined")
    throw new Error("FileSaver.js library not found (saveAs function).");

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

  // -----------------------------------------------------------------
  // Generate a proper UUID (v4) – required for dc:identifier.
  // -----------------------------------------------------------------
  const uuid = (() => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Simple fallback RFC‑4122 v4 generator.
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

  // -----------------------------------------------------------------
  // Basic stylesheet (can be overridden later)
  // -----------------------------------------------------------------
  const stylesheet = `body {font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;margin:1.5em;color:#333;background:#fff;}
h1,h2{margin-top:1.5em;margin-bottom:.5em}
h1{font-size:1.8em}
h2{font-size:1.5em}
p{margin-bottom:1em}
img{max-width:100%;height:auto;display:block;margin:1em auto;border-radius:4px}
.epub-cover-image-container{text-align:center;page-break-after:always}
.epub-cover-image-container img{max-height:95vh;width:auto}`;
  packer.addStylesheet(stylesheet);

  // -----------------------------------------------------------------
  // Optional cover image – convert everything to PNG.
  // -----------------------------------------------------------------
  if (options.coverImageUrl) {
    try {
      const rawBlob = await HttpClient.fetchBlob(options.coverImageUrl);
      await packer.addCoverImage(rawBlob, "cover.png", rawBlob.type);
    } catch (e) {
      console.warn("Cover image error:", e);
    }
  }

  // -----------------------------------------------------------------
  // Process each selected post
  // -----------------------------------------------------------------
  for (let i = 0; i < selectedPostStubs.length; i++) {
    const stub = selectedPostStubs[i];
    progressCallback(
      Math.round((i / selectedPostStubs.length) * 100),
      `Processing ${stub.title.substring(0, 30)}…`
    );

    const post = await parser.fetchPostFullData(stub.id);
    const { updatedHtml, imagesToPackage } =
      await parser.processPostImagesAndContent(post);

    // Inline images belonging to this post
    for (const imgInfo of imagesToPackage) {
      await packer.addImageToManifest(imgInfo);
    }

    // Chapter itself
    packer.addChapter(post.title || "Untitled Post", updatedHtml);
  }

  const epubBlob = await packer.packToBlob();
  const fileName = sanitizeFilename(
    options.fileName || `${displayName}.epub`
  );
  saveAs(epubBlob, fileName);
}
