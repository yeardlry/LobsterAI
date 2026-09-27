/**
 * Tests for the preset agent catalog.
 *
 * Focused on the `bio-research` default-preset entry (added 2026-09-19)
 * and the structural invariants of `presetToCreateRequest`. The catalog
 * shape itself is exercised by the existing renderer UI tests — these
 * tests only cover what the install-default-preset flow relies on.
 */

import { describe, expect, test } from 'vitest';

import { AgentAvatarIconFormat, AgentAvatarSvg } from '../shared/agent/avatar';
import { PRESET_AGENTS, presetToCreateRequest } from './presetAgents';

describe('PRESET_AGENTS', () => {
  test('contains the bio-research preset', () => {
    const bio = PRESET_AGENTS.find(p => p.id === 'bio-research');
    expect(bio).toBeDefined();
  });

  test('bio-research has the expected display fields', () => {
    const bio = PRESET_AGENTS.find(p => p.id === 'bio-research');
    expect(bio?.name).toBe('生物研究');
    expect(bio?.nameEn).toBe('Biological Research');
    // The bio-research expert is what the paper pipeline's
    // `PIPELINE_EXPERT_AGENT_ALIASES` auto-detect matches on — keep the
    // exact name aligned with the alias list (see taskHiddenSession.ts).
    expect(bio?.name).toBe('生物研究');
  });

  test('bio-research ships the web-search skill', () => {
    // web-search is the only built-in skill guaranteed to be present on
    // every LobsterAI install (see skillServices.ts). Bundling any other
    // skill here would surface "skill not found" on first launch.
    const bio = PRESET_AGENTS.find(p => p.id === 'bio-research');
    expect(bio?.skillIds).toContain('web-search');
  });

  test('bio-research icon encodes the Experiment avatar', () => {
    const bio = PRESET_AGENTS.find(p => p.id === 'bio-research');
    expect(bio?.icon).toBe(`${AgentAvatarIconFormat.Svg}:${AgentAvatarSvg.Experiment}`);
  });

  test('every preset has bilingual name/description/identity/systemPrompt', () => {
    // Sanity guard — the catalog is consumed by both zh and en locales,
    // so every entry must provide both halves. If you add a new preset
    // and forget the En side, this test fails loudly.
    for (const preset of PRESET_AGENTS) {
      expect(preset.name, `${preset.id}.name`).toBeTruthy();
      expect(preset.nameEn, `${preset.id}.nameEn`).toBeTruthy();
      expect(preset.description, `${preset.id}.description`).toBeTruthy();
      expect(preset.descriptionEn, `${preset.id}.descriptionEn`).toBeTruthy();
      expect(preset.identity, `${preset.id}.identity`).toBeTruthy();
      expect(preset.identityEn, `${preset.id}.identityEn`).toBeTruthy();
      expect(preset.systemPrompt, `${preset.id}.systemPrompt`).toBeTruthy();
      expect(preset.systemPromptEn, `${preset.id}.systemPromptEn`).toBeTruthy();
      expect(preset.skillIds.length, `${preset.id}.skillIds`).toBeGreaterThan(0);
      expect(preset.icon, `${preset.id}.icon`).toMatch(/^agent-avatar-svg:/);
    }
  });
});

describe('presetToCreateRequest', () => {
  test('marks preset-sourced agents with source=preset and presetId', () => {
    const bio = PRESET_AGENTS.find(p => p.id === 'bio-research')!;
    const req = presetToCreateRequest(bio);
    expect(req.source).toBe('preset');
    expect(req.presetId).toBe('bio-research');
    expect(req.id).toBe('bio-research');
  });

  test('bio-research request carries the catalog skill list and icon verbatim', () => {
    const bio = PRESET_AGENTS.find(p => p.id === 'bio-research')!;
    const req = presetToCreateRequest(bio);
    expect(req.skillIds).toEqual(bio.skillIds);
    expect(req.icon).toBe(bio.icon);
  });
});
