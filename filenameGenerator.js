// filenameGenerator.js

export function sanitizeAndTruncate(text, maxLength) {
  if (typeof text !== "string") return "";
  const sanitized = text.replace(/[/\\?%*:|"<>]/g, "_").replace(/__+/g, "_");
  return sanitized.substring(0, maxLength);
}

export function truncateTitle(title, maxLength = 70) {
  if (!title) return "Untitled";
  return title.length > maxLength ? `${title.substring(0, maxLength)}...` : title;
}

// Extracts the first number from a string, supporting decimals (e.g., "124.1" → "124.1").
// No spelled-out fallback here—use wordedExtractNumber for that.
export function extractNumber(text) {
  if (!text) return "";

  // Regex for numbers with optional decimal
  const digitMatch = text.match(/(\d+\.?\d*)/);
  if (digitMatch) {
    return digitMatch[1];
  }

  return "";
}

// Extracts all numbers from a string as an array, supporting decimals.
// Uses extractNumber (digit-only).
function extractNumbersFromTitle(text) {
  if (!text) return [];
  const matches = text.match(/(\d+\.?\d*)/g) || [];
  return matches.map(numStr => extractNumber(numStr));
}

// Extracts a number with spelled-out fallback (e.g., "Four Hundred and Thirty-Nine" → "439").
// Used only as fallback when no digits found.
// Processes entire text; supports 0-999+ with simple dictionary.
function wordedExtractNumber(text) {
  // First, try digits
  const digitNum = extractNumber(text);
  if (digitNum) return digitNum;

  if (!text || typeof text !== 'string') return "";

  const wordMap = {
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
    'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
    'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
    'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,
    'hundred': 100, 'thousand': 1000
  };

  // Clean entire text: lowercase, remove punctuation, handle compounds ("forty-one"), remove "and", normalize spaces
  let cleanPhrase = text.toLowerCase()
    .replace(/[.,;:!?]/g, '')  // Remove common punctuation (handles trailing ".")
    .replace(/-/g, ' ')  // Hyphens to spaces (e.g., "thirty-nine" → "thirty nine")
    .replace(/\band\b/gi, '')  // Remove whole "and" (no extra space, as it's a connector)
    .replace(/\s+/g, ' ')  // Collapse multiple spaces
    .trim();

  // Split into words and filter valid ones
  const words = cleanPhrase.split(/\s+/).filter(w => w && wordMap.hasOwnProperty(w));

  if (words.length === 0) return "";

  let total = 0;
  let temp = 0;

  for (const word of words) {
    const val = wordMap[word];

    if (val < 100) {
      // Base number: add to temp
      temp += val;
    } else if (val === 100) {
      // Hundred: multiply current temp
      temp *= 100;
    } else if (val === 1000) {
      // Thousand: add scaled group to total, reset temp for next group
      total += temp * 1000;
      temp = 0;
    }
  }

  // Add remaining temp to total
  total += temp;

  return String(total);
}

// Backward-compatible alias (uses digit-only for consistency with updates)
export function extractFirstNumber(text) {
  return extractNumber(text);
}

/**
 * Generates an EPUB filename based on selected posts and a chosen pattern.
 * Supports single/multi posts, with creator prefix where applicable.
 * Spelled-out numbers fallback only in "creator_numbers".
 * @param {string} creatorName - The display name of the creator.
 * @param {Array<object>} selectedPostsInOrder - Array of selected posts sorted chronologically.
 * @param {string} filenamePattern - One of: "titles_only", "creator_titles", "creator_numbers", "creator_second_numbers", "creator_book_chapter_numbers".
 * @returns {string} The generated filename (e.g., "my_ebook.epub").
 */
export function generateDynamicFilename(creatorName, selectedPostsInOrder, filenamePattern) {
  let baseFilename = "";

  const numSelected = selectedPostsInOrder.length;
  const sanitizedCreatorName = sanitizeAndTruncate(creatorName || "Unknown", 60);

  if (numSelected === 0) {
    baseFilename = sanitizedCreatorName || "kemono_ebook";
  } else if (numSelected === 1) {
    const postTitle = selectedPostsInOrder[0].title || "";
    let postNumber = extractNumber(postTitle);

    // Spelled-out fallback only for creator_numbers
    if (filenamePattern === "creator_numbers" && postNumber === "") {
      postNumber = wordedExtractNumber(postTitle);
    }

    switch (filenamePattern) {
      case "titles_only":
        baseFilename = sanitizeAndTruncate(postTitle, 60) || "single_post";
        break;
      case "creator_titles":
        baseFilename = `${sanitizedCreatorName}_${sanitizeAndTruncate(postTitle, 60) || "single_post"}`;
        break;
      case "creator_numbers":
        if (postNumber) {
          baseFilename = `${sanitizedCreatorName}_${postNumber}`;
        } else {
          baseFilename = `${sanitizedCreatorName}_${sanitizeAndTruncate(postTitle, 60) || "single_post"}`;
        }
        break;
      case "creator_second_numbers":
        const numbers = extractNumbersFromTitle(postTitle);  // Digit-only
        const secondNum = numbers.length > 1 ? numbers[1] : (numbers.length === 1 ? numbers[0] : postNumber);
        if (secondNum) {
          baseFilename = `${sanitizedCreatorName}_${secondNum}`;
        } else {
          baseFilename = `${sanitizedCreatorName}_${sanitizeAndTruncate(postTitle, 60) || "single_post"}`;
        }
        break;
      case "creator_book_chapter_numbers":
        const bookChapterNums = extractNumbersFromTitle(postTitle);  // Digit-only
        const bookNum = bookChapterNums[0] || "";
        const chapterNum = bookChapterNums[1] || bookChapterNums[0] || "";
        const formatted = bookNum ? `B${bookNum}C${chapterNum}` : chapterNum;
        if (formatted) {
          baseFilename = `${sanitizedCreatorName}_${formatted}`;
        } else {
          baseFilename = `${sanitizedCreatorName}_${sanitizeAndTruncate(postTitle, 60) || "single_post"}`;
        }
        break;
      default:
        baseFilename = sanitizeAndTruncate(postTitle, 60) || "single_post";
        break;
    }
  } else {  // Multi-post
    const firstPostTitle = selectedPostsInOrder[0].title || "";
    const lastPostTitle = selectedPostsInOrder[numSelected - 1].title || "";
    let firstNumber = extractNumber(firstPostTitle);
    let lastNumber = extractNumber(lastPostTitle);

    // Spelled-out fallback only for creator_numbers
    if (filenamePattern === "creator_numbers") {
      if (firstNumber === "") firstNumber = wordedExtractNumber(firstPostTitle);
      if (lastNumber === "") lastNumber = wordedExtractNumber(lastPostTitle);
    }

    switch (filenamePattern) {
      case "titles_only":
        baseFilename = `${sanitizeAndTruncate(firstPostTitle, 30) || "start"}-${sanitizeAndTruncate(lastPostTitle, 30) || "end"}`;
        break;
      case "creator_titles":
        baseFilename = `${sanitizedCreatorName}_${sanitizeAndTruncate(firstPostTitle, 30) || "start"}-${sanitizeAndTruncate(lastPostTitle, 30) || "end"}`;
        break;
      case "creator_numbers":
        if (firstNumber && lastNumber) {
          baseFilename = `${sanitizedCreatorName}_${firstNumber}-${lastNumber}`;
        } else if (firstNumber) {
          baseFilename = `${sanitizedCreatorName}_${firstNumber}`;
        } else {
          baseFilename = `${sanitizedCreatorName}_${sanitizeAndTruncate(firstPostTitle, 30) || "start"}-${sanitizeAndTruncate(lastPostTitle, 30) || "end"}`;
        }
        break;
      case "creator_second_numbers":
        const firstNums = extractNumbersFromTitle(firstPostTitle);  // Digit-only
        const lastNums = extractNumbersFromTitle(lastPostTitle);
        const firstSecond = firstNums.length > 1 ? firstNums[1] : (firstNums.length === 1 ? firstNums[0] : firstNumber);
        const lastSecond = lastNums.length > 1 ? lastNums[1] : (lastNums.length === 1 ? lastNums[0] : lastNumber);
        if (firstSecond && lastSecond) {
          baseFilename = `${sanitizedCreatorName}_${firstSecond}-${lastSecond}`;
        } else if (firstSecond) {
          baseFilename = `${sanitizedCreatorName}_${firstSecond}`;
        } else {
          baseFilename = `${sanitizedCreatorName}_${sanitizeAndTruncate(firstPostTitle, 30) || "start"}-${sanitizeAndTruncate(lastPostTitle, 30) || "end"}`;
        }
        break;
      case "creator_book_chapter_numbers":
        const firstBookNums = extractNumbersFromTitle(firstPostTitle);  // Digit-only
        const lastBookNums = extractNumbersFromTitle(lastPostTitle);
        const firstBook = firstBookNums[0] || "";
        const firstChapter = firstBookNums[1] || firstBookNums[0] || "";
        const lastBook = lastBookNums[0] || "";
        const lastChapter = lastBookNums[1] || lastBookNums[0] || "";
        const firstFormatted = firstBook ? `B${firstBook}C${firstChapter}` : firstChapter;
        const lastFormatted = lastBook ? `B${lastBook}C${lastChapter}` : lastChapter;
        if (firstFormatted && lastFormatted) {
          baseFilename = `${sanitizedCreatorName}_${firstFormatted}-${lastFormatted}`;
        } else if (firstFormatted) {
          baseFilename = `${sanitizedCreatorName}_${firstFormatted}`;
        } else {
          baseFilename = `${sanitizedCreatorName}_${sanitizeAndTruncate(firstPostTitle, 30) || "start"}-${sanitizeAndTruncate(lastPostTitle, 30) || "end"}`;
        }
        break;
      default:
        baseFilename = `${sanitizeAndTruncate(firstPostTitle, 30) || "start"}-${sanitizeAndTruncate(lastPostTitle, 30) || "end"}`;
        break;
    }
  }

  return `${baseFilename}.epub`;
}
