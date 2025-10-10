# -Kemono-EPUB-Creator

A browser extension to easily download selected posts from Kemono.cr as organized EPUB ebooks. This extension provides a user-friendly interface to browse posts, select a range or specific chapters, choose dynamic filename formats, and compile them into a readable EPUB file, complete with images and a table of contents.

## Features

*   **EPUB Generation**: Convert multiple Kemono posts into a single, well-structured EPUB file.
*   **Image Inclusion**: Automatically downloads and embeds images from post content.
*   **Table of Contents**: Generates an interactive Table of Contents (TOC) within the EPUB for easy navigation.
*   **Chapter Selection**: Select individual posts or define a range of chapters to include.
*   **Dynamic Filenames**:
    *   Customize the generated EPUB filename based on various patterns:
        *   `{FirstPostTitle}-{LastPostTitle}.epub` (default)
        *   `{CreatorName}_{FirstPostTitle}-{LastPostTitle}.epub`
        *   `{CreatorName}_{FirstPostNumber}-{LastPostNumber}.epub` (extracts numerical range from titles)
    *   Manually edit the filename, with the option to revert to dynamic generation.
*   **Cover Image Support**: Optionally set a custom cover image URL for your EPUB (defaults to the creator's icon).
*   **Progress Tracking**: Live progress updates during EPUB generation and image downloading.
*   **Cross-Browser Compatibility**: Designed to work on both Firefox and Chromium-based browsers (Chrome, Brave, Edge).

## Installation

This extension is <s>not available on official browser stores</s> now availible on the [Firefox store](https://addons.mozilla.org/en-US/firefox/addon/kemono-epub-creator/). You can install it manually on chromium browsers by loading it as an unpacked extension.

### For Chromium-based Browsers (Chrome, Brave, Edge, Opera, Vivaldi)

1.  **Download**: Download the Chromium folder in this repository. Make sure the `manifest.json` file is directly inside this folder.
2.  **Open Extensions Page**:
    *   Open your browser.
    *   Go to `chrome://extensions` (for Chrome, Brave, Edge) or `opera://extensions` (for Opera).
3.  **Enable Developer Mode**: In the top right corner, toggle on "Developer mode".
4.  **Load Unpacked**: Click the "Load unpacked" button (usually in the top left).
5.  **Select Folder**: Navigate to and select the Chromium folder.

### For Mozilla Firefox

**Firefox add-on store link**: https://addons.mozilla.org/en-US/firefox/addon/kemono-epub-creator/

**Or follow instructions to load temporary add-on**
1.  **Download**: Download the Firefox folder in this repository. Make sure the `manifest.json` file is directly inside this folder.
2.  **Open Add-ons Page**:
    *   Open Firefox.
    *   Go to `about:debugging#/runtime/this-firefox`.
3.  **Load Temporary Add-on**: Click the "Load Temporary Add-on..." button.
4.  **Select manifest.json**: Navigate to the Firefox folder and select the `manifest.json` file.
5.  **Note for Firefox**: Temporary add-ons are removed when Firefox is closed. To install permanently, you would need to sign the extension. For personal use, reloading it after each browser restart is typical.

### For Mobile
   You can install the extension on Firefox mobile through the store, or find a browser Chromium that lets you add un-signed extentions (Lemur Browser) and install it. This might require you to pack the extention into a crx file. Good luck.

## Usage

1.  **Navigate to Kemono.cr**: Go to any creator's page on `kemono.cr` (e.g., `https://kemono.cr/patreon/user/12345`).
2.  **Click the "Dowload EPUB" button**: If the button does not appear in the user-header card, reload the page. The extension won't detect the creators page loading unless the page is loaded from an external link or reloaded. For example, navigating internally on kemono.cr won't load the button. 
3.  **EPUB Creator Tab**: A new tab will open with the EPUB Creator interface.
4.  **Load Posts**: The extension will automatically start loading the creator's posts. Wait for the list to populate.
5.  **Select Chapters**:
    *   Use the checkboxes next to each post to select individual chapters.
    *   Use "Select All Displayed" or "Unselect All Displayed" buttons.
    *   Use the "First Chapter" and "Last Chapter" dropdowns to limit selection to a range of posts. This is useful is you want to use the "Select All" option to automatically select all posts within that range for quicker selection.
6.  **Load More Posts**: If not all posts are loaded, use "Load Next 50 Posts" or "Load All Remaining Posts". Due to intentional rate limiting, Loading all posts might take a few seconds, or longer if there are a lot.
7.  **Configure Filename (Optional)**:
    *   The "EPUB Filename" field will dynamically update based on your selected chapters and the chosen "Filename Pattern".
    *   You can manually edit the filename. If you do, it will stop dynamic updates until you change chapter selection or the pattern again.
    *   Choose a "Filename Pattern" from the dropdown to automatically generate names based on titles or numerical ranges. Your last chosen pattern will be remembered.
8.  **Set Cover Image (Optional)**: Enter a URL for a custom cover image, or leave it blank to use the creator's icon.
9.  **Pack EPUB**: Click the "Pack [X] Post(s) as EPUB" button.
10. **Download**: Once complete, the EPUB file will automatically download to your browser's default download location.

## Disclaimer

This extension is provided as-is, without warranty of any kind. Use at your own risk. It interacts with a third-party website, Kemono.cr, and its functionality may be affected by changes to that website's structure or API.

