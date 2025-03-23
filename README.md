# YouTube Subtitle Translator and Downloader

This project provides a web application and API for fetching, translating, and downloading subtitles (closed captions) from YouTube videos. It leverages the `youtube-caption-extractor` library for subtitle retrieval and Google's Gemini AI models for high-quality translation.

## Features

*   **Subtitle Extraction:** Fetches subtitles directly from YouTube videos using the `youtube-caption-extractor` library.
*   **Automatic Language Detection and Dropdown:** The application automatically detects all available subtitle languages (including auto-generated ones) for a given YouTube video and presents them in a dropdown menu for the user to select.
*   **SRT Conversion:** The extracted subtitle data is converted into the standard SRT format.
*   **Translation with Google Gemini AI:** Uses Google's Gemini AI models (you'll need your own API key) to translate the subtitles into a target language.  The translation process prioritizes natural, conversational tone, and grammatical correctness.
*   **Progress Updates:** The translation process provides progress updates to the user interface.  This is especially useful for long videos.
*   **SRT File Download:** Provides the translated (or original) subtitles in the standard SRT (SubRip) format, ready for use with video players.
*   **Download-Only Mode:** Allows users to download the original subtitles (in SRT format) *without* translation.
*   **Configurable Translation Batch Size:** Lets you control the number of subtitle lines processed per translation request to the Gemini API.  This helps manage API usage and avoid rate limits.
*   **Multiple Gemini Model Support:** Allows users to select from a range of Gemini models, balancing speed and quality.
*   **Clear Error Handling:** Provides informative error messages to the user if something goes wrong (e.g., invalid YouTube URL, subtitles disabled, Gemini API key error).
*   **Simple Web Interface:** Includes a user-friendly web interface built with HTML, CSS, and JavaScript.  The interface includes a two-step process: 1) Get Video Details (to populate the language dropdown) and 2) Get Subtitles (to fetch the subtitles in the selected language).

## How it Works

1.  **User Input:** The user provides a YouTube video URL.
2.  **Video Details Retrieval:** The user clicks "Get Video Details". The application fetches information about the video, including the available subtitle languages. This information is used to populate a dropdown menu of available source languages.
3.  **Subtitle Language Selection:** The user selects the desired source language from the dropdown menu.
4.  **Subtitle Fetching:** The user clicks "Get Subtitles". The application uses `youtube-caption-extractor` and the selected language code to fetch the appropriate subtitle track from YouTube.
5.  **SRT Conversion:** The fetched subtitle data is converted into the standard SRT format.
6.  **(Optional) Translation:**
    *   If the user has provided a Gemini API key and requested translation:
        *   The SRT subtitles are split into batches.
        *   Each batch is sent to the Google Gemini API for translation.
        *   The translated subtitles are used to create the final SRT
        *   Progress updates are provided to the user.
7.  **Download:** The final SRT file (either translated or the original) is made available for download.

## Project Structure

*   **`server.js`:** The main Node.js server file. Contains all the server-side logic.
*   **`public/`:**
    *   **`index.html`:** The main HTML file, including inline CSS and JavaScript for simplicity.
*   **`package.json`:** Lists dependencies and scripts.

## Setup and Installation

1.  **Prerequisites:**
    *   **Node.js and npm:** (Node.js 12+ recommended) [https://nodejs.org/](https://nodejs.org/)
    *   **Google Gemini API Key:** (If you want to use translation) [https://ai.google.dev/](https://ai.google.dev/)

2.  **Clone/Create Files:**
    *   **Clone:** `git clone <repository_url> ; cd <project_directory>`  (If you have a repository)
    *   **Create:** Create the project directory and files (`server.js`, `public/index.html`).

3.  **Install Dependencies:**
    ```bash
    npm install express @google/generative-ai youtube-caption-extractor node-fetch uuid
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

*   **`/get-video-details` (POST):** Fetches the available subtitle languages for a given YouTube video.
    *   **Request Body:**
        ```json
        {
            "url": "YOUR_YOUTUBE_VIDEO_URL"
        }
        ```
    *   **Response (Success):**
        ```json
        {
            "availableLanguages": [
                { "code": "en", "name": "English", "isAutoGenerated": false },
                { "code": "fr", "name": "French", "isAutoGenerated": false },
                ...
            ]
        }
        ```
    *   **Response (Error):**
        ```json
        { "error": "Error message" }
        ```
        Possible error messages: "YouTube URL is required", "Invalid YouTube URL", or a message indicating a failure to fetch languages.

*   **`/fetch-subtitles` (POST):** Fetches the subtitles in SRT format.
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
    *   **Response (Error):**
        ```json
         { "error": "Error message" }
        ```
        Possible error messages include: "YouTube URL is required", "Language code is required", "Invalid YouTube URL", "No subtitles found for language: ...".
*   **`/progress/:id` (GET):** Get the progress of a translation.
    *   **Path Parameter:**
        *   `id`: The translation ID.
    * **Response (Success)**
    ```json
     {
        "message": "Translating lines 1 to 20 of 100",
        "progress": 20,
        "total": 100,
        "completed": false,
        "srt": null
     }
    ```
     *   **Response (Error):**
        ```json
        { "error": "Translation not found" }
        ```
*   **`/process-subtitles` (POST):** Translates the subtitles.
    * **Request Body:**
       ```json
        {
            "apiKey": "YOUR_GEMINI_API_KEY",
            "srt": "1\n00:00:00,000 --> 00:00:05,000\nSubtitle text...\n\n...",
            "lang": "es", // Target language code (e.g., "es" for Spanish)
            "downloadOnly": false,  // Set to true to skip translation
            "linesPerRequest": 20,  // Number of lines to send per Gemini request
            "model": "gemini-pro" // Gemini model to use
        }
        ```
    * **Response (Success):**
         ```json
        { "translationId": "UNIQUE_TRANSLATION_ID" }
        ```
    * **Response (Error):**
        ```json
         { "error": "Error message" }
        ```

## Troubleshooting

*   **Gemini API Errors:** Check your API key and rate limits. Ensure your key is valid and that you haven't exceeded your quota.
*   **Subtitles Not Found:** Make sure the video has subtitles in the selected language.
*   **`fetch is not a function` Error:** Make sure you've followed the installation instructions, including installing `node-fetch`. If you're on an older Node.js, you may need to use dynamic imports (see the code).
*   **General Errors:** Check the server console for detailed error messages.

## Contributing

Contributions are welcome!  Open an issue or submit a pull request.

## License

MIT License