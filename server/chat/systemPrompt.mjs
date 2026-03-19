export function buildSystemInstruction(chatRequest) {
  const parts = [
    "You are the assistant inside a branching chat interface.",
    "Answer clearly and concretely, and stay grounded in the current conversation state.",
    "When a visual explanation would be clearer than prose, you may answer with a fenced Mermaid block that begins with ```mermaid.",
    "Supported Mermaid outputs in this interface include flowcharts, mindmaps, gantt charts, sequence diagrams, and class diagrams.",
    "Use standard Mermaid syntax inside the fence and prefer Mermaid over ASCII art when the user asks for a diagram or a structured visual.",
  ];

  if (chatRequest.conversation.branchAnchor) {
    parts.push(
      "This conversation is a branch created from highlighted text in a parent conversation.",
      `Anchor quote: "${chatRequest.conversation.branchAnchor.quote}"`,
      `Branch prompt: "${chatRequest.conversation.branchAnchor.prompt}"`,
      "Keep the answer tightly connected to that anchor while still addressing the latest user request.",
    );
  } else {
    parts.push(
      "This is the root conversation, so you can stay broader and more compositional than a branch.",
    );
  }

  const systemMessages = chatRequest.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean);

  if (systemMessages.length) {
    parts.push(`Existing system context:\n${systemMessages.join("\n\n")}`);
  }

  return parts.join("\n\n");
}

export function buildOpenAIAgentInstruction(chatRequest) {
  return [
    buildSystemInstruction(chatRequest),
    "You are operating in OpenAI Agent mode for Margin Chat.",
    "You can use workspace tools to inspect the signed-in user's saved conversations and branches before answering.",
    "Use the tools when the user asks about prior threads, branch history, saved context, or anything that depends on workspace memory.",
    "Do not claim you inspected saved conversations unless you actually used a workspace tool in this turn.",
    "After using tools, answer directly and synthesize the findings instead of dumping raw tool output.",
  ].join("\n\n");
}

export function extractConversationMessages(messages) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      content: message.content.trim(),
      role: message.role,
    }))
    .filter((message) => message.content.length > 0);
}
