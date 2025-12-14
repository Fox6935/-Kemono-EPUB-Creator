// content-script.js

function isKemonoCr() {
  try {
    const u = new URL(window.location.href);
    return u.origin === "https://kemono.cr";
  } catch {
    return false;
  }
}

function isCreatorPagePath(pathname) {
  const creatorBase = /^\/[^/]+\/user\/\d+(?:\/.*)?$/;
  const isCreator = creatorBase.test(pathname);
  const isSinglePost = /\/user\/\d+\/post\/\d+/.test(pathname);
  return isCreator && !isSinglePost;
}

// New function to detect single post path
function isSinglePostPath(pathname) {
  return /\/user\/\d+\/post\/\d+/.test(pathname);
}

function getServiceAndCreatorIdFromPath(pathname) {
  const m = pathname.match(/^\/([^/]+)\/user\/(\d+)(?:\/.*)?$/);
  if (!m) return null;
  return { service: m[1], creatorId: m[2] };
}

function getCreatorName() {
  const el = document.querySelector('.user-header__name span[itemprop="name"]');
  return el ? el.textContent.trim() : null;
}

function injectEpubButton({ service, creatorId }, creatorName) {
  const actionsDiv = document.querySelector(".user-header__actions");
  
  if (!actionsDiv) return false;
  if (document.getElementById("kemono-epub-download-button")) return true;

  const btn = document.createElement("button");
  btn.id = "kemono-epub-download-button";
  btn.className = "_favoriteButton_377bd2a"; // Re-use existing class for styling
  btn.style.marginLeft = "10px";
  btn.type = "button";
  btn.textContent = "Download EPUB";
  btn.title = "Generate an EPUB from this creator's posts";

  btn.addEventListener("click", () => {
    const currentName = getCreatorName() || creatorName || "";
    chrome.runtime.sendMessage(
      {
        action: "openEpubCreatorTab",
        service,
        creatorId,
        creatorName: currentName
      },
      () => {}
    );
  });

  actionsDiv.appendChild(btn);
  return true;
}

// --- NEW FEATURES FOR SINGLE POST ---

function scrapeSinglePostData() {
  const titleEl = document.querySelector('.post__title span:first-child');
  const title = titleEl ? titleEl.textContent.trim() : "Untitled Post";

  const timeEl = document.querySelector('.post__published time');
  const published = timeEl ? timeEl.getAttribute('datetime') : new Date().toISOString();

  const contentEl = document.querySelector('.post__content');
  let content = "";
  if (contentEl) {
    // Clone to manipulate without affecting the actual page
    const clone = contentEl.cloneNode(true);
    
    // 1. Remove scripts or ad containers
    const scripts = clone.querySelectorAll('script, .ad-container');
    scripts.forEach(s => s.remove());

    // 2. Unwrap <pre> tags (Fix formatting issue)
    const preTags = clone.querySelectorAll('pre');
    preTags.forEach(pre => {
      const parent = pre.parentNode;
      // Move all children of <pre> out to the parent, right before the <pre>
      while (pre.firstChild) {
        parent.insertBefore(pre.firstChild, pre);
      }
      // Remove the empty <pre> tag
      parent.removeChild(pre);
    });

    content = clone.innerHTML;
  }

  // Get Creator Name from the single post header or user link
  let creatorName = "Unknown";
  const userLink = document.querySelector('.post__user-name');
  if (userLink) creatorName = userLink.textContent.trim();

  // Get Service/ID from URL
  const pathParams = getServiceAndCreatorIdFromPath(window.location.pathname);
  const postIdMatch = window.location.pathname.match(/post\/(\d+)/);
  const postId = postIdMatch ? postIdMatch[1] : Date.now().toString();

  return {
    service: pathParams ? pathParams.service : 'unknown',
    creatorId: pathParams ? pathParams.creatorId : '0',
    creatorName,
    id: postId,
    title,
    published,
    content,
    attachments: [] 
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
  modal.style.cssText = `
    background: #2c2c2c; color: #e0e0e0; padding: 20px;
    border-radius: 8px; width: 400px; max-width: 90%;
    box-shadow: 0 4px 10px rgba(0,0,0,0.5);
    display: flex; flex-direction: column; gap: 15px;
  `;

  // Title
  const head = document.createElement("h3");
  head.textContent = "Download Post as EPUB";
  head.style.marginTop = "0";

  // Filename Input
  const label = document.createElement("label");
  label.textContent = "Filename:";
  label.style.fontSize = "0.9em";
  
  const input = document.createElement("input");
  input.type = "text";
  const safeTitle = postData.title.replace(/[\/\\?%*:|"<>]/g, "_").trim();
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
  cancelBtn.onclick = () => overlay.remove();

  const confirmBtn = document.createElement("button");
  confirmBtn.textContent = "Download";
  confirmBtn.style.cssText = "padding: 8px 16px; cursor: pointer; background: #0056b3; border: none; color: white; border-radius: 4px;";
  
  // --- CLICK HANDLER WITH DYNAMIC IMPORT ---
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Generating...";
    statusText.textContent = "Loading modules...";

    try {
      // 1. Dynamic Import of the Generator
      // content-script runs in "Isolated World", so we can import directly if resource is web_accessible
      const { generateKemonoEpub } = await import(chrome.runtime.getURL("EpubGenerator.js"));

      // 2. Prepare Data
      const creatorInfo = {
        service: postData.service,
        creatorId: postData.creatorId,
        creatorName: postData.creatorName
      };

      const selectedPostStubs = [postData]; // Pass the full data object

      const options = {
        fileName: input.value || "post.epub",
        coverImageUrl: null, // Single post usually doesn't have a specific cover configured this way
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
  
  input.focus();
}

function injectSinglePostButton() {
  const actionsDiv = document.querySelector(".post__actions");
  
  if (!actionsDiv) return false;
  if (document.getElementById("kemono-single-epub-btn")) return true;

  const btn = document.createElement("button");
  btn.id = "kemono-single-epub-btn";
  btn.className = "_favoriteButton_377bd2a"; // Reuse Kemono class
  btn.style.marginLeft = "10px";
  btn.type = "button";
  // Add a nice icon or text
  btn.innerHTML = `<span style="font-size:1.2em; margin-right:4px;">⬇</span><span>Download Post</span>`;
  btn.title = "Download this post as a standalone EPUB";

  btn.addEventListener("click", () => {
    try {
      const data = scrapeSinglePostData();
      showDownloadConfirmationModal(data);
    } catch (e) {
      console.error("Error scraping post data:", e);
      alert("Could not parse post data. See console.");
    }
  });

  actionsDiv.appendChild(btn);
  return true;
}

// --- MAIN INJECTOR LOGIC ---

function runInjector() {
  if (!isKemonoCr()) return;
  
  const pathname = window.location.pathname;

  // --- Case 1: Creator Page ---
  if (isCreatorPagePath(pathname)) {
    const params = getServiceAndCreatorIdFromPath(pathname);
    if (params) {
      // Try to inject immediately
      if (injectEpubButton(params, getCreatorName())) return;

      // If failed (DOM not ready), observe until it appears
      const observer = new MutationObserver((mutations, obs) => {
        if (injectEpubButton(params, getCreatorName())) {
          obs.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 5000); // Stop looking after 5s
    }
  }
  
  // --- Case 2: Single Post Page ---
  else if (isSinglePostPath(pathname)) {
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
const navigationObserver = new MutationObserver(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    setTimeout(runInjector, 500); // Slight delay for DOM to settle
  }
});

navigationObserver.observe(document.body, { childList: true, subtree: true });
window.addEventListener('popstate', () => setTimeout(runInjector, 100));
