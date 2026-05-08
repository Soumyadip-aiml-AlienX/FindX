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
  return JSON.parse(res.text || "{}");
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
    // STAGE 1: BROAD YOUTUBE SEARCH
    // Search "best mobile under 25000" and get all top videos from last 4 months
    // ─────────────────────────────────────────────────────────────────────────
    const mainQuery = `best ${category} under ${budget} India 2024 reviews comparison`;
    const allVideos = await searchYouTube(mainQuery, 20, 4);

    // Fetch transcripts of ALL these videos in parallel (this is "watching" them)
    const transcriptResults = await Promise.all(
      allVideos.map(async (video: any) => {
        const text = await getTranscript(video.id, 10000);
        return {
          title: video.title,
          date: video.publishedAt,
          transcript: text,
        };
      })
    );

    // Build a combined knowledge base from all watched videos
    const watchedData = transcriptResults
      .filter(v => v.transcript)
      .map(v => `[Video: "${v.title}" | Date: ${v.date}]\n${v.transcript}`)
      .join('\n\n---\n\n');

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: EXTRACT & COMPARE ALL DEVICES, PICK TOP 3
    // AI "watches" all videos, lists every device mentioned, compares them,
    // and picks the top 2-3 based on user specifications
    // ─────────────────────────────────────────────────────────────────────────
    const extractPrompt = `
You are an expert Indian tech analyst. You have just watched ${transcriptResults.filter(v => v.transcript).length} YouTube review/comparison videos about ${category} under ₹${budget}.

Here is everything you learned from watching them:
${watchedData || 'No transcripts were available. Use your own expert knowledge of the current Indian market instead.'}

TASK:
1. List EVERY ${category} device mentioned across all these videos.
2. Give MORE WEIGHT to devices featured in the LATEST/NEWEST videos.
3. Compare all the devices against each other based on the user's priorities: ${specs}.
4. The user prefers these brands: ${brands}.
5. After comparing, pick the TOP 3 devices that best match the user's needs.

Return ONLY the 3 device names as a comma-separated list. Nothing else.
    `;

    const candidateText = await askGemini(extractPrompt);
    const candidates = candidateText.split(',').map(c => c.trim()).filter(c => c.length > 2).slice(0, 3);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: SEARCH FOR SPECIFIC REVIEWS OF THOSE 2-3 DEVICES
    // Go back to YouTube and search for dedicated reviews of each candidate
    // ─────────────────────────────────────────────────────────────────────────
    const reviewData = await Promise.all(
      candidates.map(async (device) => {
        const reviewVideos = await searchYouTube(`${device} review India`, 2, 4);
        let reviewText = '';
        for (const rv of reviewVideos) {
          const t = await getTranscript(rv.id, 4000);
          if (t) {
            reviewText += `\n[Review: "${rv.title}"]\n${t}\n`;
          }
        }
        return { device, reviewText: reviewText || '(No review transcript found, use internal knowledge)' };
      })
    );

    const reviewKnowledge = reviewData
      .map(r => `=== ${r.device} ===\n${r.reviewText}`)
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
You are an expert Indian tech consultant. After extensive research across 15+ YouTube videos and dedicated reviews, you have narrowed it down to these 2 finalists for a ${category} under ₹${budget}:

Device 1: ${top2[0] || candidates[0]}
Device 2: ${top2[1] || candidates[1] || candidates[0]}

Review evidence:
${reviewKnowledge}

User priorities: ${specs}
Preferred brands: ${brands}

Perform a FINAL head-to-head comparison. The #1 device WINS the competition.

Return ONLY this JSON:
{
  "devices": [
    {
      "name": "Full device name",
      "price": 24999,
      "release_year": "2024",
      "buy_link": "https://www.amazon.in/s?k=device+name",
      "specs": {
        "processor": "Processor name and details",
        "display": "Size, resolution, panel type, refresh rate",
        "ram_storage": "RAM and storage details",
        "battery": "Battery capacity and charging speed",
        "camera_or_gpu": "Camera specs for mobile or GPU for laptop"
      },
      "pros": ["Advantage 1 based on reviews", "Advantage 2", "Advantage 3"],
      "verdict": "Detailed explanation of why this device won the competition based on the reviews watched"
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
