import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createLlmJudgeExtension } from "./extension.js";

/**
 * Entry point: register the allow-or-ask LLM judge as a
 * pi-permission-system Authorizer chain link.
 */
export default function llmJudgeExtension(pi: ExtensionAPI): void {
 createLlmJudgeExtension(pi);
}
