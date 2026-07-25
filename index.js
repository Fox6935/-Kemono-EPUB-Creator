// index.js
// HTML/JS logic for the EPUB creator UI in a new tab.

import {
  generateKemonoEpub,
  fetchPostListPage,
  fetchCreatorProfile,
  fetchTagsList,
  fetchPawchivePostCount
} from "./EpubGenerator.js";
import {
  sanitizeAndTruncate,
  truncateTitle,
  generateDynamicFilename
} from "./filenameGenerator.js";

// --- Global state ---
let allFetchedPosts = [];
let selectedPosts = {};
let isLoadingPosts = true;
let isLoadingMore = false;
let error = null;
let totalAvailablePosts = null;

let fileName = "";
let isFilenameManuallyEdited = false;
let coverImageUrl = "";
let sampleCover = "";

let isPacking = false;
let progress = 0;
let progressMessage = "";
let packingAbortController = null;
let postsLoadController = null;

// Filter state
let currentFilter = { tag: "", q: "" };

let service = "";
let creatorId = "";
let creatorName = "";
let siteKey = "";

let availableTags = [];

let selectedFilenamePattern = "titles_only";

let enableCover = true;

let rangeStartId = "";
let rangeEndId = "";

let totalFetchedOffset = 0;
let atEndOfPosts = false;
let countRequestVersion = 0;

// --- Constants ---
const POSTS_PER_PAGE_FOR_LIST = 50;
const FILENAME_PATTERN_STORAGE_KEY = "kemonoEpubFilenamePattern";
const COVER_ENABLED_STORAGE_KEY = "kemonoEpubCoverEnabled";

// --- DOM refs ---
let creatorNameDisplay = null;
let fileNameInput = null;
let filenamePatternSelect = null;
let coverImageUrlInput = null;
let coverPreviewImg = null;
let enableCoverToggle = null;
let coverImageGroup = null;
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

// Filter UI refs
let tagSelect = null;
let customSearchInput = null;
let applyFilterBtn = null;

// --- Utils ---
function getQueryParams() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

function filterPostsForDisplay() {
  if (allFetchedPosts.length === 0 || !rangeStartId || !rangeEndId) {
    return allFetchedPosts;
  }
  const startIndex = allFetchedPosts.findIndex((p) => p.id === rangeStartId);
  const endIndex = allFetchedPosts.findIndex((p) => p.id === rangeEndId);
  if (startIndex === -1 || endIndex === -1) return allFetchedPosts;

  const firstIndexInList = Math.min(startIndex, endIndex);
  const lastIndexInList = Math.max(startIndex, endIndex);
  return allFetchedPosts.slice(firstIndexInList, lastIndexInList + 1);
}

// Load tags and populate dropdown
async function loadTagsAndPopulateDropdown() {
  if (!service || !creatorId) return;
  const site = ExtensionSites.get(siteKey);
  if (!site.supportsTags) {
    tagSelect.innerHTML = '<option value="custom">Custom Search</option>';
    tagSelect.value = "custom";
    currentFilter.tag = "";
    updateFilterUI();
    return;
  }
  try {
    isLoadingPosts = true;
    availableTags = await fetchTagsList(siteKey, service, creatorId);
    if (tagSelect) {
      tagSelect.innerHTML = `
        <option value="">All Posts (No Filter)</option>
        <option value="custom">Custom Search (q=)</option>
      `;
      availableTags.forEach((tagObj) => {
        const opt = document.createElement("option");
        opt.value = tagObj.tag;
        opt.textContent = `${tagObj.tag} (${tagObj.post_count || 0} posts)`;
        tagSelect.appendChild(opt);
      });
      // Restore current filter if any
      tagSelect.value = currentFilter.tag || "";
      if (tagSelect.value === "custom" && currentFilter.q) {
        if (customSearchInput) customSearchInput.value = currentFilter.q;
      }
    }
    updateFilterUI();
  } catch (err) {
    console.error("Failed to load tags:", err);
    error = "Failed to load tags for filtering. Proceeding without filter options.";
  } finally {
    isLoadingPosts = false;
    updateOverallUIState();
  }
}

// Update filter UI (show/hide custom input)
function updateFilterUI() {
  if (!tagSelect || !customSearchInput) return;
  if (tagSelect.value === "custom") {
    customSearchInput.style.display = "inline-block";
    customSearchInput.value = currentFilter.q || "";
    customSearchInput.focus();
  } else {
    customSearchInput.style.display = "none";
    customSearchInput.value = "";
  }
}

// Handle filter changes
function handleFilterChange(event) {
  updateFilterUI();
}

function handleApplyFilter() {
  const newTag = tagSelect ? tagSelect.value : "";
  let newQ = "";
  if (newTag === "custom") {
    newQ = customSearchInput ? customSearchInput.value.trim() : "";
    if (newQ.length > 0 && newQ.length < 3) {
      alert("Custom search (q=) requires at least 3 characters.");
      return;
    }
  }

  // Update state (clear opposite filter)
  currentFilter = { tag: newTag !== "custom" ? newTag : "", q: newQ };

  // Reset for new filter: Clear data, range, selections, offset, end flag
  rangeStartId = "";
  rangeEndId = "";
  selectedPosts = {};
  totalFetchedOffset = 0;
  atEndOfPosts = false;

  loadPostsPage(0);
}

// Handle cover toggle change
function handleCoverToggleChange(event) {
  const isEnabled = event.target.checked;
  enableCover = isEnabled;
  localStorage.setItem(COVER_ENABLED_STORAGE_KEY, isEnabled.toString());
  
  if (coverImageGroup) {
    if (isEnabled) {
      coverImageGroup.style.display = "flex";
      coverImageGroup.style.flexDirection = "column";
    } else {
      coverImageGroup.style.display = "none";
    }
  }
  
  if (!isEnabled) {
    coverImageUrl = "";
    sampleCover = "";
    if (coverImageUrlInput) coverImageUrlInput.value = "";
    updateCoverPreviewDisplay();
  } else {
    if (!coverImageUrl) {
      coverImageUrl = ExtensionSites.get(siteKey).iconUrl(service, creatorId);
      sampleCover = coverImageUrl;
      if (coverImageUrlInput) coverImageUrlInput.value = coverImageUrl;
      updateCoverPreviewDisplay();
    }
  }

  updateFilenameDisplay();
}

// --- UI updates ---
function updateFilenameDisplay() {
  if (!isFilenameManuallyEdited) {
    const selectedInOrder = allFetchedPosts
      .filter((post) => selectedPosts[post.id])
      .sort(
        (a, b) =>
          new Date(a.published).getTime() - new Date(b.published).getTime()
      );
    fileName = generateDynamicFilename(
      creatorName,
      selectedInOrder,
      selectedFilenamePattern
    );
  }
  if (fileNameInput) fileNameInput.value = fileName;
}

function updateRangeSelectorsDisplay() {
  if (!selectRangeStartChapter || !selectRangeEndChapter) return;
  selectRangeStartChapter.innerHTML = "";
  selectRangeEndChapter.innerHTML = "";

  if (allFetchedPosts.length > 0) {
    if (!rangeStartId || !allFetchedPosts.some((p) => p.id === rangeStartId)) {
      rangeStartId = allFetchedPosts[allFetchedPosts.length - 1].id;  // Oldest
    }
    if (!rangeEndId || !allFetchedPosts.some((p) => p.id === rangeEndId)) {
      rangeEndId = allFetchedPosts[0].id;
    }

    allFetchedPosts.forEach((post) => {
      const opt1 = document.createElement("option");
      opt1.value = post.id;
      opt1.textContent = `${truncateTitle(post.title)}`;
      selectRangeStartChapter.appendChild(opt1);

      const opt2 = document.createElement("option");
      opt2.value = post.id;
      opt2.textContent = `${truncateTitle(post.title)}`;
      selectRangeEndChapter.appendChild(opt2);
    });

    selectRangeStartChapter.value = rangeStartId;
    selectRangeEndChapter.value = rangeEndId;
  } else {
    rangeStartId = "";
    rangeEndId = "";
  }
}

function updateChapterListDisplay() {
  if (!chapterListUl) return;
  chapterListUl.innerHTML = "";

  const postsToDisplay = filterPostsForDisplay();
  postsToDisplay.forEach((post) => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!selectedPosts[post.id];
    input.disabled = isPacking;
    input.addEventListener("change", () => handlePostSelectionChange(post.id));

    const spanDate = document.createElement("span");
    spanDate.className = "post-date-epub";
    spanDate.textContent = `(${new Date(post.published).toLocaleDateString()})`;

    label.appendChild(input);
    label.appendChild(document.createTextNode(post.title));
    label.appendChild(spanDate);
    li.appendChild(label);
    chapterListUl.appendChild(li);
  });

  updateSelectedCountsDisplay();
  updateRangeSelectorsDisplay();
}

function updateSelectedCountsDisplay() {
  const count = Object.values(selectedPosts).filter(Boolean).length;
  if (selectedPostsCountSpan) selectedPostsCountSpan.textContent = count;

  if (totalPostsCountSpan) {
    if (isLoadingPosts && allFetchedPosts.length === 0) {
      totalPostsCountSpan.textContent = "...";
    } else if (allFetchedPosts.length === 0) {
      totalPostsCountSpan.textContent = "0";
    } else if (totalAvailablePosts == null) {
      totalPostsCountSpan.textContent = `? (${allFetchedPosts.length} loaded)`;
    } else {
      totalPostsCountSpan.textContent = totalAvailablePosts;
    }
  }

  if (packEpubButton) {
    packEpubButton.disabled = isPacking
      ? !!packingAbortController?.signal.aborted
      : count === 0 || isLoadingPosts || isLoadingMore;
    packEpubButton.textContent = isPacking
      ? packingAbortController?.signal.aborted
        ? "Cancelling..."
        : `Cancel Generation (${progress.toFixed(0)}%)`
      : `Pack ${count} Post(s) as EPUB`;
  }
}

function updatePackingProgressUI() {
  if (progressBar) {
    progressBar.style.display = isPacking ? "block" : "none";
    progressBar.value = progress;
  }
  if (progressMsgSpan) {
    progressMsgSpan.style.display = isPacking ? "inline" : "none";
    progressMsgSpan.textContent = progressMessage;
  }
  updateSelectedCountsDisplay();
}

function updateCoverPreviewDisplay() {
  if (!coverPreviewImg) return;
  if (enableCover && sampleCover) {
    coverPreviewImg.src = sampleCover;
    coverPreviewImg.style.display = "block";
    coverPreviewImg.onerror = function () {
      coverPreviewImg.style.display = "none";
    };
  } else {
    coverPreviewImg.style.display = "none";
    coverPreviewImg.src = "";
  }
}

function updateOverallUIState() {
  if (creatorNameDisplay) creatorNameDisplay.textContent = creatorName;

  if (errorMessageDiv) {
    errorMessageDiv.textContent = error || "";
    errorMessageDiv.style.display = error ? "block" : "none";
  }

  if (progressBar) progressBar.style.display = isPacking ? "block" : "none";
  if (progressMsgSpan)
    progressMsgSpan.style.display = isPacking ? "inline" : "none";
  if (progressBar) progressBar.value = progress;
  if (progressMsgSpan) progressMsgSpan.textContent = progressMessage;

  if (fileNameInput) fileNameInput.disabled = isPacking;
  if (filenamePatternSelect) filenamePatternSelect.disabled = isPacking;
  if (coverImageUrlInput && enableCover) coverImageUrlInput.disabled = isPacking;
  if (enableCoverToggle) enableCoverToggle.disabled = isPacking;
  if (selectAllBtn) selectAllBtn.disabled = isPacking;
  if (unselectAllBtn) unselectAllBtn.disabled = isPacking;
  if (selectRangeStartChapter)
    selectRangeStartChapter.disabled =
      isPacking || allFetchedPosts.length === 0;
  if (selectRangeEndChapter)
    selectRangeEndChapter.disabled =
      isPacking || allFetchedPosts.length === 0;

  // Filter UI state
  if (applyFilterBtn) applyFilterBtn.disabled = isLoadingPosts || isPacking;
  if (tagSelect) tagSelect.disabled = isLoadingPosts || isPacking;
  if (customSearchInput) customSearchInput.disabled = isLoadingPosts || isPacking;

  const showLoadingMessage = isLoadingPosts && allFetchedPosts.length === 0;
  const showNoPostsMessage =
    !isLoadingPosts && allFetchedPosts.length === 0 && !error;
  const showMainContentWrapper =
    !showLoadingMessage && allFetchedPosts.length > 0;

  if (mainContentSectionsWrapper) {
    mainContentSectionsWrapper.style.display = showMainContentWrapper
      ? "flex"
      : "none";
  }

  if (initialLoadingMessageElement) {
    initialLoadingMessageElement.style.display = showLoadingMessage
      ? "block"
      : "none";
    initialLoadingMessageElement.textContent = isLoadingPosts
      ? `Loading posts for ${creatorName}...`
      : "";
  }

  if (noPostsFoundMessage) {
    noPostsFoundMessage.style.display = showNoPostsMessage ? "block" : "none";
  }

  const hasMoreByCount =
    totalAvailablePosts == null || totalFetchedOffset < totalAvailablePosts;
  const showLoadButtons = !atEndOfPosts && hasMoreByCount && !isLoadingMore && !isPacking && !showLoadingMessage && !showNoPostsMessage;
  if (loadMoreBtn) {
    loadMoreBtn.style.display = showLoadButtons ? "inline-block" : "none";
    loadMoreBtn.disabled = isLoadingMore;
  }
  if (loadAllBtn) {
    loadAllBtn.style.display = showLoadButtons ? "inline-block" : "none";
    loadAllBtn.disabled = isLoadingMore;
  }
  if (loadMoreMessage) {
    loadMoreMessage.style.display = isLoadingMore ? "block" : "none";
    loadMoreMessage.textContent = "Loading more posts...";
    if (atEndOfPosts) loadMoreMessage.textContent = "All posts loaded.";
  }

  updateChapterListDisplay();
  updateFilenameDisplay();
  updateCoverPreviewDisplay();
}

// --- Events/handlers ---
async function loadPostsPage(offsetToLoad, loadAll = false) {
  if (!service || !creatorId) {
    error = "Service or Creator ID is missing. Cannot load posts.";
    isLoadingPosts = false;
    isLoadingMore = false;
    updateOverallUIState();
    return;
  }

  postsLoadController?.abort(
    new DOMException("Superseded by a newer post request.", "AbortError")
  );
  const loadController = new AbortController();
  postsLoadController = loadController;
  const { signal } = loadController;

  const initialLoading = offsetToLoad === 0;
  if (initialLoading) {
    isLoadingPosts = true;
    allFetchedPosts = [];
    totalFetchedOffset = 0;
    atEndOfPosts = false;
    selectedPosts = {};
    rangeStartId = "";
    rangeEndId = "";
    updateOverallUIState();
    
    try {
      const { postCount, creatorName: apiCreatorName } = await fetchCreatorProfile(
        siteKey,
        service,
        creatorId,
        { signal }
      );
      totalAvailablePosts = postCount;
      if (siteKey === "kemono" && currentFilter.q) {
        totalAvailablePosts = null;
      } else if (siteKey === "kemono" && currentFilter.tag) {
        totalAvailablePosts =
          availableTags.find((tag) => tag.tag === currentFilter.tag)?.post_count ?? null;
      }
      
      if (typeof apiCreatorName === "string" && apiCreatorName.trim()) {
        creatorName = apiCreatorName.trim();
      }
      if (siteKey === "pawchive") {
        const requestVersion = ++countRequestVersion;
        try {
          const scrapedCount = await fetchPawchivePostCount(
            service,
            creatorId,
            currentFilter.q,
            { signal }
          );
          if (requestVersion === countRequestVersion && scrapedCount != null) {
            totalAvailablePosts = scrapedCount;
          }
        } catch {
          // Post loading still works when Pawchive changes its page markup.
        }
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      totalAvailablePosts = null;
      console.warn("Creator profile unavailable; continuing with post list:", err);
    }
  }

  if (!initialLoading) isLoadingMore = true;
  error = null;
  updateOverallUIState();

  let accumulatedPosts = [...allFetchedPosts];
  let currentOffset = offsetToLoad;
  let stillFetching = true;
  const commitAccumulatedPosts = () => {
    allFetchedPosts = accumulatedPosts.sort(
      (a, b) => new Date(b.published).getTime() - new Date(a.published).getTime()
    );
    totalFetchedOffset = currentOffset;
    if (atEndOfPosts) totalAvailablePosts = allFetchedPosts.length;

    if (allFetchedPosts.length > 0) {
      rangeStartId = allFetchedPosts[allFetchedPosts.length - 1].id;
      rangeEndId = allFetchedPosts[0].id;
    }
  };

  try {
    while (stillFetching) {
      if (signal.aborted) throw signal.reason;
      const { posts: newPosts } = await fetchPostListPage(
        siteKey,
        service,
        creatorId,
        currentOffset,
        { q: currentFilter.q, tag: currentFilter.tag, signal }
      );

      if (newPosts.length === 0) {
        atEndOfPosts = true;
        stillFetching = false;
        break;
      }

      const existingIds = new Set(accumulatedPosts.map((p) => p.id));
      const uniqueNewPosts = newPosts.filter((p) => !existingIds.has(p.id));
      accumulatedPosts = [...accumulatedPosts, ...uniqueNewPosts];

      currentOffset += POSTS_PER_PAGE_FOR_LIST;

      // Stop conditions
      if (!loadAll) {
        stillFetching = false;
        if (newPosts.length < POSTS_PER_PAGE_FOR_LIST) {
          atEndOfPosts = true;
        }
      } else if (newPosts.length < POSTS_PER_PAGE_FOR_LIST) {
        atEndOfPosts = true;
        stillFetching = false;
      }
    }

    commitAccumulatedPosts();
  } catch (err) {
    if (err?.name === "AbortError") return;
    commitAccumulatedPosts();
    error = err.message || "Failed to load posts.";
    console.error("Error fetching posts for EPUB list:", err);
  } finally {
    if (postsLoadController === loadController) {
      isLoadingPosts = false;
      isLoadingMore = false;
      postsLoadController = null;
      updateOverallUIState();
    }
  }
}

function handlePostSelectionChange(postId) {
  selectedPosts[postId] = !selectedPosts[postId];
  isFilenameManuallyEdited = false;
  updateOverallUIState();
}

function handleSelectAllDisplayed() {
  const newSelection = {};
  const postsCurrentlyDisplayed = filterPostsForDisplay();
  postsCurrentlyDisplayed.forEach((post) => (newSelection[post.id] = true));
  selectedPosts = newSelection;
  isFilenameManuallyEdited = false;
  updateOverallUIState();
}

function handleUnselectAllDisplayed() {
  selectedPosts = {};
  isFilenameManuallyEdited = false;
  updateOverallUIState();
}

function handleRangeSelect() {
  const startIdFromSelect = selectRangeStartChapter ? selectRangeStartChapter.value : "";
  const endIdFromSelect = selectRangeEndChapter ? selectRangeEndChapter.value : "";
  handleRangeSelectInternal(startIdFromSelect, endIdFromSelect, {
    autoDeselectOutside: true,
    autoSelectInside: true,
    suppressUpdate: false
  });
  isFilenameManuallyEdited = false;
  updateOverallUIState();
}

function handleRangeSelectInternal(startId, endId, options = {}) {
  const { autoDeselectOutside = false, autoSelectInside = false, suppressUpdate = false } = options;

  rangeStartId = startId;
  rangeEndId = endId;

  const startIndex = allFetchedPosts.findIndex((p) => p.id === startId);
  const endIndex = allFetchedPosts.findIndex((p) => p.id === endId);

  if (startIndex === -1 || endIndex === -1) {
    if (!suppressUpdate) updateOverallUIState();
    return;
  }

  const firstIndexInList = Math.min(startIndex, endIndex);
  const lastIndexInList = Math.max(startIndex, endIndex);

  allFetchedPosts.forEach((post, index) => {
    const isWithinRange = index >= firstIndexInList && index <= lastIndexInList;
    if (autoDeselectOutside && !isWithinRange) {
      selectedPosts[post.id] = false;
    }
    if (autoSelectInside && isWithinRange) {
      selectedPosts[post.id] = true;
    }
  });

  if (!suppressUpdate) {
    updateOverallUIState();
  }
}

function handleFilenamePatternChange(event) {
  selectedFilenamePattern = event.target.value;
  localStorage.setItem(FILENAME_PATTERN_STORAGE_KEY, selectedFilenamePattern);
  isFilenameManuallyEdited = false;
  updateOverallUIState();
}

function handleLoadMore() {
  if (
    !atEndOfPosts &&
    (totalAvailablePosts == null || totalFetchedOffset < totalAvailablePosts) &&
    !isLoadingMore
  ) {
    loadPostsPage(totalFetchedOffset);
  }
}

function handleLoadAll() {
  if (!isLoadingMore) {
    loadPostsPage(totalFetchedOffset, true);
  }
}

async function handlePackEpub() {
  if (isPacking) {
    if (!packingAbortController?.signal.aborted) {
      progressMessage = "Cancelling EPUB generation...";
      packingAbortController?.abort(
        new DOMException("Generation cancelled.", "AbortError")
      );
      updatePackingProgressUI();
    }
    return;
  }

  const postsToPackStubs = allFetchedPosts
    .filter((post) => selectedPosts[post.id])
    .sort(
      (a, b) =>
        new Date(a.published).getTime() - new Date(b.published).getTime()
    );

  if (postsToPackStubs.length === 0) {
    alert("Please select at least one post to include in the EPUB.");
    return;
  }

  isPacking = true;
  packingAbortController = new AbortController();
  progress = 0;
  progressMessage = "Starting EPUB generation...";
  error = null;
  updateOverallUIState();

  try {
    const defaultFileName = `${sanitizeAndTruncate(
      creatorName || "Unknown",
      120
    )}.epub`;
    const fileNameToUse =
      fileName && fileName.trim().length > 0 ? fileName : defaultFileName;

    const effectiveCoverUrl = enableCover ? (coverImageUrl || undefined) : undefined;

    const result = await generateKemonoEpub(
      { site: siteKey, service, creatorId, creatorName },
      postsToPackStubs,
      {
        fileName: fileNameToUse,
        coverImageUrl: effectiveCoverUrl,
        customQ: currentFilter.q,
        tagFilter: currentFilter.tag,
        signal: packingAbortController.signal
      },
      (currentProgress, message) => {
        progress = currentProgress >= 0 ? currentProgress : progress;
        progressMessage = message;
        updatePackingProgressUI();
      }
    );
    progressMessage = result.skippedPosts.length
      ? `EPUB generated; ${result.skippedPosts.length} post(s) were skipped.`
      : "EPUB generated and download started!";
  } catch (err) {
    if (err?.name === "AbortError") {
      progressMessage = "EPUB generation cancelled.";
    } else {
      error = err.message || "Failed to generate EPUB.";
      console.error("EPUB Packing Error:", err);
      progressMessage = `Error: ${err.message.substring(0, 50)}...`;
    }
  } finally {
    const wasCancelled = !!packingAbortController?.signal.aborted;
    isPacking = false;
    packingAbortController = null;
    if (!error && !wasCancelled) progress = 100;
    updateOverallUIState();
  }
}

// --- Setup ---
function setupUIAndListeners() {
  creatorNameDisplay = document.getElementById("creator-name-display");
  fileNameInput = document.getElementById("fileNameInput");
  filenamePatternSelect = document.getElementById("filenamePatternSelect");
  coverImageUrlInput = document.getElementById("coverImageUrlInput");
  coverPreviewImg = document.getElementById("cover-preview-img");
  enableCoverToggle = document.getElementById("enableCoverToggle");
  coverImageGroup = document.getElementById("coverImageGroup");
  packEpubButton = document.getElementById("packEpubButton");
  progressBar = document.getElementById("progressBar");
  progressMsgSpan = document.getElementById("progressMsgSpan");
  selectedPostsCountSpan = document.getElementById("selected-posts-count");
  totalPostsCountSpan = document.getElementById("total-posts-count");
  selectAllBtn = document.getElementById("selectAllBtn");
  unselectAllBtn = document.getElementById("unselectAllBtn");
  selectRangeStartChapter = document.getElementById("selectRangeStartChapter");
  selectRangeEndChapter = document.getElementById("selectRangeEndChapter");
  chapterListUl = document.getElementById("chapterListUl");
  loadMoreBtn = document.getElementById("loadMoreBtn");
  loadAllBtn = document.getElementById("loadAllBtn");
  loadMoreMessage = document.getElementById("loadMoreMessage");
  errorMessageDiv = document.getElementById("error-message-div");
  noPostsFoundMessage = document.getElementById("noPostsFoundMessage");
  mainContentContainer = document.getElementById("epub-creator-container");
  mainContentSectionsWrapper = document.getElementById(
    "main-content-sections-wrapper"
  );
  initialLoadingMessageElement = document.getElementById("initial-loading-message");

  // Filter UI refs
  tagSelect = document.getElementById("tagSelect");
  customSearchInput = document.getElementById("customSearchInput");
  applyFilterBtn = document.getElementById("applyFilterBtn");

  // Create initial loading message if missing
  if (!initialLoadingMessageElement) {
    initialLoadingMessageElement = document.createElement("p");
    initialLoadingMessageElement.id = "initial-loading-message";
    initialLoadingMessageElement.className = "message-text info-message";
    initialLoadingMessageElement.style.display = "none";
    if (mainContentContainer) {
      mainContentContainer.insertBefore(
        initialLoadingMessageElement,
        mainContentContainer.firstChild
      );
    }
  }

  // Event listeners
  if (fileNameInput) {
    fileNameInput.addEventListener("input", (e) => {
      fileName = e.target.value;
      isFilenameManuallyEdited = true;
    });
  }

  if (filenamePatternSelect) {
    filenamePatternSelect.addEventListener("change", handleFilenamePatternChange);
  }

  if (coverImageUrlInput) {
    coverImageUrlInput.addEventListener("input", (e) => {
      coverImageUrl = e.target.value;
      sampleCover = coverImageUrl;
      updateCoverPreviewDisplay();
    });
  }

  if (enableCoverToggle) {
    enableCoverToggle.addEventListener("change", handleCoverToggleChange);
  }

  if (packEpubButton) packEpubButton.addEventListener("click", handlePackEpub);
  if (selectAllBtn) selectAllBtn.addEventListener("click", handleSelectAllDisplayed);
  if (unselectAllBtn) unselectAllBtn.addEventListener("click", handleUnselectAllDisplayed);
  if (selectRangeStartChapter) selectRangeStartChapter.addEventListener("change", handleRangeSelect);
  if (selectRangeEndChapter) selectRangeEndChapter.addEventListener("change", handleRangeSelect);
  if (loadMoreBtn) loadMoreBtn.addEventListener("click", handleLoadMore);
  if (loadAllBtn) loadAllBtn.addEventListener("click", handleLoadAll);

  // Filter listeners
  if (tagSelect) tagSelect.addEventListener("change", handleFilterChange);
  if (applyFilterBtn) applyFilterBtn.addEventListener("click", handleApplyFilter);

  // Restore saved filename pattern
  const savedPattern = localStorage.getItem(FILENAME_PATTERN_STORAGE_KEY);
  if (savedPattern) {
    selectedFilenamePattern = savedPattern;
    if (filenamePatternSelect) filenamePatternSelect.value = selectedFilenamePattern;
  } else {
    selectedFilenamePattern = "titles_only";
    if (filenamePatternSelect) filenamePatternSelect.value = selectedFilenamePattern;
  }

  // Restore cover toggle state from localStorage (default true)
  const savedCoverEnabled = localStorage.getItem(COVER_ENABLED_STORAGE_KEY);
  enableCover = savedCoverEnabled !== "false";
  if (enableCoverToggle) enableCoverToggle.checked = enableCover;
  if (coverImageGroup) coverImageGroup.style.display = enableCover ? "block" : "none";

  // Pre-fill filename with creatorName if available
  if (!fileName && !isFilenameManuallyEdited && creatorName) {
    fileName = `${sanitizeAndTruncate(creatorName, 120)}.epub`;
  }

  updateOverallUIState();
}

document.addEventListener("DOMContentLoaded", async () => {
  const queryParams = getQueryParams();
  
  setupUIAndListeners();

  if (queryParams.permissionError) {
    error = queryParams.permissionError;
    isLoadingPosts = false;
    updateOverallUIState();
    return;
  }

  // Standard Logic (Creator Page / Bulk Download)
  service = queryParams.service || "";
  creatorId = queryParams.id || "";
  creatorName = queryParams.name || "";
  siteKey = queryParams.site || (service && creatorId ? "kemono" : "");
  if (siteKey && !ExtensionSites.sites[siteKey]) {
    error = `Unsupported source site: ${siteKey}`;
    isLoadingPosts = false;
    updateOverallUIState();
    return;
  }

  if (enableCover && !coverImageUrl && siteKey && service && creatorId) {
    coverImageUrl = ExtensionSites.get(siteKey).iconUrl(service, creatorId);
    sampleCover = coverImageUrl;
    if (coverImageUrlInput) coverImageUrlInput.value = coverImageUrl;
    updateCoverPreviewDisplay();
  }

  if (siteKey && service && creatorId) {
    await loadTagsAndPopulateDropdown();
    await loadPostsPage(0);
  } else {
    // If opened via icon click without parameters, or error
    if (!service && !creatorId) {
      error = "Missing source information. Please navigate to a creator page on Kemono or Pawchive.";
    } else {
      error = "Missing service or creator ID.";
    }
    isLoadingPosts = false;
    updateOverallUIState();
  }
});
