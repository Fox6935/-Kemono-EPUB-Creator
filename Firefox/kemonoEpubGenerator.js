// kemonoEpubGenerator.js

// --- Configuration ---
const KEMONO_API_BASE_URL = "https://kemono.cr/api/v1";
const KEMONO_SITE_BASE_URL = "https://kemono.cr";
const KEMONO_IMG_BASE_URL = "https://img.kemono.cr";
// Only used for inline content images when links are site-relative
const KEMONO_DATA_BASE_URL = "https://kemono.cr/data";

const POSTS_PER_PAGE_FOR_LIST = 50;
const API_CALL_DELAY = 500;

// --- Rate limiter ---
let lastApiCallTime = 0;
async function ensureApiRateLimit() {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < API_CALL_DELAY) {
    await new Promise((r) => setTimeout(r, API_CALL_DELAY - elapsed));
  }
  lastApiCallTime = Date.now();
}

// --- HTTP helpers ---
const HttpClient = {
  fetchJson: async (url) => {
    await ensureApiRateLimit();
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to read error response.");
      console.error(`HTTP Error ${res.status} for ${url}: ${text}`);
      throw new Error(`API request failed: ${res.status} - ${text.substring(0, 200)}`);
    }
    return res.json();
  },
  fetchBlob: async (url) => {
    await ensureApiRateLimit();
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`HTTP Error ${res.status} for asset ${url}`);
      throw new Error(`Asset request failed: ${res.status}`);
    }
    return res.blob();
  }
};

// --- Filename helpers ---
function sanitizeFilename(filename) {
  if (typeof filename !== "string") return "";
  const sanitized = filename.replace(/[/\\?%*:|"<>]/g, "_").replace(/__+/g, "_");
  return sanitized.substring(0, 200);
}

// Strict basename sanitizer for XHTML filenames and IDs
function sanitizeBasenameForXhtmlStrict(basename) {
  if (!basename) return "chapter";
  let name = String(basename);
  name = name.replace(/\s+/g, "_"); // spaces -> underscores
  name = name.replace(/[^A-Za-z0-9._-]/g, "_"); // unsafe -> underscore (handles &, etc.)
  name = name.replace(/_+/g, "_"); // collapse
  name = name.replace(/^[._-]+|[._-]+$/g, ""); // trim edge punctuation
  if (!name) name = "chapter";
  return name.substring(0, 120);
}

// --- XML/HTML helpers ---
function escapeXml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only normalize <br> to <br />. Do not touch <img> to avoid breaking attributes.
function normalizeXhtmlVoidTags(html) {
  if (!html) return "";
  return html.replace(/<br(\s*)>/gi, "<br />");
}

// Replace named HTML entities that are not defined in XML with numeric equivalents.
// Keep &amp;, &lt;, &gt;, &quot;, &#...; intact.
function replaceUnsupportedEntities(html) {
  if (!html) return "";
  // Common offender
  html = html.replace(/&nbsp;/gi, "&#160;");
  // Map additional named entities here if they show up in your content:
  // html = html.replace(/&copy;/gi, "&#169;");
  // html = html.replace(/&reg;/gi, "&#174;");
  // html = html.replace(/&euro;/gi, "&#8364;");
  // html = html.replace(/&hellip;/gi, "&#8230;");
  // html = html.replace(/&mdash;/gi, "&#8212;");
  // html = html.replace(/&ndash;/gi, "&#8211;");
  // html = html.replace(/&lsquo;/gi, "&#8216;");
  // html = html.replace(/&rsquo;/gi, "&#8217;");
  // html = html.replace(/&ldquo;/gi, "&#8220;");
  // html = html.replace(/&rdquo;/gi, "&#8221;");
  return html;
}

function sanitizeHtmlContent(htmlString) {
  if (!htmlString) return "";
  // Remove scripts
  const SCRIPT_REGEX = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
  let sanitized = htmlString.replace(SCRIPT_REGEX, "");

  // XHTML compliance tweaks
  sanitized = replaceUnsupportedEntities(sanitized);
  sanitized = normalizeXhtmlVoidTags(sanitized);

  return sanitized;
}

// --- Parser ---
class KemonoContentParser {
  constructor(service, creatorId, progressReporter) {
    this.service = service;
    this.creatorId = creatorId;
    this.reportProgress = progressReporter;
    this.postCache = new Map();
  }

  async fetchPostFullData(postId) {
    if (this.postCache.has(postId)) {
      this.reportProgress(`Cache hit for post ${postId.substring(0, 10)}...`);
      return this.postCache.get(postId);
    }
    try {
      this.reportProgress(`Fetching post details: ${postId.substring(0, 10)}...`);
      const url = `${KEMONO_API_BASE_URL}/${this.service}/user/${this.creatorId}/post/${postId}`;
      const data = await HttpClient.fetchJson(url);
      const postDetail = data.post || data;
      if (!postDetail || !postDetail.id) {
        throw new Error(`Post data for ${postId} is malformed or missing.`);
      }
      this.postCache.set(postId, postDetail);
      return postDetail;
    } catch (error) {
      console.error(`Error fetching full data for post ${postId}:`, error);
      this.reportProgress(
        `Error fetching post ${postId.substring(0, 10)}...: ${error.message.substring(0, 50)}...`
      );
      throw error;
    }
  }

  // Bulk fetching is no longer possible with the new API
  async prepareForBulkFetch(selectedPostStubs) {
    this.reportProgress("Bulk fetching is no longer available with the new API. Posts will be fetched individually.");
    return;
  }

  // Parse raw content first, fetch/replace inline images, then sanitize for XHTML
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
        this.reportProgress(`Fetching content image: ${originalSrc.substring(0, 30)}...`);
        const blob = await HttpClient.fetchBlob(absoluteSrc);
        const extGuess = originalSrc.split(".").pop()?.toLowerCase() || "jpg";
        const ext = extGuess.replace(/[^a-z0-9]/g, "") || "jpg";
        const fileNameInEpub = sanitizeFilename(`content_${postData.id}_${i}.${ext}`);

        imagesToPackage.push({
          originalUrl: absoluteSrc,
          fileNameInEpub,
          localPathInEpub: `Images/${fileNameInEpub}`,
          blob,
          mimeType: blob.type || `image/${ext === "jpg" ? "jpeg" : ext}`
        });

        // Rewrite src to local relative path
        img.setAttribute("src", `../Images/${fileNameInEpub}`);
      } catch (e) {
        console.warn(`Failed to fetch content image ${absoluteSrc}:`, e);
        const alt = img.getAttribute("alt") || "";
        img.setAttribute("alt", `${alt} (Image not available: ${originalSrc})`);
      }
    }

    // Serialize then sanitize for XHTML compliance
    const contentOut = doc.body.innerHTML;
    const xhtmlSafe = sanitizeHtmlContent(contentOut);

    return { updatedHtml: xhtmlSafe, imagesToPackage };
  }
}

// --- EPUB packer ---
class EpubPacker {
  constructor(metadata) {
    if (typeof JSZip === "undefined") {
      throw new Error("JSZip library not found. Make sure jszip.min.js is loaded.");
    }
    this.zip = new JSZip();
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
    this.tocEntries = []; // { rawTitle, href } href is OEBPS-relative (e.g., "Text/file.xhtml")
    this.fileCounter = 0;
  }

  addMimetype() {
    this.zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  }

  addContainerXml() {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
    this.zip.folder("META-INF").file("container.xml", xml);
  }

  addStylesheet(content, fileName = "stylesheet.css") {
    const path = `Styles/${fileName}`;
    this.stylesFolder.file(fileName, content);
    this.manifestItems.push({ id: "css", href: path, mediaType: "text/css" });
  }

  addCoverImage(imageBlob, fileNameInEpub, mimeType) {
    const imageId = "cover-image";
    const imagePath = `Images/${fileNameInEpub}`;
    this.imagesFolder.file(fileNameInEpub, imageBlob);
    this.manifestItems.push({
      id: imageId,
      href: imagePath,
      mediaType: mimeType,
      properties: "cover-image"
    });
    this.metadata.coverImageId = imageId;

    const coverXhtmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${this.metadata.language}" lang="${this.metadata.language}">
<head>
  <title>Cover</title>
  <link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/>
</head>
<body>
  <div style="text-align: center; padding: 0; margin: 0;">
    <img src="../${imagePath}" alt="${escapeXml(this.metadata.title)} Cover" style="max-width: 100%; max-height: 100vh; height: auto;"/>
  </div>
</body>
</html>`;
    const coverXhtmlPath = "Text/cover.xhtml";
    this.textFolder.file("cover.xhtml", coverXhtmlContent);
    this.manifestItems.push({
      id: "cover-xhtml",
      href: coverXhtmlPath,
      mediaType: "application/xhtml+xml"
    });
    this.spineOrder.unshift("cover-xhtml");
  }

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
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${this.metadata.language}" lang="${this.metadata.language}">
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

    // Deterministic manifest ID from sanitized filename (without extension)
    const idBase = baseStrict.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
    const chapterId = `ch-${idBase || this.fileCounter}`;

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

  addTableOfContentsPage() {
    if (this.tocEntries.length <= 1) return;

    const tocXhtmlId = "toc-page";
    const tocXhtmlFileName = "toc_page.xhtml";
    const tocXhtmlPath = `Text/${tocXhtmlFileName}`;

    // toc_page.xhtml is in OEBPS/Text; links must be relative to Text/
    const listItems = this.tocEntries
      .map((e) => {
        const fileOnly = e.href.startsWith("Text/") ? e.href.slice(5) : e.href;
        return `<li><a href="${fileOnly}">${escapeXml(e.rawTitle)}</a></li>`;
      })
      .join("\n      ");

    const tocPageContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${this.metadata.language}" lang="${this.metadata.language}">
<head>
  <title>Table of Contents</title>
  <link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/>
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

    this.textFolder.file(tocXhtmlFileName, tocPageContent);
    this.manifestItems.push({
      id: tocXhtmlId,
      href: tocXhtmlPath,
      mediaType: "application/xhtml+xml",
      properties: "nav"
    });

    const insertIndex =
      this.spineOrder.indexOf("cover-xhtml") !== -1
        ? this.spineOrder.indexOf("cover-xhtml") + 1
        : 0;
    this.spineOrder.splice(insertIndex, 0, tocXhtmlId);
  }

  addImageToManifest(imageInfo) {
    const imageId = `img-${imageInfo.fileNameInEpub.split(".")[0]}`;
    this.imagesFolder.file(imageInfo.fileNameInEpub, imageInfo.blob);
    this.manifestItems.push({
      id: imageId,
      href: imageInfo.localPathInEpub,
      mediaType: imageInfo.mimeType
    });
  }

  buildContentOpf() {
    const dc = "http://purl.org/dc/elements/1.1/";
    const opfNs = "http://www.idpf.org/2007/opf";
    const modifiedDate = new Date().toISOString().substring(0, 19) + "Z";

    const manifestXml = this.manifestItems
      .map(
        (item) =>
          `<item id="${item.id}" href="${item.href}" media-type="${item.mediaType}"${
            item.properties ? ` properties="${item.properties}"` : ""
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
    <meta property="dcterms:modified">${modifiedDate}</meta>
    ${this.metadata.coverImageId ? `<meta name="cover" content="${this.metadata.coverImageId}"/>` : ""}
  </metadata>
  <manifest>
    ${manifestXml}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${this.metadata.epubVersion === "3.0" ? '<item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : ""}
  </manifest>
  <spine toc="ncx">
    ${spineXml}
  </spine>
</package>`;
  }

  buildTocNcx() {
    const navPointsXml = this.tocEntries
      .map(
        (entry, idx) => `
    <navPoint id="navpoint-${idx + 1}" playOrder="${idx + 1}">
      <navLabel><text>${escapeXml(entry.rawTitle)}</text></navLabel>
      <content src="${entry.href}"/>
    </navPoint>`
      )
      .join("");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/2005/ncx/" version="2005-1" xml:lang="${escapeXml(this.metadata.language)}">
  <head>
    <meta name="dtb:uid" content="${escapeXml(this.metadata.uuid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(this.metadata.title)}</text></docTitle>
  <navMap>
    ${navPointsXml}
  </navMap>
</ncx>`;
  }

  buildTocXhtml() {
    const listItemsXml = this.tocEntries
      .map(
        (entry) =>
          `<li><a href="${entry.href}">${escapeXml(entry.rawTitle)}</a></li>`
      )
      .join("\n      ");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(this.metadata.language)}" lang="${escapeXml(this.metadata.language)}">
<head>
  <title>Table of Contents</title>
  <link rel="stylesheet" type="text/css" href="Styles/stylesheet.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h2>Table of Contents</h2>
    <ol>
      ${listItemsXml}
    </ol>
  </nav>
</body>
</html>`;
  }

  async packToBlob() {
    this.addMimetype();
    this.addContainerXml();
    this.oebps.file("content.opf", this.buildContentOpf());
    this.oebps.file("toc.ncx", this.buildTocNcx());
    if (this.metadata.epubVersion === "3.0") {
      this.oebps.file("toc.xhtml", this.buildTocXhtml());
    }

    return this.zip.generateAsync({
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
  }
}

// --- API exports ---

/**
 * Fetch creator profile to get the total post count and creator name.
 */
export const fetchCreatorProfile = async (service, creatorId) => {
  const url = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/profile`;
  try {
    const data = await HttpClient.fetchJson(url);
    return {
      postCount: data.post_count || 0,
      creatorName: data.name || ""
    };
  } catch (error) {
    console.error(
      `Error fetching creator profile for ${service}/${creatorId}:`,
      error
    );
    throw error;
  }
};

/**
 * Fetch a paginated list of post stubs.
 */
export const fetchPostListPage = async (
  service,
  creatorId,
  offset,
  limit = POSTS_PER_PAGE_FOR_LIST
) => {
  const url = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/posts?o=${offset}`;
  try {
    const data = await HttpClient.fetchJson(url);
    
    const posts = data.map((post) => ({
      id: String(post.id),
      title: post.title || `Untitled Post ${post.id}`,
      published: post.published,
      originalOffset: offset
    }));

    return { posts };
  } catch (error) {
    console.error(
      `Error fetching post list page (offset ${offset}) for ${service}/${creatorId}:`,
      error
    );
    throw error;
  }
};

/**
 * Generate an EPUB from selected posts and trigger download.
 */
export const generateKemonoEpub = async (
  creatorInfo,
  selectedPostStubs,
  options,
  progressCallback
) => {
  if (typeof JSZip === "undefined") throw new Error("JSZip library not found.");
  if (typeof saveAs === "undefined")
    throw new Error("FileSaver.js library not found (saveAs function).");

  const parserProgressReporter = (message) => {
    progressCallback(-1, message);
  };

  const parser = new KemonoContentParser(
    creatorInfo.service,
    creatorInfo.creatorId,
    parserProgressReporter
  );

  const displayName =
    creatorInfo.creatorName && creatorInfo.creatorName.trim()
      ? creatorInfo.creatorName.trim()
      : "Unknown";

  const packer = new EpubPacker({
    title: displayName,
    author: displayName,
    uuid: `urn:uuid:${creatorInfo.service}-${creatorInfo.creatorId}-${Date.now()}`,
    language: "en"
  });

  const stylesheetContent = `body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; line-height: 1.6; margin: 1.5em; color: #333; background-color: #fff; }
h1, h2 { text-align: left; margin-top: 1.5em; margin-bottom: 0.5em; line-height: 1.2; }
h1 { font-size: 1.8em; }
h2 { font-size: 1.5em; }
p { margin-bottom: 1em; }
img { max-width: 100%; height: auto; display: block; margin: 1em auto; border-radius: 4px; }
.epub-cover-image-container { text-align: center; page-break-after: always; }
.epub-cover-image-container img { max-height: 95vh; width: auto; }
`;
  packer.addStylesheet(stylesheetContent);

  const WEIGHT_SETUP = 5;
  const WEIGHT_BULK_FETCH = 15;
  const WEIGHT_PROCESS_POSTS = 75;
  const WEIGHT_PACKING = 5;

  let currentProgress = 0;

  progressCallback(currentProgress, "Initializing EPUB structure and cover...");
  if (options.coverImageUrl) {
    try {
      const coverBlob = await HttpClient.fetchBlob(options.coverImageUrl);
      const coverExt =
        options.coverImageUrl.split(".").pop()?.toLowerCase() || "jpeg";
      const coverMime = `image/${coverExt === "jpg" ? "jpeg" : coverExt}`;
      const coverFilename = `cover.${coverExt}`;
      packer.addCoverImage(coverBlob, coverFilename, coverMime);
      progressCallback(
        currentProgress,
        `Fetched cover image: ${options.coverImageUrl.substring(0, 40)}...`
      );
    } catch (e) {
      console.warn("Failed to fetch or add cover image:", e);
      progressCallback(
        currentProgress,
        `Warning: Could not add cover. ${e.message.substring(0, 30)}`
      );
    }
  }
  currentProgress += WEIGHT_SETUP;
  progressCallback(currentProgress, "Setup complete.");

  if (selectedPostStubs.length > 0) {
    progressCallback(
      currentProgress,
      `Preparing for individual post fetching (${selectedPostStubs.length} posts)...`
    );
    try {
      await parser.prepareForBulkFetch(selectedPostStubs);
    } catch (error) {
      console.error("Error during preparation phase:", error);
      progressCallback(
        currentProgress,
        `Preparation failed: ${error.message.substring(0, 30)}`
      );
    }
  }
  currentProgress += WEIGHT_BULK_FETCH;
  progressCallback(
    currentProgress,
    "Preparation phase finished. Processing individual posts..."
  );

  const numSelectedPosts = selectedPostStubs.length;
  for (let i = 0; i < numSelectedPosts; i++) {
    const postStub = selectedPostStubs[i];
    const postProgressFraction = WEIGHT_PROCESS_POSTS / numSelectedPosts;

    progressCallback(
      Math.min(100, currentProgress),
      `Processing chapter ${i + 1} of ${numSelectedPosts}: ${postStub.title.substring(
        0,
        30
      )}...`
    );

    try {
      const postFullData = await parser.fetchPostFullData(postStub.id);
      if (!postFullData) {
        console.warn(`Skipping post ${postStub.id} (fetch failure).`);
        currentProgress += postProgressFraction;
        progressCallback(Math.min(100, currentProgress), `Skipped: ${postStub.title}`);
        continue;
      }

      const { updatedHtml, imagesToPackage } =
        await parser.processPostImagesAndContent(postFullData);

      for (const imgInfo of imagesToPackage) {
        packer.addImageToManifest(imgInfo);
      }

      packer.addChapter(postFullData.title || "Untitled Post", updatedHtml);

      currentProgress += postProgressFraction;
      progressCallback(
        Math.min(100, currentProgress),
        `Processed chapter ${i + 1} of ${numSelectedPosts}: ${postStub.title}`
      );
    } catch (error) {
      console.error(`Error processing post ${postStub.id} (${postStub.title}):`, error);
      currentProgress += postProgressFraction;
      progressCallback(
        Math.min(100, currentProgress),
        `Error on chapter ${i + 1} of ${numSelectedPosts}: ${postStub.title.substring(
          0,
          20
        )}... - ${error.message.substring(0, 30)}`
      );
    }
  }

  currentProgress = WEIGHT_SETUP + WEIGHT_BULK_FETCH + WEIGHT_PROCESS_POSTS;
  progressCallback(currentProgress, "All posts processed. Finalizing EPUB...");

  if (packer.tocEntries.length > 1) {
    packer.addTableOfContentsPage();
  }

  const finalProgress = currentProgress + WEIGHT_PACKING;
  progressCallback(finalProgress, "Finalizing EPUB file...");
  const epubBlob = await packer.packToBlob();

  progressCallback(100, "EPUB generated and download started!");
  saveAs(epubBlob, sanitizeFilename(options.fileName || `${displayName}.epub`));
};
