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
  btn.className = "_favoriteButton_377bd2a";
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

function runInjector() {
  if (!isKemonoCr()) return;
  
  const pathname = window.location.pathname;
  if (!isCreatorPagePath(pathname)) return;

  const params = getServiceAndCreatorIdFromPath(pathname);
  if (!params) return;

  if (injectEpubButton(params, getCreatorName())) return;

  const observer = new MutationObserver((mutations, obs) => {
    if (document.getElementById("kemono-epub-download-button")) {
      obs.disconnect();
      return;
    }

    if (injectEpubButton(params, getCreatorName())) {
      obs.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(() => observer.disconnect(), 5000);
}

// --- NAVIGATION HANDLING ---

let lastUrl = window.location.href;
runInjector();

const navigationObserver = new MutationObserver(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;

    setTimeout(runInjector, 100); 
  }
});

navigationObserver.observe(document.body, { 
  childList: true, 
  subtree: true 
});

window.addEventListener('popstate', () => {
  setTimeout(runInjector, 100);
});
