import { YoutubeTranscript } from 'youtube-transcript-plus';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function fetchTranscript(videoId) {
    try {
        console.log(`[Transcript] Universal Fetching for ${videoId}...`);

        let items = null;

        // 1. Try library with explicit 'ko'
        try {
            items = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'ko' });
            if (items && items.length > 0) {
                console.log(`[Transcript] Library 'ko' success for ${videoId}`);
            }
        } catch (err) {
            console.log(`[Transcript] Library 'ko' failed for ${videoId}: ${err.message}`);
        }

        // 2. Try library general fetch (if 'ko' failed)
        if (!items || items.length === 0) {
            try {
                items = await YoutubeTranscript.fetchTranscript(videoId);
                if (items && items.length > 0) {
                    console.log(`[Transcript] Library general success for ${videoId}`);
                }
            } catch (err) {
                console.log(`[Transcript] Library general failed for ${videoId}: ${err.message}`);
            }
        }

        // 3. Try custom scraper (last resort)
        if (!items || items.length === 0) {
            console.log(`[Transcript] Entering Custom Scraper mode for ${videoId}...`);
            items = await fetchTranscriptCustom(videoId).catch(err => {
                console.error(`[Transcript] Custom Scraper failed for ${videoId}:`, err.message);
                return null;
            });
        }

        if (!items || items.length === 0) {
            console.warn(`[Transcript] ❌ All methods failed for ${videoId}`);
            return null;
        }

        const result = combineTranscript(items);
        return result;
    } catch (err) {
        console.error(`[Transcript] 💥 Fatal unexpected error for ${videoId}:`, err.message);
        return null;
    }
}

// Robust fallback scraper (direct HTML parsing)
async function fetchTranscriptCustom(videoId) {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' }
    });
    const html = await response.text();

    // Find captionTracks in the HTML
    let match = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!match) {
        // Try fallback pattern for some page versions
        match = html.match(/"captionTracks":\s*(\[{"baseUrl":.*?\])/);
    }

    if (!match) {
        console.log(`[Transcript] Custom Scraper: No captionTracks found for ${videoId}`);
        return null;
    }

    let tracks;
    try {
        tracks = JSON.parse(match[1]);
    } catch (e) {
        console.error(`[Transcript] Custom Scraper: JSON parse error for ${videoId}`);
        return null;
    }

    // Prefer Korean (exact or starts with 'ko'), then first available
    const track = tracks.find(t => t.languageCode === 'ko' || t.languageCode?.startsWith('ko')) || tracks[0];
    console.log(`[Transcript] Custom Scraper: Selected track language: ${track.languageCode} for ${videoId}`);
    const xmlResponse = await fetch(track.baseUrl);
    const xml = await xmlResponse.text();

    const segments = [...xml.matchAll(/<text(?:\s+[^>]*?)?>(.*?)<\/text>/g)];
    return segments.map(m => ({
        text: m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    }));
}

function combineTranscript(items) {
    const fullText = items.map(item => item.text?.trim()).filter(Boolean).join(' ');
    const cleaned = fullText.replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length < 1) return null;
    return cleaned.length > 100000 ? cleaned.substring(0, 100000) : cleaned;
}
