# YouTube Subtitle Translator and Downloader

This project provides a web application and API for fetching, translating, and downloading subtitles (closed captions) from YouTube videos. It leverages the power of `youtubei.js` for robust subtitle retrieval and Google's Gemini AI models for high-quality translation.

## Features

*   **Subtitle Extraction:** Fetches subtitles directly from YouTube videos using the `youtubei.js` library.  This library is generally more reliable than other methods because it uses YouTube's internal APIs.
*   **Automatic Language Detection and Dropdown:** The application automatically detects all available subtitle languages for a given YouTube video and presents them in a dropdown menu for the user to select.
*   **JSON and XML Subtitle Handling:**  Handles both JSON3 and XML subtitle formats returned by YouTube's API.  Includes robust XML parsing with error handling to deal with potentially malformed XML.
*   **Translation with Google Gemini AI:**  Uses Google's Gemini AI models (you'll need your own API key) to translate the subtitles into a target language.  The translation process prioritizes natural, conversational tone, and grammatical correctness.
*   **Streaming Translation:**  The translation process uses server-sent events (SSE) to provide real-time progress updates to the user interface.  This is especially useful for long videos.
*   **SRT File Download:**  Provides the translated (or original) subtitles in the standard SRT (SubRip) format, ready for use with video players.
*   **Download-Only Mode:**  Allows users to download the original subtitles (in SRT format) *without* translation.
*   **Configurable Translation Batch Size:**  Lets you control the number of subtitle lines processed per translation request to the Gemini API.  This helps manage API usage and avoid rate limits.
*   **Multiple Gemini Model Support:**  Allows users to select from a range of Gemini models, balancing speed and quality.
*   **Clear Error Handling:** Provides informative error messages to the user if something goes wrong (e.g., invalid YouTube URL, subtitles disabled, Gemini API key error, XML parsing errors).
*   **Simple Web Interface:** Includes a user-friendly web interface built with HTML, CSS, and JavaScript.  The interface includes a two-step process: 1) Get Video Details (to populate the language dropdown) and 2) Get Subtitles (to fetch the subtitles in the selected language).

## How it Works

1.  **User Input:** The user provides a YouTube video URL.
2.  **Video Details Retrieval:** The user clicks "Get Video Details". The application uses `youtubei.js` to fetch information about the video, including the available subtitle languages.  This information is used to populate a dropdown menu of available source languages.
3.  **Subtitle Language Selection:** The user selects the desired source language from the dropdown menu.
4.  **Subtitle Fetching:** The user clicks "Get Subtitles".
    *   The application uses `youtubei.js` and the selected language code to fetch the appropriate subtitle track from YouTube.
    *   It first tries to fetch JSON3 formatted subtitles.  If that fails, it tries XML format.
5.  **Subtitle Processing (JSON or XML):**
    *   The fetched subtitle data (either JSON or XML) is parsed into a structured format (an array of objects, each representing a subtitle entry with `offset`, `duration`, and `text`).
    *   Robust XML parsing with error handling is used.
6.  **SRT Conversion:**  The parsed subtitle data is converted into the standard SRT format.
7.  **(Optional) Translation:**
    *   If the user has provided a Gemini API key and requested translation:
        *   The SRT subtitles are split into batches.
        *   Each batch is sent to the Google Gemini API for translation.
        *   The translated subtitles are streamed back to the client using server-sent events (SSE), providing progress updates.
        *  The translated subtitles are combined and converted back into the SRT format.
8.  **Download:**  The final SRT file (either translated or the original) is made available for download.

## Project Structure

*   **`server.js`:** The main Node.js server file. Contains all the server-side logic.
*   **`public/`:**
    *   **`index.html`:**  The main HTML file, including inline CSS and JavaScript for simplicity.
*   **`package.json`:**  Lists dependencies and scripts.

## Setup and Installation

1.  **Prerequisites:**
    *   **Node.js and npm:** (Node.js 16+ recommended) [https://nodejs.org/](https://nodejs.org/)
    *   **Google Gemini API Key:**  (If you want to use translation) [https://ai.google.dev/](https://ai.google.dev/)

2.  **Clone/Create Files:**
    *   **Clone:** `git clone <repository_url> ; cd <project_directory>`
    *   **Create:** Create the project directory and files (`server.js`, `public/index.html`).

3.  **Install Dependencies:**
    ```bash
    npm install express youtubei.js @google/generative-ai axios @xmldom/xmldom
    ```

4.  **Place the Code:**
    *   Copy the JavaScript code into `server.js`.
    *   Copy the HTML/CSS/JavaScript code into `public/index.html`.

5.  **Run the Server:**
    ```bash
    node server.js
    ```

6.  **Access the Web Interface:**
    Open `http://localhost:3000` in your browser.

## API Endpoints

*   **`/get-languages` (GET):**  Fetches the available subtitle languages for a given YouTube video.
    *   **Query Parameters:**
        *   `url`: The YouTube video URL (required).
    *   **Response (Success):**
        ```json
        {
            "languages": [
                { "code": "en", "name": "English" },
                { "code": "fr", "name": "French" },
                ...
            ]
        }
        ```
    * **Response (Error):**
        ```json
        { "error": "Error message" }
        ```
        Possible error messages: "YouTube URL is required", "Invalid YouTube URL", "No captions available for this video.", or a message indicating a failure to fetch languages.

*   **`/fetch-subtitles` (POST):**  Fetches the subtitles in SRT format.
    *   **Request Body:**
        ```json
        {
            "url": "YOUR_YOUTUBE_VIDEO_URL",
            "languageCode": "en" // Selected language code (e.g., "en", "fr")
        }
        ```
    *   **Response (Success):**
        ```json
        {
            "srt": "1\n00:00:00,000 --> 00:00:05,000\nSubtitle text...\n\n..."
        }
        ```
    *   **Response (Error):**  See the original README for the comprehensive list of possible errors.

*   **`/process-subtitles` (GET):**  Translates the subtitles (using SSE).  See the original README for details.  This endpoint hasn't changed.

## Troubleshooting

*   **`CompositeVideoPrimaryInfo not found!` Error:**  Update `youtubei.js`: `npm update youtubei.js` or `npm install youtubei.js@latest`.
*   **Gemini API Errors:**  Check your API key and rate limits.
*   **XML Parsing Errors:** The application handles these robustly.  It usually indicates malformed XML from YouTube.
*   **Subtitles Not Found:** Make sure the video has subtitles in the selected language.
* **General Errors:** Check server console for details.

## Contributing

Contributions are welcome!  Open an issue or submit a pull request.  Consider contributing to `youtubei.js` if you encounter parsing issues.

## License

MIT License.