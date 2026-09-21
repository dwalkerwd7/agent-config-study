// Fake credential-shaped values for redact.test.ts, one per detector. Each is
// random characters generated for this file in the provider's format: none was
// ever issued, and none may be swapped for a real one. gitleaks flags them by
// design, and every flagged line has its own entry in .gitleaksignore keyed on
// this file's line numbers, so keep new code below the object, not inside it.
export const FAKE = {
  github: 'ghp_gwTJfRLOwtxU9wL88wmGDeKAQqGQ9TR9sRCQ',
  aws: 'AKIACF24RDTJVML5HHI3',
  anthropic:
    'sk-ant-api03-V0N9bhi1PbmQr-0YlK0TMoRdPc6RDzx6g9nA4QHFJraSLXajQ_Je834y2CRjnReX7p0B7stAVDEyDyHvKaogwc--3FkizAA',
  openai:
    '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',
  slack: 'xoxb-397244209406-7763027290499-W1GIgcr5hPogDR8cVpLroO9H',
  stripe: 'sk_live_jxrvlLuQ8URxELDJCNTX5utm',
  google: 'AIzaJOniT4TTaAbiRgZ5Eg_NDQWjo7wSxTK_X9c',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmaXh0dXJlIiwiaWF0IjoxNzAwMDAwMDAwfQ.m1msgmopF760BCtklofkyBr3n0ak0DFGiF66cFEV99B',
  pem: [
    '-----BEGIN PRIVATE KEY-----',
    'MIGHBWPA0MhRiDQ0o13m1JvUMLkQcaJbG338Z/SkiAvpYYN2BVB6S47IzOCzVfwq',
    '/JDQ+xpF+Uyj0fOVeug3zPGuI/z+iSCeabGw0FNTlMOArr+hMukFhomnu2gW98hV',
    'DoNMXRqpBRnkUgF929Hsmo90zqskoXw0txTivkIcnSGv6AWFqa24i5MK',
    '-----END PRIVATE KEY-----',
  ].join('\n'),
  // The value of a keyed literal: random, with no provider prefix of its own.
  keyedLiteral: 'pleYHHjnLTfJfcjN5dCXAqK4iKDjqjHf',
} as const;
