// sanitize-filename.js
export default function sanitizeFilename(filename) {
  if (typeof filename !== 'string') {
    return '';
  }
  return filename.replace(/[/\\?%*:|"<>]/g, '_');
}