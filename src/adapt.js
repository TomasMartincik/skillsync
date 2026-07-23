/**
 * Per-agent adaptation seam.
 *
 * Given a validated source skill tree and a target agent, produce the list of
 * files to materialize for that agent. The central format IS Claude-native, so:
 *
 *   - Claude (`.claude/skills/<name>/`): copied VERBATIM.
 *   - Codex  (`.agents/skills/<name>/`): transformed —
 *       * `disable-model-invocation: true` in SKILL.md frontmatter is the Claude
 *         way to say "the model must not auto-invoke this". Codex expresses the
 *         same intent with `policy.allow_implicit_invocation: false` in a separate
 *         `agents/openai.yaml` sidecar. We DROP the Claude key from the Codex
 *         SKILL.md and emit (or merge into) that sidecar. (The Claude key is
 *         always dropped from the Codex copy — Codex would ignore it — but the
 *         sidecar is only written when the value was `true`.)
 *       * Claude-only frontmatter keys (see CLAUDE_ONLY_KEYS) have no Codex
 *         equivalent; they are dropped from the Codex SKILL.md with a warning.
 *       * Everything else (body, supporting files, spec-portable frontmatter)
 *         copies through byte-for-byte.
 *
 * The empirical ground truth for the Codex switch and sidecar path is in
 * docs/research/claude-vs-codex-skill-format.md and
 * docs/research/codex-skill-path-verification.md.
 *
 * Adaptation is FORWARD-ONLY: there is no de-adaptation path. A file this layer
 * synthesizes carries its bytes inline as `content`; materialize stages that
 * directly instead of streaming from a source path.
 *
 * @module adapt
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanSkillTree } from './input-policy.js';
import { parseFrontmatter, stripFrontmatterKeys } from './frontmatter.js';
import { warn } from './util.js';

/**
 * Claude-only SKILL.md frontmatter keys with no OpenAI Codex equivalent. When
 * materializing the Codex copy these are dropped (with a warning) — Codex would
 * ignore them and shipping them is misleading. `disable-model-invocation` is
 * handled SEPARATELY (transformed into the Codex policy sidecar, not merely
 * dropped) and is therefore not in this list.
 * See docs/research/claude-vs-codex-skill-format.md §C
 * ("Cannot be expressed for one agent (drop + warn)").
 */
const CLAUDE_ONLY_KEYS = [
  'when_to_use',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'hooks',
  'paths',
  'shell',
  'arguments',
  'argument-hint',
];

/** Repo-relative path (within a skill dir) of Codex's sidecar. */
const OPENAI_YAML_REL = 'agents/openai.yaml';

/** The Codex sidecar generated when Claude asked the model not to auto-invoke. */
const POLICY_SIDECAR = 'policy:\n  allow_implicit_invocation: false\n';

/**
 * Produce the list of files to materialize for `agent` from a source tree.
 * @param {string} sourceDir absolute path to the validated source skill dir
 * @param {string} agent agent id ('claude' | 'codex')
 * @returns {Promise<import('./input-policy.js').SkillFile[]>}
 */
export async function adaptForAgent(sourceDir, agent) {
  const files = await scanSkillTree(sourceDir);
  // Claude-native IS the central format: its copy is verbatim.
  if (agent !== 'codex') return files;
  return adaptForCodex(sourceDir, files);
}

/**
 * Codex materialization: rename/relocate the invocation switch and drop
 * Claude-only frontmatter.
 * @param {string} sourceDir
 * @param {import('./input-policy.js').SkillFile[]} files
 * @returns {Promise<import('./input-policy.js').SkillFile[]>}
 */
async function adaptForCodex(sourceDir, files) {
  const skill = path.basename(sourceDir);
  const skillFile = files.find((f) => f.rel === 'SKILL.md');
  if (!skillFile) return files; // no SKILL.md (validated upstream) — nothing to transform

  const raw = await fs.readFile(skillFile.abs, 'utf8');
  const { data } = parseFrontmatter(raw);

  /** @type {string[]} keys to strip from the Codex SKILL.md frontmatter */
  const drop = [];
  // "Model must not auto-invoke": always strip the Claude key from the Codex copy;
  // when it was `true`, re-express the intent as the Codex policy sidecar.
  const hasSwitch = Object.prototype.hasOwnProperty.call(data, 'disable-model-invocation');
  const suppressImplicit = hasSwitch && data['disable-model-invocation'] === 'true';
  if (hasSwitch) drop.push('disable-model-invocation');

  for (const key of CLAUDE_ONLY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      drop.push(key);
      warn(`codex adapt: skill "${skill}" drops Claude-only frontmatter key "${key}" (no Codex equivalent)`);
    }
  }

  // No frontmatter change and no sidecar to write → verbatim copy.
  if (drop.length === 0 && !suppressImplicit) return files;

  const out = files.map((f) => ({ ...f }));

  if (drop.length > 0) {
    replaceContent(out, 'SKILL.md', stripFrontmatterKeys(raw, drop));
  }

  if (suppressImplicit) {
    const existing = out.find((f) => f.rel === OPENAI_YAML_REL);
    if (existing) {
      // Merge into the author-provided sidecar — never clobber interface/deps.
      const base = existing.content ?? (await fs.readFile(existing.abs, 'utf8'));
      replaceContent(out, OPENAI_YAML_REL, mergeImplicitInvocationFalse(base));
    } else {
      out.push(contentFile(OPENAI_YAML_REL, POLICY_SIDECAR));
    }
  }

  return out;
}

/**
 * Attach synthesized bytes to an existing file entry (marks it for inline staging).
 * @param {import('./input-policy.js').SkillFile[]} files
 * @param {string} rel
 * @param {string} content
 */
function replaceContent(files, rel, content) {
  const f = files.find((x) => x.rel === rel);
  f.content = content;
  f.size = Buffer.byteLength(content);
}

/**
 * A file the adapter synthesizes from scratch (no source on disk).
 * @param {string} rel
 * @param {string} content
 * @returns {import('./input-policy.js').SkillFile}
 */
function contentFile(rel, content) {
  return { rel, abs: '', size: Buffer.byteLength(content), exec: false, content };
}

/**
 * Merge `policy.allow_implicit_invocation: false` into an existing Codex sidecar,
 * preserving every other section (interface, dependencies, …). Textual, block
 * style: update the value if the key already exists under a top-level `policy:`,
 * insert it into an existing policy block, or append a fresh policy block.
 * @param {string} yaml
 * @returns {string}
 */
function mergeImplicitInvocationFalse(yaml) {
  const nl = yaml.includes('\r\n') ? '\r\n' : '\n';
  const lines = yaml.split(/\r?\n/);
  const policyIdx = lines.findIndex((l) => /^policy:[ \t]*\r?$/.test(l));

  if (policyIdx === -1) {
    const trimmed = yaml.replace(/[\r\n]+$/, '');
    const prefix = trimmed === '' ? '' : trimmed + nl;
    return `${prefix}policy:${nl}  allow_implicit_invocation: false${nl}`;
  }

  for (let i = policyIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (!/^[ \t]/.test(lines[i])) break; // left the policy block
    const m = lines[i].match(/^([ \t]+)allow_implicit_invocation:/);
    if (m) {
      lines[i] = `${m[1]}allow_implicit_invocation: false`;
      return lines.join(nl);
    }
  }
  lines.splice(policyIdx + 1, 0, '  allow_implicit_invocation: false');
  return lines.join(nl);
}
