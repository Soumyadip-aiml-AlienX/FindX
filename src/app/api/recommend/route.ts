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
      // (Mock logic remains the same)
      return NextResponse.json({ success: true, recommendation: { devices: [] } }); 
    }

    // STAGE 1: Broad Market Scan (20 videos from last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const publishedAfter = sixMonthsAgo.toISOString();
    
    const marketQuery = `best ${category} under ${budget} india reviews comparison 2024`;
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(marketQuery)}&type=video&maxResults=20&publishedAfter=${publishedAfter}&relevanceLanguage=en&regionCode=IN&key=${YOUTUBE_API_KEY}`;
    
    const res = await fetch(searchUrl);
    const data = await res.json();
    const marketVideos = data.items || [];
    const marketContext = marketVideos.map((v: any, i: number) => `[Video ${i+1}] ${v.snippet.title}`).join('\n');

    // STAGE 2: Filter the Market (Identify Top 3 Candidates from 15-20 mentioned devices)
    const filterPrompt = `
      You are an expert tech researcher. I have scanned the top 20 YouTube reviews for ${category} under ₹${budget} in India from the last 6 months.
      Here are the video titles:
      ${marketContext}

      Based on these titles, identify the 3 most recommended and highly-rated device models that fit the "all-rounder" or specific priorities: ${requirements.join(', ')}.
      Heavily prioritize brands: ${finalCompanies}.
      Return ONLY the names of the 3 devices as a comma-separated list.
    `;

    const filterRes = await ai.getGenerativeModel({ model: 'gemini-1.5-flash' }).generateContent(filterPrompt);
    const candidates = filterRes.response.text().split(',').map(c => c.trim()).filter(c => c.length > 0);

    // STAGE 3: Specific Review Analysis
    let deepReviewData = "";
    for (const candidate of candidates.slice(0, 3)) {
      const reviewVideos = await searchYouTube(`${candidate} India review latest`, 1);
      if (reviewVideos.length > 0) {
        const transcript = await getTranscriptText(reviewVideos[0].id);
        if (transcript) {
          deepReviewData += `\nDEVICE: ${candidate}\nREVIEW DATA: ${transcript.substring(0, 5000)}\n`;
        } else {
          deepReviewData += `\nDEVICE: ${candidate}\n(Used general knowledge for this model as transcript was unavailable)\n`;
        }
      }
    }

    // STAGE 4: Final Competition & Suggestions
    const finalPrompt = `
      You are an expert Indian tech consultant. You have identified 3 candidates based on market popularity. 
      Now, perform a final competition based on these deep-dive review summaries for a user with budget ₹${budget} and priorities: ${requirements.join(', ')}.
      
      Review Data:
      ${deepReviewData}

      Pick the TOP 2 devices. The #1 spot must be the "Winner" of the competition.
      Return ONLY a JSON object:
      {
        "devices": [
          {
            "name": "Full name",
            "price": integer,
            "release_year": "string",
            "buy_link": "URL",
            "specs": { "processor": "string", "display": "string", "ram_storage": "string", "battery": "string", "camera_or_gpu": "string" },
            "pros": ["string", "string", "string"],
            "verdict": "Detailed explanation of why this won the competition over others"
          }
        ]
      }
    `;

    const finalRes = await ai.getGenerativeModel({ model: 'gemini-1.5-flash' }).generateContent({
      contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const resultJson = JSON.parse(finalRes.response.text() || "{}");

    return NextResponse.json({
      success: true,
      recommendation: resultJson
    });

  } catch (error) {
    console.error("API Route Error:", error);
    return NextResponse.json({ success: false, error: "Failed to process" }, { status: 500 });
  }
}
