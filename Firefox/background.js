// background.js

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openEpubCreatorTab') {
    const { service, creatorId, creatorName } = request;

    // Encode parameters for URL
    const encodedService = encodeURIComponent(service);
    const encodedCreatorId = encodeURIComponent(creatorId);
    const encodedCreatorName = encodeURIComponent(creatorName || '');

    // Construct the URL for your HTML UI file
    const url = chrome.runtime.getURL(
      `epub_creator.html?service=${encodedService}&id=${encodedCreatorId}&name=${encodedCreatorName}`,
    );

    chrome.tabs.create({ url: url }, (newTab) => {
      if (chrome.runtime.lastError) {
        console.error(
          'Error opening new tab:',
          chrome.runtime.lastError.message,
        );
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        console.log('New tab opened:', newTab.id);
        sendResponse({ success: true, tabId: newTab.id });
      }
    });

    // Return true to indicate that you will send a response asynchronously
    return true;
  }
});