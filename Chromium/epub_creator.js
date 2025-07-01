// epub_creator.js
// This script contains the pure HTML/JS logic for the EPUB creator UI in a new tab.

// Import necessary modules
import { generateKemonoEpub, fetchPostListPage } from './kemonoEpubGenerator.js';
import { sanitizeAndTruncate, truncateTitle, generateDynamicFilename } from './filenameGenerator.js';


// --- Global variables to simulate React state ---
let allFetchedPosts = []; // Array of all posts loaded from the API, sorted newest-first for display
let selectedPosts = {};   // Object mapping postId to boolean (true if selected, false if not)
let isLoadingPosts = true; // True when initially loading the posts list (first fetch)
let isLoadingMore = false; // True when loading additional pages of posts
let error = null;         // Stores any error messages to display
let currentOffset = 0;    // Tracks the offset for the next `fetchPostListPage` call
let totalAvailablePosts = 0; // ACCURATE: Total posts available from the API (from posts-legacy `count`)

let fileName = '';        // The desired filename for the EPUB
let isFilenameManuallyEdited = false; // NEW: Track if filename was manually edited
let coverImageUrl = '';   // URL for the EPUB cover image
let sampleCover = '';     // URL used for the cover image preview

let isPacking = false;    // True when the EPUB is being packed
let progress = 0;         // Current progress percentage of EPUB packing
let progressMessage = ''; // Message accompanying the progress

// Variables for range selection, storing the IDs of the "From" and "To" posts
let rangeStartId = '';
let rangeEndId = '';

// Variables holding creator info, parsed from URL parameters
let service = '';
let creatorId = '';
let creatorName = '';

// NEW: State for filename generation pattern
let selectedFilenamePattern = 'titles_only'; // Default pattern


// --- Constants ---
const POSTS_PER_PAGE_FOR_LIST = 50; // Number of posts fetched per API page for the list display
const KEMONO_IMG_BASE_URL_DEFAULT_ICON = 'https://img.kemono.su'; // Base URL for Kemono icons, used for default cover
const FILENAME_PATTERN_STORAGE_KEY = 'kemonoEpubFilenamePattern';


// --- DOM Element References ---
let creatorNameDisplay = null;
let fileNameInput = null;
let filenamePatternSelect = null; // NEW: Reference to the new select element
let coverImageUrlInput = null;
let coverPreviewImg = null;
let packEpubButton = null;
let progressBar = null;
let progressMsgSpan = null;
let selectedPostsCountSpan = null;
let totalPostsCountSpan = null;
let selectAllBtn = null;
let unselectAllBtn = null;
let selectRangeStartChapter = null;
let selectRangeEndChapter = null;
let chapterListUl = null;
let loadMoreBtn = null;
let loadAllBtn = null;
let loadMoreMessage = null;
let errorMessageDiv = null;
let noPostsFoundMessage = null;
let mainContentContainer = null;
let mainContentSectionsWrapper = null;
let initialLoadingMessageElement = null;


// --- Utility Functions ---

/** Parses URL query parameters into an object. */
function getQueryParams() {
    const params = {};
    window.location.search.substring(1).split('&').forEach(param => {
        const [key, value] = param.split('=');
        params[key] = decodeURIComponent(value);
    });
    return params;
}

// NOTE: sanitizeAndTruncate and truncateTitle are now imported from filenameGenerator.js

// Moved to filenameGenerator.js for modularity.
// /** Sanitizes text for use in filenames, replacing invalid characters and truncating. */
// function sanitizeAndTruncate(text, maxLength) {
//   if (!text) return '';
//   const sanitized = text.replace(/[<>:"/\\|?*\s]+/g, '_').replace(/__+/g, '_');
//   return sanitized.substring(0, maxLength);
// }

// Moved to filenameGenerator.js for modularity.
// /** Truncates a title string for display, adding "..." if too long. */
// function truncateTitle(title, maxLength = 35) {
//   if (!title) return 'Untitled';
//   return title.length > maxLength ? `${title.substring(0, maxLength)}...` : title;
// }


/**
 * Filters the `allFetchedPosts` array based on the currently selected range.
 * @returns {Array<object>} An array of posts that fall within the current range.
 */
function filterPostsForDisplay() {
    // If no posts loaded, or range isn't set, return all posts.
    if (allFetchedPosts.length === 0 || !rangeStartId || !rangeEndId) {
        return allFetchedPosts;
    }

    // Find the indices of the selected range boundaries in the (newest-first) allFetchedPosts array.
    const startIndex = allFetchedPosts.findIndex((p) => p.id === rangeStartId);
    const endIndex = allFetchedPosts.findIndex((p) => p.id === rangeEndId);

    // If range IDs are no longer valid, return all posts.
    if (startIndex === -1 || endIndex === -1) {
        console.warn('Range filter: Start or end post ID not found in current loaded list.');
        return allFetchedPosts;
    }

    // Determine the actual chronological boundaries based on their indices.
    const firstIndexInList = Math.min(startIndex, endIndex); // Index of the more recent post in the range
    const lastIndexInList = Math.max(startIndex, endIndex);  // Index of the older post in the range

    // Slice the array to get only the posts within the specified range for display.
    return allFetchedPosts.slice(firstIndexInList, lastIndexInList + 1);
}


// --- UI Update Functions ---

/** Updates the display of the current filename in the input field. */
function updateFilenameDisplay() {
    // Only update dynamically if not manually edited
    if (!isFilenameManuallyEdited) {
        const currentlySelectedPostsInOrder = allFetchedPosts
            .filter((post) => selectedPosts[post.id])
            .sort((a, b) => new Date(a.published).getTime() - new Date(b.published).getTime());

        // Use the new generateDynamicFilename function
        fileName = generateDynamicFilename(creatorName, currentlySelectedPostsInOrder, selectedFilenamePattern);
    }
    if (fileNameInput) fileNameInput.value = fileName;
}

/** Populates the range selector dropdowns and sets their selected values. */
function updateRangeSelectorsDisplay() {
    if (selectRangeStartChapter && selectRangeEndChapter) {
        selectRangeStartChapter.innerHTML = '';
        selectRangeEndChapter.innerHTML = '';

        if (allFetchedPosts.length > 0) {
            const newestPostId = allFetchedPosts[0].id;
            const oldestPostId = allFetchedPosts[allFetchedPosts.length - 1].id;

            // Populate "first chapter" dropdown: list posts from newest to oldest for chronological selection
            allFetchedPosts.forEach(post => {
                const option = document.createElement('option');
                option.value = post.id;
                option.textContent = `${truncateTitle(post.title)}`;
                selectRangeStartChapter.appendChild(option);
            });

            // Populate "last chapter" dropdown: list posts from newest to oldest for chronological selection
            allFetchedPosts.forEach(post => {
                const option = document.createElement('option');
                option.value = post.id;
                option.textContent = `${truncateTitle(post.title)}`;
                selectRangeEndChapter.appendChild(option);
            });

            // Set the `rangeStartId` and `rangeEndId` global variables to encompass the full loaded range by default
            let defaultRangeApplied = false;
            if (!rangeStartId || !allFetchedPosts.some(p => p.id === rangeStartId)) {
                rangeStartId = oldestPostId;
                defaultRangeApplied = true;
            }
            if (!rangeEndId || !allFetchedPosts.some(p => p.id === rangeEndId)) {
                rangeEndId = newestPostId;
                defaultRangeApplied = true;
            }

            // Apply these values to the HTML select elements
            selectRangeStartChapter.value = rangeStartId;
            selectRangeEndChapter.value = rangeEndId;

            // Apply the range filter internally after posts load or range defaults, without triggering a full update immediately.
            if (defaultRangeApplied || Object.keys(selectedPosts).length > 0) {
                 handleRangeSelectInternal(rangeStartId, rangeEndId, { autoDeselectOutside: true, suppressUpdate: true });
            }

        } else {
            // No posts loaded, clear range IDs and values
            rangeStartId = '';
            rangeEndId = '';
        }
    }
}

/** Renders or re-renders the list of posts with checkboxes based on `allFetchedPosts` and `selectedPosts`. */
function updateChapterListDisplay() {
  if (!chapterListUl) return;

  chapterListUl.innerHTML = ''; // Clear existing list items

  // Filter posts based on current range selectors before displaying
  const postsToDisplay = filterPostsForDisplay();

  postsToDisplay.forEach((post) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!selectedPosts[post.id]; // Reflects selection state
    input.disabled = isPacking; // Disable during packing
    input.addEventListener('change', () => handlePostSelectionChange(post.id));

    const spanDate = document.createElement('span');
    spanDate.className = 'post-date-epub';
    spanDate.textContent = `(${new Date(post.published).toLocaleDateString()})`;

    label.appendChild(input);
    label.appendChild(document.createTextNode(post.title));
    label.appendChild(spanDate);
    li.appendChild(label);
    chapterListUl.appendChild(li);
  });

  updateSelectedCountsDisplay(); // Update counts after list
  updateRangeSelectorsDisplay(); // Update range selectors (they depend on allFetchedPosts)
}

/** Updates the displayed count of selected posts versus the estimated total available. */
function updateSelectedCountsDisplay() {
  const count = Object.values(selectedPosts).filter(Boolean).length; // Count currently selected posts
  if (selectedPostsCountSpan) selectedPostsCountSpan.textContent = count;

  if (totalPostsCountSpan) {
      if (isLoadingPosts && allFetchedPosts.length === 0) {
          totalPostsCountSpan.textContent = '...'; // Show indeterminate total during initial loading
      } else if (allFetchedPosts.length === 0) {
          totalPostsCountSpan.textContent = '0'; // If no posts loaded, show 0.
      } else {
          // Use the `totalAvailablePosts` directly from the API response for the Y count
          totalPostsCountSpan.textContent = totalAvailablePosts;
      }
  }

  // Update "Pack EPUB" button text and disable/enable state
  if (packEpubButton) {
      packEpubButton.disabled = isPacking || count === 0 || isLoadingPosts || isLoadingMore;
      packEpubButton.textContent = isPacking ? `Packing... ${progress.toFixed(0)}%` : `Pack ${count} Post(s) as EPUB`;
  }
}

/** Updates the display of the cover image preview based on `sampleCover`. */
function updateCoverPreviewDisplay() {
    if (coverPreviewImg) {
        if (sampleCover) {
            coverPreviewImg.src = sampleCover;
            coverPreviewImg.style.display = 'block';
            coverPreviewImg.onerror = function() {
                coverPreviewImg.style.display = 'none'; // Hide if image fails to load
                console.warn('Cover image failed to load, hiding preview.');
            };
        } else {
            coverPreviewImg.style.display = 'none';
            coverPreviewImg.src = ''; // Clear src when no cover URL
        }
    }
}

/**
 * Manages the overall visibility of UI sections (loading message, main content, no posts message)
 * and updates progress/error displays. This is the main "render" function.
 */
function updateOverallUIState() {
    // Update creator name display
    if (creatorNameDisplay) creatorNameDisplay.textContent = creatorName;

    // Update error message display
    if (errorMessageDiv) {
        errorMessageDiv.textContent = error || '';
        errorMessageDiv.style.display = error ? 'block' : 'none';
    }

    // Update packing progress display
    if (progressBar) progressBar.style.display = isPacking ? 'block' : 'none';
    if (progressMsgSpan) progressMsgSpan.style.display = isPacking ? 'inline' : 'none';
    if (progressBar) progressBar.value = progress;
    if (progressMsgSpan) progressMsgSpan.textContent = progressMessage;

    // Disable/enable inputs and controls based on packing state and loading state
    // Filename input should only be disabled if isPacking, NOT if isLoadingPosts/More
    if (fileNameInput) fileNameInput.disabled = isPacking;
    // NEW: Filename pattern select also disabled during packing
    if (filenamePatternSelect) filenamePatternSelect.disabled = isPacking;
    if (coverImageUrlInput) coverImageUrlInput.disabled = isPacking;
    if (selectAllBtn) selectAllBtn.disabled = isPacking;
    if (unselectAllBtn) unselectAllBtn.disabled = isPacking;
    if (selectRangeStartChapter) selectRangeStartChapter.disabled = isPacking || allFetchedPosts.length === 0;
    if (selectRangeEndChapter) selectRangeEndChapter.disabled = isPacking || allFetchedPosts.length === 0;

    // --- Core Logic for Showing/Hiding Sections ---
    const showLoadingMessage = isLoadingPosts && allFetchedPosts.length === 0;
    const showNoPostsMessage = !isLoadingPosts && allFetchedPosts.length === 0 && !error;
    const showMainContentWrapper = !showLoadingMessage && !showNoPostsMessage && !error;

    // Control visibility of the wrapper containing all content sections
    if (mainContentSectionsWrapper) {
        mainContentSectionsWrapper.style.display = showMainContentWrapper ? 'flex' : 'none';
    }

    // Control visibility of the initial loading message
    if (initialLoadingMessageElement) {
        initialLoadingMessageElement.style.display = showLoadingMessage ? 'block' : 'none';
        initialLoadingMessageElement.textContent = `Loading initial posts for ${creatorName}...`;
    }

    // Control visibility of the "No posts found" message
    if (noPostsFoundMessage) {
        noPostsFoundMessage.style.display = showNoPostsMessage ? 'block' : 'none';
    }

    // Control visibility of "Load More/All" buttons and their message
    const showLoadButtons = (allFetchedPosts.length < totalAvailablePosts && !isLoadingMore && !isPacking && !showLoadingMessage && !showNoPostsMessage);
    if (loadMoreBtn) loadMoreBtn.style.display = showLoadButtons ? 'inline-block' : 'none';
    if (loadAllBtn) loadAllBtn.style.display = showLoadButtons ? 'inline-block' : 'none';
    if (loadMoreMessage) {
        loadMoreMessage.style.display = isLoadingMore ? 'block' : 'none';
        loadMoreMessage.textContent = 'Loading more posts...';
    }

    // Always update child UI components that depend on detailed data/state
    updateChapterListDisplay(); // This implicitly updates counts and range selectors
    updateFilenameDisplay();
}


// --- Event Handlers ---

/** Fetches a page of posts from Kemono's API and updates the UI state. */
async function loadPostsPage(offsetToLoad, loadAll = false) {
  if (!service || !creatorId) {
    error = 'Service or Creator ID is missing. Cannot load posts.';
    isLoadingPosts = false;
    isLoadingMore = false;
    updateOverallUIState();
    return;
  }

  // If this is a fresh load (offset 0), clear existing data and selection.
  if (offsetToLoad === 0) {
      allFetchedPosts = [];
      totalAvailablePosts = 0; // Reset total count for a fresh load
      selectedPosts = {};      // Clear selection on a fresh load
  }

  // Set loading flags and clear previous errors
  if (offsetToLoad === 0 && !loadAll) isLoadingPosts = true;
  else isLoadingMore = true;
  error = null;
  updateOverallUIState(); // Update UI to show loading state

  let accumulatedPosts = [...allFetchedPosts]; // Start with current posts if not a fresh load
  let currentFetchOffset = offsetToLoad;
  let stillFetching = true;

  try {
    while (stillFetching) {
      const { posts: newPosts, totalCount: apiTotalCount } = await fetchPostListPage(
        service,
        creatorId,
        currentFetchOffset,
        POSTS_PER_PAGE_FOR_LIST,
      );

      // Update totalAvailablePosts directly with the accurate count from the API
      if (apiTotalCount > totalAvailablePosts) {
          totalAvailablePosts = apiTotalCount;
      }

      // Filter out duplicate posts
      const existingIds = new Set(accumulatedPosts.map((p) => p.id));
      const uniqueNewPosts = newPosts.filter((p) => !existingIds.has(p.id));
      accumulatedPosts = [...accumulatedPosts, ...uniqueNewPosts];

      // Determine if more fetching is needed:
      if (!loadAll || newPosts.length < POSTS_PER_PAGE_FOR_LIST || accumulatedPosts.length >= totalAvailablePosts) {
        stillFetching = false;
      } else {
        currentFetchOffset += newPosts.length;
      }
    }

    // Sort all fetched posts (newest first for general display)
    allFetchedPosts = accumulatedPosts.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());

  } catch (err) {
    error = err.message || 'Failed to load posts.';
    console.error('Error fetching posts for EPUB list:', err);
  } finally {
    isLoadingPosts = false;
    isLoadingMore = false;

    if (allFetchedPosts.length > 0) {
        rangeStartId = allFetchedPosts[allFetchedPosts.length - 1].id; // Oldest post ID
        rangeEndId = allFetchedPosts[0].id; // Newest post ID
        // Apply this range to update dropdowns and filtered display, without suppressing UI update
        handleRangeSelectInternal(rangeStartId, rangeEndId, { autoDeselectOutside: true, suppressUpdate: false });
    } else {
        // If no posts are loaded, ensure range IDs are cleared
        rangeStartId = '';
        rangeEndId = '';
        updateOverallUIState(); // Still trigger UI update for other states (like "no posts found")
    }
    // Note: updateOverallUIState is now called conditionally by handleRangeSelectInternal (if not suppressed),
    // or by the else block above. This ensures only one update triggers.
  }
}

/** Toggles the selection state of a single post checkbox. */
function handlePostSelectionChange(postId) {
  selectedPosts[postId] = !selectedPosts[postId];
  updateOverallUIState();
}

/** Selects all posts currently displayed (filtered by range). */
function handleSelectAllDisplayed() {
  const newSelection = {};
  // ONLY select posts currently displayed (filtered by range)
  const postsCurrentlyDisplayed = filterPostsForDisplay(); // Get the filtered list
  postsCurrentlyDisplayed.forEach((post) => (newSelection[post.id] = true));
  selectedPosts = newSelection;
  isFilenameManuallyEdited = false; // Reset to false to enable dynamic update on select all
  updateOverallUIState();
}

/** Clears all selected posts, unchecking all checkboxes. */
function handleUnselectAllDisplayed() {
  selectedPosts = {};
  isFilenameManuallyEdited = false; // Reset to false to enable dynamic update on unselect all
  updateOverallUIState();
}

/**
 * Event handler for when the "From" or "To" range selectors change.
 * It reads their values and triggers the internal range selection logic.
 */
function handleRangeSelect() {
    const startIdFromSelect = selectRangeStartChapter.value;
    const endIdFromSelect = selectRangeEndChapter.value;
    // Apply the range filter: deselect posts outside the new range, and update display.
    // Reset to false to enable dynamic update on range change
    handleRangeSelectInternal(startIdFromSelect, endIdFromSelect, { autoDeselectOutside: true, suppressUpdate: false });
    isFilenameManuallyEdited = false; // Reset after internal handling, before final UI update
    updateOverallUIState(); // Ensure UI is updated
}

/**
 * Internal logic for applying range selection/filtering.
 * This function is used by the range select dropdowns and also internally to enforce the display range.
 * @param {string} startId - The ID of the post that marks the start of the desired range.
 * @param {string} endId - The ID of the post that marks the end of the desired range.
 * @param {object} [options] - Optional settings.
 * @param {boolean} [options.autoDeselectOutside=false] - If true, posts outside the range are deselected.
 * @param {boolean} [options.suppressUpdate=false] - If true, `updateOverallUIState()` is not called after selection.
 */
function handleRangeSelectInternal(startId, endId, options = {}) {
    const { autoDeselectOutside = false, suppressUpdate = false } = options;

    // Update the global range IDs to reflect the currently selected range
    rangeStartId = startId;
    rangeEndId = endId;

    const startIndex = allFetchedPosts.findIndex((p) => p.id === startId);
    const endIndex = allFetchedPosts.findIndex((p) => p.id === endId);

    // If range IDs are no longer valid (e.g., a post in the range was deleted), warn and update UI.
    if (startIndex === -1 || endIndex === -1) {
        console.warn('Range selection: start or end post ID not found in current loaded list.');
        if (!suppressUpdate) updateOverallUIState();
        return;
    }

    // Determine the actual indices in the newest-first `allFetchedPosts` array
    const firstIndexInList = Math.min(startIndex, endIndex);
    const lastIndexInList = Math.max(startIndex, endIndex);

    // Iterate through all currently fetched posts to adjust their selection status
    allFetchedPosts.forEach((post, index) => {
        const isWithinRange = (index >= firstIndexInList && index <= lastIndexInList);

        if (autoDeselectOutside) {
            // Deselect posts that fall outside the new range.
            // Posts within the range keep their current selection status.
            if (!isWithinRange) {
                selectedPosts[post.id] = false;
            }
        }
    });

    if (!suppressUpdate) {
        updateOverallUIState(); // Trigger UI refresh to update chapter list display and checkbox states
    }
}

// NEW: Event handler for filename pattern change
function handleFilenamePatternChange(event) {
    selectedFilenamePattern = event.target.value;
    localStorage.setItem(FILENAME_PATTERN_STORAGE_KEY, selectedFilenamePattern); // Save preference
    isFilenameManuallyEdited = false; // Reset to false to enable dynamic update
    updateOverallUIState(); // Re-trigger filename display update
}


/** Loads the next page of posts. */
function handleLoadMore() {
  currentOffset = allFetchedPosts.length; // The offset for the next load is the current number of posts loaded.
  if (allFetchedPosts.length < totalAvailablePosts && !isLoadingMore) {
    loadPostsPage(currentOffset);
  }
}

/** Loads all remaining posts. */
function handleLoadAll() {
  if (!isLoadingMore) {
    // Start from offset 0 to ensure all posts are captured from the beginning.
    loadPostsPage(0, true);
  }
}

/** Initiates the EPUB generation process and triggers download. */
async function handlePackEpub() {
  const postsToPackStubs = allFetchedPosts
    .filter((post) => selectedPosts[post.id])
    .sort((a, b) => new Date(a.published).getTime() - new Date(b.published).getTime());

  if (postsToPackStubs.length === 0) {
    alert('Please select at least one post to include in the EPUB.');
    return;
  }

  isPacking = true;
  progress = 0; // Reset progress before starting
  progressMessage = 'Starting EPUB generation...';
  error = null;
  updateOverallUIState();

  try {
    await generateKemonoEpub(
      { service, creatorId, creatorName },
      postsToPackStubs,
      { fileName: fileName || 'kemono_ebook.epub', coverImageUrl: coverImageUrl || undefined },
      (currentProgress, message) => {
        // This callback is invoked by generateKemonoEpub to update progress.
        // `currentProgress` should be a value from 0 to 100.
        progress = currentProgress;
        progressMessage = message;
        updateOverallUIState(); // Re-render the UI to show updated progress
      },
    );
    progressMessage = 'EPUB generated and download started!';
  } catch (err) {
    error = err.message || 'Failed to generate EPUB.';
    console.error('EPUB Packing Error:', err);
    progressMessage = `Error: ${err.message.substring(0, 50)}`;
  } finally {
    isPacking = false;
    // Reset progress bar to 0 or 100 after completion/error for clarity
    progress = 100;
    updateOverallUIState();
  }
}


// --- Initial Setup and Event Listener Attachment ---
/**
 * Initializes DOM element references and attaches all event listeners.
 * This function runs once when the `epub_creator.html` page's DOM is loaded.
 */
function setupUIAndListeners() {
    // Get references to all necessary HTML elements by their IDs.
    creatorNameDisplay = document.getElementById('creator-name-display');
    fileNameInput = document.getElementById('fileNameInput');
    filenamePatternSelect = document.getElementById('filenamePatternSelect'); // NEW
    coverImageUrlInput = document.getElementById('coverImageUrlInput');
    coverPreviewImg = document.getElementById('cover-preview-img');
    packEpubButton = document.getElementById('packEpubButton');
    progressBar = document.getElementById('progressBar');
    progressMsgSpan = document.getElementById('progressMsgSpan');
    selectedPostsCountSpan = document.getElementById('selected-posts-count');
    totalPostsCountSpan = document.getElementById('total-posts-count');
    selectAllBtn = document.getElementById('selectAllBtn');
    unselectAllBtn = document.getElementById('unselectAllBtn');
    selectRangeStartChapter = document.getElementById('selectRangeStartChapter');
    selectRangeEndChapter = document.getElementById('selectRangeEndChapter');
    chapterListUl = document.getElementById('chapterListUl');
    loadMoreBtn = document.getElementById('loadMoreBtn');
    loadAllBtn = document.getElementById('loadAllBtn');
    loadMoreMessage = document.getElementById('loadMoreMessage');
    errorMessageDiv = document.getElementById('error-message-div');
    noPostsFoundMessage = document.getElementById('noPostsFoundMessage');
    mainContentContainer = document.getElementById('epub-creator-container');
    mainContentSectionsWrapper = document.getElementById('main-content-sections-wrapper');

    initialLoadingMessageElement = document.getElementById('initial-loading-message');
    if (!initialLoadingMessageElement) {
        initialLoadingMessageElement = document.createElement('p');
        initialLoadingMessageElement.id = 'initial-loading-message';
        initialLoadingMessageElement.className = 'message-text info-message';
        initialLoadingMessageElement.style.display = 'none';
        mainContentContainer.insertBefore(initialLoadingMessageElement, mainContentContainer.firstChild);
    }

    // Attach all event listeners to the retrieved DOM elements.
    fileNameInput.addEventListener('input', (e) => {
        fileName = e.target.value;
        isFilenameManuallyEdited = true; // User is typing, so set flag
        // No need to call updateFilenameDisplay here, the input's value is already updated
        // We only call it when we want to dynamically set the value from code.
    });
    // NEW: Add event listener for the filename pattern select
    if (filenamePatternSelect) {
        filenamePatternSelect.addEventListener('change', handleFilenamePatternChange);
    }

    coverImageUrlInput.addEventListener('input', (e) => {
        coverImageUrl = e.target.value;
        sampleCover = coverImageUrl;
        updateCoverPreviewDisplay();
    });
    packEpubButton.addEventListener('click', handlePackEpub);
    selectAllBtn.addEventListener('click', handleSelectAllDisplayed);
    unselectAllBtn.addEventListener('click', handleUnselectAllDisplayed);
    selectRangeStartChapter.addEventListener('change', handleRangeSelect);
    selectRangeEndChapter.addEventListener('change', handleRangeSelect);
    loadMoreBtn.addEventListener('click', handleLoadMore);
    loadAllBtn.addEventListener('click', handleLoadAll);

    // Load saved filename pattern from local storage
    const savedPattern = localStorage.getItem(FILENAME_PATTERN_STORAGE_KEY);
    if (savedPattern) {
        selectedFilenamePattern = savedPattern;
        if (filenamePatternSelect) {
            filenamePatternSelect.value = selectedFilenamePattern; // Set the dropdown value
        }
    } else {
        selectedFilenamePattern = 'titles_only'; // Default if nothing saved
        if (filenamePatternSelect) {
            filenamePatternSelect.value = selectedFilenamePattern;
        }
    }


    // Perform an initial UI update based on the default state.
    updateFilenameDisplay(); // Call initially to set default filename
    updateCoverPreviewDisplay();
    updateOverallUIState();
}


// --- Initialization on page load ---
document.addEventListener('DOMContentLoaded', async () => {
    // Parse URL parameters to get creator information passed from the content script.
    const queryParams = getQueryParams();
    service = queryParams.service || '';
    creatorId = queryParams.id || '';
    creatorName = queryParams.name || `Creator ${creatorId}`;

    // First, set up all UI element references and attach their event listeners.
    setupUIAndListeners();

    // Set the default cover image URL if none is provided.
    if (!coverImageUrl) {
        coverImageUrl = `${KEMONO_IMG_BASE_URL_DEFAULT_ICON}/icons/${service}/${creatorId}`;
        sampleCover = coverImageUrl;
        if (coverImageUrlInput) coverImageUrlInput.value = coverImageUrl;
        updateCoverPreviewDisplay();
    }

    // Attempt to load posts if valid service and creator ID are available.
    if (service && creatorId) {
        await loadPostsPage(0);
    } else {
        error = "Missing service or creator ID. Cannot load posts for this creator.";
        isLoadingPosts = false;
        updateOverallUIState();
    }
});