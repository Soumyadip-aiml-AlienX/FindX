import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { YoutubeTranscript } from 'youtube-transcript';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function searchYouTube(query: string, maxResults: number = 3) {
  if (!YOUTUBE_API_KEY) return [];
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const publishedAfter = oneYearAgo.toISOString();

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&publishedAfter=${publishedAfter}&relevanceLanguage=en&regionCode=IN&key=${YOUTUBE_API_KEY}`;
  
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.items) {
      return data.items.map((item: any) => ({
        id: item.id.videoId,
        title: item.snippet.title,
      }));
    }
  } catch (e) {
    console.error("YouTube search error:", e);
  }
  return [];
}

async function getTranscriptText(videoId: string) {
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    return transcript.map(t => t.text).join(' ').substring(0, 15000); // Limit to ~15k chars to fit context
  } catch (e) {
    console.error(`Transcript error for ${videoId}:`, e);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const { budget, category, requirements, preferredCompanies } = await request.json();
    const finalCompanies = preferredCompanies && preferredCompanies.length > 0 ? preferredCompanies.join(', ') : 'Any';

    if (!YOUTUBE_API_KEY || !GEMINI_API_KEY) {
      return NextResponse.json({ success: true, recommendation: { devices: [] } }); 
    }

    // STAGE 1 & 2: Market Scan (Top 15 videos, prioritizing recency)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const marketQuery = `best ${category} under ${budget} india reviews comparison 2024`;
    // Using order=relevance but filtering for last 6 months to ensure quality + recency
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(marketQuery)}&type=video&maxResults=15&publishedAfter=${sixMonthsAgo.toISOString()}&relevanceLanguage=en&regionCode=IN&key=${YOUTUBE_API_KEY}`;
    
    const marketRes = await fetch(searchUrl);
    const marketData = await marketRes.json();
    // Include the publication date in the context so the LLM can prioritize
    const marketContext = (marketData.items || []).map((v: any) => `[Date: ${v.snippet.publishedAt}] ${v.snippet.title}`).join('\n');

    const filterPrompt = `
      List of recent YouTube videos:
      ${marketContext}

      Identify the top 3 ${category} models under ₹${budget} for ${requirements.join(', ')}. 
      CRITICAL: Give much more weight and importance to the LATEST videos (the ones with the most recent dates). 
      Preferred brands: ${finalCompanies}. 
      Return only device names as a comma-separated list.
    `;
    const filterRes = await ai.getGenerativeModel({ model: 'gemini-1.5-flash' }).generateContent(filterPrompt);
    const candidates = filterRes.response.text().split(',').map(c => c.trim()).slice(0, 3);

    // STAGE 3: Parallel Deep Research (Researching winners of the recency filter)
    const researchResults = await Promise.all(candidates.map(async (candidate) => {
      try {
        const reviewVideos = await searchYouTube(`${candidate} review india latest 2024`, 1);
        if (reviewVideos.length > 0) {
          const transcript = await getTranscriptText(reviewVideos[0].id);
          return `DEVICE: ${candidate}\nDATA: ${transcript ? transcript.substring(0, 3000) : 'Use internal knowledge'}`;
        }
      } catch (e) { console.error(e); }
      return `DEVICE: ${candidate}\nDATA: Use internal knowledge`;
    }));

    // STAGE 4: Final Verdict
    const finalPrompt = `
      Compare these ${category}s for budget ₹${budget} and priorities: ${requirements.join(', ')}.
      ${researchResults.join('\n\n')}
      Pick top 2. #1 is the Winner. Return JSON only:
      { "devices": [ { "name": "string", "price": int, "release_year": "string", "buy_link": "string", "specs": { "processor": "string", "display": "string", "ram_storage": "string", "battery": "string", "camera_or_gpu": "string" }, "pros": [], "verdict": "string" } ] }
    `;

    const finalRes = await ai.getGenerativeModel({ model: 'gemini-1.5-flash' }).generateContent({
      contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    return NextResponse.json({ success: true, recommendation: JSON.parse(finalRes.response.text() || "{}") });

  } catch (error) {
    console.error("API Route Error:", error);
    return NextResponse.json({ success: false, error: "Timeout or Processing Error" }, { status: 500 });
  }
}
