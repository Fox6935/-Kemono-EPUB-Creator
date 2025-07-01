// kemonoEpubGenerator.js

// --- Configuration ---
const KEMONO_API_BASE_URL = 'https://kemono.su/api/v1';
const KEMONO_SITE_BASE_URL = 'https://kemono.su';
const KEMONO_IMG_BASE_URL = 'https://img.kemono.su';
const KEMONO_DATA_BASE_URL = 'https://kemono.su/data';

const POSTS_PER_PAGE_FOR_LIST = 50;
const API_CALL_DELAY = 1000;

// --- Utility: Rate Limiter ---
let lastApiCallTime = 0;
async function ensureApiRateLimit() {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCallTime;
  if (timeSinceLastCall < API_CALL_DELAY) {
    const delayNeeded = API_CALL_DELAY - timeSinceLastCall;
    await new Promise((resolve) => setTimeout(resolve, delayNeeded));
  }
  lastApiCallTime = Date.now();
}

// --- Utility: HTTP Client (using fetch) ---
const HttpClient = {
  fetchJson: async (url) => {
    await ensureApiRateLimit();
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'Failed to read error response.');
      console.error(
        `HTTP Error ${response.status} for ${url}: ${errorText}`,
      );
      throw new Error(
        `API request failed: ${
          response.status
        } - ${errorText.substring(0, 200)}`,
      );
    }
    return response.json();
  },
  fetchBlob: async (url) => {
    await ensureApiRateLimit();
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`HTTP Error ${response.status} for asset ${url}`);
      throw new Error(`Asset request failed: ${response.status}`);
    }
    return response.blob();
  },
};

// --- Utility: Sanitize Filename (simplified and integrated) ---
function sanitizeFilename(filename) {
  if (typeof filename !== 'string') {
    return '';
  }
  const sanitized = filename.replace(/[/\\?%*:|"<>]/g, '_').replace(/__+/g, '_');
  return sanitized.substring(0, 200);
}

// --- Utility: Check Image Extension ---
function isImageExtension(filename) {
  if (!filename || typeof filename !== 'string') return false;
  const ext = filename.split('.').pop()?.toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
};

// --- Utility: Sanitize HTML for EPUB ---
function sanitizeHtmlContent(htmlString) {
  if (!htmlString) return '';
  const SCRIPT_REGEX = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
  let sanitized = htmlString.replace(SCRIPT_REGEX, '');
  return sanitized;
}


// --- Adapted Kemono Data Parser Class ---
class KemonoContentParser {
  constructor(service, creatorId, progressReporter) { // Changed to progressReporter
    this.service = service;
    this.creatorId = creatorId;
    this.reportProgress = progressReporter; // Renamed for clarity
    this.postCache = new Map();
  }

  async fetchPostFullData(postId) {
    if (this.postCache.has(postId)) {
      this.reportProgress(`Cache hit for post ${postId.substring(0, 10)}...`); // Message only
      return this.postCache.get(postId);
    }
    try {
      this.reportProgress(`Fetching post details: ${postId.substring(0, 10)}...`); // Message only
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
      this.reportProgress(`Error fetching post ${postId.substring(0, 10)}...: ${error.message.substring(0, 50)}...`); // Message only
      throw error;
    }
  }

  async prepareForBulkFetch(selectedPostStubs) {
    if (!selectedPostStubs || selectedPostStubs.length === 0) {
      this.reportProgress('No selected posts for bulk fetch.'); // Message only
      return;
    }

    this.reportProgress('Determining relevant offsets for bulk fetch...'); // Message only
    const offsetsToFetch = new Set();
    const selectedPostIdSet = new Set(selectedPostStubs.map((s) => s.id));

    for (const stub of selectedPostStubs) {
      if (stub.originalOffset !== undefined) {
        offsetsToFetch.add(stub.originalOffset);
        const prevOffset = stub.originalOffset - POSTS_PER_PAGE_FOR_LIST;
        if (prevOffset >= 0) {
          offsetsToFetch.add(prevOffset);
        }
      }
    }

    if (offsetsToFetch.size === 0) {
      this.reportProgress('No valid offsets identified for bulk fetch. Posts will be fetched individually.'); // Message only
      return;
    }

    const sortedOffsets = Array.from(offsetsToFetch).sort((a, b) => a - b);
    this.reportProgress(`Identified ${sortedOffsets.length} unique page offsets for bulk fetch: ${sortedOffsets.join(', ')}`); // Message only

    for (let i = 0; i < sortedOffsets.length; i++) {
      const offset = sortedOffsets[i];
      const bulkApiUrl = `${KEMONO_API_BASE_URL}/${this.service}/user/${this.creatorId}?o=${offset}`;
      try {
        this.reportProgress(`Bulk fetching page offset ${offset} (${i + 1}/${sortedOffsets.length})...`); // Message only
        const postsOnPage = await HttpClient.fetchJson(bulkApiUrl);

        if (Array.isArray(postsOnPage)) {
          let cachedCount = 0;
          for (const postFullData of postsOnPage) {
            if (postFullData && postFullData.id) {
              this.postCache.set(String(postFullData.id), postFullData);
              if (selectedPostIdSet.has(String(postFullData.id))) {
                cachedCount++;
              }
            }
          }
          this.reportProgress(`Bulk fetched offset ${offset}: ${postsOnPage.length} posts, ${cachedCount} directly matched selected.`); // Message only
        } else {
          console.warn(`Bulk fetch for offset ${offset} did not return an array:`, postsOnPage);
          this.reportProgress(`Warning: Bulk fetch for offset ${offset} returned unexpected data.`); // Message only
        }
      } catch (error) {
        console.error(`Error bulk fetching offset ${offset}:`, error);
        this.reportProgress(`Error bulk fetching offset ${offset}: ${error.message.substring(0, 50)}...`); // Message only
      }
    }
    this.reportProgress('Bulk fetch attempt complete.'); // Message only
  }

  async processPostImagesAndContent(postData) {
    let htmlContent = postData.content || '';
    const imagesToPackage = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');

    const imgElements = Array.from(doc.querySelectorAll('img'));
    for (let i = 0; i < imgElements.length; i++) {
      const img = imgElements[i];
      let originalSrc = img.getAttribute('src');
      if (!originalSrc) continue;

      let absoluteSrc = originalSrc;
      if (originalSrc.startsWith('/')) {
        if (originalSrc.startsWith('//')) {
          absoluteSrc = `https:${originalSrc}`;
        } else {
          absoluteSrc = `${KEMONO_SITE_BASE_URL}${originalSrc}`;
        }
      }

      let existingImage = imagesToPackage.find((item) => item.originalUrl === absoluteSrc);
      if (existingImage) {
        img.setAttribute('src', `../Images/${existingImage.fileNameInEpub}`);
      } else {
        try {
          this.reportProgress(`Fetching content image: ${originalSrc.substring(0, 30)}...`); // Message only
          const blob = await HttpClient.fetchBlob(absoluteSrc);
          const ext = originalSrc.split('.').pop()?.toLowerCase() || 'jpg';
          const fileNameInEpub = sanitizeFilename(`content_img_${postData.id}_${i}.${ext}`);
          const localPathInEpub = `Images/${fileNameInEpub}`;

          imagesToPackage.push({
            originalUrl: absoluteSrc,
            fileNameInEpub,
            localPathInEpub,
            blob,
            mimeType: blob.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
          });
          img.setAttribute('src', `../Images/${fileNameInEpub}`);
        } catch (e) {
          console.warn(`Failed to fetch content image ${absoluteSrc}:`, e);
          img.alt = `${img.alt || ''} (Image not available: ${originalSrc})`;
        }
      }
    }

    if (postData.file && postData.file.path && postData.file.name && isImageExtension(postData.file.name)) {
      const fileServer = postData.file.server || KEMONO_DATA_BASE_URL.replace('/data', '');
      const fileUrl = `${fileServer}${postData.file.path}`;
      if (!imagesToPackage.find((item) => item.originalUrl === fileUrl)) {
        try {
          this.reportProgress(`Fetching post file image: ${postData.file.name.substring(0, 25)}...`); // Message only
          const blob = await HttpClient.fetchBlob(fileUrl);
          const fileNameInEpub = sanitizeFilename(postData.file.name);
          const localPathInEpub = `Images/${fileNameInEpub}`;
          imagesToPackage.push({
            originalUrl: fileUrl,
            fileNameInEpub,
            localPathInEpub,
            blob,
            mimeType: blob.type,
          });
        } catch (e) {
          console.warn(`Failed to fetch post.file image ${fileUrl}:`, e);
        }
      }
    }

    if (postData.attachments && Array.isArray(postData.attachments)) {
      for (const att of postData.attachments) {
        if (att.path && att.name && isImageExtension(att.name)) {
          const attServer = att.server || KEMONO_DATA_BASE_URL.replace('/data', '');
          const attUrl = `${attServer}${att.path}`;
          if (!imagesToPackage.find((item) => item.originalUrl === attUrl)) {
            try {
              this.reportProgress(`Fetching attachment: ${att.name.substring(0, 25)}...`); // Message only
              const blob = await HttpClient.fetchBlob(attUrl);
              const fileNameInEpub = sanitizeFilename(att.name);
              const localPathInEpub = `Images/${fileNameInEpub}`;
              imagesToPackage.push({
                originalUrl: attUrl,
                fileNameInEpub,
                localPathInEpub,
                blob,
                mimeType: blob.type,
              });
            } catch (e) {
              console.warn(`Failed to fetch attachment image ${attUrl}:`, e);
            }
          }
        }
      }
    }
    return { updatedHtml: doc.body.innerHTML, imagesToPackage };
  }
}


// --- Epub Packer Class (using global JSZip) ---
class EpubPacker {
  constructor(metadata) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip library not found. Make sure jszip.min.js is loaded.');
    }
    this.zip = new JSZip();
    this.metadata = {
      language: 'en',
      epubVersion: '3.0',
      ...metadata,
    };
    this.oebps = this.zip.folder('OEBPS');
    this.textFolder = this.oebps.folder('Text');
    this.imagesFolder = this.oebps.folder('Images');
    this.stylesFolder = this.oebps.folder('Styles');

    this.manifestItems = [];
    this.spineOrder = [];
    this.tocEntries = [];
    this.fileCounter = 0;
  }

  addMimetype() {
    this.zip.file('mimetype', 'application/epub+zip', {
      compression: 'STORE',
    });
  }

  addContainerXml() {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
    this.zip.folder('META-INF').file('container.xml', xml);
  }

  addStylesheet(content, fileName = 'stylesheet.css') {
    const path = `Styles/${fileName}`;
    this.stylesFolder.file(fileName, content);
    this.manifestItems.push({ id: 'css', href: path, mediaType: 'text/css' });
  }

  addCoverImage(imageBlob, fileNameInEpub, mimeType) {
    const imageId = 'cover-image';
    const imagePath = `Images/${fileNameInEpub}`;
    this.imagesFolder.file(fileNameInEpub, imageBlob);
    this.manifestItems.push({
      id: imageId,
      href: imagePath,
      mediaType: mimeType,
      properties: 'cover-image',
    });
    this.metadata.coverImageId = imageId;
    this.metadata.coverImageLocalPath = imagePath;
    this.metadata.coverImageMimeType = mimeType;

    const coverXhtmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${this.metadata.language}" lang="${this.metadata.language}">
<head>
  <title>Cover</title>
  <link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/>
</head>
<body>
  <div style="text-align: center; padding: 0; margin: 0;">
    <img src="../${imagePath}" alt="${this.metadata.title} Cover" style="max-width: 100%; max-height: 100vh; height: auto;"/>
  </div>
</body>
</html>`;
    const coverXhtmlPath = 'Text/cover.xhtml';
    this.textFolder.file('cover.xhtml', coverXhtmlContent);
    this.manifestItems.push({
      id: 'cover-xhtml',
      href: coverXhtmlPath,
      mediaType: 'application/xhtml+xml',
    });
    this.spineOrder.unshift('cover-xhtml');
  }

  /**
   * Adds a chapter to the EPUB.
   * @param {string} title - The title of the chapter.
   * @param {string} htmlContent - The HTML content of the chapter body.
   * @param {string} postId - The original post ID (for unique file naming).
   */
  addChapter(title, htmlContent, postId) {
    this.fileCounter++;
    const chapterId = `chapter-${postId || this.fileCounter}`;
    const fileName = `${chapterId}.xhtml`;
    const pathInEpub = `Text/${fileName}`;

    const chapterXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${this.metadata.language}" lang="${this.metadata.language}">
<head>
  <title>${sanitizeHtmlContent(title)}</title>
  <link rel="stylesheet" type="text/css" href="../Styles/stylesheet.css"/>
</head>
<body>
  <h1>${sanitizeHtmlContent(title)}</h1>
  ${htmlContent}
</body>
</html>`;
    this.textFolder.file(fileName, chapterXhtml);
    this.manifestItems.push({
      id: chapterId,
      href: pathInEpub,
      mediaType: 'application/xhtml+xml',
    });
    this.spineOrder.push(chapterId); // Add chapter to spine order
    this.tocEntries.push({
      title: sanitizeHtmlContent(title),
      href: pathInEpub,
      id: `nav-${chapterId}`,
      playOrder: this.tocEntries.length + 1,
    });
  }

  /**
   * Conditionally adds a Table of Contents (ToC) page to the EPUB if there's more than one chapter.
   */
  addTableOfContentsPage() {
      // Add ToC page only if there is more than 1 chapter
      if (this.tocEntries.length > 1) { // If only 1 chapter, a ToC is redundant
          const tocXhtmlId = 'toc-page';
          const tocXhtmlFileName = 'toc_page.xhtml'; // A dedicated filename for the ToC XHTML file
          const tocXhtmlPath = `Text/${tocXhtmlFileName}`;

          // The ToC XHTML content is generated by buildTocXhtml()
          // Write the ToC XHTML file to the ZIP
          this.textFolder.file(tocXhtmlFileName, this.buildTocXhtml());

          // Add ToC XHTML file to manifest
          this.manifestItems.push({
              id: tocXhtmlId,
              href: tocXhtmlPath,
              mediaType: 'application/xhtml+xml',
              properties: 'nav' // Recommended property for EPUB3 nav document
          });

          // Add ToC page to spine (typically after cover, before chapters)
          const insertIndex = this.spineOrder.indexOf('cover-xhtml') !== -1 ?
                              this.spineOrder.indexOf('cover-xhtml') + 1 :
                              0;
          this.spineOrder.splice(insertIndex, 0, tocXhtmlId);

          // Add a ToC entry for the ToC page itself in the navigation list
          this.tocEntries.unshift({
              title: 'Table of Contents',
              href: tocXhtmlPath,
              id: 'nav-toc-page',
              playOrder: 0 // Should appear at the very beginning of the NCX/XHTML nav list
          });
      }
  }


  addImageToManifest(imageInfo) {
    const imageId = `img-${imageInfo.fileNameInEpub.split('.')[0]}`;
    this.imagesFolder.file(imageInfo.fileNameInEpub, imageInfo.blob);
    this.manifestItems.push({
      id: imageId,
      href: imageInfo.localPathInEpub,
      mediaType: imageInfo.mimeType,
    });
  }

  buildContentOpf() {
    const dc = 'http://purl.org/dc/elements/1.1/';
    const opfNs = 'http://www.idpf.org/2007/opf';
    const modifiedDate = new Date().toISOString().substring(0, 19) + 'Z';

    let manifestXml = this.manifestItems
      .map(
        (item) =>
          `<item id="${item.id}" href="${item.href}" media-type="${
            item.mediaType
          }" ${item.properties ? `properties="${item.properties}"` : ''}/>`,
      )
      .join('\n    ');

    let spineXml = this.spineOrder
      .map((idref) => `<itemref idref="${idref}"/>`)
      .join('\n    ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="${opfNs}" unique-identifier="BookId" version="${this.metadata.epubVersion}">
  <metadata xmlns:dc="${dc}" xmlns:opf="${opfNs}">
    <dc:title>${sanitizeHtmlContent(this.metadata.title)}</dc:title>
    <dc:creator id="author">${sanitizeHtmlContent(this.metadata.author)}</dc:creator>
    <meta refines="#author" property="role" scheme="marc:relators">aut</meta>
    <dc:language>${this.metadata.language}</dc:language>
    <dc:identifier id="BookId">${this.metadata.uuid}</dc:identifier>
    <meta property="dcterms:modified">${modifiedDate}</meta>
    ${
      this.metadata.coverImageId
        ? `<meta name="cover" content="${this.metadata.coverImageId}"/>`
        : ''
    }
  </metadata>
  <manifest>
    ${manifestXml}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${
      this.metadata.epubVersion === '3.0'
        ? '<item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        : ''
    }
  </manifest>
  <spine toc="ncx">
    ${spineXml}
  </spine>
</package>`;
  }

  buildTocNcx() {
    let navPointsXml = this.tocEntries
      .map(
        (entry) => `
    <navPoint id="${
      entry.id || `navpoint-${entry.playOrder}`
    }" playOrder="${entry.playOrder}">
      <navLabel><text>${entry.title}</text></navLabel>
      <content src="${entry.href}"/>
    </navPoint>`,
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${this.metadata.language}">
  <head>
    <meta name="dtb:uid" content="${this.metadata.uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${sanitizeHtmlContent(this.metadata.title)}</text></docTitle>
  <navMap>
    ${navPointsXml}
  </navMap>
</ncx>`;
  }

  buildTocXhtml() {
    // This is the HTML content for the actual Table of Contents *page* in the EPUB.
    // It should list the chapters for human readers.
    let listItemsXml = this.tocEntries
      .filter(entry => entry.id !== 'nav-toc-page') // Don't list the ToC page itself in the ToC list
      .map((entry) => `<li><a href="${entry.href}">${entry.title}</a></li>`)
      .join('\n      ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${this.metadata.language}" lang="${this.metadata.language}">
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
    this.oebps.file('content.opf', this.buildContentOpf());
    this.oebps.file('toc.ncx', this.buildTocNcx());
    // --- CRITICAL FIX: Ensure toc.xhtml is written to the ZIP ---
    // The toc.xhtml file is the EPUB3 navigation document, which can also serve as the human-readable ToC page.
    if (this.metadata.epubVersion === '3.0') {
      this.oebps.file('toc.xhtml', this.buildTocXhtml()); // This writes the EPUB3 Nav Doc
    }

    return this.zip.generateAsync({
      type: 'blob',
      mimeType: 'application/epub+zip',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 6,
      },
    });
  }
}

// --- Main Exported Functions (for use by epub_creator.js) ---

/**
 * Fetches a paginated list of post stubs from Kemono.su's posts-legacy API endpoint.
 * This endpoint provides post titles, published dates, and a reliable total count.
 * @param {string} service - The service ID (e.g., 'patreon').
 * @param {string} creatorId - The creator's ID.
 * @param {number} offset - The offset for pagination (how many posts to skip).
 * @param {number} limit - The number of posts to fetch per page.
 * @returns {Promise<{posts: Array<object>, totalCount: number}>} - Array of post stubs and the total count from the API.
 */
export const fetchPostListPage = async (
  service,
  creatorId,
  offset,
  limit = POSTS_PER_PAGE_FOR_LIST,
) => {
  const url = `${KEMONO_API_BASE_URL}/${service}/user/${creatorId}/posts-legacy?o=${offset}&limit=${limit}`;
  try {
    const data = await HttpClient.fetchJson(url);
    const results = data.results || [];
    const totalCount = data.props?.count || 0;

    const posts = results.map((post) => ({
      id: String(post.id),
      title: post.title || `Untitled Post ${post.id}`,
      published: post.published,
      originalOffset: offset,
    }));
    return { posts, totalCount };
  } catch (error) {
    console.error(
      `Error fetching post list page (offset ${offset}) for ${service}/${creatorId}:`,
      error,
    );
    throw error;
  }
};


/**
 * Generates an EPUB file from selected Kemono posts and triggers a download.
 * @param {object} creatorInfo - { service, creatorId, creatorName }
 * @param {Array<object>} selectedPostStubs - Array of { id, title, published, originalOffset } for selected posts.
 * @param {object} options - { fileName: string, coverImageUrl?: string }
 * @param {function(number, string): void} progressCallback - Callback for progress updates (percentage, message).
 */
export const generateKemonoEpub = async (
  creatorInfo,
  selectedPostStubs,
  options,
  progressCallback,
) => {
  if (typeof JSZip === 'undefined') throw new Error('JSZip library not found.');
  if (typeof saveAs === 'undefined') throw new Error('FileSaver.js library not found (saveAs function).');

  // Helper function for the parser to report its internal messages
  // This function does NOT update the main progress percentage, only the message
  const parserProgressReporter = (message) => {
      progressCallback(-1, message); // Use -1 for percentage to indicate it's just a message update
  };

  const parser = new KemonoContentParser(
    creatorInfo.service,
    creatorInfo.creatorId,
    parserProgressReporter, // Pass the new reporter function
  );

  const packer = new EpubPacker({
    title: creatorInfo.creatorName || 'Untitled Creator EPUB',
    author: creatorInfo.creatorName || 'Unknown',
    uuid: `urn:uuid:${creatorInfo.service}-${
      creatorInfo.creatorId
    }-${new Date().getTime()}`,
    language: 'en',
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

  progressCallback(currentProgress, 'Initializing EPUB structure and cover...');
  if (options.coverImageUrl) {
    try {
      const coverBlob = await HttpClient.fetchBlob(options.coverImageUrl);
      const coverExt = options.coverImageUrl.split('.').pop()?.toLowerCase() || 'jpeg';
      const coverMime = `image/${coverExt === 'jpg' ? 'jpeg' : coverExt}`;
      const coverFilename = `cover.${coverExt}`;
      packer.addCoverImage(coverBlob, coverFilename, coverMime);
      progressCallback(currentProgress, `Fetched cover image: ${options.coverImageUrl.substring(0, 40)}...`);
    } catch (e) {
      console.warn('Failed to fetch or add cover image:', e);
      progressCallback(currentProgress, `Warning: Could not add cover. ${e.message.substring(0, 30)}`);
    }
  }
  currentProgress += WEIGHT_SETUP;
  progressCallback(currentProgress, 'Setup complete.');

  if (selectedPostStubs.length > 0) {
    progressCallback(currentProgress, `Preparing for bulk fetch (${selectedPostStubs.length} posts)...`);
    try {
      await parser.prepareForBulkFetch(selectedPostStubs);
    } catch (error) {
      console.error('Error during bulk fetch preparation phase:', error);
      progressCallback(currentProgress, `Bulk fetch prep failed: ${error.message.substring(0, 30)}`);
    }
  }
  currentProgress += WEIGHT_BULK_FETCH;
  progressCallback(currentProgress, 'Bulk fetch phase finished. Processing individual posts...');

  const numSelectedPosts = selectedPostStubs.length;
  for (let i = 0; i < numSelectedPosts; i++) {
    const postStub = selectedPostStubs[i];
    const postProgressFraction = (WEIGHT_PROCESS_POSTS / numSelectedPosts); // Fraction of WEIGHT_PROCESS_POSTS for one post
    const postProgressStart = currentProgress; // Capture current overall progress before this post
    const postProgressThisPostSection = i * postProgressFraction;

    // Report the overall progress based on the completion of previous posts
    progressCallback(
      Math.min(100, currentProgress),
      `Processing chapter ${i + 1} of ${numSelectedPosts}: ${postStub.title.substring(0, 30)}...`,
    );

    try {
      // The parser's internal progress reporter will handle messages for its sub-tasks
      const postFullData = await parser.fetchPostFullData(postStub.id);
      if (!postFullData) {
        console.warn(`Skipping post ${postStub.id} (fetch failure).`);
        // Manually advance progress for skipped post
        currentProgress += postProgressFraction;
        progressCallback(Math.min(100, currentProgress), `Skipped: ${postStub.title}`);
        continue;
      }

      // The parser's internal progress reporter will handle messages for its sub-tasks
      const { updatedHtml, imagesToPackage } = await parser.processPostImagesAndContent(postFullData);

      for (const imgInfo of imagesToPackage) {
        packer.addImageToManifest(imgInfo);
      }

      packer.addChapter(postFullData.title || 'Untitled Post', updatedHtml, postStub.id);

      // Increment the overall progress by the fraction assigned to this post
      currentProgress += postProgressFraction;
      progressCallback(Math.min(100, currentProgress), `Processed chapter ${i + 1} of ${numSelectedPosts}: ${postStub.title}`);
    } catch (error) {
      console.error(`Error processing post ${postStub.id} (${postStub.title}):`, error);
      // Ensure progress still advances even on error
      currentProgress += postProgressFraction;
      progressCallback(Math.min(100, currentProgress), `Error on chapter ${i + 1} of ${numSelectedPosts}: ${postStub.title.substring(0, 20)}... - ${error.message.substring(0, 30)}`);
    }
  }

  // Ensure currentProgress is capped before the final packing phase, in case of floating point issues
  currentProgress = WEIGHT_SETUP + WEIGHT_BULK_FETCH + WEIGHT_PROCESS_POSTS;
  progressCallback(currentProgress, 'All posts processed. Finalizing EPUB...');

  // --- NEW: Add Table of Contents page if more than one chapter ---
  if (packer.tocEntries.length > 1) { // Check number of actual chapters added (excluding cover)
      packer.addTableOfContentsPage();
  }

  // Final packing progress
  const finalProgress = currentProgress + WEIGHT_PACKING;
  progressCallback(finalProgress, 'Finalizing EPUB file...');
  const epubBlob = await packer.packToBlob();

  progressCallback(100, 'EPUB generated and download started!');
  saveAs(epubBlob, sanitizeFilename(options.fileName || 'kemono_ebook.epub'));
};