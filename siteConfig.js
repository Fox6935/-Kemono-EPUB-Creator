(function (global) {
  const sites = {
    kemono: {
      key: "kemono",
      name: "Kemono",
      hostname: "kemono.cr",
      siteOrigin: "https://kemono.cr",
      apiOrigin: "https://kemono.cr/api/v1",
      apiAccept: "text/css",
      supportsTags: true,
      profileHasPostCount: true,
      permissionOrigins: [
        "https://kemono.cr/*",
        "https://*.kemono.cr/*"
      ],
      iconUrl(service, creatorId) {
        return `https://img.kemono.cr/icons/${encodeURIComponent(service)}/${encodeURIComponent(creatorId)}`;
      }
    },
    pawchive: {
      key: "pawchive",
      name: "Pawchive",
      hostname: "pawchive.pw",
      siteOrigin: "https://pawchive.pw",
      apiOrigin: "https://pawchive.pw/api/v1",
      apiAccept: "application/json",
      supportsTags: false,
      profileHasPostCount: false,
      permissionOrigins: [
        "https://pawchive.pw/*",
        "https://*.pawchive.pw/*"
      ],
      iconUrl(service, creatorId) {
        return `https://pawchive.pw/icons/${encodeURIComponent(service)}/${encodeURIComponent(creatorId)}`;
      }
    }
  };

  function get(siteKey) {
    const site = sites[siteKey];
    if (!site) throw new Error(`Unsupported source site: ${siteKey || "(missing)"}`);
    return site;
  }

  function fromHostname(hostname) {
    const normalized = String(hostname || "").toLowerCase();
    return Object.values(sites).find(
      (site) => normalized === site.hostname || normalized.endsWith(`.${site.hostname}`)
    ) || null;
  }

  function creatorPath(service, creatorId) {
    return `/${encodeURIComponent(service)}/user/${encodeURIComponent(creatorId)}`;
  }

  function postListUrls(siteKey, service, creatorId, query = {}) {
    const site = get(siteKey);
    const base = `${site.apiOrigin}${creatorPath(service, creatorId)}`;
    const params = new URLSearchParams();
    params.set("o", String(query.offset || 0));
    if (query.tag) params.set("tag", query.tag);
    if (query.q) params.set("q", query.q);
    const suffix = `?${params.toString()}`;
    return siteKey === "pawchive"
      ? [`${base}/posts${suffix}`, `${base}${suffix}`]
      : [`${base}/posts${suffix}`];
  }

  function normalizeAssetUrl(siteKey, value) {
    const site = get(siteKey);
    const source = String(value || "").trim();
    if (!source) return null;

    try {
      let url;
      if (source.startsWith("//")) {
        url = new URL(`https:${source}`);
      } else if (/^https?:\/\//i.test(source)) {
        url = new URL(source);
      } else if (siteKey === "pawchive" && source.startsWith("/data/")) {
        url = new URL(source, "https://file.pawchive.pw");
      } else {
        url = new URL(source, `${site.siteOrigin}/`);
      }
      if (
        siteKey === "pawchive" &&
        url.hostname === "img.pawchive.pw" &&
        url.pathname.startsWith("/thumbnail/data/")
      ) {
        url = new URL(url.pathname.replace(/^\/thumbnail/, ""), "https://file.pawchive.pw");
      }
      url.hash = "";
      return url.href;
    } catch {
      return null;
    }
  }

  global.ExtensionSites = Object.freeze({
    sites: Object.freeze(sites),
    get,
    fromHostname,
    creatorPath,
    postListUrls,
    normalizeAssetUrl
  });
})(globalThis);
