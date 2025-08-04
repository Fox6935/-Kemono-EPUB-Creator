// filenameGenerator.js

/**
 * Sanitizes text for use in filenames, replacing invalid characters and truncating.
 * The maxLength is doubled as requested.
 * @param {string} text - The input string to sanitize.
 * @param {number} maxLength - The maximum desired length for the sanitized string.
 * @returns {string} The sanitized and truncated filename part.
 */
export function sanitizeAndTruncate(text, maxLength) {
  if (typeof text !== "string") return "";
  const sanitized = text.replace(/[/\\?%*:|"<>]/g, "_").replace(/__+/g, "_");
  return sanitized.substring(0, maxLength);
}

/**
 * Truncates a title string for display, adding "..." if too long.
 * The maxLength is doubled as requested.
 * @param {string} title - The title string.
 * @param {number} maxLength - The maximum length for display.
 * @returns {string} The truncated title with "..." if necessary.
 */
export function truncateTitle(title, maxLength = 70) {
  // Doubled from 35
  if (!title) return "Untitled";
  return title.length > maxLength ? `${title.substring(0, maxLength)}...` : title;
}

/**
 * Extracts the first consecutive number from a string.
 * "Chapter 1166 - Level 320" -> "1166"
 * "My Post (2023) Part 1" -> "2023"
 * @param {string} text The string to search for a number.
 * @returns {string} The first number found as a string, or an empty string if none.
 */
function extractFirstNumber(text) {
  const match = text.match(/\d+/);
  return match ? match[0] : "";
}

/**
 * Generates an EPUB filename based on selected posts and a chosen pattern.
 * Always uses the creator's display name (from API props.name) provided by caller.
 * @param {string} creatorName - The display name of the creator.
 * @param {Array<object>} selectedPostsInOrder - Array of selected posts sorted chronologically.
 * @param {string} filenamePattern - The chosen pattern.
 * @returns {string} The generated filename (e.g., "my_ebook.epub").
 */
export function generateDynamicFilename(
  creatorName,
  selectedPostsInOrder,
  filenamePattern
) {
  let baseFilename = "";

  const numSelected = selectedPostsInOrder.length;
  const sanitizedCreatorName = sanitizeAndTruncate(creatorName || "Unknown", 60);

  if (numSelected === 0) {
    baseFilename = sanitizedCreatorName || "kemono_ebook";
  } else if (numSelected === 1) {
    const postTitle = sanitizeAndTruncate(selectedPostsInOrder[0].title, 60);
    const postNumber = extractFirstNumber(selectedPostsInOrder[0].title);

    switch (filenamePattern) {
      case "titles_only":
        baseFilename = postTitle || "single_post";
        break;
      case "creator_titles":
        baseFilename = `${sanitizedCreatorName}_${postTitle || "single_post"}`;
        break;
      case "creator_numbers":
        if (postNumber) {
          baseFilename = `${sanitizedCreatorName}_${postNumber}`;
        } else {
          baseFilename = `${sanitizedCreatorName}_${postTitle || "single_post"}`;
        }
        break;
      default:
        baseFilename = postTitle || "single_post";
        break;
    }
  } else {
    const firstPost = selectedPostsInOrder[0];
    const lastPost = selectedPostsInOrder[numSelected - 1];
    const firstTitle = sanitizeAndTruncate(firstPost.title, 30);
    const lastTitle = sanitizeAndTruncate(lastPost.title, 30);

    switch (filenamePattern) {
      case "titles_only":
        baseFilename = `${firstTitle || "start"}-${lastTitle || "end"}`;
        break;
      case "creator_titles":
        baseFilename = `${sanitizedCreatorName}_${firstTitle || "start"}-${
          lastTitle || "end"
        }`;
        break;
      case "creator_numbers":
        const firstNumber = extractFirstNumber(firstPost.title);
        const lastNumber = extractFirstNumber(lastPost.title);
        if (firstNumber && lastNumber) {
          baseFilename = `${sanitizedCreatorName}_${firstNumber}-${lastNumber}`;
        } else if (firstNumber) {
          baseFilename = `${sanitizedCreatorName}_${firstNumber}`;
        } else {
          baseFilename = `${sanitizedCreatorName}_${firstTitle || "start"}-${
            lastTitle || "end"
          }`;
        }
        break;
      default:
        baseFilename = `${firstTitle || "start"}-${lastTitle || "end"}`;
        break;
    }
  }

  return `${baseFilename}.epub`;
}
