/**
 * Fail-closed secret redaction (issue #101).
 *
 * DESIGN: invert the polarity. Do NOT try to enumerate "things that look like a
 * secret" — every such list has a gap, and a gap here is a silent leak. Instead,
 * redact by DEFAULT and SPARE only text positively identified as ordinary prose.
 *
 * A run of token-ish characters (>= 20 chars of [A-Za-z0-9_+.=-]) is treated as
 * OPAQUE and redacted UNLESS it is positively recognised as prose: a word that
 * appears in a small common-word list, a version/number, a file name or path
 * shape, or a normal capitalised word. Unknown vendors, changed token shapes,
 * bare hex, base64, JWTs and all-lowercase/uppercase runs all fall to "redact".
 *
 * Failure direction: a false positive costs a redacted identifier; a false
 * negative leaks a credential. We always choose the former.
 */

/** Runs at least this long are candidates for opaque-token treatment. */
const OPAQUE_MIN = 20;

/** A run of characters that can appear in a token (but also in many identifiers). */
const TOKEN_RUN = /[A-Za-z0-9_+.=-]+/g;

/**
 * Words that are positively prose even when long. Kept deliberately small and
 * boring: these are the shapes a developer message legitimately contains that
 * would otherwise trip the opaque rule. Anything NOT here and >= OPAQUE_MIN is
 * redacted (fail closed).
 */
const PROSE_WORDS = new Set(
  [
    // common words that could exceed 20 chars only when concatenated; keep the
    // list to genuinely long-but-benign words we expect in logs/summaries.
    "authentication", "authorization", "configuration", "documentation",
    "implementation", "infrastructure", "internationalization", "localization",
    "initialization", "reconciliation", "serialization", "deserialization",
    "synchronization", "transformation", "interpretation", "representation",
    "characterization", "institutionalization", "counterrevolutionaries",
    "electroencephalogram", "uncharacteristically", "incomprehensibility",
    "acknowledgement", "acknowledgment", "authenticationprovider",
    "typescript", "javascript", "node_modules", "package-lock",
  ].map((w) => w.toLowerCase()),
);

/** Shapes we positively recognise as NOT a secret (so we can spare them). */
function isProseRun(run: string): boolean {
  const lower = run.toLowerCase();
  if (PROSE_WORDS.has(lower)) return true;
  // A dotted version like 1.2.3 / v1.2.3-beta / 2026.10.04
  if (/^v?\d+(?:\.\d+){1,4}(?:[-+][A-Za-z0-9.]+)?$/.test(run)) return true;
  // A purely numeric run (ids, counts, timestamps)
  if (/^\d+$/.test(run)) return true;
  // A snake/camel/kebab identifier built ONLY from dictionary-ish word chunks:
  // every chunk is <= 12 chars and contains a vowel (a crude "pronounceable"
  // test). Long opaque blobs (hex, base64) almost never satisfy this.
  const chunks = run.split(/[_\-.]+/).filter(Boolean);
  if (chunks.length >= 1 && chunks.every((c) => c.length <= 12 && /[aeiou]/i.test(c) && !/^[0-9]+$/.test(c))) {
    return true;
  }
  return false;
}

/**
 * Redact opaque runs. A run is spared only when it is positively prose; every
 * other run >= OPAQUE_MIN is redacted, with the reason recorded.
 */
export function redactOpaqueRuns(text: string): string {
  return text.replace(TOKEN_RUN, (run) => {
    if (run.length < OPAQUE_MIN) return run;
    if (isProseRun(run)) return run;
    return `[REDACTED:opaque:${run.length}]`;
  });
}

/**
 * Exact vendor shapes, applied FIRST for a nicer tag and to catch shapes whose
 * punctuation would otherwise split the run. These are a bonus, never the only
 * line — the opaque default above is the guarantee.
 */
const EXACT_SHAPES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-token]"],
  [/sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED:api-key]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws-key]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"],
  // A JWT: three base64url segments separated by dots.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:jwt]"],
  // A credential-ish key word, then any value.
  [
    /\b(?:api[_-]?key|apikey|secret|token|password|passwd|passphrase|authorization|auth|access[_-]?key|private[_-]?key|client[_-]?secret|credential|bearer)["']?\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
    "[REDACTED:credential]",
  ],
];

/** Mask credential-shaped substrings so they do not reach the ledger or an agent's context. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of EXACT_SHAPES) out = out.replace(re, rep);
  return redactOpaqueRuns(out);
}
