// server.js
const express = require('express');
const { YoutubeTranscript } = require('youtube-transcript');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs/promises');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const cheerio = require('cheerio'); // Optional

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Proxy Management (No Persistence) ---
let proxies = [];
let currentProxyIndex = 0;

async function fetchProxies() {
    try {
        const response = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all');
        const fetchedProxies = response.data.split('\r\n').map(proxy => proxy.trim()).filter(proxy => proxy !== '');

        if (fetchedProxies.length > 0) {
            proxies = fetchedProxies;
            currentProxyIndex = 0;
            console.log(`Fetched ${proxies.length} proxies.`);
        } else {
            console.warn('No proxies fetched.');
        }
    } catch (error) {
        console.error('Error fetching proxies:', error.message);
        // Don't re-throw here, handle it gracefully.
    }
}

function getNextProxy() {
    if (proxies.length === 0) { return null; }
    const proxy = proxies[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
    return proxy;
}

// --- Caching Setup ---
const cacheDir = path.join(__dirname, 'cache');

async function getCachedTranscript(videoId) {
    try {
        const filePath = path.join(cacheDir, `${videoId}.json`);
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') { return null; }
        throw error;
    }
}

async function saveCachedTranscript(videoId, transcript) {
    try {
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(path.join(cacheDir, `${videoId}.json`), JSON.stringify(transcript), 'utf8');
    } catch (err) {
        console.error('Error writing to cache:', err);
    }
}

// --- User-Agent Rotation ---
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36 Edg/92.0.902.67',
];

// --- Monkey-Patch _fetchCaptions (Corrected) ---
const originalFetchCaptions = YoutubeTranscript.prototype._fetchCaptions;
YoutubeTranscript.prototype._fetchCaptions = async function (fetchOptions) {
    let proxyUrl = getNextProxy();
    if (!proxyUrl) {
        await fetchProxies();
        if (proxies.length === 0) {
          throw new Error('No proxies available'); // Throw error
        }
      proxyUrl = getNextProxy(); // Get a proxy after fetching
    }

    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    console.log(`Using User-Agent: ${randomUserAgent}`);
    console.log(`Using Proxy: ${proxyUrl}`);

    const proxyAgent = new HttpsProxyAgent(proxyUrl);

    try {
        // Use Axios directly, with the proxy agent and headers
        const response = await axios.get(fetchOptions.url, {
            httpsAgent: proxyAgent,
            headers: {
                'User-Agent': randomUserAgent,
                ...(fetchOptions.cookie ? { Cookie: fetchOptions.cookie } : {}), // Preserve original cookie
            },
            timeout: 15000,
        });

        return {
            player: fetchOptions.player,
            captions: response.data
        };
    } catch (error) {
        console.error("Axios request failed:", error.message);
        // IMPORTANT:  Let the error propagate.  The retry logic is now in fetchTranscriptWithRetries.
        throw error;
    }
};

// --- fetchTranscriptWithRetries (Corrected) ---
async function fetchTranscriptWithRetries(url) {
  let transcript = null;
  let retries = 0;
  const maxRetries = 5; // Retry up to 5 times

  while (!transcript && retries < maxRetries) {
    try {
      // Call the library's fetchTranscript (which now uses our patched _fetchCaptions)
      transcript = await YoutubeTranscript.fetchTranscript(url);
      console.log('Transcript fetched successfully.');
    } catch (error) {
      console.error(`Attempt ${retries + 1} failed:`, error.message);

      // Only retry for specific errors (network issues, timeouts, etc.)
      if (
        error.name !== 'YoutubeTranscriptDisabledError' &&
        !error.message.includes('No transcript found')
      ) {
        retries++;
        if (retries < maxRetries) {
          console.log(`Retrying in 5 seconds... (Attempt ${retries}/${maxRetries})`);
          await delay(5000); // Wait 5 seconds before retrying
        }
      } else {
        // Don't retry for "disabled subtitles" or "no transcript found"
        throw error;
      }
    }
  }

  if (!transcript) {
    throw new Error('Failed to fetch transcript after multiple retries');
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
    const cachedTranscript = await getCachedTranscript(videoId);
    if (cachedTranscript) {
      console.log('Using cached transcript');
      const srt = cachedTranscript
        .map((item, index) => `${index + 1}\n${secondsToSrtTimecode(item.offset)} --> ${secondsToSrtTimecode(item.offset + item.duration)}\n${item.text.trim()}\n`)
        .join('\n');
      return res.json({ srt });
    }

    // Use fetchTranscriptWithRetries to handle retries and proxy rotation
    const transcript = await fetchTranscriptWithRetries(url);
    const srt = transcript
      .map((item, index) => `${index + 1}\n${secondsToSrtTimecode(item.offset)} --> ${secondsToSrtTimecode(item.offset + item.duration)}\n${item.text.trim()}\n`)
      .join('\n');

    await saveCachedTranscript(videoId, transcript);
    res.json({ srt });
  } catch (error) {
    console.error('Error in /fetch-subtitles:', error);

    let errorMessage = 'Failed to fetch transcript';
    let statusCode = 500;

    if (error.name === 'YoutubeTranscriptDisabledError') {
      errorMessage = 'Subtitles are disabled for this video.';
      statusCode = 400;
    } else if (error.message.includes('No transcript found')) {
      errorMessage = 'No transcript found for this video.';
      statusCode = 404;
    } else if (error.message === 'No proxies available') {
        errorMessage = 'No working proxies available.  Please try again later.';
        statusCode = 503; // Service Unavailable
    }else if (error.message === 'Failed to fetch transcript after multiple retries') {
        errorMessage = 'Failed to fetch transcript after multiple retries.  Please try again later.';
        statusCode = 500;
    }else if (error.message.startsWith('Request failed with status code')) {
      errorMessage = `YouTube request failed: ${error.message}`;
      statusCode = parseInt(error.message.match(/\d+$/)[0], 10) || 500;
    }else if (error.message.includes('Invalid URL')) {
        errorMessage = `Internal error fetching subtitles.`;
    }

    res.status(statusCode).json({ error: errorMessage });
  }
});

app.get('/process-subtitles', async (req, res) => {
    const { apiKey, srt, lang, downloadOnly, linesPerRequest, model } = req.query;

    if (!apiKey) {
        sendError('Gemini API key is required');
        return;
    }
    if (!srt) {
        sendError('Subtitles content is required');
        return;
    }
    if (downloadOnly !== 'true' && !lang) {
        sendError('Target language is required for translation');
        return;
    }
    if (downloadOnly !== 'true' && !linesPerRequest) {
        sendError('Lines per request is required for translation');
        return;
    }
    if (!model) {
        sendError('Model selection is required');
        return;
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
    console.error('Sending Error:', error);
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
        throw new Error('Failed to parse subtitles for translation');
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
          console.warn('Mismatch in translated lines, adjusting...');
        }
        translations.push(...translatedLines.slice(0, batch.length));

        // Delay for Gemini API
        if (i + maxLines < total) {
          console.log('Waiting 4 seconds before next translation batch...');
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
      sendProgress('Preparing download without translation', 1, 1);
    }

    sendFinalSrt(finalSrt);
  } catch (error) {
    console.error('Error in processing:', error);
    if (error.status === 429) {
      sendError('Gemini API rate limit exceeded.  Please try again later.');
    } else if (error.message.includes('API key')) {
      sendError('Invalid Gemini API key');
    } else {
      sendError(error.message || 'Failed to process subtitles');
    }
  }
});

// --- Initialization (Fetch proxies on startup and periodically) ---
(async () => {
  try {
    await fetchProxies(); // Fetch initial proxies
  } catch (error) {
    console.error('Failed to fetch initial proxies:', error);
    process.exit(1); // Exit if we can't get proxies
  }
  setInterval(fetchProxies, 60 * 60 * 1000); // Refresh every hour

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
})();
