# Kemono EPUB Creator

A browser extension for downloading selected posts from
[Kemono](https://kemono.cr) and [Pawchive](https://pawchive.pw) as organized
EPUB ebooks.

Browse a creator's posts, select individual chapters or a chapter range, choose
a dynamic filename format, and compile the result into an EPUB containing
embedded images and a table of contents. Individual posts can also be saved
directly from their webpages.

## Features

- **Kemono and Pawchive support**: Use the same extension on creator and post
  pages from either website.
- **EPUB generation**: Convert multiple creator posts into one structured EPUB.
- **Single-post downloads**: Save the currently displayed post as a standalone
  EPUB using the webpage as the source.
- **Image inclusion**: Download and embed supported images from post content.
- **Table of contents**: Generate an interactive EPUB table of contents for
  navigation.
- **Chapter selection**:
  - Select individual posts.
  - Select all currently displayed posts.
  - Limit the selection to a first and last chapter.
  - Load the next 50 posts or all remaining posts.
- **Post filtering**:
  - Filter Kemono posts using tags.
  - Search posts using a custom query.
- **Dynamic filenames**:
  - `{FirstPostTitle}-{LastPostTitle}.epub` (default)
  - `{CreatorName}_{FirstPostTitle}-{LastPostTitle}.epub`
  - `{CreatorName}_{FirstPostNumber}-{LastPostNumber}.epub`
  - A second-number pattern for titles such as `B3 Chapter 47`
  - `{CreatorName}_{BookAndChapterRange}.epub`
  - Manually edit the generated filename when needed.
- **Cover image support**: Use the creator's icon or provide a custom cover
  image URL.
- **Progress and cancellation**: View live generation progress and cancel an
  EPUB while it is being built.
- **SPA navigation support**: Download buttons are restored and rebound when
  navigating between creator and post pages without a full page reload.
- **Cross-browser compatibility**: One Manifest V3 package supports Firefox and
  Chromium-based browsers such as Chrome, Brave, Edge, Opera, and Vivaldi.

## Installation

### Mozilla Firefox

Kemono EPUB Creator is available from the
[Firefox Add-ons store](https://addons.mozilla.org/en-US/firefox/addon/kemono-epub-creator/).

To load the source temporarily:

1. Download or clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Select **Load Temporary Add-on...**.
4. Select `manifest.json`.

Temporary add-ons are removed when Firefox closes.

Firefox controls Manifest V3 website access separately from installation. A
fresh store installation requests access to Kemono and Pawchive during the
installation prompt. Existing users upgrading from a Kemono-only release may
need to visit a supported creator page, click the extension's toolbar icon, and
approve the new site-access request once.

### Chromium-based browsers

These instructions apply to Chrome, Brave, Edge, Opera, Vivaldi, and other
browsers that support loading unpacked Chromium extensions.

1. Download or clone this repository.
2. Open the browser's extensions page:
   - Chrome, Brave, or Vivaldi: `chrome://extensions`
   - Edge: `edge://extensions`
   - Opera: `opera://extensions`
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Select the directory with the `manifest.json` file.

Chrome may display a warning that `background.scripts` requires Manifest V2.
On Chrome 121 or newer, this is an expected cross-browser-manifest warning:
Chrome uses `background.service_worker`, while Firefox uses
`background.scripts`.

### Mobile browsers

Firefox for Android availability depends on the versions supported by the
Firefox Add-ons listing. Some third-party Chromium-based Android browsers can
load unpacked or packaged extensions, but this is browser-specific and is not
officially supported or tested by this project.

## Usage

1. Open a creator page on Kemono or Pawchive, for example:
   - `https://kemono.cr/patreon/user/12345`
   - `https://pawchive.pw/patreon/user/12345`
2. Select **Download EPUB** in the creator header.
   - If Firefox has not granted access to that website, click the extension's
     toolbar icon and approve the request. The creator page will reload so the
     button can be injected.
3. Wait for the EPUB Creator tab to load the first page of posts.
4. Select chapters using the checkboxes, **Select All Displayed**, or the first
   and last chapter controls.
5. Use **Load Next 50 Posts** or **Load All Remaining Posts** when more posts
   are available. Requests are intentionally rate-limited.
6. Optionally apply a Kemono tag filter or enter a custom search query.
7. Choose a filename pattern or edit the filename manually.
8. Optionally enable or change the cover image.
9. Select **Pack [X] Post(s) as EPUB**.
10. The completed EPUB downloads to the browser's configured download
    location.

To save only one post, open its post page and select **Download Post**. This
mode scrapes the displayed webpage instead of requiring the post API.

## Disclaimer

This extension is provided as-is, without warranty of any kind. Use it at your
own risk and follow all applicable laws and website terms.

Kemono and Pawchive are independent third-party websites with different owners
and developers. This project is not affiliated with either website. Changes to
their webpages, APIs, availability, or access policies may affect extension
functionality.
