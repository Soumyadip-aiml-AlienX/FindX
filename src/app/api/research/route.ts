import { NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

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

// Helper: Raw Fetch Model Sniffer
async function sniffModels() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    console.log("DEBUG: FETCH SNIFFER RESULT:", JSON.stringify(data).substring(0, 500));
  } catch (e: any) {
    console.error("DEBUG: FETCH SNIFFER CRASHED:", e.message);
  }
}

// Helper: Ask Gemini with automatic fallback and retry logic (DIRECT FETCH VERSION)
async function askGemini(prompt: string, useJSON: boolean = false): Promise<any> {
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-pro", "gemini-pro"];
  let lastError: any = null;

  console.log("DEBUG: askGemini triggered (DIRECT FETCH MODE).");

  for (const modelName of models) {
    let retries = 2;
    while (retries > 0) {
      try {
        // PACE: Wait 4 seconds to stay well under Free Tier 20 RPM limit (which is 1 request every 3s)
        await new Promise(r => setTimeout(r, 4000));
        
        console.log(`DEBUG: Attempting Direct Fetch with model: ${modelName}`);
        
        const fullModelName = modelName.startsWith("models/") ? modelName : `models/${modelName}`;
        // Using v1beta as it generally has wider model support for newer releases
        const url = `https://generativelanguage.googleapis.com/v1beta/${fullModelName}:generateContent?key=${GEMINI_API_KEY}`;
        
        const payload = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: useJSON ? { response_mime_type: "application/json" } : {}
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
          console.error(`DEBUG: API Error Response for ${modelName}:`, JSON.stringify(data));
          throw new Error(data.error?.message || `HTTP ${response.status}`);
        }

        if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content) {
          console.warn(`DEBUG: Empty candidates for ${modelName}. Possible safety block or filter.`);
          throw new Error("Empty AI response (Safety/Filter)");
        }

        const text = data.candidates[0].content.parts[0].text;
        
        if (useJSON) {
          try {
            const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanedText);
          } catch (jsonErr) {
            console.error("DEBUG: JSON Parse Error:", jsonErr, "Raw Text:", text);
            throw new Error("Invalid JSON returned by AI");
          }
        }
        return text;

      } catch (e: any) {
        lastError = e;
        console.warn(`DEBUG: Direct Fetch failed for ${modelName}:`, e.message || e);
        await new Promise(r => setTimeout(r, 2000));
        retries--;
      }
    }
  }
  
  console.error("--- ALL AI MODELS FAILED ---");
  throw lastError || new Error("AI Brain Connectivity Issue");
}

// Helper: Ask Gemini for JSON response
async function askGeminiJSON(prompt: string): Promise<any> {
  return await askGemini(prompt, true);
}

export async function POST(request: Request) {
  try {
    const { budget, category, selectedReqs, preferredCompanies } = await request.json();
    const brands = preferredCompanies && preferredCompanies.length > 0 ? preferredCompanies.join(', ') : 'Any';
    const specs = selectedReqs ? selectedReqs.join(', ') : 'All-Rounder';

    if (!GEMINI_API_KEY || !YOUTUBE_API_KEY) {
      console.error("CRITICAL: Missing API Keys!");
      return NextResponse.json({ success: false, error: "API Keys Missing" }, { status: 500 });
    }

    console.log("BRAIN INITIALIZED. Searching for:", category, "Budget:", budget);
    await sniffModels();

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: BROAD YOUTUBE SEARCH & "WATCHING"
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 1: SEARCHING ---");
    const currentYear = new Date().getFullYear();
    // More aggressive query for fresh 2026 data
    const mainQuery = `latest ${category} reviews India ${currentYear} comparison benchmark "pros and cons"`;
    const allVideos = await searchYouTube(mainQuery, 25, 8); // Increased to 25 to bypass disabled transcripts
    console.log(`Found ${allVideos.length} potential videos. Analyzing for transcripts...`);

    const summaryResults: string[] = [];
    let videosWithData = 0;
    
    // SEQUENTIAL PROCESSING
    for (const video of allVideos) {
      if (videosWithData >= 8) break; // Limit to 8 high-quality sources to keep speed reasonable

      console.log(`Checking transcript for: ${video.title}`);
      const text = await getTranscript(video.id, 9000);
      
      if (!text) {
        console.warn(`No transcript for ${video.id}, skipping.`);
        continue;
      }

      videosWithData++;
      console.log(`Processing AI Summary for: ${video.title} (${videosWithData}/8)`);
      
      const summaryPrompt = `
Extract technical specs, Indian pricing (₹), and performance data for ${category} in this video: "${video.title}"
Transcript: ${text}
CRITICAL: Only focus on devices released in ${currentYear} or late ${currentYear-1}. Skip older models.
      `;
      
      try {
        const summary = await askGemini(summaryPrompt);
        summaryResults.push(`[Source: ${video.title}]\n${summary}`);
      } catch (e) {
        console.warn(`AI Error summarizing ${video.title}`);
      }
    }

    const RefinedKnowledge = summaryResults.join('\n\n---\n\n');
    console.log(`Refined Knowledge gathered from ${summaryResults.length} live sources.`);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: TECHNICAL SHORTLIST
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 2: SHORTLISTING ---");
    const extractPrompt = `
You are an expert Indian tech journalist in May ${currentYear}.
Research Data: ${RefinedKnowledge || 'CRITICAL: No live transcripts found. You MUST use your internal knowledge of ' + currentYear + ' flagships like S26, iQOO 13, OnePlus 13, etc.'}

TASK: Select the top 3 ${category} for ₹${budget} (Specs: ${specs}, Brands: ${brands}).
REQUIREMENT: The devices MUST be current-gen (2025-2026). Do NOT suggest 2023 or 2024 models.
Return ONLY the 3 device names as a comma-separated list.
    `;

    const candidateText = await askGemini(extractPrompt);
    const candidates = candidateText.split(',').map((c: string) => c.trim()).filter((c: string) => c.length > 2).slice(0, 3);
    console.log("Candidates selected:", candidates);

    if (candidates.length === 0) throw new Error("No modern candidates found.");

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: DEEP-DIVE RESEARCH
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 3: DEEP DIVING ---");
    const reviewKnowledgeParts: string[] = [];
    
    for (const device of candidates) {
      console.log(`Deep diving into ${currentYear} data for: ${device}`);
      const reviewVideos = await searchYouTube(`${device} India review ${currentYear} full test`, 3, 6);
      for (const rv of reviewVideos) {
        const t = await getTranscript(rv.id, 9000);
        if (!t) continue;
        const p = `Extract detailed benchmark scores and real-world battery life for "${device}" from this ${currentYear} review: "${rv.title}"\nTranscript: ${t}`;
        try { 
          const s = await askGemini(p);
          reviewKnowledgeParts.push(`=== DEEP RESEARCH: ${device} ===\nSource: ${rv.title}\n${s}`);
        } catch (e) {
          console.warn(`Deep dive failed for ${device}`);
        }
      }
    }

    const reviewKnowledge = reviewKnowledgeParts.join('\n\n');

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 4: PICK TOP 2
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 4: FILTERING TOP 2 ---");
    const top2Prompt = `
Compare these ${currentYear} finalists:
${reviewKnowledge}

Pick the absolute TOP 2 for ₹${budget} (Focus: ${specs}).
Return ONLY 2 names comma-separated.
    `;

    const top2Text = await askGemini(top2Prompt);
    const top2 = top2Text.split(',').map((c: string) => c.trim()).filter((c: string) => c.length > 2).slice(0, 2);
    console.log("Finalists:", top2);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 5: FINAL VERDICT
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 5: FINAL VERDICT ---");
    const finalPrompt = `
Create a professional recommendation for:
1. ${top2[0] || candidates[0]}
2. ${top2[1] || candidates[1] || candidates[0]}

Data Context: ${reviewKnowledge}

Return JSON strictly matching this structure:
{
  "devices": [
    {
      "name": "Full ${currentYear} model name",
      "price": 0,
      "release_year": "${currentYear}",
      "buy_link": "https://www.amazon.in/s?k=...",
      "specs": { "processor": "...", "display": "...", "ram_storage": "...", "battery": "...", "camera_or_gpu": "..." },
      "pros": ["...", "..."],
      "verdict": "Detailed explanation why this ${currentYear} model is the winner."
    }
  ]
}
    `;

    const result = await askGeminiJSON(finalPrompt);
    console.log("SUCCESS: 2026 Research complete.");

    return NextResponse.json({ success: true, recommendation: result });

  } catch (error: any) {
    console.error("CRITICAL API ERROR:", error.message || error);
    return NextResponse.json({ success: false, error: error.message || "Brain Overload" }, { status: 500 });
  }
}
