const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Innertube } = require('youtubei.js');
const path = require('path');
const axios = require('axios');
const { DOMParser } = require('@xmldom/xmldom');

const app = express();
const port = process.env.PORT || 3000;

let innertube;
(async () => {
    innertube = await Innertube.create();
})();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

async function fetchTranscriptWithYoutubei(url, languageCode) {
    const videoId = extractVideoId(url);
    console.log(`[YOUTUBE] Fetching video info for ${videoId}`);
    let video;
    try {
        video = await innertube.getInfo(videoId);
    } catch (error) {
        throw new Error('Failed to fetch video info: ' + error.message);
    }

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
            return processYoutubeiTranscript(response.data);
        } catch (jsonError) {
            console.error('[YOUTUBE] JSON fetch failed, trying XML:', jsonError.message);
            try {
                const xmlResponse = await axios.get(baseUrl);
                return processXmlTranscript(xmlResponse.data);
            } catch (xmlError) {
                throw new Error(`Failed to fetch transcript (both JSON and XML): ${xmlError.message}`);
            }
        }
    }

    try {
        const { baseUrl: fetchedBaseUrl } = await getCaptionTrackAndBaseUrl(video.captions, languageCode);
        const transcript = await processCaptionsFromBaseUrl(fetchedBaseUrl);
        return transcript;
    } catch (error) {
        console.error('[YOUTUBE] Error fetching or processing captions:', error);
        throw error;
    }
}

function processYoutubeiTranscript(data) {
    if (!data.events) {
        throw new Error('Invalid transcript data format');
    }
    return data.events
        .filter(event => event.segs)
        .map(event => ({
            offset: event.tStartMs / 1000,
            duration: (event.dDurationMs || 2000) / 1000,
            text: event.segs.map(seg => seg.utf8).join(' ')
        }));
}

function processXmlTranscript(xmlData) {
    const parser = new DOMParser({
        errorHandler: {
            warning: (w) => { console.warn("XML Warning:", w); },
            error: (e) => { console.error("XML Error:", e); },
            fatalError: (e) => { console.error("XML Fatal Error:", e); throw e; }
        }
    });
    const xmlDoc = parser.parseFromString(xmlData, 'text/xml');

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
        const durAttr = node.getAttribute('dur');
        const dur = durAttr ? parseFloat(durAttr) : 2;
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
    const prompt = `Translate the following subtitle text into ${targetLang}: ${text}`;
    try {
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        if (error.status === 429 && retry) {
            console.log('Gemini 429 error, waiting 60 seconds...');
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

// NEW ENDPOINT:  /get-languages
app.get('/get-languages', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    try {
        const video = await innertube.getInfo(videoId);
        if (!video.captions || !video.captions.caption_tracks) {
          return res.status(404).json({ error: 'No captions available for this video.' });
        }
        const languages = video.captions.caption_tracks.map(track => ({
            code: track.language_code,
            name: track.name.text  // Use the 'text' property
        }));
        res.json({ languages });
    } catch (error) {
         console.error('Error fetching languages:', error);
        res.status(500).json({ error: 'Failed to fetch available languages: ' + error.message });
    }
});


app.post('/fetch-subtitles', async (req, res) => {
    const { url, languageCode } = req.body;

    if (!url) { return res.status(400).json({ error: 'YouTube URL is required' }); }
    const videoId = extractVideoId(url);
    if (!videoId) { return res.status(400).json({ error: 'Invalid YouTube URL' }); }

    try {
        console.log(`[FETCH] Fetching transcript. Video ID: ${videoId}, Language: ${languageCode}`);
        let transcript = await fetchTranscriptWithYoutubei(url, languageCode);
        const srt = transcript.map((item, index) => `${index + 1}\n${secondsToSrtTimecode(item.offset)} --> ${secondsToSrtTimecode(item.offset + item.duration)}\n${item.text.trim()}\n`).join('\n');
        res.json({ srt });
    } catch (error) {
        console.error(`[FETCH] Error: ${error.message}`);
        const statusCode = error.message.includes('No caption track') ? 404 : 500;
        res.status(statusCode).json({ error: error.message });
    }
});

app.get('/process-subtitles', async (req, res) => {
    const { apiKey, srt, lang, downloadOnly, linesPerRequest, model } = req.query;

    if (!apiKey) { return res.status(400).send('Gemini API key is required'); }
    if (!srt) { return res.status(400).send('Subtitles content is required'); }
    if (!downloadOnly && !lang) { return res.status(400).send('Target language is required'); }
    if (!downloadOnly && !linesPerRequest) { return res.status(400).send('Lines per request is required'); }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        let finalSrt = decodeURIComponent(srt);
        if (!downloadOnly) {
          const lines = finalSrt.split('\n');
          const transcript = [];
          let currentItem = null;

          for (const line of lines) {
              if (line.includes('-->')) {
                  currentItem = { time: line, text: '' };
              } else if (line.trim() && currentItem && !/^\d+$/.test(line)) {
                  currentItem.text += line.trim() + ' ';
              } else if (!line.trim() && currentItem) {
                  transcript.push(currentItem);
                  currentItem = null;
              }
          }
            const total = transcript.length;
            const translations = [];
            const maxLines = Math.min(parseInt(linesPerRequest, 10) || 1, 50);
            for (let i = 0; i < total; i += maxLines) {
                const batch = transcript.slice(i, i + maxLines);
                const batchText = batch.map(item => item.text.trim()).join('\n');

                sendProgress(res, `Translating lines ${i + 1} to ${Math.min(i + maxLines, total)} of ${total}`, i + maxLines, total);
                const translatedBatch = await translateText(batchText, lang, apiKey, model);
                translations.push(...translatedBatch.split('\n'));

                if (i + maxLines < total) {
                    await delay(4000); // Wait 4 seconds
                }
            }

            finalSrt = transcript.map((item, index) => `${index + 1}\n${item.time}\n${translations[index] || item.text.trim()}\n`).join('\n');
        }

        sendFinalSrt(res, finalSrt);
    } catch (error) {
        console.error('Error in processing:', error);
        sendError(res, error.message);
    }
});

function sendProgress(res, message, progress, total) {
    res.write(`data: ${JSON.stringify({ type: 'progress', message, progress, total })}\n\n`);
}

function sendError(res, error) {
    console.error('Error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
    res.end();
}

function sendFinalSrt(res, srt) {
    res.write(`data: ${JSON.stringify({ type: 'complete', srt })}\n\n`);
    res.end();
}

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