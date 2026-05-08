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

    // STAGE 1: Broad Market Research (Get 10 recent review videos)
    const marketQuery = `top ${category} under ${budget} india ${new Date().getFullYear()} reviews comparison`;
    const marketVideos = await searchYouTube(marketQuery, 10);
    const marketContext = marketVideos.map(v => v.title).join('\n');

    // STAGE 2: Identify Top 3 Candidates
    const candidatePrompt = `
      Based on these recent YouTube video titles for ${category} under ₹${budget} in India:
      ${marketContext}

      Identify the TOP 3 most promising device models that users and reviewers are talking about right now.
      Prioritize these brands if they appear: ${finalCompanies}.
      Return ONLY the names of the 3 devices as a comma-separated list.
    `;

    const candidateRes = await ai.getGenerativeModel({ model: 'gemini-1.5-flash' }).generateContent(candidatePrompt);
    const candidates = candidateRes.response.text().split(',').map(c => c.trim()).filter(c => c.length > 0);

    // STAGE 3: Deep Review Analysis (Fetch transcripts for specific reviews of candidates)
    let deepReviewData = "";
    for (const candidate of candidates.slice(0, 3)) {
      const reviewVideos = await searchYouTube(`${candidate} India review long term`, 1);
      if (reviewVideos.length > 0) {
        const transcript = await getTranscriptText(reviewVideos[0].id);
        if (transcript) {
          deepReviewData += `\nDEVICE: ${candidate}\nREVIEW DATA: ${transcript.substring(0, 4000)}\n`;
        } else {
          deepReviewData += `\nDEVICE: ${candidate}\n(Transcript unavailable, rely on internal knowledge for this model)\n`;
        }
      }
    }

    // STAGE 4: Final Comparison & Verdict
    const finalPrompt = `
      You are an expert Indian tech consultant. Compare these devices for a user with budget ₹${budget} and priorities: ${requirements.join(', ')}.
      
      Research Data:
      ${deepReviewData}

      Pick the TOP 2 devices and provide a detailed comparison.
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
            "verdict": "Detailed explanation of why this won"
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
