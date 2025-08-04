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
  // Allow extra segments (e.g., /posts), exclude single-post pages
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
    chrome.runtime.sendMessage(
      {
        action: "openEpubCreatorTab",
        service,
        creatorId,
        creatorName: creatorName || ""
      },
      () => {}
    );
  });

  actionsDiv.appendChild(btn);
  return true;
}

function waitForActionsAndInject(params, creatorName, timeoutMs = 3000) {
  const start = performance.now();

  function tryInject() {
    if (injectEpubButton(params, creatorName)) return;
    if (performance.now() - start >= timeoutMs) return;
    requestAnimationFrame(tryInject);
  }

  tryInject();
}

(function () {
  if (!isKemonoCr()) return;
  if (!isCreatorPagePath(window.location.pathname)) return;

  const params = getServiceAndCreatorIdFromPath(window.location.pathname);
  if (!params) return;

  const name = getCreatorName();
  waitForActionsAndInject(params, name);
})();
