const express = require('express');
const { YoutubeTranscript } = require('youtube-transcript');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs/promises');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Proxy Management ---
let proxies = [];
let currentProxyIndex = 0;

async function fetchProxies() {
    try {
        const response = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all', { timeout: 10000 });
        const fetchedProxies = response.data.split('\r\n')
            .map(proxy => proxy.trim())
            .filter(proxy => proxy !== '');
        
        if (fetchedProxies.length > 0) {
            proxies = fetchedProxies;
            currentProxyIndex = 0;
            console.log(`[PROXY] Successfully fetched ${proxies.length} proxies`);
            return true;
        }
        console.warn('[PROXY] No proxies fetched from API');
        return false;
    } catch (error) {
        console.error('[PROXY] Error fetching proxies:', error.message);
        return false;
    }
}

function getNextProxy() {
    if (proxies.length === 0) {
        console.warn('[PROXY] No proxies available in pool');
        return null;
    }
    const proxy = proxies[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
    return proxy;
}

// --- User-Agent Rotation ---
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
];

// --- Enhanced YoutubeTranscript Fetching with Retry Loop and Timeout ---
async function fetchTranscriptWithProxy(url) {
    // Fetch fresh proxies for each request
    console.log('[YOUTUBE] Fetching fresh proxy list');
    const success = await fetchProxies();
    if (!success) {
        throw new Error('Failed to fetch proxies');
    }

    let attempts = 0;
    const maxAttempts = proxies.length;
    const PROXY_TIMEOUT = 10000; // 10 seconds timeout per proxy attempt

    while (attempts < maxAttempts) {
        let proxyUrl = getNextProxy();
        if (!proxyUrl) {
            throw new Error('No proxies available');
        }

        const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
        const proxyAgent = new HttpsProxyAgent(`http://${proxyUrl}`);

        console.log(`[YOUTUBE] Attempt ${attempts + 1}/${maxAttempts} with proxy: ${proxyUrl}`);
        console.log(`[YOUTUBE] User-Agent: ${randomUserAgent}`);

        const originalFetch = YoutubeTranscript.fetchTranscript;
        YoutubeTranscript.fetchTranscript = async function(videoUrl, options = {}) {
            try {
                // Wrap axios request in a Promise with timeout
                const fetchPromise = axios.get(`https://www.youtube.com/watch?v=${extractVideoId(videoUrl)}`, {
                    httpsAgent: proxyAgent,
                    headers: {
                        'User-Agent': randomUserAgent,
                    },
                    timeout: PROXY_TIMEOUT
                });

                const response = await Promise.race([
                    fetchPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Proxy timeout')), PROXY_TIMEOUT))
                ]);

                console.log(`[YOUTUBE] Initial page fetch status: ${response.status}`);
                
                const transcript = await originalFetch.call(this, videoUrl, {
                    ...options,
                    fetchOptions: {
                        ...options.fetchOptions,
                        httpsAgent: proxyAgent,
                        headers: {
                            'User-Agent': randomUserAgent,
                            ...(options.fetchOptions?.headers || {})
                        }
                    }
                });
                
                return transcript;
            } catch (error) {
                console.error(`[YOUTUBE] Proxy ${proxyUrl} failed:`, error.message);
                throw error;
            }
        };

        try {
            const transcriptPromise = YoutubeTranscript.fetchTranscript(url);
            const transcript = await Promise.race([
                transcriptPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Transcription timeout')), PROXY_TIMEOUT))
            ]);
            console.log(`[YOUTUBE] Successfully fetched transcript using proxy ${proxyUrl}`);
            YoutubeTranscript.fetchTranscript = originalFetch; // Restore immediately on success
            return transcript;
        } catch (error) {
            YoutubeTranscript.fetchTranscript = originalFetch; // Restore on failure
            attempts++;
            if (error.message === 'Transcription timeout' || error.message === 'Proxy timeout') {
                console.log(`[YOUTUBE] Proxy ${proxyUrl} timed out after ${PROXY_TIMEOUT / 1000}s`);
            }
            if (attempts === maxAttempts) {
                throw new Error('All proxies failed or timed out');
            }
            console.log(`[YOUTUBE] Retrying with next proxy... (${maxAttempts - attempts} attempts remaining)`);
            await delay(1000); // Small delay between retries
        }
    }
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
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    try {
        console.log(`[FETCH] Starting transcript fetch for video: ${videoId}`);
        const transcript = await fetchTranscriptWithProxy(url);
        const srt = transcript.map((item, index) => 
            `${index + 1}\n${secondsToSrtTimecode(item.offset)} --> ${secondsToSrtTimecode(item.offset + item.duration)}\n${item.text.trim()}\n`
        ).join('\n');
        
        console.log(`[FETCH] Successfully fetched ${transcript.length} subtitle entries`);
        res.json({ srt });

    } catch (error) {
        console.error(`[FETCH] Error for video ${videoId}:`, error);

        let errorMessage = 'Failed to fetch transcript';
        let statusCode = 500;

        if (error.name === 'YoutubeTranscriptDisabledError') {
            errorMessage = 'Subtitles are disabled for this video';
            statusCode = 400;
        } else if (error.message.includes('No transcript found')) {
            errorMessage = 'No transcript found for this video';
            statusCode = 404;
        } else if (error.message === 'Failed to fetch proxies' || error.message === 'No proxies available') {
            errorMessage = 'Unable to fetch working proxies';
            statusCode = 503;
        } else if (error.message === 'All proxies failed or timed out') {
            errorMessage = 'All available proxies failed or timed out';
            statusCode = 503;
        } else if (error.message.startsWith('Request failed with status code')) {
            errorMessage = `YouTube request failed: ${error.message}`;
            statusCode = parseInt(error.message.match(/\d+$/)[0], 10) || 500;
        }

        res.status(statusCode).json({ error: errorMessage });
    }
});

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
        console.log('[INIT] Starting server without initial proxy fetch');
        app.listen(port, () => {
            console.log(`[INIT] Server running at http://localhost:${port}`);
        });
    } catch (error) {
        console.error('[INIT] Startup error:', error);
        process.exit(1);
    }
})();
