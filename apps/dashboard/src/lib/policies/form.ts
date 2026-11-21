import type { Policy, PolicyCreateInput, PolicyEffect, PolicyResource, PolicyRule, PolicyUpdateInput } from '@/lib/api/types';

/**
 * Policy form state and the two judgements the form must not get wrong.
 *
 *  * **Validation mirrors the gateway, it does not replace it.** The rules here
 *    catch what a `400` would say anyway, in the field where the mistake is, so
 *    the operator does not lose a long rule list to one bad target.
 *  * **Broadening is computed, not guessed.** The gateway's model is
 *    deny-overrides-allow with default-deny, so access widens when an `allow`
 *    appears that was not there before, or when a `deny` disappears. That diff is
 *    what the confirmation dialog reports; the form never changes an effect on
 *    its own.
 */

export interface RuleDraft {
  resource: PolicyResource;
  target: string;
  effect: PolicyEffect;
}

export interface PolicyFormState {
  name: string;
  description: string;
  /** `null` while the field is empty; `NumberInput` owns the numeric parsing. */
  priority: number | null;
  rules: RuleDraft[];
}

export const EMPTY_FORM: PolicyFormState = { name: '', description: '', priority: 0, rules: [] };

export const EMPTY_RULE: RuleDraft = { resource: 'tool', target: '', effect: 'allow' };

/** A public tool name, normalized by the catalog. Mirrors `TOOL_TARGET_PATTERN` in `policy-service.ts`. */
const TOOL_TARGET = /^[A-Za-z0-9._-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WILDCARD = '*';

export function formFromPolicy(policy: Policy): PolicyFormState {
  return {
    name: policy.name,
    description: policy.description ?? '',
    priority: policy.priority,
    rules: policy.rules.map((rule) => ({ ...rule })),
  };
}

export type FormErrors = Record<string, string>;

export function validateForm(form: PolicyFormState): FormErrors {
  const errors: FormErrors = {};
  const name = form.name.trim();

  if (name === '') errors.name = 'A name is required.';
  else if (name.length > 120) errors.name = 'At most 120 characters.';
  if (form.description.trim().length > 2000) errors.description = 'At most 2000 characters.';

  const priority = form.priority;
  if (priority === null || !Number.isInteger(priority)) {
    errors.priority = 'A whole number is required.';
  } else if (priority < -1000 || priority > 1000) {
    errors.priority = 'Between -1000 and 1000.';
  }

  if (form.rules.length > 500) errors.rules = 'At most 500 rules.';

  form.rules.forEach((rule, index) => {
    const target = rule.target.trim();
    if (target === '') {
      errors[`rule-${index}-target`] = 'A target is required, or `*` for everything.';
    } else if (target === WILDCARD) {
      // Always valid: the wildcard is the documented "at that level" match.
    } else if (rule.resource === 'backend' && !UUID.test(target)) {
      errors[`rule-${index}-target`] = 'A backend rule targets a backend id, or `*`.';
    } else if (rule.resource === 'tool' && !TOOL_TARGET.test(target)) {
      errors[`rule-${index}-target`] = 'Letters, digits, dot, underscore and hyphen only; at most 128.';
    }
  });

  return errors;
}

function toRules(rules: RuleDraft[]): PolicyRule[] {
  return rules.map((rule) => ({
    resource: rule.resource,
    target: rule.target.trim(),
    effect: rule.effect,
  }));
}

export function toCreateInput(form: PolicyFormState): PolicyCreateInput {
  const description = form.description.trim();
  return {
    name: form.name.trim(),
    priority: form.priority ?? 0,
    rules: toRules(form.rules),
    ...(description === '' ? {} : { description }),
  };
}

/**
 * `rules` is always sent, because the gateway replaces the array wholesale: a
 * partial send would silently keep rules the operator just deleted.
 */
export function toUpdateInput(form: PolicyFormState): PolicyUpdateInput {
  const description = form.description.trim();
  return {
    name: form.name.trim(),
    priority: form.priority ?? 0,
    rules: toRules(form.rules),
    description: description === '' ? null : description,
  };
}

function key(rule: { resource: string; target: string }): string {
  return `${rule.resource}:${rule.target}`;
}

/**
 * Human-readable list of the ways `after` grants more than `before`.
 *
 * Empty means the edit does not widen access (it may narrow it, or rename).
 * A `deny` removal counts: with deny-overrides-allow, deleting a denial restores
 * whatever an allow rule would otherwise permit.
 */
export function broadeningChanges(before: readonly RuleDraft[], after: readonly RuleDraft[]): string[] {
  const previous = new Map(before.map((rule) => [key({ resource: rule.resource, target: rule.target.trim() }), rule.effect]));
  const current = new Map(after.map((rule) => [key({ resource: rule.resource, target: rule.target.trim() }), rule.effect]));
  const changes: string[] = [];

  for (const [ruleKey, effect] of current) {
    const was = previous.get(ruleKey);
    if (effect === 'allow' && was !== 'allow') {
      changes.push(was === 'deny' ? `${ruleKey} changes from DENY to ALLOW` : `${ruleKey} becomes allowed`);
    }
  }

  for (const [ruleKey, effect] of previous) {
    // Only a *removed* denial is reported here; a denial flipped to ALLOW is
    // already described above and must not be counted twice.
    if (effect === 'deny' && !current.has(ruleKey)) {
      changes.push(`${ruleKey} is no longer denied`);
    }
  }

  return changes;
}

/** A wildcard allow is the broadest grant the model can express; it always deserves a prompt. */
export function hasWildcardAllow(rules: readonly RuleDraft[]): boolean {
  return rules.some((rule) => rule.effect === 'allow' && rule.target.trim() === WILDCARD);
}
