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
    const { budget, category, requirements, preferredCompany, preferredCompanies } = await request.json();

    const finalCompany = preferredCompanies ? preferredCompanies.join(', ') : preferredCompany;

    // Mocking the result if API keys are missing to ensure UI can be demonstrated
    if (!YOUTUBE_API_KEY || !GEMINI_API_KEY) {
      console.log("Mocking response due to missing API keys.");
      await new Promise(resolve => setTimeout(resolve, 8000)); // Simulate delay
      return NextResponse.json({
        success: true,
        recommendation: {
          devices: [
            {
              name: finalCompany && finalCompany !== 'Any' ? `${finalCompany} Top Pick` : (category === 'mobile' ? "iQOO 12 5G" : "Lenovo Legion Slim 5"),
              price: budget - 1000,
              release_year: "2024",
              buy_link: `https://www.amazon.in/s?k=${encodeURIComponent(category === 'mobile' ? "iQOO 12 5G" : "Lenovo Legion Slim 5")}`,
              specs: {
                processor: category === 'mobile' ? "Snapdragon 8 Gen 3" : "AMD Ryzen 7 7840HS",
                display: category === 'mobile' ? "6.78\" 144Hz LTPO AMOLED" : "16\" 165Hz WQXGA IPS",
                ram_storage: category === 'mobile' ? "12GB RAM | 256GB UFS 4.0" : "16GB DDR5 | 1TB NVMe SSD",
                battery: category === 'mobile' ? "5000mAh | 120W Fast Charging" : "80Wh | 140W Type-C",
                camera_or_gpu: category === 'mobile' ? "50MP Main + 64MP Periscope + 50MP UW" : "NVIDIA RTX 4060 8GB (100W TGP)"
              },
              pros: [
                "Exceptional performance for your budget",
                category === 'mobile' ? "Incredible cameras and fast charging" : "Great cooling and display quality",
                `Perfectly hits your priority for ${requirements[0]}`
              ],
              verdict: "This device is the absolute best value in the Indian market right now based on recent tech reviews."
            },
            {
              name: preferredCompany && preferredCompany !== 'Any' ? `${preferredCompany} Value Pick` : (category === 'mobile' ? "OnePlus 12R" : "ASUS ROG Strix G16"),
              price: budget - 2000,
              release_year: "2024",
              buy_link: `https://www.amazon.in/s?k=${encodeURIComponent(category === 'mobile' ? "OnePlus 12R" : "ASUS ROG Strix G16")}`,
              specs: {
                processor: category === 'mobile' ? "Snapdragon 8 Gen 2" : "Intel Core i7-13650HX",
                display: category === 'mobile' ? "6.78\" 120Hz ProXDR AMOLED" : "16\" 165Hz FHD+ IPS",
                ram_storage: category === 'mobile' ? "8GB RAM | 128GB UFS 3.1" : "16GB DDR5 | 512GB NVMe SSD",
                battery: category === 'mobile' ? "5500mAh | 100W SUPERVOOC" : "90Wh | 280W Adapter",
                camera_or_gpu: category === 'mobile' ? "50MP Main + 8MP UW + 2MP Macro" : "NVIDIA RTX 4050 6GB (140W TGP)"
              },
              pros: [
                "Solid build quality and reliable UI",
                "Great battery life",
                "Strong community support"
              ],
              verdict: "A very close second if you prefer a different brand ecosystem."
            }
          ]
        }
      });
    }

    // Step 1: Initial Search
    const brandQuery = preferredCompany && preferredCompany !== 'Any' ? preferredCompany + " " : "";
    const query = `best ${brandQuery}${category} under ${budget} in india ${new Date().getFullYear()} hindi english review`;
    const videos = await searchYouTube(query, 3);
    
    // Step 2 & 3: Fetch Transcripts for selection
    let combinedTranscripts = "";
    for (const video of videos) {
      const text = await getTranscriptText(video.id);
      if (text) {
        combinedTranscripts += `\nVideo Title: ${video.title}\nTranscript snippet: ${text.substring(0, 5000)}\n`;
      }
    }

    // Step 4 & 5: LLM extraction and comparison
    const prompt = `
      You are an expert tech reviewer analyzing YouTube transcripts to recommend the best ${category} under ₹${budget} in India.
      The user prioritizes: ${requirements.join(', ')}.
      ${finalCompany && finalCompany !== 'Any' ? `CRITICAL: The user PREFERS devices from these brands: ${finalCompany}. You MUST heavily prioritize recommending devices from these brands if they fit the criteria.` : ''}

      Analyze the following transcript snippets from recent top Indian tech YouTube videos.
      Extract the top 2 recommended devices that fit the budget and the user's priorities.
      
      Return ONLY a JSON object exactly matching this schema:
      {
        "devices": [
          {
            "name": "Full device name",
            "price": "estimated price in INR as integer",
            "release_year": "Year the device was released, e.g. 2024",
            "buy_link": "A valid Amazon India or Flipkart search URL for this exact device model",
            "specs": {
              "processor": "Processor / SoC details",
              "display": "Screen size, resolution, panel type, and refresh rate",
              "ram_storage": "RAM and Storage info",
              "battery": "Battery capacity and charging speed",
              "camera_or_gpu": "Camera specs for mobile, GPU for laptop"
            },
            "pros": ["pro 1 related to user priorities", "pro 2", "pro 3"],
            "verdict": "Why this specifically fits the user based on reviews"
          }
        ]
      }

      Transcripts:
      ${combinedTranscripts}
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const llmOutput = response.text || "{}";
    const resultJson = JSON.parse(llmOutput);

    return NextResponse.json({
      success: true,
      recommendation: resultJson
    });

  } catch (error) {
    console.error("API Route Error:", error);
    return NextResponse.json({ success: false, error: "Failed to process" }, { status: 500 });
  }
}
