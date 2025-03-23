const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Innertube } = require('youtubei.js');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs'); // For synchronous operations and existsSync
const axios = require('axios');
const { DOMParser } = require('@xmldom/xmldom');

const app = express();
const port = process.env.PORT || 3000;

// Initialize youtubei.js Innertube client globally
let innertube;
(async () => {
    innertube = await Innertube.create();
})();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());


// --- Method 2: Fetching Transcripts with youtubei.js ---
async function fetchTranscriptWithYoutubei(url, languageCode = 'en') {
    const videoId = extractVideoId(url);

    // Fetch video info with youtubei.js
    console.log('[YOUTUBE] Fetching video info with youtubei.js (Method 2)');
    let video;
    try {
        video = await innertube.getInfo(videoId);
        // Removed: Saving captions to a file.
        console.log('[DEBUG] Full video object keys:', Object.keys(video));
        console.log('[DEBUG] PlayerResponse captions:', JSON.stringify(video.playerResponse?.captions, null, 2));

    } catch (error) {
        throw new Error('Failed to fetch video info with youtubei.js (Method 2): ' + error.message);
    }

    let baseUrl;
    async function getCaptionTrackAndBaseUrl(captions, languageCode) {
        if (!captions || !captions.caption_tracks) {
            throw new Error('No captions data available.');
        }

        const captionTrack = captions.caption_tracks.find(track => track.language_code === languageCode);
        if (!captionTrack) {
            throw new Error(`No caption track found for language code: ${languageCode}`);
        }

        return { baseUrl: captionTrack.base_url };
    }

    async function processCaptionsFromBaseUrl(baseUrl) {
        console.log('[YOUTUBE] Fetching transcript from base URL');
        try {
            const response = await axios.get(`${baseUrl}&fmt=json3`);
            return processYoutubeiTranscript(response.data);  // Use existing processor
        } catch (jsonError) {
            console.error('[YOUTUBE] JSON fetch failed, trying XML:', jsonError.message);
            try {
                const xmlResponse = await axios.get(baseUrl);
                return processXmlTranscript(xmlResponse.data); // Use existing XML processor
            } catch (xmlError) {
                 throw new Error(`Failed to fetch transcript (both JSON and XML): ${xmlError.message}`);
            }
        }

    }

    try {
        const {  baseUrl: fetchedBaseUrl } = await getCaptionTrackAndBaseUrl(video.captions, languageCode);
        baseUrl = fetchedBaseUrl;
        const transcript = await processCaptionsFromBaseUrl(baseUrl);
        return transcript;
    } catch (error) {
        console.error('[YOUTUBE] Error fetching or processing captions:', error);
        throw error;
    }
}

// Existing JSON processing function
function processYoutubeiTranscript(data) {
    if (!data.events) {
        throw new Error('Invalid transcript data format');
    }
    return data.events
        .filter(event => event.segs)
        .map(event => ({
            offset: event.tStartMs / 1000,
            duration: (event.dDurationMs || 2000) / 1000, // Default 2s if duration missing
            text: event.segs.map(seg => seg.utf8).join(' ')
        }));
}
// Improved XML processing function
function processXmlTranscript(xmlData) {
    const parser = new DOMParser({
        errorHandler: {
            warning: (w) => { console.warn("XML Warning:", w); },  // Log warnings
            error: (e) => { console.error("XML Error:", e); },     // Log errors
            fatalError: (e) => { console.error("XML Fatal Error:", e); throw e; } // Throw fatal errors
        }
    });
    const xmlDoc = parser.parseFromString(xmlData, 'text/xml');

    // Check for parser errors *before* proceeding.  This is key!
    if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
        const errorText = xmlDoc.getElementsByTagName('parsererror')[0].textContent;
        console.error("XML Parsing Error:", errorText);
        throw new Error("Failed to parse XML transcript: " + errorText);
    }


    const textNodes = xmlDoc.getElementsByTagName('text');
    const transcript = [];

    for (let i = 0; i < textNodes.length; i++) {
        const node = textNodes[i];
        const start = parseFloat(node.getAttribute('start'));

        // Handle missing 'dur' attribute more robustly:
        const durAttr = node.getAttribute('dur');
        const dur = durAttr ? parseFloat(durAttr) : 2; // Default 2s, but *parse* if it exists

        const text = node.textContent.trim();

        if (text) {
            transcript.push({
                offset: start,
                duration: dur,
                text: text
            });
        }
    }

    return transcript;
}
// --- Helper Functions ---
function secondsToSrtTimecode(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function translateText(text, targetLang, apiKey, modelName, retry = true) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });
    const prompt = `Translate the following subtitle text into ${targetLang} while maintaining:
- Natural, conversational tone
- Proper grammar and sentence structure
- Contextual accuracy
- Consistent terminology
- Appropriate length for on-screen display

Avoid:
- Literal translations
- Overly formal or bookish language
- Unnatural phrasing
- Excessive wordiness

Return ONLY the translated phrase, and nothing else. Do not include any introductory text. Do not include any numbering.

Input Text:
${text}`;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        if (error.status === 429 && retry) {
            console.log('[TRANSLATE] Gemini 429 error, waiting 60 seconds before retry...');
            await delay(60000);
            return translateText(text, targetLang, apiKey, modelName, false);
        }
        throw error;
    }
}

function extractVideoId(url) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^"&?\/\s]{11})/);
    return match ? match[1] : null;
}

// --- API Endpoints ---
app.post('/fetch-subtitles', async (req, res) => {
     const { url, languageCode = 'en' } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    try {
       console.log(`[FETCH] Starting transcript fetch for video: ${videoId} , Language: ${languageCode}`);
        let transcript = await fetchTranscriptWithYoutubei(url, languageCode);
        const srt = transcript.map((item, index) =>
            `${index + 1}\n${secondsToSrtTimecode(item.offset)} --> ${secondsToSrtTimecode(item.offset + item.duration)}\n${item.text.trim()}\n`
        ).join('\n');
        console.log(`[FETCH] Successfully fetched ${transcript.length} subtitle entries`);
        res.json({ srt });

    } catch (error) {
        console.error(`[FETCH] Error for video ${videoId} :`, error);

        let errorMessage = 'Failed to fetch transcript';
        let statusCode = 500;

        if (error.message.includes('No caption tracks available')) {
            errorMessage = 'Subtitles are disabled or unavailable for this video';
            statusCode = 400;
        } else if (error.message.includes('No transcript found')) {
            errorMessage = 'No transcript found for this video';
            statusCode = 404;
        } else if (error.message.startsWith('Request failed with status code')) {
            errorMessage = `YouTube request failed: ${error.message}`;
            statusCode = parseInt(error.message.match(/\d+$/)[0], 10) || 500;
        } else if (error.message.includes('Failed to write captions file')) {
            errorMessage = 'Failed to save caption data.';
            statusCode = 500;
        }  else if (error.message.includes('No caption track found for language code')) {
            errorMessage = error.message;
            statusCode = 404;
        } else if (error.message.includes('Failed to parse XML transcript')) { // XML parse error
            errorMessage = 'Failed to parse the XML subtitle data.';
            statusCode = 500;
        } else if (error.message.includes('Failed to fetch video info')) {
            errorMessage = "Failed to get video information.  This might be due to a temporary issue with the youtubei.js library.  Please try again later, or try updating the youtubei.js library.";
            statusCode = 500;
        }
        res.status(statusCode).json({ error: errorMessage });
    }
});

// --- Process Subtitles Endpoint (Unchanged) ---
app.get('/process-subtitles', async (req, res) => {
    const { apiKey, srt, lang, downloadOnly, linesPerRequest, model } = req.query;

    if (!apiKey) {
        return res.status(400).send('Gemini API key is required');
    }
    if (!srt) {
        return res.status(400).send('Subtitles content is required');
    }
    if (downloadOnly !== 'true' && !lang) {
        return res.status(400).send('Target language is required for translation');
    }
    if (downloadOnly !== 'true' && !linesPerRequest) {
        return res.status(400).send('Lines per request is required for transcription');
    }
    if (!model) {
        return res.status(400).send('Model selection is required');
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const shouldDownloadOnly = downloadOnly === 'true';
    const maxLines = Math.min(parseInt(linesPerRequest, 10) || 1, 50);

    const sendProgress = (message, progress, total) => {
        res.write(
            `data: ${JSON.stringify({ type: 'progress', message, progress, total })}\n\n`
        );
    };

    const sendError = (error) => {
        console.error('[PROCESS] Error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
        res.end();
    };

    const sendFinalSrt = (srt) => {
        res.write(`data: ${JSON.stringify({ type: 'complete', srt })}\n\n`);
        res.end();
    };

    try {
        let finalSrt = decodeURIComponent(srt);

        if (!shouldDownloadOnly) {
            const lines = finalSrt.split('\n');
            const transcript = [];
            let currentItem = null;

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('-->')) {
                    currentItem = { time: lines[i], text: '' };
                } else if (
                    lines[i].trim() &&
                    currentItem &&
                    !/^\d+$/.test(lines[i])
                ) {
                    currentItem.text += lines[i].trim() + ' ';
                } else if (!lines[i].trim() && currentItem) {
                    transcript.push(currentItem);
                    currentItem = null;
                }
            }

            if (transcript.length === 0) {
                throw new Error('Failed to parse subtitles for transcription');
            }

            const total = transcript.length;
            const translations = [];
            for (let i = 0; i < total; i += maxLines) {
                const batch = transcript.slice(i, i + maxLines);
                const batchText = batch.map((item) => item.text.trim()).join('\n');

                sendProgress(
                    `Translating lines ${i + 1} to ${Math.min(
                        i + maxLines,
                        total
                    )} of ${total}`,
                    i + maxLines,
                    total
                );
                const translatedBatch = await translateText(
                    batchText,
                    lang,
                    apiKey,
                    model
                );
                const translatedLines = translatedBatch.split('\n');

                if (translatedLines.length !== batch.length) {
                    console.warn('[PROCESS] Mismatch in translated lines, adjusting...');
                }
                translations.push(...translatedLines.slice(0, batch.length));

                if (i + maxLines < total) {
                    console.log('[PROCESS] Waiting 4 seconds before next batch...');
                    await delay(4000);
                }
            }

            if (translations.length < total) {
                translations.push(...Array(total - translations.length).fill(''));
            }

            finalSrt = transcript
                .map((item, index) => {
                    return `${index + 1}\n${item.time}\n${
                        translations[index] || item.text.trim()
                    }\n`;
                })
                .join('\n');
        } else {
            sendProgress('Preparing download without transcription', 1, 1);
        }

        sendFinalSrt(finalSrt);
    } catch (error) {
        console.error('[PROCESS] Error in processing:', error);
        if (error.status === 429) {
            sendError('Gemini API rate limit exceeded. Please try again later.');
        } else if (error.message.includes('API key')) {
            sendError('Invalid Gemini API key');
        } else {
            sendError(error.message || 'Failed to process subtitles');
        }
    }
});

// --- Initialization ---
(async () => {
    try {
        console.log('[INIT] Starting server');
        app.listen(port, () => {
            console.log(`[INIT] Server running at http://localhost:${port}`);
        });
    } catch (error) {
        console.error('[INIT] Startup error:', error);
        process.exit(1);
    }
})();