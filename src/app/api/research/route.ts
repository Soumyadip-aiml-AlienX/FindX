import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { YoutubeTranscript } from 'youtube-transcript';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const ai = new GoogleGenerativeAI(GEMINI_API_KEY);

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

// Helper: Ask Gemini with automatic fallback and retry logic
async function askGemini(prompt: string, useJSON: boolean = false): Promise<any> {
  const models = ["gemini-1.5-flash-latest", "gemini-1.5-pro", "gemini-1.5-flash"];
  let lastError: any = null;

  console.log("DEBUG: askGemini triggered.");

  for (const modelName of models) {
    let retries = 2;
    while (retries > 0) {
      try {
        console.log(`DEBUG: Attempting AI call with model: ${modelName} (Retries left: ${retries})`);
        const model = ai.getGenerativeModel({ 
          model: modelName,
          generationConfig: useJSON ? { responseMimeType: "application/json" } : undefined
        });
        
        const res = await model.generateContent(prompt);
        const response = await res.response;
        const text = response.text();
        
        if (useJSON) {
          const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
          return JSON.parse(cleanedText);
        }
        return text;
      } catch (e: any) {
        lastError = e;
        console.warn(`DEBUG: Model ${modelName} failed. Error:`, e.message || e);
        await new Promise(r => setTimeout(r, 2000));
        retries--;
      }
    }
  }
  
  console.error("--- ALL AI MODELS FAILED ---");
  throw lastError || new Error("AI Brain Connectivity Issue");
}

// Helper: Ask Gemini for JSON response (now using the unified helper)
async function askGeminiJSON(prompt: string): Promise<any> {
  return await askGemini(prompt, true);
}

// Allow up to 300 seconds for the full research pipeline (Railway/Docker)
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { budget, category, requirements, preferredCompanies } = await request.json();
    const brands = preferredCompanies && preferredCompanies.length > 0 ? preferredCompanies.join(', ') : 'Any';
    const specs = requirements.join(', ');

    if (!YOUTUBE_API_KEY || !GEMINI_API_KEY) {
      console.error("CRITICAL: Missing API Keys! YOUTUBE:", !!YOUTUBE_API_KEY, "GEMINI:", !!GEMINI_API_KEY);
      return NextResponse.json({ success: true, recommendation: { devices: [] } });
    }
    console.log("BRAIN INITIALIZED. Keys present.");

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: BROAD YOUTUBE SEARCH & "WATCHING"
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 1: SEARCHING ---");
    const mainQuery = `best ${category} under ${budget} India 2024 full reviews comparison benchmark`;
    const allVideos = await searchYouTube(mainQuery, 25, 4);
    console.log(`Found ${allVideos.length} videos.`);

    const summaryResults: (string | null)[] = [];
    for (let i = 0; i < allVideos.length; i += 5) {
      console.log(`Processing batch ${Math.floor(i/5) + 1}...`);
      const batch = allVideos.slice(i, i + 5);
      const batchResults = await Promise.all(
        batch.map(async (video: any) => {
          const text = await getTranscript(video.id, 12000);
          if (!text) return null;

          const summaryPrompt = `Extract technical specs and pros/cons for devices in this video: "${video.title}"\nTranscript: ${text}`;
          
          try {
            await new Promise(r => setTimeout(r, 500));
            const summary = await askGemini(summaryPrompt);
            return `[Source: ${video.title}]\n${summary}`;
          } catch (e) {
            return null;
          }
        })
      );
      summaryResults.push(...batchResults);
      if (i + 5 < allVideos.length) await new Promise(r => setTimeout(r, 1000));
    }

    const RefinedKnowledge = summaryResults.filter(s => s !== null).join('\n\n---\n\n');
    console.log(`Refined Knowledge size: ${RefinedKnowledge.length} chars.`);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: TECHNICAL SHORTLIST
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 2: SHORTLISTING ---");
    const extractPrompt = `
You are a WORLD-CLASS tech researcher. Analyzed ${summaryResults.filter(s => s !== null).length} videos.
Data: ${RefinedKnowledge || 'No transcripts available. Use your internal expert knowledge of the Indian market in 2024 instead.'}

TASK: Select top 3 candidates for ${category} under ₹${budget} (Specs: ${specs}, Brands: ${brands}).
Return ONLY the 3 device names as a comma-separated list.
    `;

    const candidateText = await askGemini(extractPrompt);
    const candidates = candidateText.split(',').map(c => c.trim()).filter(c => c.length > 2).slice(0, 3);
    console.log("Candidates selected:", candidates);

    if (candidates.length === 0) throw new Error("No candidates found in research.");

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: DEEP-DIVE RESEARCH
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 3: DEEP DIVING ---");
    const deepReviewData = await Promise.all(
      candidates.map(async (device) => {
        const reviewVideos = await searchYouTube(`${device} review India latest long-term`, 2, 4);
        const summaries = await Promise.all(
          reviewVideos.map(async (rv) => {
            const t = await getTranscript(rv.id, 10000);
            if (!t) return null;
            const p = `Extract technical benchmark data and battery stats for "${device}" from this review: "${rv.title}"\nTranscript: ${t}`;
            try { return await askGemini(p); } catch (e) { return null; }
          })
        );
        return { device, reviewSummary: summaries.filter(s => s !== null).join('\n\n') };
      })
    );

    const reviewKnowledge = deepReviewData
      .map(r => `=== DEEP RESEARCH: ${r.device} ===\n${r.reviewSummary || 'Using expert knowledge'}`)
      .join('\n\n');

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 4: PICK TOP 2
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 4: FILTERING TOP 2 ---");
    const top2Prompt = `
Watch these reviews:
${reviewKnowledge}

Pick TOP 2 for ₹${budget} (Specs: ${specs}).
Return ONLY 2 names comma-separated.
    `;

    const top2Text = await askGemini(top2Prompt);
    const top2 = top2Text.split(',').map(c => c.trim()).filter(c => c.length > 2).slice(0, 2);
    console.log("Finalists:", top2);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 5: FINAL VERDICT
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 5: FINAL VERDICT ---");
    const finalPrompt = `
Perform a technical comparison for:
1. ${top2[0] || candidates[0]}
2. ${top2[1] || candidates[1] || candidates[0]}

Data: ${reviewKnowledge}

Return JSON:
{
  "devices": [
    {
      "name": "Full model name",
      "price": 0,
      "release_year": "2024",
      "buy_link": "https://www.amazon.in/s?k=...",
      "specs": { "processor": "...", "display": "...", "ram_storage": "...", "battery": "...", "camera_or_gpu": "..." },
      "pros": ["...", "..."],
      "verdict": "Detailed data-backed winner explanation."
    }
  ]
}
    `;

    const result = await askGeminiJSON(finalPrompt);
    console.log("SUCCESS: Research project complete.");

    return NextResponse.json({ success: true, recommendation: result });

  } catch (error: any) {
    console.error("CRITICAL API ERROR:", error.message || error);
    return NextResponse.json({ success: false, error: error.message || "Brain Overload" }, { status: 500 });
  }
}
