import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { YoutubeTranscript } from 'youtube-transcript';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Helper: Search YouTube with custom date filter
async function searchYouTube(query: string, maxResults: number = 5, monthsAgo: number = 4) {
  if (!YOUTUBE_API_KEY) return [];
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsAgo);

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&publishedAfter=${cutoff.toISOString()}&relevanceLanguage=en&regionCode=IN&key=${YOUTUBE_API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.items) {
      return data.items.map((item: any) => ({
        id: item.id.videoId,
        title: item.snippet.title,
        publishedAt: item.snippet.publishedAt,
      }));
    }
  } catch (e) {
    console.error("YouTube search error:", e);
  }
  return [];
}

// Helper: Get transcript text (with size limit)
async function getTranscript(videoId: string, charLimit: number = 8000) {
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    return transcript.map(t => t.text).join(' ').substring(0, charLimit);
  } catch (e) {
    console.error(`Transcript error for ${videoId}:`, e);
    return null;
  }
}

// Helper: Ask Gemini a quick question (plain text response)
async function askGemini(prompt: string): Promise<string> {
  const res = await ai.models.generateContent({
    model: 'gemini-1.5-flash',
    contents: prompt,
  });
  return res.text || '';
}

// Helper: Ask Gemini for JSON response
async function askGeminiJSON(prompt: string): Promise<any> {
  const res = await ai.models.generateContent({
    model: 'gemini-1.5-flash',
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });
  
  const text = res.text || "{}";
  try {
    // Attempt to clean the response if it contains markdown backticks
    const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanedText);
  } catch (e) {
    console.error("JSON Parsing Error. Raw text:", text);
    throw new Error("Invalid AI Response Format");
  }
}

// Allow up to 60 seconds for the full research pipeline (Vercel Hobby max)
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { budget, category, requirements, preferredCompanies } = await request.json();
    const brands = preferredCompanies && preferredCompanies.length > 0 ? preferredCompanies.join(', ') : 'Any';
    const specs = requirements.join(', ');

    if (!YOUTUBE_API_KEY || !GEMINI_API_KEY) {
      return NextResponse.json({ success: true, recommendation: { devices: [] } });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: BROAD YOUTUBE SEARCH & "WATCHING"
    // Search "best mobile under 25000" and get all top videos from last 4 months
    // ─────────────────────────────────────────────────────────────────────────
    const mainQuery = `best ${category} under ${budget} India 2024 full reviews comparison benchmark`;
    const allVideos = await searchYouTube(mainQuery, 25, 4);

    // AI "watches" and summarizes ALL 25 videos in parallel
    const summaryResults = await Promise.all(
      allVideos.map(async (video: any) => {
        const text = await getTranscript(video.id, 15000); // Get a good chunk of transcript
        if (!text) return null;

        const summaryPrompt = `
You just watched this YouTube video: "${video.title}"
Date: ${video.publishedAt}
Transcript: ${text}

EXTRACT ONLY:
1. Device models mentioned.
2. Key specs (Processor, RAM, Camera, Battery) for each.
3. Reviewer's main pros/cons for each.
4. Final ranking if provided.

Be technical and concise. No fluff.
        `;
        
        try {
          const summary = await askGemini(summaryPrompt);
          return `[Source: ${video.title} | Date: ${video.publishedAt}]\n${summary}`;
        } catch (e) {
          console.error(`Summary failed for ${video.id}`);
          return null;
        }
      })
    );

    // Build a refined knowledge base from all 25 summaries
    const RefinedKnowledge = summaryResults.filter(s => s !== null).join('\n\n---\n\n');

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: TECHNICAL SHORTLIST
    // Compare all refined data and pick the top 3 candidates
    // ─────────────────────────────────────────────────────────────────────────
    const extractPrompt = `
You are a WORLD-CLASS tech researcher. You have just analyzed the key technical data from 25+ YouTube review videos about ${category} under ₹${budget}.

Here is the refined research data:
${RefinedKnowledge || 'No transcripts were available. Use your expert knowledge instead.'}

TASK:
1. Compare every single device mentioned based on the refined research.
2. Prioritize the ABSOLUTE LATEST releases (last 1-2 months).
3. Select the top 3 absolute best candidates that match: ${specs}.
4. Must be from these brands: ${brands}.

Return ONLY the 3 device names as a comma-separated list.
    `;

    const candidateText = await askGemini(extractPrompt);
    const candidates = candidateText.split(',').map(c => c.trim()).filter(c => c.length > 2).slice(0, 3);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: DEEP-DIVE RESEARCH FOR SHORTLIST
    // Go back to YouTube and watch dedicated reviews of each candidate
    // ─────────────────────────────────────────────────────────────────────────
    const deepReviewData = await Promise.all(
      candidates.map(async (device) => {
        const reviewVideos = await searchYouTube(`${device} review India latest long-term`, 3, 4);
        
        // AI "watches" and summarizes each deep-dive review
        const summaries = await Promise.all(
          reviewVideos.map(async (rv) => {
            const t = await getTranscript(rv.id, 15000);
            if (!t) return null;
            
            const p = `
You are doing a deep-dive on "${device}".
Watch this full review: "${rv.title}"
Transcript: ${t}

EXTRACT DEEP TECH SPECS:
- Benchmark scores (AnTuTu, Geekbench)
- Battery screen-on time
- Thermal performance / throttling
- Camera sensor models & low-light performance
- Display color accuracy & brightness nits

Be extremely technical. No fluff.
            `;
            return await askGemini(p);
          })
        );
        
        return { device, reviewSummary: summaries.filter(s => s !== null).join('\n\n') };
      })
    );

    const reviewKnowledge = deepReviewData
      .map(r => `=== DEEP RESEARCH: ${r.device} ===\n${r.reviewSummary || 'Using internal expert knowledge'}`)
      .join('\n\n');

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 4: PICK TOP 2 FROM REVIEWS
    // After "watching" the reviews, choose the best 2 devices
    // ─────────────────────────────────────────────────────────────────────────
    const top2Prompt = `
You are an expert Indian tech reviewer. You just watched dedicated reviews for these ${candidates.length} devices:

${reviewKnowledge}

The user wants a ${category} under ₹${budget} with priorities: ${specs}.
Preferred brands: ${brands}.

Based on the reviews you just watched:
1. Pick the TOP 2 devices.
2. The #1 device is the WINNER of the competition.

Return ONLY the 2 device names as a comma-separated list. Nothing else.
    `;

    const top2Text = await askGemini(top2Prompt);
    const top2 = top2Text.split(',').map(c => c.trim()).filter(c => c.length > 2).slice(0, 2);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 5: FINAL HEAD-TO-HEAD COMPARISON & SUGGESTION
    // Compare the top 2 devices one last time and generate the final verdict
    // ─────────────────────────────────────────────────────────────────────────
    const finalPrompt = `
You are a WORLD-CLASS tech consultant. You have just completed a massive research project involving 25+ YouTube comparison videos and 9+ dedicated deep-dive reviews for the top candidates.

Finalists:
1. ${top2[0] || candidates[0]}
2. ${top2[1] || candidates[1] || candidates[0]}

The MASSIVE evidence from your research:
${reviewKnowledge}

User constraints:
Budget: ₹${budget}
Priorities: ${specs}
Preferred Brands: ${brands}

TASK:
1. Perform a BRUTAL head-to-head comparison. No fluff.
2. Based on the review transcripts, identify the definitive WINNER.
3. Explain the WINNER's victory using specific data points found in the research (battery life, display tech, benchmark results, etc).

Return ONLY this JSON format:
{
  "devices": [
    {
      "name": "Exact model name",
      "price": 24999,
      "release_year": "2024",
      "buy_link": "https://www.amazon.in/s?k=device+name",
      "specs": {
        "processor": "Technical name & performance details",
        "display": "Panel type, size, refresh rate, peak brightness",
        "ram_storage": "Detailed RAM & Storage specs",
        "battery": "Capacity & charging wattage",
        "camera_or_gpu": "Full sensor details or GPU performance"
      },
      "pros": ["Data-backed advantage 1", "Data-backed advantage 2", "Data-backed advantage 3"],
      "verdict": "A comprehensive, technical explanation of why this device is the winner based on the 30+ videos you 'watched' during research."
    }
  ]
}
    `;

    const result = await askGeminiJSON(finalPrompt);

    return NextResponse.json({ success: true, recommendation: result });

  } catch (error) {
    console.error("API Route Error:", error);
    return NextResponse.json({ success: false, error: "Processing Error" }, { status: 500 });
  }
}
