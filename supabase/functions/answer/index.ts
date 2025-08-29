// supabase/functions/answer/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 1. Pull in your env vars
const SUPABASE_URL           = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY         = Deno.env.get("OPENAI_API_KEY")!;

// 2. Initialize Supabase client with service‐role key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// 3. Helper: call the LLM
async function callLLM(question: string, mode: string, intent: string, role: string) {
  // Replace the systemPrompt string below with your full hidden prompt
  const systemPrompt = `
You are "Project Devi," a clinical assistant for orthopedics, emergency medicine, and radiology.
Return valid HTML with clear sections and numbered citations. Do not give legal or billing advice.
Auto-detect mode/intent, ground everything in Indian workflows, and follow the JSON contract.
  `.trim();

  const payload = {
    model: "gpt-4o",           // or your chosen model
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: question }
    ]
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  const latency = data.usage?.total_tokens ?? 0; // adjust if you have timing info

  // TODO: parse out your citations into { title, url }[]
  const sources: { title: string; url: string }[] = [];

  return {
    html: content,
    sources,
    confidence: 85,            // compute or extract if possible
    latency,
    modeFinal: mode,
    intentFinal: intent
  };
}

// 4. Serve the function
serve(async (req) => {
  try {
    const { question, mode = "ortho", intent = "rounds", role = "jr" } = await req.json();

    // 4a. Log the query
    const { data: query } = await supabase
      .from("queries")
      .insert({ text: question, mode, intent, role })
      .select("id")
      .single();

    // 4b. Ask the LLM
    const llm = await callLLM(question, mode, intent, role);

    // 4c. Save the answer
    const { data: answer } = await supabase
      .from("answers")
      .insert({
        query_id:      query.id,
        html:          llm.html,
        confidence_pct: llm.confidence,
        latency_ms:     llm.latency,
        mode_final:     llm.modeFinal,
        intent_final:   llm.intentFinal
      })
      .select("id")
      .single();

    // 4d. Save each source
    for (let i = 0; i < llm.sources.length; i++) {
      const src = llm.sources[i];
      await supabase
        .from("sources")
        .insert({
          answer_id: answer.id,
          title:     src.title,
          url:       src.url,
          domain:    new URL(src.url).hostname,
          rank:      i + 1
        });
    }

    // 4e. Return the final payload
    return new Response(JSON.stringify({
      answer_html: llm.html,
      sources:      llm.sources,
      meta: {
        mode_final:     llm.modeFinal,
        intent_final:   llm.intentFinal,
        confidence_pct: llm.confidence,
        latency_ms:     llm.latency
      }
    }), {
      headers: { "Content-Type
