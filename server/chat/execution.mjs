import { randomUUID } from "node:crypto";

// Each hosted provider operation reserves independently immediately before its
// request, including fallbacks, agent rounds, titles, and document embeddings.
export function createChatExecutionService({ apiKeyService, billingService, chatService }) {
  async function createUsageContext({ user, signal, operation = "reply" }) {
    signal?.throwIfAborted();
    const apiKeys = await apiKeyService.getDecryptedKeys(user.id);
    signal?.throwIfAborted();
    return {
      allowHosted: user.billing.hasAccess,
      apiKeys,
      userId: user.id,
      signal,
      usageMeter: user.role === "admin" ? null : chatService.createUsageMeter({
        billingService, requestId: randomUUID(), userId: user.id, operation,
      }),
    };
  }

  async function executeChatReply({ payload, user, signal, handlers = {}, operation = "reply" }) {
    const context = await createUsageContext({ user, signal, operation });
    const credentialSource = operation === "title"
      ? chatService.getPlannedTitleCredentialSource(payload, context)
      : chatService.getPlannedCredentialSource(payload, context);
    if (credentialSource === "hosted") {
      const limits = billingService.getHostedUsageLimits(payload, { validateInput: false });
      // Naming every cluster at once needs a line per cluster, and a cleaned
      // transcript is as long as the transcript; other titles need one line.
      const titleTokens = payload?.kind === "categories" ? 2_048 : payload?.kind === "dictation" ? limits.maxOutputTokens : 256;
      context.hostedMaxOutputTokens = operation === "title" ? Math.min(limits.maxOutputTokens, titleTokens) : limits.maxOutputTokens;
      context.hostedMaxInputCharacters = limits.maxInputCharacters;
    }
    const result = operation === "title"
      ? await chatService.generateTitle(payload, context)
      : await chatService.requestReplyStream(payload, context, {
          async onReady(metadata) {
            signal?.throwIfAborted();
            await handlers.onReady?.(metadata);
          },
          async onDelta(delta) {
            signal?.throwIfAborted();
            await handlers.onDelta?.(delta);
          },
        });
    signal?.throwIfAborted();
    return result;
  }
  executeChatReply.createUsageContext = createUsageContext;
  return executeChatReply;
}
