// background.js – Handles extension icon clicks and content-script messages to open EPUB creator

chrome.action.onClicked.addListener(async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.url) {
      console.warn('No active tab found; opening EPUB creator without params');
      chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
      return;
    }

    const url = new URL(activeTab.url);
    let service = '';
    let creatorId = '';
    let creatorName = '';

    if (url.hostname === 'kemono.cr' || url.hostname.includes('kemono.cr')) {
      const pathname = url.pathname;
      const match = pathname.match(/^\/([a-zA-Z0-9_-]+)\/user\/([a-zA-Z0-9_-]+)/);
      if (match) {
        service = match[1];
        creatorId = match[2];
        console.log(`Parsed Kemono page: service=${service}, id=${creatorId}`);
      } else {
        console.log('Active tab is on Kemono but not a creator page; opening without params');
      }
    } else {
      console.log('Active tab not on Kemono; opening without params');
    }

    const params = new URLSearchParams();
    if (service) params.set('service', service);
    if (creatorId) params.set('id', creatorId);
    if (creatorName) params.set('name', creatorName);

    const epubUrl = `index.html${params.toString() ? '?' + params.toString() : ''}`;
    chrome.tabs.create({
      url: chrome.runtime.getURL(epubUrl),
      active: true
    });
  } catch (error) {
    console.error('Error handling icon click:', error);
    chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Existing listener for Creator Tab
  if (request.action === 'openEpubCreatorTab') {
    const { service, creatorId, creatorName } = request;
    const encodedService = encodeURIComponent(service);
    const encodedCreatorId = encodeURIComponent(creatorId);
    const encodedCreatorName = encodeURIComponent(creatorName || '');
    const url = chrome.runtime.getURL(
      `index.html?service=${encodedService}&id=${encodedCreatorId}&name=${encodedCreatorName}`,
    );

    chrome.tabs.create({ url: url });
    return true;
  }
});

