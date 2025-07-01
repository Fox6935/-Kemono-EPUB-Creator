// content-script.js

// --- URL Parsing & Validation ---

/**
 * Extracts service and creator ID from the current URL if it's a target page.
 * @returns {object|null} { service, creatorId } if on a valid creator page, null otherwise.
 */
function getServiceAndCreatorIdFromUrl() {
  const path = window.location.pathname;
  const match = path.match(/^\/(.+?)\/user\/(\d+)(?:\/.*)?$/);

  if (match && match[1] && match[2]) {
    const service = match[1];
    const creatorId = match[2];

    if (path.includes('/post/')) return null;
    if (path.includes('/api/v1/')) return null;

    return { service, creatorId };
  }
  return null;
}

/**
 * Checks if the current URL is one where the EPUB button should be injected.
 * @returns {boolean}
 */
function isTargetPageForInjection() {
  const url = window.location.href;

  if (!url.startsWith('https://kemono.su/')) {
    return false;
  }

  const creatorPageGeneralMatch = url.match(/^https:\/\/kemono\.su\/[^/]+\/user\/\d+/);
  if (!creatorPageGeneralMatch) {
    return false;
  }

  if (url.includes('/account/favorites/artists')) return false;
  if (url.includes('/api/v1/')) return false;
  if (url.match(/\/user\/\d+\/post\/\d+/)) return false;

  return true;
}

/**
 * Gets the creator's name from the page's header.
 * @returns {string|null} Creator's name or null if not found.
 */
function getCreatorName() {
  const creatorNameElement = document.querySelector(
    '.user-header__name span[itemprop="name"]',
  );
  return creatorNameElement ? creatorNameElement.textContent.trim() : null;
}


// --- Button Injection Logic ---

/**
 * Attempts to inject the "Download EPUB" button into the page.
 * @param {object} params - Object containing {service, creatorId}.
 * @param {string} creatorName - The creator's name.
 * @returns {boolean} - True if the button was successfully injected or already existed, false otherwise.
 */
function injectEpubButton(params, creatorName) {
  const targetDiv = document.querySelector('.user-header__actions');
  if (targetDiv) {
    const existingButton = document.getElementById('kemono-epub-download-button');
    if (existingButton) {
        if (existingButton.dataset.creatorId !== params.creatorId) {
            existingButton.parentNode.removeChild(existingButton); // Remove stale button
        } else {
            return true; // Button already exists for this creator
        }
    }

    const downloadButton = document.createElement('button');
    downloadButton.id = 'kemono-epub-download-button';
    downloadButton.className = '_favoriteButton_377bd2a';
    downloadButton.style.marginLeft = '10px';
    downloadButton.textContent = 'Download EPUB';
    downloadButton.title = 'Generate an EPUB from this creator\'s posts';
    downloadButton.dataset.creatorId = params.creatorId;

    targetDiv.appendChild(downloadButton);
    console.log(`[EPUB] Button injected for ${creatorName || params.creatorId}.`);

    downloadButton.addEventListener('click', () => {
      chrome.runtime.sendMessage(
        {
          action: 'openEpubCreatorTab',
          service: params.service,
          creatorId: params.creatorId,
          creatorName: creatorName,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error(
              '[EPUB] Error sending message to background script:',
              chrome.runtime.lastError.message,
            );
          }
        },
      );
    });
    return true; // Button injected successfully
  }
  return false; // Target div not found
}


// --- Main Script Execution ---

(function() { // Wrap in an IIFE for local scope

  let pollIntervalId = null; // ID for the polling interval
  let pollAttempts = 0;      // Counter for polling attempts
  const MAX_POLLING_ATTEMPTS = 50; // Try 50 times (50 * 100ms = 5 seconds)
  const POLL_INTERVAL_MS = 100;    // Check every 100 milliseconds

  // This function is the core of our polling strategy
  function executeInjectionLogic() {
    // If not a target page, exit and clean up any ongoing polls
    if (!isTargetPageForInjection()) {
      console.log('Content script: Not on a target Kemono creator page. Stopping checks.');
      clearInterval(pollIntervalId); // Stop polling if not on target page
      return;
    }

    // Attempt to inject. If successful, clear the interval.
    const urlParams = getServiceAndCreatorIdFromUrl();
    if (urlParams && injectEpubButton(urlParams, getCreatorName())) {
      console.log('Button injected successfully. Stopping poll.');
      clearInterval(pollIntervalId); // Success! Stop polling.
      return;
    }

    // If we've reached max attempts without success, stop polling and log an error.
    pollAttempts++;
    if (pollAttempts >= MAX_POLLING_ATTEMPTS) {
      console.error('EPUB button injection failed: Target div not found after maximum polling attempts.');
      clearInterval(pollIntervalId); // Give up
    }
  }

  // --- Initial Trigger ---
  // Run the injection logic once immediately at document_idle.
  // Then, if not successful, start a polling interval.
  console.log('[EPUB] Content script started. Initial injection attempt.');
  if (!isTargetPageForInjection() || !getServiceAndCreatorIdFromUrl() || !injectEpubButton(getServiceAndCreatorIdFromUrl(), getCreatorName())) {
    console.log('Initial injection failed or not on target page. Starting polling interval.');
    // Start polling if initial attempt failed
    pollIntervalId = setInterval(executeInjectionLogic, POLL_INTERVAL_MS);
  } else {
    console.log('Button injected immediately on initial check.');
    // If immediate injection succeeded, no need to start polling.
  }

})(); // End of IIFE