import {
  groundDraft,
  type DraftInput,
  type GroundingSources,
  type ModelProvider,
} from "@maman/model-provider";
import type { ComposedDraft } from "./compose.js";

/**
 * The model composer. Voice from the person's own writing, facts from the
 * thread, and a fallback that is always ready.
 *
 * The provider's answer is not trusted on its own: `groundDraft` checks every
 * number, sum, URL and committing word against the thread and the facts we
 * hold. A draft that fails, or a provider that fails, gives way to the
 * fallback composer, and the result says so (`fallback_reason`), so the
 * receipt can tell "the model wrote this" from "the template did".
 */

export type ComposeContext = DraftInput;

export type ComposedDraftWithProvenance = ComposedDraft & {
  fallback_reason?: string;
  model_alias?: string;
};

export interface ContextComposer {
  compose(input: ComposeContext): Promise<ComposedDraftWithProvenance>;
}

export function modelComposer(deps: {
  provider: Pick<ModelProvider, "composeDraft">;
  fallback: ContextComposer;
}): ContextComposer {
  return {
    async compose(input) {
      const result = await deps.provider.composeDraft(input);
      if (!result.ok) {
        const fb = await deps.fallback.compose(input);
        return { ...fb, fallback_reason: `model ${result.error}` };
      }
      const sources: GroundingSources = {
        messages: input.messages,
        subject: input.subject,
        days_elapsed: input.days_elapsed,
        open_deal_value: input.open_deal_value,
        ask: input.ask,
        meetings: [
          ...(input.last_meeting ? [input.last_meeting] : []),
          ...(input.next_meeting ? [input.next_meeting] : []),
        ],
      };
      const grounded = groundDraft(result.value.body, sources);
      if (!grounded.ok) {
        const fb = await deps.fallback.compose(input);
        return { ...fb, fallback_reason: `ungrounded: ${grounded.violations.join("; ")}` };
      }
      return {
        to: input.contact_address,
        subject: result.value.subject,
        body: result.value.body,
        composer: "model",
        model_alias: result.usage.model_alias,
      };
    },
  };
}

/** The template composer, given the full context: the fallback the model version leans on. */
export function deterministicContextComposer(
  provider: Pick<ModelProvider, "composeDraft">,
): ContextComposer {
  return {
    async compose(input) {
      // The deterministic provider IS the template, grounded by construction.
      const result = await provider.composeDraft(input);
      if (!result.ok) throw new Error(`template composer failed: ${result.error}`);
      return {
        to: input.contact_address,
        subject: result.value.subject,
        body: result.value.body,
        composer: "deterministic",
      };
    },
  };
}
