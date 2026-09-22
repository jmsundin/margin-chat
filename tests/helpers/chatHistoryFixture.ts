export function chatGPTFixture(id = "chat-one", title = "A familiar conversation") {
  return { id, title, create_time: 1700000000, update_time: 1700000060, current_node: "answer", mapping: {
    // Deliberately out of order: ancestry, not JSON order, determines messages.
    answer: { parent: "question", message: { author: { role: "assistant" }, create_time: 1700000060,
      content: { content_type: "text", parts: ["Hello **world**!\n\n```ts\nconst n = 1;\n```\n\n日本語 🌿"] } } },
    root: { parent: null, message: { author: { role: "system" }, content: { parts: ["Hidden system instructions"] } } },
    question: { parent: "root", message: { author: { role: "user" }, create_time: 1700000001, content: { parts: ["Can we continue this?"] } } },
  } };
}
