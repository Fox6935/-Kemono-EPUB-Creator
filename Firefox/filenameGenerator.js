// filenameGenerator.js

/**
 * Sanitizes text for use in filenames, replacing invalid characters and truncating.
 * The maxLength is doubled as requested.
 * @param {string} text - The input string to sanitize.
 * @param {number} maxLength - The maximum desired length for the sanitized string.
 * @returns {string} The sanitized and truncated filename part.
 */
export function sanitizeAndTruncate(text, maxLength) {
  if (typeof text !== 'string') return '';
  const sanitized = text.replace(/[/\\?%*:|"<>]/g, '_').replace(/__+/g, '_');
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
  if (!title) return 'Untitled';
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
  return match ? match[0] : '';
}

/**
 * Generates an EPUB filename based on selected posts and a chosen pattern.
 * @param {string} creatorName - The name of the creator.
 * @param {Array<object>} selectedPostsInOrder - An array of selected post objects, sorted chronologically.
 * @param {string} filenamePattern - The chosen pattern for filename generation.
 * @returns {string} The generated filename (e.g., "my_ebook.epub").
 */
export function generateDynamicFilename(
  creatorName,
  selectedPostsInOrder,
  filenamePattern,
) {
  let baseFilename = '';

  const numSelected = selectedPostsInOrder.length;

  // Increased limit for creator name
  const sanitizedCreatorName = sanitizeAndTruncate(creatorName, 60);

  if (numSelected === 0) {
    // Default behavior when no chapters are selected (should rarely happen if pack button is disabled)
    baseFilename = sanitizedCreatorName || 'kemono_ebook';
  } else if (numSelected === 1) {
    const postTitle = sanitizeAndTruncate(selectedPostsInOrder[0].title, 60); // Doubled from 30
    const postNumber = extractFirstNumber(selectedPostsInOrder[0].title);

    switch (filenamePattern) {
      case 'titles_only':
        baseFilename = postTitle || 'single_post';
        break;
      case 'creator_titles':
        baseFilename = `${sanitizedCreatorName}_${postTitle || 'single_post'}`;
        break;
      case 'creator_numbers':
        if (postNumber) {
          baseFilename = `${sanitizedCreatorName}_${postNumber}`;
        } else {
          // Fallback to title if no number found for single post
          baseFilename = `${sanitizedCreatorName}_${postTitle || 'single_post'}`;
        }
        break;
      default: // Fallback for any unknown pattern or if not explicitly set
        baseFilename = postTitle || 'single_post';
        break;
    }
  } else {
    // Multiple chapters case (existing logic, adjusted limits)
    const firstPost = selectedPostsInOrder[0];
    const lastPost = selectedPostsInOrder[numSelected - 1];

    const firstTitle = sanitizeAndTruncate(firstPost.title, 30); // Max 30 for combined titles
    const lastTitle = sanitizeAndTruncate(lastPost.title, 30); // Max 30 for combined titles

    switch (filenamePattern) {
      case 'titles_only':
        baseFilename = `${firstTitle || 'start'}-${lastTitle || 'end'}`;
        break;
      case 'creator_titles':
        baseFilename = `${sanitizedCreatorName}_${firstTitle || 'start'}-${lastTitle || 'end'}`;
        break;
      case 'creator_numbers':
        const firstNumber = extractFirstNumber(firstPost.title);
        const lastNumber = extractFirstNumber(lastPost.title);
        if (firstNumber && lastNumber) {
          baseFilename = `${sanitizedCreatorName}_${firstNumber}-${lastNumber}`;
        } else if (firstNumber) {
          // Fallback if only one number is found
          baseFilename = `${sanitizedCreatorName}_${firstNumber}`;
        } else {
          // Fallback to titles if no numbers found
          baseFilename = `${sanitizedCreatorName}_${firstTitle || 'start'}-${lastTitle || 'end'}`;
        }
        break;
      default: // Fallback to titles_only for any unknown pattern or if not explicitly set
        baseFilename = `${firstTitle || 'start'}-${lastTitle || 'end'}`;
        break;
    }
  }

  return `${baseFilename}.epub`;
}