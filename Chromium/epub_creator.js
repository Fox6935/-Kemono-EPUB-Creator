// epub_creator.js
// Pure HTML/JS logic for the EPUB creator UI in a new tab.

import { generateKemonoEpub, fetchPostListPage } from "./kemonoEpubGenerator.js";
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

let rangeStartId = "";
let rangeEndId = "";

let service = "";
let creatorId = "";
let creatorName = ""; // Always use props.name from API when available

let selectedFilenamePattern = "titles_only";

// --- Constants ---
const POSTS_PER_PAGE_FOR_LIST = 50;
const KEMONO_IMG_BASE_URL_DEFAULT_ICON = "https://img.kemono.cr";
const FILENAME_PATTERN_STORAGE_KEY = "kemonoEpubFilenamePattern";

// --- DOM refs ---
let creatorNameDisplay = null;
let fileNameInput = null;
let filenamePatternSelect = null;
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
    const newestPostId = allFetchedPosts[0].id;
    const oldestPostId = allFetchedPosts[allFetchedPosts.length - 1].id;

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

    let defaultRangeApplied = false;
    if (!rangeStartId || !allFetchedPosts.some((p) => p.id === rangeStartId)) {
      rangeStartId = oldestPostId;
      defaultRangeApplied = true;
    }
    if (!rangeEndId || !allFetchedPosts.some((p) => p.id === rangeEndId)) {
      rangeEndId = newestPostId;
      defaultRangeApplied = true;
    }

    selectRangeStartChapter.value = rangeStartId;
    selectRangeEndChapter.value = rangeEndId;

    if (defaultRangeApplied || Object.keys(selectedPosts).length > 0) {
      handleRangeSelectInternal(rangeStartId, rangeEndId, {
        autoDeselectOutside: true,
        suppressUpdate: true
      });
    }
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
  if (sampleCover) {
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
  if (coverImageUrlInput) coverImageUrlInput.disabled = isPacking;
  if (selectAllBtn) selectAllBtn.disabled = isPacking;
  if (unselectAllBtn) unselectAllBtn.disabled = isPacking;
  if (selectRangeStartChapter)
    selectRangeStartChapter.disabled =
      isPacking || allFetchedPosts.length === 0;
  if (selectRangeEndChapter)
    selectRangeEndChapter.disabled = isPacking || allFetchedPosts.length === 0;

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
    initialLoadingMessageElement.textContent = `Loading initial posts for ${creatorName}...`;
  }

  if (noPostsFoundMessage) {
    noPostsFoundMessage.style.display = showNoPostsMessage ? "block" : "none";
  }

  const showLoadButtons =
    allFetchedPosts.length < totalAvailablePosts &&
    !isLoadingMore &&
    !isPacking &&
    !showLoadingMessage &&
    !showNoPostsMessage;
  if (loadMoreBtn)
    loadMoreBtn.style.display = showLoadButtons ? "inline-block" : "none";
  if (loadAllBtn)
    loadAllBtn.style.display = showLoadButtons ? "inline-block" : "none";
  if (loadMoreMessage) {
    loadMoreMessage.style.display = isLoadingMore ? "block" : "none";
    loadMoreMessage.textContent = "Loading more posts...";
  }

  updateChapterListDisplay();
  updateFilenameDisplay();
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

  if (offsetToLoad === 0) {
    allFetchedPosts = [];
    totalAvailablePosts = 0;
    selectedPosts = {};
  }

  if (offsetToLoad === 0 && !loadAll) isLoadingPosts = true;
  else isLoadingMore = true;
  error = null;
  updateOverallUIState();

  let accumulatedPosts = [...allFetchedPosts];
  let currentFetchOffset = offsetToLoad;
  let stillFetching = true;

  try {
    while (stillFetching) {
      const {
        posts: newPosts,
        totalCount: apiTotalCount,
        creatorName: apiCreatorName
      } = await fetchPostListPage(
        service,
        creatorId,
        currentFetchOffset,
        POSTS_PER_PAGE_FOR_LIST
      );

      // Capture creatorName from API on first page
      if (
        offsetToLoad === 0 &&
        typeof apiCreatorName === "string" &&
        apiCreatorName.trim()
      ) {
        creatorName = apiCreatorName.trim();
      }

      if (apiTotalCount > totalAvailablePosts) {
        totalAvailablePosts = apiTotalCount;
      }

      const existingIds = new Set(accumulatedPosts.map((p) => p.id));
      const uniqueNewPosts = newPosts.filter((p) => !existingIds.has(p.id));
      accumulatedPosts = [...accumulatedPosts, ...uniqueNewPosts];

      if (
        !loadAll ||
        newPosts.length < POSTS_PER_PAGE_FOR_LIST ||
        accumulatedPosts.length >= totalAvailablePosts
      ) {
        stillFetching = false;
      } else {
        currentFetchOffset += newPosts.length;
      }
    }

    allFetchedPosts = accumulatedPosts.sort(
      (a, b) => new Date(b.published).getTime() - new Date(a.published).getTime()
    );
  } catch (err) {
    error = err.message || "Failed to load posts.";
    console.error("Error fetching posts for EPUB list:", err);
  } finally {
    isLoadingPosts = false;
    isLoadingMore = false;

    if (allFetchedPosts.length > 0) {
      rangeStartId = allFetchedPosts[allFetchedPosts.length - 1].id;
      rangeEndId = allFetchedPosts[0].id;
      handleRangeSelectInternal(rangeStartId, rangeEndId, {
        autoDeselectOutside: true,
        suppressUpdate: false
      });
    } else {
      rangeStartId = "";
      rangeEndId = "";
      updateOverallUIState();
    }
  }
}

function handlePostSelectionChange(postId) {
  selectedPosts[postId] = !selectedPosts[postId];
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
  const startIdFromSelect = selectRangeStartChapter.value;
  const endIdFromSelect = selectRangeEndChapter.value;
  handleRangeSelectInternal(startIdFromSelect, endIdFromSelect, {
    autoDeselectOutside: true,
    suppressUpdate: false
  });
  isFilenameManuallyEdited = false;
  updateOverallUIState();
}

function handleRangeSelectInternal(startId, endId, options = {}) {
  const { autoDeselectOutside = false, suppressUpdate = false } = options;

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
  const currentOffset = allFetchedPosts.length;
  if (allFetchedPosts.length < totalAvailablePosts && !isLoadingMore) {
    loadPostsPage(currentOffset);
  }
}

function handleLoadAll() {
  if (!isLoadingMore) {
    loadPostsPage(0, true);
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

    await generateKemonoEpub(
      { service, creatorId, creatorName },
      postsToPackStubs,
      {
        fileName: fileNameToUse,
        coverImageUrl: coverImageUrl || undefined
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
    progressMessage = `Error: ${err.message.substring(0, 50)}`;
  } finally {
    isPacking = false;
    progress = 100;
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

  initialLoadingMessageElement =
    document.getElementById("initial-loading-message");
  if (!initialLoadingMessageElement) {
    initialLoadingMessageElement = document.createElement("p");
    initialLoadingMessageElement.id = "initial-loading-message";
    initialLoadingMessageElement.className = "message-text info-message";
    initialLoadingMessageElement.style.display = "none";
    mainContentContainer.insertBefore(
      initialLoadingMessageElement,
      mainContentContainer.firstChild
    );
  }

  fileNameInput.addEventListener("input", (e) => {
    fileName = e.target.value;
    isFilenameManuallyEdited = true;
  });

  if (filenamePatternSelect) {
    filenamePatternSelect.addEventListener("change", handleFilenamePatternChange);
  }

  coverImageUrlInput.addEventListener("input", (e) => {
    coverImageUrl = e.target.value;
    sampleCover = coverImageUrl;
    updateCoverPreviewDisplay();
  });

  packEpubButton.addEventListener("click", handlePackEpub);
  selectAllBtn.addEventListener("click", handleSelectAllDisplayed);
  unselectAllBtn.addEventListener("click", handleUnselectAllDisplayed);
  selectRangeStartChapter.addEventListener("change", handleRangeSelect);
  selectRangeEndChapter.addEventListener("change", handleRangeSelect);
  loadMoreBtn.addEventListener("click", handleLoadMore);
  loadAllBtn.addEventListener("click", handleLoadAll);

  const savedPattern = localStorage.getItem(FILENAME_PATTERN_STORAGE_KEY);
  if (savedPattern) {
    selectedFilenamePattern = savedPattern;
    if (filenamePatternSelect) filenamePatternSelect.value = selectedFilenamePattern;
  } else {
    selectedFilenamePattern = "titles_only";
    if (filenamePatternSelect) filenamePatternSelect.value = selectedFilenamePattern;
  }

  // Pre-fill filename with creatorName if available (may be updated after first API fetch)
  if (!fileName && !isFilenameManuallyEdited && creatorName) {
    fileName = `${sanitizeAndTruncate(creatorName, 120)}.epub`;
  }

  updateFilenameDisplay();
  updateCoverPreviewDisplay();
  updateOverallUIState();
}

document.addEventListener("DOMContentLoaded", async () => {
  const queryParams = getQueryParams();
  service = queryParams.service || "";
  creatorId = queryParams.id || "";
  // Prefill from URL if provided; API value from posts-legacy will override
  creatorName = queryParams.name || "";

  setupUIAndListeners();

  if (!coverImageUrl) {
    coverImageUrl = `${KEMONO_IMG_BASE_URL_DEFAULT_ICON}/icons/${service}/${creatorId}`;
    sampleCover = coverImageUrl;
    if (coverImageUrlInput) coverImageUrlInput.value = coverImageUrl;
    updateCoverPreviewDisplay();
  }

  if (service && creatorId) {
    await loadPostsPage(0);
  } else {
    error = "Missing service or creator ID. Cannot load posts for this creator.";
    isLoadingPosts = false;
    updateOverallUIState();
  }
});
