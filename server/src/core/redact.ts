// Best-effort scrubbing of secrets from strings that leave the server (errors, logs, details).

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED JWT]'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\b(sk|pk|rk|ghp|gho|ghs|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED TOKEN]'],
  [/(\w+:\/\/)[^\s:@/]+:[^\s@/]+@/g, '$1[REDACTED]@'],
  [
    /\b([\w.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|cookie|session)[\w.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;&]+)/gi,
    '$1$2[REDACTED]',
  ],
  [/([?&](?:token|key|secret|password|sig|signature|auth)=)[^&\s]+/gi, '$1[REDACTED]'],
];

export function redact(input: string): string {
  let s = input;
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

export function redactError(err: unknown, max = 300): string {
  const msg = err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? err.name}: ${err.message}` : String(err);
  return redact(msg).slice(0, max);
}

/** Shallow-sanitise a details object received from outside: primitives only, size-limited, redacted. */
export function sanitizeDetails(d: unknown, maxKeys = 12): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!d || typeof d !== 'object' || Array.isArray(d)) return out;
  for (const [k, v] of Object.entries(d).slice(0, maxKeys)) {
    if (!/^[\w.-]{1,40}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = redact(v).slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}
