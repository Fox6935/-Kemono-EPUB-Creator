// EpubGenerator.js
//  This file creates an EPUB from Kemono posts.

// CONFIGURATION
const KEMONO_API_BASE_URL = "https://kemono.cr/api/v1";
const KEMONO_SITE_BASE_URL = "https://kemono.cr";
const KEMONO_DATA_BASE_URL = "https://kemono.cr/data";

const POSTS_PER_PAGE_FOR_LIST = 50;
const API_CALL_DELAY = 500;
const LARGE_OFFSET_FOR_COUNT = 100000;

// RATE-LIMITER: Promise chaining to ensure strict serialization
let apiQueue = Promise.resolve();
let lastApiCallTime = 0;

async function ensureApiRateLimit() {
  const nextCall = apiQueue.then(async () => {
    const now = Date.now();
    const timeSinceLast = now - lastApiCallTime;
    if (timeSinceLast < API_CALL_DELAY) {
      await new Promise(r => setTimeout(r, API_CALL_DELAY - timeSinceLast));
    }
    lastApiCallTime = Date.now();
  });
  apiQueue = nextCall.catch(() => {});
  return nextCall;
}

// HTTP HELPER
const HttpClient = {
  async fetchJson(url) {
    await ensureApiRateLimit();
    const res = await fetch(url, { headers: { Accept: "text/css" } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "Failed to read error response.");
      console.error(`HTTP ${res.status} for ${url}: ${txt}`);
      throw new Error(`API request failed: ${res.status} - ${txt.substring(0, 200)}`);
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
  const sanitized = filename.replace(/[\/\\?%*:|"<>]/g, "_").replace(/__+/g, "_");
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
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, c => map[c]);
}

// IMAGE PROCESSING
function getMimeType(blob, url) {
  if (blob.type && blob.type !== 'application/octet-stream') {
    return blob.type;
  }
  const ext = url.split('.').pop().toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

async function processImageBlob(blob, url) {
  const mime = getMimeType(blob, url);

  if (['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'].includes(mime)) {
    return { blob, mimeType: mime, extension: mime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg') };
  }

  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const pngBlob = await canvas.convertToBlob({ type: "image/png" });
  
  return { blob: pngBlob, mimeType: "image/png", extension: "png" };
}

// CONTENT PARSER
class KemonoContentParser {
  constructor(service, creatorId, progressReporter) {
    this.service = service;
    this.creatorId = creatorId;
    this.reportProgress = progressReporter;
    this.postCache = new Map();
    this.domParser = new DOMParser(); 
    this.xmlSerializer = new XMLSerializer();
  }

  async fetchPostFullData(postId) {
    postId = String(postId);
    if (this.postCache.has(postId)) {
      return this.postCache.get(postId);
    }
    try {
      this.reportProgress(`Fetching post details: ${postId.substring(0, 10)}…`);
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
      this.reportProgress(`Error fetching post ${postId}…`);
      throw error;
    }
  }

  async prepareForBulkFetch(selectedPostStubs, { customQ, tagFilter } = {}) {
    if (!selectedPostStubs || selectedPostStubs.length === 0) return;

    let bulkParamType = "q";
    let bulkValue = customQ || "<p>";
    if (tagFilter) {
       bulkParamType = "tag";
       bulkValue = tagFilter;
    } else if (customQ && customQ.length < 3) {
      bulkValue = "<p";
    }

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
      const offset = sortedOffsets[i];
      let url = `${KEMONO_API_BASE_URL}/${this.service}/user/${this.creatorId}/posts?o=${offset}`;
      url += (bulkParamType === "tag") ? `&tag=${encodeURIComponent(bulkValue)}` : `&q=${encodeURIComponent(bulkValue)}`;

      try {
        this.reportProgress(`Bulk page ${i + 1}/${sortedOffsets.length} (offset ${offset})...`);
        const postsOnPage = await HttpClient.fetchJson(url);
        if (Array.isArray(postsOnPage)) {
          for (const fullPost of postsOnPage) {
            if (fullPost && fullPost.id) {
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
    const rawHtml = postData.content || "";
    const imagesToPackage = [];

    let doc = this.domParser.parseFromString(rawHtml, "text/html");

    const scripts = doc.querySelectorAll('script, .ad-container');
    scripts.forEach(s => s.remove());

    const imgElements = Array.from(doc.querySelectorAll("img"));
    for (let i = 0; i < imgElements.length; i++) {
      const img = imgElements[i];
      const originalSrc = img.getAttribute("src");
      if (!originalSrc) continue;

      let absoluteSrc = this._normalizeUrl(originalSrc);
      if (!absoluteSrc) continue;

      try {
        let rawBlob = await HttpClient.fetchBlob(absoluteSrc);
        const { blob, mimeType, extension } = await processImageBlob(rawBlob, absoluteSrc);
        const fileNameInEpub = sanitizeFilename(`inline_${postData.id}_${i}.${extension}`);

        imagesToPackage.push({
          originalUrl: absoluteSrc,
          fileNameInEpub,
          localPathInEpub: `Images/${fileNameInEpub}`,
          blob,
          mimeType,
        });

        img.setAttribute("src", `../Images/${fileNameInEpub}`);
      } catch (e) {
        const alt = img.getAttribute("alt") || "";
        img.setAttribute("alt", `${alt} (Image not available)`);
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
    let absoluteSrc = originalSrc;
    if (originalSrc.startsWith("//")) {
      absoluteSrc = `https:${originalSrc}`;
    } else if (originalSrc.startsWith("/")) {
      absoluteSrc = originalSrc.startsWith("/data/") 
        ? `${KEMONO_DATA_BASE_URL}${originalSrc}` 
        : `${KEMONO_SITE_BASE_URL}${originalSrc}`;
    } else if (!originalSrc.startsWith("http")) {
      absoluteSrc = `${KEMONO_SITE_BASE_URL}/${originalSrc}`;
    }
    
    if (absoluteSrc.includes("#") || absoluteSrc.includes("?")) {
      try {
        const u = new URL(absoluteSrc);
        absoluteSrc = u.origin + u.pathname;
      } catch (e) {
         try {
             const cleanSrc = new URL(absoluteSrc, KEMONO_SITE_BASE_URL).origin + new URL(absoluteSrc, KEMONO_SITE_BASE_URL).pathname;
             absoluteSrc = cleanSrc;
         } catch {
             console.warn(`Could not normalize URL: ${originalSrc}`);
             return null;
         }
      }
    }
    return absoluteSrc;
  }

  _rewriteAllImageReferences(doc, imagesToPackage) {
    const urlToLocalMap = new Map();
    imagesToPackage.forEach((imgInfo) => {
      urlToLocalMap.set(imgInfo.originalUrl, imgInfo.localPathInEpub);
      const partialPath = imgInfo.originalUrl
        .replace(KEMONO_SITE_BASE_URL, "")
        .replace(KEMONO_DATA_BASE_URL.replace("https://", ""), "");
      if (partialPath) urlToLocalMap.set(partialPath, imgInfo.localPathInEpub);
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
        if(href && href.startsWith("Images/") && (a.textContent.includes("Download") || !a.textContent.trim())) {
            a.textContent = a.textContent.replace(/Download/i, "View") || "View Image";
        }
    });

    return doc;
  }
}

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
    return { posts: data.map((p) => ({
      id: String(p.id),
      title: p.title || `Untitled Post ${p.id}`,
      published: p.published,
      originalOffset: offset
    }))};
  } catch (error) {
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
    } catch (error) {
      return { postCount: 0, creatorName: "" };
    }
  
    const largeOffsetUrl = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/posts?o=${LARGE_OFFSET_FOR_COUNT}`;
    try {
      await ensureApiRateLimit();
      const response = await fetch(largeOffsetUrl, { headers: { Accept: "text/css" } });
      const text = await response.text();
  
      if (response.status === 400) {
        try {
          const errorData = JSON.parse(text);
          const errorMsg = errorData.error || "";
          const parts = errorMsg.split(/\s+/);
          const candidate = parts[parts.length - 1].replace(/\.$/, "");
          const parsedCount = parseInt(candidate, 10);
          if (!isNaN(parsedCount) && parsedCount >= 0) postCount = parsedCount;
        } catch (jsonError) {}
      } else if (response.status === 200) {
        const data = JSON.parse(text);
        if(Array.isArray(data)) postCount = data.length; 
      }
    } catch (fetchError) {}
  
    return { postCount, creatorName };
}

// MAIN GENERATOR
export async function generateKemonoEpub(
  creatorInfo,
  selectedPostStubs,
  options,
  progressCallback
) {
  const ZipLib = (typeof JSZip !== "undefined") ? JSZip : (window.JSZip || undefined);
  if (!ZipLib) throw new Error("JSZip library not found.");
  
  const SaverLib = (typeof saveAs !== "undefined") ? saveAs : (window.saveAs || undefined);
  if (!SaverLib) throw new Error("FileSaver.js library not found.");

  const parserProgress = (msg) => progressCallback(-1, msg);
  const parser = new KemonoContentParser(
    creatorInfo.service,
    creatorInfo.creatorId,
    parserProgress
  );

  selectedPostStubs.forEach(stub => {
    if (stub.content) parser.postCache.set(String(stub.id), stub);
  });

  const displayName = (creatorInfo.creatorName || "Unknown").trim();
  const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const packer = new EpubPacker({
    title: displayName,
    author: displayName,
    uuid: `urn:uuid:${uuid}`,
    language: "en"
  }, ZipLib); 

  packer.addStylesheet(`.epub-cover-image-container { text-align: center; } img { max-width: 100%; }`);

  if (options.coverImageUrl) {
    try {
      const rawBlob = await HttpClient.fetchBlob(options.coverImageUrl);
      const { blob, mimeType, extension } = await processImageBlob(rawBlob, options.coverImageUrl);
      await packer.addCoverImage(blob, `cover.${extension}`, mimeType);
      progressCallback(5, "Cover image processed.");
    } catch (e) {
      console.warn("Cover image error:", e);
    }
  }

  const postsNeedingFetch = selectedPostStubs.filter(s => !s.content);
  if (postsNeedingFetch.length > 0) {
    progressCallback(10, `Preparing for bulk fetch (${postsNeedingFetch.length} posts)...`);
    try {
      await parser.prepareForBulkFetch(postsNeedingFetch, {
        customQ: options.customQ,
        tagFilter: options.tagFilter
      });
    } catch (error) {
      console.error("Bulk fetch prep failed:", error);
    }
  }

  const numPosts = selectedPostStubs.length;
  const processedPosts = [];
  const updateFrequency = Math.min(50, Math.max(10, Math.floor(numPosts / 100)));
  
  // TRACKER FOR FILENAME UNIQUENESS
  // Set contains lowercase versions of all filenames used so far
  const usedFilenames = new Set();

  for (let i = 0; i < numPosts; i++) {
    if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const stub = selectedPostStubs[i];

    if (i === 0 || i === numPosts - 1 || i % updateFrequency === 0) {
      const percent = 15 + ((i / numPosts) * 70);
      progressCallback(
        percent,
        `Processing: ${i + 1}/${numPosts} - ${stub.title.substring(0, 20)}…`
      );
    }

    const post = await parser.fetchPostFullData(stub.id);
    if (!post) continue;

    const { updatedHtml, imagesToPackage } =
      await parser.processPostImagesAndContent(post);

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

  if (processedPosts.length > 0) {
    packer.addTableOfContents(processedPosts);
  }

  progressCallback(90, "Building EPUB structure...");
  await new Promise(r => setTimeout(r, 50)); 
  
  const epubBlob = await packer.packToBlob();
  progressCallback(100, "EPUB generated – download started!");
  const fileName = sanitizeFilename(options.fileName || `${displayName}.epub`);
  
  SaverLib(epubBlob, fileName);
}

// EPUB PACKER
class EpubPacker {
  constructor(metadata, JSZipClass) {
    this.zip = new JSZipClass();
    this.zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    this.metadata = { language: "en", epubVersion: "3.0", ...metadata };
    this.oebps = this.zip.folder("OEBPS");
    this.textFolder = this.oebps.folder("Text");
    this.imagesFolder = this.oebps.folder("Images");
    this.stylesFolder = this.oebps.folder("Styles");
    this.manifestItems = [];
    this.spineOrder = [];
    this.tocEntries = [];
    this.fileCounter = 0;
    this.imageIdCounter = 0; 
    this.usedImageIds = new Set();
    this.usedImagePaths = new Set();
  }

  addStylesheet(content) {
      this.stylesFolder.file("stylesheet.css", content);
      this.manifestItems.push({ id: "css", href: "Styles/stylesheet.css", mediaType: "text/css" });
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
    
    this.imagesFolder.file(fileNameInEpub, blob);
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
      
      if (this.spineOrder.includes("toc")) this.spineOrder.splice(this.spineOrder.indexOf("toc") + 1, 0, chapterId);
      else if (this.spineOrder.includes("cover-xhtml")) this.spineOrder.splice(this.spineOrder.indexOf("cover-xhtml") + 1, 0, chapterId);
      else this.spineOrder.push(chapterId);
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

  async packToBlob() {
    this.addContainerXml();
    this.oebps.file("content.opf", this.buildContentOpf());
    this.oebps.file("toc.ncx", `<?xml version="1.0" encoding="UTF-8"?><ns:ncx xmlns:ns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><ns:head><ns:meta name="dtb:uid" content="${this.metadata.uuid}"/></ns:head><ns:docTitle><ns:text>${escapeXml(this.metadata.title)}</ns:text></ns:docTitle><ns:navMap>${this.tocEntries.map((e,i)=>`<ns:navPoint id="navpoint-${i+1}" playOrder="${i+1}"><ns:navLabel><ns:text>${escapeXml(e.rawTitle)}</ns:text></ns:navLabel><ns:content src="${e.href}"/></ns:navPoint>`).join("")}</ns:navMap></ns:ncx>`);
    
    return this.zip.generateAsync({
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
  }
}
