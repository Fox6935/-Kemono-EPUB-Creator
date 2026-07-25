// content-script.js

function getCurrentSite() {
  try {
    return ExtensionSites.fromHostname(window.location.hostname);
  } catch {
    return null;
  }
}

function isCreatorPagePath(pathname) {
  const creatorBase = /^\/[^/]+\/user\/[^/]+(?:\/.*)?$/;
  const isCreator = creatorBase.test(pathname);
  const isSinglePost = /\/user\/[^/]+\/post\/[^/]+/.test(pathname);
  return isCreator && !isSinglePost;
}

function isSinglePostPath(pathname) {
  return /\/user\/[^/]+\/post\/[^/]+/.test(pathname);
}

function getServiceAndCreatorIdFromPath(pathname) {
  const m = pathname.match(/^\/([^/]+)\/user\/([^/]+)(?:\/.*)?$/);
  if (!m) return null;
  return { service: m[1], creatorId: m[2] };
}

function getCreatorName() {
  const el = document.querySelector('.user-header__name span[itemprop="name"]');
  const fallback = document.querySelector(".user-header__name");
  return (el || fallback)?.textContent.trim() || null;
}

function createEpubButton(id, label, title) {
  const btn = document.createElement("button");
  btn.id = id;
  btn.className = "kemono-epub-button";
  btn.type = "button";
  btn.title = title;

  const icon = document.createElement("span");
  icon.className = "kemono-epub-button__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "↓";

  const text = document.createElement("span");
  text.className = "kemono-epub-button__label";
  text.textContent = label;

  btn.append(icon, text);
  return btn;
}

function ensureEpubButton(actionsDiv, id, label, title) {
  let btn = document.getElementById(id);
  const isReusable =
    btn &&
    btn.parentElement === actionsDiv &&
    btn.classList.contains("kemono-epub-button");

  if (!isReusable) {
    btn?.remove();
    btn = createEpubButton(id, label, title);
    actionsDiv.appendChild(btn);
  } else {
    btn.title = title;
    const labelElement = btn.querySelector(".kemono-epub-button__label");
    if (labelElement) labelElement.textContent = label;
  }

  return btn;
}

function decodeAttachmentName(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function scrapePawchiveAttachments(root = document) {
  const links = root.querySelectorAll(
    ".post__files a[download][href], a.post__attachment-link[href]"
  );
  const attachments = [];
  const seenPaths = new Set();

  for (const link of links) {
    try {
      const url = new URL(link.getAttribute("href"), window.location.href);
      if (
        url.hostname !== "file.pawchive.pw" ||
        !url.pathname.startsWith("/data/")
      ) {
        continue;
      }

      const pathKey = `${url.origin}${url.pathname}`;
      if (seenPaths.has(pathKey)) continue;
      seenPaths.add(pathKey);

      const textName = link.textContent.trim().replace(/^Download\s+/i, "");
      const filename = decodeAttachmentName(
        link.getAttribute("download") ||
        url.searchParams.get("f") ||
        textName ||
        url.pathname.split("/").pop()
      );
      if (!filename) continue;

      attachments.push({
        name: filename,
        path: url.href
      });
    } catch {
      // Ignore malformed download links while preserving the rest of the post.
    }
  }

  return attachments;
}

function injectEpubButton({ service, creatorId }, creatorName, site) {
  const actionsDiv = document.querySelector(".user-header__actions");
  
  if (!actionsDiv) return false;
  const btn = ensureEpubButton(
    actionsDiv,
    "kemono-epub-download-button",
    "Download EPUB",
    "Generate an EPUB from this creator's posts"
  );

  btn.onclick = () => {
    const currentSite = getCurrentSite() || site;
    const currentParams =
      getServiceAndCreatorIdFromPath(window.location.pathname) ||
      { service, creatorId };
    const currentName = getCreatorName() || creatorName || "";
    chrome.runtime.sendMessage(
      {
        action: "openEpubCreatorTab",
        site: currentSite.key,
        service: currentParams.service,
        creatorId: currentParams.creatorId,
        creatorName: currentName
      },
      () => {
        // Read lastError so a transient extension shutdown does not emit an
        // unchecked callback warning.
        void chrome.runtime.lastError;
      }
    );
  };

  return true;
}

// --- NEW FEATURES FOR SINGLE POST ---

function scrapeSinglePostData() {
  const site = getCurrentSite();
  const titleEl = document.querySelector('.post__title span:first-child');
  const title = titleEl ? titleEl.textContent.trim() : "Untitled Post";

  const timeEl = document.querySelector('.post__published time');
  const publishedContainer = document.querySelector(".post__published");
  const publishedText = publishedContainer?.textContent || "";
  const textDate = publishedText.match(
    /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/
  )?.[0];
  const published =
    timeEl?.getAttribute("datetime") ||
    textDate ||
    new Date().toISOString();

  const contentEl = document.querySelector('.post__content');
  let content = "";
  if (contentEl) {
    // Clone to manipulate without affecting the actual page
    const clone = contentEl.cloneNode(true);
    
    // 1. Remove scripts or ad containers
    const scripts = clone.querySelectorAll('script, .ad-container');
    scripts.forEach(s => s.remove());

    content = clone.innerHTML;
  }

  // Get Creator Name from the single post header or user link
  let creatorName = "Unknown";
  const userLink = document.querySelector('.post__user-name');
  if (userLink) creatorName = userLink.textContent.trim();

  // Get Service/ID from URL
  const pathParams = getServiceAndCreatorIdFromPath(window.location.pathname);
  const postIdMatch = window.location.pathname.match(/post\/([^/]+)/);
  const postId = postIdMatch ? postIdMatch[1] : Date.now().toString();
  const attachments =
    site?.key === "pawchive" ? scrapePawchiveAttachments() : [];

  return {
    site: site?.key || "kemono",
    service: pathParams ? pathParams.service : 'unknown',
    creatorId: pathParams ? pathParams.creatorId : '0',
    creatorName,
    id: postId,
    title,
    published,
    content,
    attachments,
    _epubComplete: true
  };
}

function showDownloadConfirmationModal(postData) {
  // Remove existing modal if any
  const existing = document.getElementById("epub-single-modal-overlay");
  if (existing) existing.remove();

  // Create Overlay
  const overlay = document.createElement("div");
  overlay.id = "epub-single-modal-overlay";
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); z-index: 9999;
    display: flex; justify-content: center; align-items: center;
    font-family: sans-serif;
  `;

  // Create Modal Box
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "epub-single-modal-title");
  modal.style.cssText = `
    background: #2c2c2c; color: #e0e0e0; padding: 20px;
    border-radius: 8px; width: 400px; max-width: 90%;
    box-shadow: 0 4px 10px rgba(0,0,0,0.5);
    display: flex; flex-direction: column; gap: 15px;
  `;

  // Title
  const head = document.createElement("h3");
  head.id = "epub-single-modal-title";
  head.textContent = "Download Post as EPUB";
  head.style.marginTop = "0";

  // Filename Input
  const label = document.createElement("label");
  label.textContent = "Filename:";
  label.style.fontSize = "0.9em";
  
  const input = document.createElement("input");
  input.id = "epub-single-filename";
  label.htmlFor = input.id;
  input.type = "text";
  const safeTitle =
    postData.title
      .replace(/[\u0000-\u001F\u007F\/\\?%*:|"<>]/g, "_")
      .trim()
      .replace(/[. ]+$/g, "") ||
    "post";
  input.value = `${safeTitle}.epub`;
  input.style.cssText = `
    padding: 8px; width: 100%; background: #3a3a3a; 
    border: 1px solid #555; color: white; border-radius: 4px;
  `;

  // Progress/Status Text (to show while generating)
  const statusText = document.createElement("div");
  statusText.style.fontSize = "0.9em";
  statusText.style.color = "#aaa";
  statusText.style.minHeight = "1.2em";

  // Buttons
  const btnContainer = document.createElement("div");
  btnContainer.style.cssText = "display: flex; justify-content: flex-end; gap: 10px;";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = "padding: 8px 16px; cursor: pointer; background: #444; border: none; color: white; border-radius: 4px;";
  let generationController = null;
  const closeModal = () => {
    generationController?.abort(
      new DOMException("Generation cancelled.", "AbortError")
    );
    overlay.remove();
  };
  cancelBtn.onclick = closeModal;

  const confirmBtn = document.createElement("button");
  confirmBtn.textContent = "Download";
  confirmBtn.style.cssText = "padding: 8px 16px; cursor: pointer; background: #0056b3; border: none; color: white; border-radius: 4px;";
  
  // --- CLICK HANDLER WITH DYNAMIC IMPORT ---
  confirmBtn.onclick = async () => {
    generationController = new AbortController();
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Generating...";
    statusText.textContent = "Loading modules...";
    statusText.style.color = "#aaa";

    try {
      // 1. Dynamic Import of the Generator
      const { generateKemonoEpub } = await import(chrome.runtime.getURL("EpubGenerator.js"));
      // 2. Prepare Data
      const creatorInfo = {
        site: postData.site,
        service: postData.service,
        creatorId: postData.creatorId,
        creatorName: postData.creatorName
      };

      const selectedPostStubs = [postData]; // Pass the full data object

      const options = {
        fileName: input.value || "post.epub",
        coverImageUrl: null,
        signal: generationController.signal
      };

      // 3. Run Generator
      statusText.textContent = "Processing content...";
      
      await generateKemonoEpub(
        creatorInfo,
        selectedPostStubs,
        options,
        (progress, msg) => {
          // Update status text with progress
          statusText.textContent = msg || `Progress: ${Math.floor(progress)}%`;
        }
      );

      // 4. Close on success
      setTimeout(() => overlay.remove(), 1000);

    } catch (err) {
      if (err?.name === "AbortError") {
        overlay.remove();
        return;
      }
      console.error(err);
      statusText.textContent = "Error: " + err.message;
      statusText.style.color = "#ff8080";
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Retry";
    }
  };

  btnContainer.appendChild(cancelBtn);
  btnContainer.appendChild(confirmBtn);

  modal.appendChild(head);
  modal.appendChild(label);
  modal.appendChild(input);
  modal.appendChild(statusText); // Add status below input
  modal.appendChild(btnContainer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });
  input.focus();
}

function injectSinglePostButton() {
  const actionsDiv = document.querySelector(".post__actions");
  
  if (!actionsDiv) return false;
  const btn = ensureEpubButton(
    actionsDiv,
    "kemono-single-epub-btn",
    "Download Post",
    "Download this post as a standalone EPUB"
  );

  btn.onclick = () => {
    try {
      const data = scrapeSinglePostData();
      showDownloadConfirmationModal(data);
    } catch (e) {
      console.error("Error scraping post data:", e);
      alert("Could not parse post data. See console.");
    }
  };

  return true;
}

// --- MAIN INJECTOR LOGIC ---

function runInjector() {
  const site = getCurrentSite();
  if (!site) return;
  
  const pathname = window.location.pathname;

  // --- Case 1: Creator Page ---
  if (isCreatorPagePath(pathname)) {
    document.getElementById("kemono-single-epub-btn")?.remove();
    const params = getServiceAndCreatorIdFromPath(pathname);
    if (params) {
      // Try to inject immediately
      if (injectEpubButton(params, getCreatorName(), site)) return;

      // If failed (DOM not ready), observe until it appears
      const observer = new MutationObserver((mutations, obs) => {
        if (injectEpubButton(params, getCreatorName(), site)) {
          obs.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 5000); // Stop looking after 5s
    }
  }
  
  // --- Case 2: Single Post Page ---
  else if (isSinglePostPath(pathname)) {
    document.getElementById("kemono-epub-download-button")?.remove();
    // Try to inject immediately
    if (injectSinglePostButton()) return;

    // If failed (DOM not ready), observe until it appears
    const observer = new MutationObserver((mutations, obs) => {
      if (injectSinglePostButton()) {
        obs.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 5000); // Stop looking after 5s
  }
}

// Initial Run
runInjector();

// Navigation Handling (SPA support)
let lastUrl = window.location.href;
let injectorTimer = null;

function scheduleInjector(delay = 75) {
  clearTimeout(injectorTimer);
  injectorTimer = setTimeout(runInjector, delay);
}

function isCurrentPageButtonReady() {
  const pathname = window.location.pathname;
  let actionsDiv;
  let button;

  if (isCreatorPagePath(pathname)) {
    actionsDiv = document.querySelector(".user-header__actions");
    button = document.getElementById("kemono-epub-download-button");
  } else if (isSinglePostPath(pathname)) {
    actionsDiv = document.querySelector(".post__actions");
    button = document.getElementById("kemono-single-epub-btn");
  } else {
    return true;
  }

  if (!actionsDiv) return false;
  return button?.parentElement === actionsDiv && typeof button.onclick === "function";
}

const navigationObserver = new MutationObserver(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    scheduleInjector(100);
  } else if (!isCurrentPageButtonReady()) {
    // Pawchive replaces/clones action containers during history navigation.
    // DOM event listeners are not copied by cloneNode, so rebind if needed.
    scheduleInjector();
  }
});

navigationObserver.observe(document.body, { childList: true, subtree: true });
window.addEventListener("popstate", () => scheduleInjector(100));
window.addEventListener("pageshow", () => scheduleInjector());
