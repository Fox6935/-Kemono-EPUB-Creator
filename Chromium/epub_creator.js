// epub_creator.js
// HTML/JS logic for the EPUB creator UI in a new tab.

import { generateKemonoEpub, fetchPostListPage, fetchCreatorProfile, fetchTagsList } from "./kemonoEpubGenerator.js";
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
let totalAvailablePosts = 0;

let fileName = "";
let isFilenameManuallyEdited = false;
let coverImageUrl = "";
let sampleCover = "";

let isPacking = false;
let progress = 0;
let progressMessage = "";

// Filter state
let currentFilter = { tag: "", q: "" };

let service = "";
let creatorId = "";
let creatorName = "";

let availableTags = [];

let selectedFilenamePattern = "titles_only";

let enableCover = true;

let rangeStartId = "";
let rangeEndId = "";

let totalFetchedOffset = 0;
let atEndOfPosts = false;

// --- Constants ---
const POSTS_PER_PAGE_FOR_LIST = 50;
const KEMONO_IMG_BASE_URL_DEFAULT_ICON = "https://img.kemono.cr";
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
  const params = {};
  window.location.search
    .substring(1)
    .split("&")
    .forEach((param) => {
      if (!param) return;
      const [key, value] = param.split("=");
      params[key] = decodeURIComponent(value || "");
    });
  return params;
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
  try {
    isLoadingPosts = true;
    availableTags = await fetchTagsList(service, creatorId);
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
    if (newQ.length < 3) {
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
      coverImageUrl = `${KEMONO_IMG_BASE_URL_DEFAULT_ICON}/icons/${service}/${creatorId}`;
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
    } else {
      totalPostsCountSpan.textContent = totalAvailablePosts;
    }
  }

  if (packEpubButton) {
    packEpubButton.disabled =
      isPacking || count === 0 || isLoadingPosts || isLoadingMore;
    packEpubButton.textContent = isPacking
      ? `Packing... ${progress.toFixed(0)}%`
      : `Pack ${count} Post(s) as EPUB`;
  }
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
    !showLoadingMessage && !showNoPostsMessage && !error;

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

  const showLoadButtons = !atEndOfPosts && totalFetchedOffset < totalAvailablePosts && !isLoadingMore && !isPacking && !showLoadingMessage && !showNoPostsMessage;
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

  const initialLoading = offsetToLoad === 0;
  if (initialLoading) {
    allFetchedPosts = [];
    totalFetchedOffset = 0;
    atEndOfPosts = false;
    selectedPosts = {};
    rangeStartId = "";
    rangeEndId = "";
    
    try {
      const { postCount, creatorName: apiCreatorName } = await fetchCreatorProfile(service, creatorId);
      totalAvailablePosts = postCount;
      
      if (typeof apiCreatorName === "string" && apiCreatorName.trim()) {
        creatorName = apiCreatorName.trim();
      }
      console.log(`Initial load: Total posts=${totalAvailablePosts}, creator=${creatorName}`);
    } catch (err) {
      error = err.message || "Failed to load creator profile.";
      console.error("Error fetching creator profile:", err);
      isLoadingPosts = false;
      isLoadingMore = false;
      updateOverallUIState();
      return;
    }
  }

  if (initialLoading) isLoadingPosts = true;
  else isLoadingMore = true;
  error = null;
  updateOverallUIState();

  let accumulatedPosts = [...allFetchedPosts];
  let currentOffset = offsetToLoad;
  let stillFetching = true;
  let pagesFetchedInThisCall = 0;

  try {
    while (stillFetching) {
      console.log(`Fetching offset=${currentOffset} (multiple of 50), loadAll=${loadAll}, filter=${JSON.stringify(currentFilter)}`);
      const { posts: newPosts } = await fetchPostListPage(
        service,
        creatorId,
        currentOffset,
        POSTS_PER_PAGE_FOR_LIST,
        { q: currentFilter.q, tag: currentFilter.tag }
      );

      console.log(`Fetched ${newPosts.length} posts at offset ${currentOffset} (expected up to 50)`);

      if (newPosts.length === 0) {
        atEndOfPosts = true;
        stillFetching = false;
        break;
      }

      const existingIds = new Set(accumulatedPosts.map((p) => p.id));
      const uniqueNewPosts = newPosts.filter((p) => !existingIds.has(p.id));
      accumulatedPosts = [...accumulatedPosts, ...uniqueNewPosts];

      pagesFetchedInThisCall++;
      currentOffset += POSTS_PER_PAGE_FOR_LIST;

      // Stop conditions
      if (!loadAll) {
        stillFetching = false;
        if (newPosts.length < POSTS_PER_PAGE_FOR_LIST) {
          atEndOfPosts = true;
        }
      } else if (newPosts.length < POSTS_PER_PAGE_FOR_LIST) {
        if (currentOffset >= totalAvailablePosts) {
          atEndOfPosts = true;
          stillFetching = false;
        }
      }
    }

    allFetchedPosts = accumulatedPosts.sort(
      (a, b) => new Date(b.published).getTime() - new Date(a.published).getTime()
    );

    totalFetchedOffset += pagesFetchedInThisCall * POSTS_PER_PAGE_FOR_LIST;
    console.log(`Accumulated ${allFetchedPosts.length} unique posts, new offset=${totalFetchedOffset}, atEnd=${atEndOfPosts}`);

    if (allFetchedPosts.length > 0) {
      const oldestId = allFetchedPosts[allFetchedPosts.length - 1].id;
      const newestId = allFetchedPosts[0].id;
      rangeStartId = oldestId;
      rangeEndId = newestId;
      console.log(`Range: ${rangeStartId.substring(0,8)}... to ${rangeEndId.substring(0,8)}...`);
    }

  } catch (err) {
    error = err.message || "Failed to load posts.";
    atEndOfPosts = true;
    console.error("Error fetching posts for EPUB list:", err);
  } finally {
    isLoadingPosts = false;
    isLoadingMore = false;
    updateOverallUIState();
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
  if (!atEndOfPosts && totalFetchedOffset < totalAvailablePosts && !isLoadingMore) {
    loadPostsPage(totalFetchedOffset);
  }
}

function handleLoadAll() {
  if (!isLoadingMore) {
    loadPostsPage(totalFetchedOffset, true);
  }
}

async function handlePackEpub() {
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

    await generateKemonoEpub(
      { service, creatorId, creatorName },
      postsToPackStubs,
      {
        fileName: fileNameToUse,
        coverImageUrl: effectiveCoverUrl,
        customQ: currentFilter.q,
        tagFilter: currentFilter.tag
      },
      (currentProgress, message) => {
        progress = currentProgress >= 0 ? currentProgress : progress;
        progressMessage = message;
        updateOverallUIState();
      }
    );
    progressMessage = "EPUB generated and download started!";
  } catch (err) {
    error = err.message || "Failed to generate EPUB.";
    console.error("EPUB Packing Error:", err);
    progressMessage = `Error: ${err.message.substring(0, 50)}...`;
  } finally {
    isPacking = false;
    if (!error) progress = 100;
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
  service = queryParams.service || "";
  creatorId = queryParams.id || "";
  creatorName = queryParams.name || "";

  setupUIAndListeners();

  // Set default cover only if enabled
  if (enableCover && !coverImageUrl) {
    coverImageUrl = `${KEMONO_IMG_BASE_URL_DEFAULT_ICON}/icons/${service}/${creatorId}`;
    sampleCover = coverImageUrl;
    if (coverImageUrlInput) coverImageUrlInput.value = coverImageUrl;
    updateCoverPreviewDisplay();
  }

  if (service && creatorId) {
    await loadTagsAndPopulateDropdown();
    await loadPostsPage(0);
  } else {
    error = "Missing service or creator ID. Cannot load posts for this creator.";
    isLoadingPosts = false;
    updateOverallUIState();
  }
});
