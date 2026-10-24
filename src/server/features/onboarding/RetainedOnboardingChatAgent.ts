import { DurableObject } from "cloudflare:workers";

/**
 * Storage-only Durable Object retained to preserve the retired onboarding-chat
 * namespace and its existing instances. The product feature is gone: requests
 * return 410 and this class never reads, writes, or deletes stored data.
 */
export class OnboardingChatAgent extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response("This chat is no longer available.", { status: 410 });
  }
}
