import { describe, expect, it } from 'vitest';

import {
  EMPTY_FORM,
  broadeningChanges,
  formFromPolicy,
  hasWildcardAllow,
  toCreateInput,
  toUpdateInput,
  validateForm,
  WILDCARD,
  type RuleDraft,
} from '@/lib/policies/form';
import type { Policy } from '@/lib/api/types';

/**
 * Policy form logic, without a browser.
 *
 * The two judgements worth testing in isolation are the ones an operator cannot
 * easily catch by eye:
 *
 *  * which edits *widen* access (new ALLOW, removed DENY) — the confirmation
 *    depends on this being complete, not approximate;
 *  * which payload is sent — the rule array is replaced wholesale, so a partial
 *    send would silently keep rules that were just deleted.
 */

const BACKEND = '11111111-1111-4111-8111-111111111111';

function rule(overrides: Partial<RuleDraft> = {}): RuleDraft {
  return { resource: 'tool', target: 'github__read', effect: 'allow', ...overrides };
}

describe('validateForm', () => {
  it('accepts a minimal valid policy', () => {
    expect(validateForm({ ...EMPTY_FORM, name: 'read-only' })).toEqual({});
  });

  it('requires a name and bounds it', () => {
    expect(validateForm({ ...EMPTY_FORM, name: '   ' }).name).toBe('A name is required.');
    expect(validateForm({ ...EMPTY_FORM, name: 'x'.repeat(121) }).name).toBe('At most 120 characters.');
  });

  it('requires a whole priority inside the documented range', () => {
    expect(validateForm({ ...EMPTY_FORM, name: 'a', priority: null }).priority).toBe('A whole number is required.');
    expect(validateForm({ ...EMPTY_FORM, name: 'a', priority: 1001 }).priority).toBe('Between -1000 and 1000.');
    expect(validateForm({ ...EMPTY_FORM, name: 'a', priority: -1000 }).priority).toBeUndefined();
  });

  it('requires a target, but never on the wildcard', () => {
    expect(validateForm({ ...EMPTY_FORM, name: 'a', rules: [rule({ target: '  ' })] })['rule-0-target']).toBe(
      'A target is required, or `*` for everything.',
    );
    expect(validateForm({ ...EMPTY_FORM, name: 'a', rules: [rule({ target: WILDCARD })] })['rule-0-target']).toBeUndefined();
  });

  it('shapes a backend target as a backend id and a tool target as a public name', () => {
    expect(
      validateForm({ ...EMPTY_FORM, name: 'a', rules: [rule({ resource: 'backend', target: 'not-a-uuid' })] })[
        'rule-0-target'
      ],
    ).toBe('A backend rule targets a backend id, or `*`.');

    expect(
      validateForm({ ...EMPTY_FORM, name: 'a', rules: [rule({ resource: 'tool', target: 'not a tool name' })] })[
        'rule-0-target'
      ],
    ).toBe('Letters, digits, dot, underscore and hyphen only; at most 128.');

    expect(
      validateForm({ ...EMPTY_FORM, name: 'a', rules: [rule({ resource: 'backend', target: BACKEND })] })[
        'rule-0-target'
      ],
    ).toBeUndefined();

    // Tool targets are shape-only: the catalog is derived and a tool may not
    // exist yet, so existence is deliberately not checked here.
    expect(
      validateForm({ ...EMPTY_FORM, name: 'a', rules: [rule({ resource: 'tool', target: 'a__b.c-d_e' })] })[
        'rule-0-target'
      ],
    ).toBeUndefined();
  });
});

describe('payloads', () => {
  it('creates with the whole rule array and trims every target', () => {
    const input = toCreateInput({
      name: ' read-only ',
      description: '  for the laptop  ',
      priority: 3,
      rules: [rule({ target: ' github__read ' })],
    });

    expect(input).toEqual({
      name: 'read-only',
      description: 'for the laptop',
      priority: 3,
      rules: [{ resource: 'tool', target: 'github__read', effect: 'allow' }],
    });
  });

  it('omits an empty description instead of storing one', () => {
    expect(toCreateInput({ ...EMPTY_FORM, name: 'a' })).toEqual({ name: 'a', priority: 0, rules: [] });
  });

  it('always sends rules on update, because the array is replaced wholesale', () => {
    const input = toUpdateInput({ ...EMPTY_FORM, name: 'a', description: '', rules: [] });

    expect(input).toEqual({ name: 'a', priority: 0, rules: [], description: null });
    expect(input).toHaveProperty('rules');
  });

  it('round-trips a stored policy', () => {
    const policy: Policy = {
      id: '77777777-7777-4777-8777-777777777777',
      name: 'read-only',
      priority: 10,
      rules: [{ resource: 'backend', target: BACKEND, effect: 'allow' }],
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    };

    const form = formFromPolicy(policy);
    expect(form).toEqual({
      name: 'read-only',
      description: '',
      priority: 10,
      rules: [{ resource: 'backend', target: BACKEND, effect: 'allow' }],
    });
    expect(toUpdateInput(form)).toEqual({
      name: 'read-only',
      priority: 10,
      rules: [{ resource: 'backend', target: BACKEND, effect: 'allow' }],
      description: null,
    });
  });
});

describe('broadeningChanges', () => {
  it('is empty for a narrowing edit', () => {
    const before = [rule({ target: 'a' }), rule({ target: 'b' })];
    const after = [rule({ target: 'a' })];

    expect(broadeningChanges(before, after)).toEqual([]);
  });

  it('reports a new ALLOW rule', () => {
    expect(broadeningChanges([], [rule({ target: 'a' })])).toEqual(['tool:a becomes allowed']);
  });

  it('reports a DENY that was flipped to ALLOW, and only as a widening', () => {
    const changes = broadeningChanges([rule({ target: 'a', effect: 'deny' })], [rule({ target: 'a', effect: 'allow' })]);

    expect(changes).toEqual(['tool:a changes from DENY to ALLOW']);
  });

  it('reports a removed DENY, because deny-overrides-allow means removing it restores access', () => {
    expect(broadeningChanges([rule({ target: 'a', effect: 'deny' })], [])).toEqual(['tool:a is no longer denied']);
  });

  it('does not report an ALLOW that was already there, or a rename of priority/resource pair', () => {
    const before = [rule({ target: 'a' })];
    expect(broadeningChanges(before, [rule({ target: 'a' })])).toEqual([]);
  });

  it('treats resource and target together as the identity of a rule', () => {
    const before = [rule({ resource: 'backend', target: BACKEND, effect: 'deny' })];
    const after = [rule({ resource: 'tool', target: BACKEND, effect: 'allow' })];

    // Different keys, so this is a removal plus an addition — both widen.
    expect(broadeningChanges(before, after)).toEqual([
      `tool:${BACKEND} becomes allowed`,
      `backend:${BACKEND} is no longer denied`,
    ]);
  });
});

describe('hasWildcardAllow', () => {
  it('is true only for an allow rule with target *', () => {
    expect(hasWildcardAllow([rule({ target: WILDCARD })])).toBe(true);
    expect(hasWildcardAllow([rule({ target: WILDCARD, effect: 'deny' })])).toBe(false);
    expect(hasWildcardAllow([rule({ target: 'github__read' })])).toBe(false);
  });
});
