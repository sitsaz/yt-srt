// server.js
const express = require('express');
const { YoutubeTranscript } = require('youtube-transcript');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs/promises');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const cheerio = require('cheerio'); // For HTML scraping (if needed)

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Proxy Management ---
let proxies = []; // Array to store fetched proxies
let currentProxyIndex = 0;

// Function to fetch proxies (Example: ProxyScrape API - Free Tier)
async function fetchProxies() {
    try {
        const response = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all');
        const fetchedProxies = response.data.split('\r\n').filter(proxy => proxy.trim() !== '');
        if (fetchedProxies.length > 0) {
            proxies = fetchedProxies;
            currentProxyIndex = 0; // Reset index
            console.log(`Fetched ${proxies.length} proxies from ProxyScrape.`);
            await saveProxiesToFile(); // Save to file
        } else {
            console.warn('No proxies fetched from ProxyScrape.');
        }
    } catch (error) {
        console.error('Error fetching proxies from ProxyScrape:', error.message);
    }
}

// Function to get the next proxy (with retries and error handling)
async function getNextProxy() {
    const maxRetries = 3; // Maximum retries per proxy
    let retries = 0;

    while (retries < maxRetries) {
        if (proxies.length === 0) {
            console.log("proxies array is empty");
            await fetchProxies(); // Fetch proxies if list is empty
            if (proxies.length === 0) {
                // If still empty after fetching, return null
                console.error("No proxies available even after fetching.");
                return null;
            }
        }

        const proxy = proxies[currentProxyIndex];
        currentProxyIndex = (currentProxyIndex + 1) % proxies.length;

        if (await isProxyWorking(proxy)) { // Check if proxy is working
            return proxy;
        } else {
            console.warn(`Proxy ${proxy} is not working, trying next...`);
        }

        retries++;
    }

    console.error(`Max retries (${maxRetries}) reached for getting a working proxy.`);
    return null; // Or throw an error: throw new Error('No working proxies available');
}

// Function to check if a proxy is working
async function isProxyWorking(proxy) {
    try {
        const testUrl = 'https://www.youtube.com/'; // Use a reliable test URL
        const proxyAgent = new HttpsProxyAgent(proxy);
        const response = await axios.get(testUrl, {
            httpsAgent: proxyAgent,
            timeout: 5000, // Shorter timeout for testing
        });
        return response.status >= 200 && response.status < 300;

    } catch (error) {
        // console.error(`Proxy ${proxy} failed:`, error.message);  // Optional logging
        return false;
    }
}

async function saveProxiesToFile() {
    try {
        const filePath = path.join(__dirname, 'proxies.json');
        await fs.writeFile(filePath, JSON.stringify(proxies), 'utf8');
        console.log('Proxies saved to file.');
    } catch (error) {
        console.error('Error saving proxies to file:', error);
    }
}

async function loadProxiesFromFile() {
    try {
        const filePath = path.join(__dirname, 'proxies.json');
        const data = await fs.readFile(filePath, 'utf8');
        proxies = JSON.parse(data);
        console.log('Proxies loaded from file.');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('proxies.json file not found, starting with empty proxy list.');
        } else {
            console.error('Error loading proxies from file:', error);
        }
    }
}

// --- Caching Setup ---
const cacheDir = path.join(__dirname, 'cache');

async function getCachedTranscript(videoId) {
    try {
        const filePath = path.join(cacheDir, `${videoId}.json`);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null; // Not found
        }
        throw error; // Other errors
    }
}

async function saveCachedTranscript(videoId, transcript) {
    try {
        await fs.mkdir(cacheDir, { recursive: true });
        const filePath = path.join(cacheDir, `${videoId}.json`);
        await fs.writeFile(filePath, JSON.stringify(transcript), 'utf8');
    } catch (err) {
        console.error("Error writing to cache:", err);
    }
}

// --- User-Agent Rotation (Monkey-Patching - Modified for Axios) ---
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36 Edg/92.0.902.67',
];

// Monkey-patch the YoutubeTranscript._fetchCaptions method (using Axios)
const originalFetchCaptions = YoutubeTranscript.prototype._fetchCaptions;
YoutubeTranscript.prototype._fetchCaptions = async function (fetchOptions) {

    const proxyUrl = await getNextProxy(); // Await the proxy
    if (!proxyUrl) {
        throw new Error('No working proxies available');
    }
    const proxyAgent = new HttpsProxyAgent(proxyUrl);
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    console.log(`Using User-Agent: ${randomUserAgent}`);
    console.log(`Using Proxy: ${proxyUrl}`);

    try {
        const response = await axios.get(fetchOptions.url, {
            httpsAgent: proxyAgent,
            headers: {
                'User-Agent': randomUserAgent,
                Cookie: fetchOptions.cookie,
            },
            timeout: 15000,
        });
        return originalFetchCaptions.call(this, { ...fetchOptions, data: response.data });

    } catch (error) {
        console.error("Axios request failed:", error.message);
        if (error.code === 'ECONNABORTED') {
            console.error('Request timed out');
        } else if (error.response) {
            console.error(`Response status: ${error.response.status}`);
        }
        throw error;
    }
};

// --- Helper Functions ---

function secondsToSrtTimecode(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds - Math.floor(seconds)) * 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
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

Return ONLY the translated phrase, and nothing else.  Do not include any introductory text. Do not include any numbering.

Input Text:
${text}`;

    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        if (error.status === 429 && retry) {
            console.log('Gemini 429 error, waiting 60 seconds before retry...');
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
        // --- Caching Logic ---
        const cachedTranscript = await getCachedTranscript(videoId);
        if (cachedTranscript) {
            console.log('Using cached transcript');
            const srt = cachedTranscript.map((item, index) => {
                const start = secondsToSrtTimecode(item.offset);
                const end = secondsToSrtTimecode(item.offset + item.duration);
                return `${index + 1}\n${start} --> ${end}\n${item.text.trim()}\n`;
            }).join('\n');
            return res.json({ srt });
        }

        // --- Aggressive Delay (Before Fetching) ---
        console.log('Waiting 60 seconds before fetching transcript...');
        await delay(60000);

        const transcript = await YoutubeTranscript.fetchTranscript(url);
        const srt = transcript.map((item, index) => {
            const start = secondsToSrtTimecode(item.offset);
            const end = secondsToSrtTimecode(item.offset + item.duration);
            return `${index + 1}\n${start} --> ${end}\n${item.text.trim()}\n`;
        }).join('\n');

        // --- Save to Cache ---
        await saveCachedTranscript(videoId, transcript);

        res.json({ srt });

    } catch (error) {
        console.error(error);
        if (error.name === 'YoutubeTranscriptDisabledError') {
            res.status(400).json({ error: 'Subtitles are disabled for this video.' });
        } else if (error.message.includes('No transcript found')) {
             res.status(404).json({ error: 'No transcript found for this video' });
          } else{
          res.status(500).json({ error: 'Failed to fetch transcript' });
          }
    }
});

app.get('/process-subtitles', async (req, res) => {
    const { apiKey, srt, lang, downloadOnly, linesPerRequest, model } = req.query;

    if (!apiKey) {
        return res.status(400).json({ error: 'Gemini API key is required' });
    }
    if (!srt) {
        return res.status(400).json({ error: 'Subtitles content is required' });
    }
    if (downloadOnly !== 'true' && !lang) {
        return res.status(400).json({ error: 'Target language is required for translation' });
    }
    if (downloadOnly !== 'true' && !linesPerRequest) {
        return res.status(400).json({ error: 'Lines per request is required for translation' });
    }
    if (!model) {
        return res.status(400).json({ error: 'Model selection is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const shouldDownloadOnly = downloadOnly === 'true';
    const maxLines = Math.min(parseInt(linesPerRequest, 10) || 1, 50);

    const sendProgress = (message, progress, total) => {
        res.write(`data: ${JSON.stringify({ type: 'progress', message, progress, total })}\n\n`);
    };

    const sendError = (error) => {
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
                } else if (lines[i].trim() && currentItem && !/^\d+$/.test(lines[i])) {
                    currentItem.text += lines[i].trim() + ' ';
                } else if (!lines[i].trim() && currentItem) {
                    transcript.push(currentItem);
                    currentItem = null;
                }
            }

            if (transcript.length === 0) {
                throw new Error('Failed to parse subtitles for translation');
            }

            const total = transcript.length;
            const translations = [];
            for (let i = 0; i < total; i += maxLines) {
                const batch = transcript.slice(i, i + maxLines);
                const batchText = batch.map(item => item.text.trim()).join('\n');
                const batchSize = batch.length;

                sendProgress(`Translating lines ${i + 1} to ${Math.min(i + batchSize, total)} of ${total}`, i + batchSize, total);
                const translatedBatch = await translateText(batchText, lang, apiKey, model);
                const translatedLines = translatedBatch.split('\n');

                if (translatedLines.length !== batchSize) {
                    console.warn('Mismatch in translated lines, adjusting...');
                }
                translations.push(...translatedLines.slice(0, batchSize));

                // Delay between translation batches (Gemini API)
                if (i + maxLines < total) {
                    console.log('Waiting 4 seconds before next translation batch...');
                    await delay(4000);
                }
            }

            if (translations.length < total) {
                translations.push(...Array(total - translations.length).fill(''));
            }

            finalSrt = transcript.map((item, index) => {
                return `${index + 1}\n${item.time}\n${translations[index] || item.text.trim()}\n`;
            }).join('\n');
        } else {
            sendProgress('Preparing download without translation', 1, 1);
        }

        sendFinalSrt(finalSrt);

    } catch (error) {
        console.error('Error in processing:', error);
        if (error.status === 429) {
            sendError('Gemini API rate limit exceeded.  Please try again later.');
        } else if (error.message.includes('API key')) {
          sendError('Invalid Gemini API key');
        }else {
            sendError(error.message || 'Failed to process subtitles');
        }
    }
});

// --- Initialization (Fetch proxies on startup and periodically) ---
(async () => {
    await loadProxiesFromFile();
    await fetchProxies();
    setInterval(fetchProxies, 60 * 60 * 1000); // Refresh proxies every hour

    // Start the Express server *after* initial proxy setup
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
})();

module.exports = app;