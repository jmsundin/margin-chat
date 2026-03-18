import { HttpError } from "../lib/errors.mjs";
import { extractConversationMessages } from "./systemPrompt.mjs";

export async function requestOpenAIResponse({
  apiKey,
  chatRequest,
  model,
  systemInstruction,
}) {
  if (!apiKey) {
    throw new HttpError(
      503,
      "OpenAI API is not configured. Add OPENAI_API_KEY to your environment.",
    );
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    body: JSON.stringify({
      input: extractConversationMessages(chatRequest.messages).map((message) => ({
        content: message.content,
        role: message.role,
      })),
      instructions: systemInstruction,
      model,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new HttpError(
      response.status,
      extractApiErrorMessage(payload) ?? "OpenAI request failed.",
    );
  }

  const reply = extractOpenAIReply(payload);

  if (!reply) {
    throw new HttpError(
      502,
      "OpenAI returned a response without assistant text.",
    );
  }

  return {
    model,
    reply,
  };
}

export async function requestXAIResponse({
  apiKey,
  chatRequest,
  model,
  systemInstruction,
}) {
  if (!apiKey) {
    throw new HttpError(
      503,
      "xAI API is not configured. Add XAI_API_KEY to your environment.",
    );
  }

  const response = await fetch("https://api.x.ai/v1/responses", {
    body: JSON.stringify({
      input: [
        {
          content: systemInstruction,
          role: "system",
        },
        ...extractConversationMessages(chatRequest.messages).map((message) => ({
          content: message.content,
          role: message.role,
        })),
      ],
      model,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new HttpError(
      response.status,
      extractApiErrorMessage(payload) ?? "xAI request failed.",
    );
  }

  const reply = extractOpenAIReply(payload);

  if (!reply) {
    throw new HttpError(
      502,
      "xAI returned a response without assistant text.",
    );
  }

  return {
    model:
      typeof payload?.model === "string" && payload.model.trim()
        ? payload.model
        : model,
    reply,
  };
}

export async function requestGeminiResponse({
  apiKey,
  chatRequest,
  model,
  systemInstruction,
}) {
  if (!apiKey) {
    throw new HttpError(
      503,
      "Gemini API is not configured. Add GEMINI_API_KEY to your environment.",
    );
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      body: JSON.stringify({
        contents: extractConversationMessages(chatRequest.messages).map(
          (message) => ({
            parts: [{ text: message.content }],
            role: message.role === "assistant" ? "model" : "user",
          }),
        ),
        system_instruction: {
          parts: [{ text: systemInstruction }],
        },
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new HttpError(
      response.status,
      extractApiErrorMessage(payload) ?? "Gemini request failed.",
    );
  }

  const reply = extractGeminiReply(payload);

  if (!reply) {
    throw new HttpError(
      502,
      "Gemini returned a response without assistant text.",
    );
  }

  return {
    model,
    reply,
  };
}

export async function requestHuggingFaceResponse({
  apiKey,
  chatRequest,
  model,
  systemInstruction,
}) {
  if (!apiKey) {
    throw new HttpError(
      503,
      "Hugging Face API is not configured. Add HUGGINGFACE_API_KEY or HF_TOKEN to your environment.",
    );
  }

  const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
    body: JSON.stringify({
      messages: [
        {
          content: systemInstruction,
          role: "system",
        },
        ...extractConversationMessages(chatRequest.messages).map((message) => ({
          content: message.content,
          role: message.role,
        })),
      ],
      model,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new HttpError(
      response.status,
      extractApiErrorMessage(payload) ?? "Hugging Face request failed.",
    );
  }

  const reply = extractHuggingFaceReply(payload);

  if (!reply) {
    throw new HttpError(
      502,
      "Hugging Face returned a response without assistant text.",
    );
  }

  return {
    model:
      typeof payload?.model === "string" && payload.model.trim()
        ? payload.model
        : model,
    reply,
  };
}

function extractOpenAIReply(payload) {
  if (
    payload &&
    typeof payload.output_text === "string" &&
    payload.output_text.trim()
  ) {
    return payload.output_text.trim();
  }

  const textChunks = [];

  for (const item of payload?.output ?? []) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content ?? []) {
      if (
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string" &&
        content.text.trim()
      ) {
        textChunks.push(content.text.trim());
      }
    }
  }

  return textChunks.join("\n\n").trim();
}

function extractGeminiReply(payload) {
  const parts =
    payload?.candidates?.[0]?.content?.parts
      ?.map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
      .filter(Boolean) ?? [];

  return parts.join("\n\n").trim();
}

function extractHuggingFaceReply(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part.trim();
      }

      if (typeof part?.text === "string") {
        return part.text.trim();
      }

      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function extractApiErrorMessage(payload) {
  if (typeof payload?.error === "string" && payload.error) {
    return payload.error;
  }

  if (
    typeof payload?.error?.message === "string" &&
    payload.error.message
  ) {
    return payload.error.message;
  }

  const nestedErrorMessage = payload?.errors
    ?.map((error) =>
      typeof error?.message === "string" && error.message
        ? error.message
        : "",
    )
    ?.find(Boolean);

  if (nestedErrorMessage) {
    return nestedErrorMessage;
  }

  if (typeof payload?.message === "string" && payload.message) {
    return payload.message;
  }

  return null;
}
