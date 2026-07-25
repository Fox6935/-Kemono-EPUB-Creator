if (!globalThis.ExtensionSites && typeof importScripts === "function") {
  importScripts("siteConfig.js");
}

function creatorParamsFromUrl(rawUrl) {
  const url = new URL(rawUrl);
  const site = ExtensionSites.fromHostname(url.hostname);
  if (!site) return null;
  const match = url.pathname.match(/^\/([^/]+)\/user\/([^/]+)/);
  if (!match) return null;
  return { site: site.key, service: match[1], creatorId: match[2] };
}

function openCreatorTab(params = {}) {
  const query = new URLSearchParams();
  if (params.site) query.set("site", params.site);
  if (params.service) query.set("service", params.service);
  if (params.creatorId) query.set("id", params.creatorId);
  if (params.creatorName) query.set("name", params.creatorName);
  if (params.permissionError) {
    query.set("permissionError", params.permissionError);
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  return chrome.tabs.create({
    url: chrome.runtime.getURL(`index.html${suffix}`),
    active: true
  });
}

async function requestSiteAccess(site) {
  const origins = Array.isArray(site?.permissionOrigins)
    ? site.permissionOrigins
    : [];
  if (origins.length === 0 || !chrome.permissions?.request) return true;

  try {
    // Keep this as the first asynchronous browser call made by the toolbar
    // click handler. Firefox requires permission prompts to originate from a
    // direct user action.
    return await chrome.permissions.request({ origins });
  } catch (requestError) {
    // Chrome can reject a request for an install-time permission even when it
    // is already granted. Confirm the effective permission before failing.
    try {
      return await chrome.permissions.contains({ origins });
    } catch {
      console.warn("Could not verify site access:", requestError);
      return false;
    }
  }
}

chrome.action.onClicked.addListener(async (clickedTab) => {
  try {
    const activeTab = clickedTab?.url
      ? clickedTab
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const parsed = activeTab?.url ? creatorParamsFromUrl(activeTab.url) : null;
    if (parsed) {
      const site = ExtensionSites.get(parsed.site);
      const accessGranted = await requestSiteAccess(site);
      if (!accessGranted) {
        await openCreatorTab({
          ...parsed,
          permissionError:
            `${site.name} access was not granted. Click the extension icon ` +
            "again and allow site access, then reload the creator page."
        });
        return;
      }

      // Manifest content scripts are injected on navigation. Reloading after
      // a newly granted Firefox host permission makes the page button appear.
      if (Number.isInteger(activeTab.id)) {
        await chrome.tabs.reload(activeTab.id).catch((error) => {
          console.warn("Could not reload the creator page:", error);
        });
      }
    }
    await openCreatorTab(parsed || {});
  } catch (error) {
    console.error("Could not open EPUB creator:", error);
    await openCreatorTab();
  }
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== "openEpubCreatorTab") return false;
  void openCreatorTab({
    site: request.site,
    service: request.service,
    creatorId: request.creatorId,
    creatorName: request.creatorName
  }).catch((error) => {
    console.error("Could not open EPUB creator from page button:", error);
  });
  return false;
});
