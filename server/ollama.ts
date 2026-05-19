// Korean → English caption translator. We pass the result on as ACE-Step's
// "Music Caption" so the model sees English, which it understands best.
const OLLAMA_URL = "http://localhost:11434/api/generate";

const SYSTEM_PROMPT =
  "Translate Korean music descriptions to short English music captions, " +
  "5-10 words. Output ONLY the English translation. No quotes, no " +
  "explanation, no extra words.";

export async function translateKoreanToEnglish(prompt: string): Promise<string> {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemma2:2b",
      stream: false,
      system: SYSTEM_PROMPT,
      prompt,
      options: { temperature: 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = (await res.json()) as { response: string };
  return data.response.trim();
}
