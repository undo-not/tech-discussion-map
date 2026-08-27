import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const forbiddenExtensions = new Set(['.wav', '.mp3', '.m4a', '.webm', '.pcm', '.raw', '.transcript', '.bin']);
const forbiddenPathParts = [/(^|\/)recordings\//i, /(^|\/)sessions\//i, /(^|\/)data\/local\//i];
const secretPatterns = [
  { name: 'OpenAI-style API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { name: 'literal bearer credential', pattern: /\bBearer\s+[A-Za-z0-9._~-]{24,}\b/ },
];

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
for (const file of tracked) {
  if (forbiddenExtensions.has(extname(file).toLowerCase()) || forbiddenPathParts.some((pattern) => pattern.test(file))) {
    findings.push(`${file}: forbidden meeting-data or model path`);
    continue;
  }
  if (file === 'scripts/scan-public-repo.mjs') continue;
  const content = readFileSync(file, 'utf8');
  for (const rule of secretPatterns) if (rule.pattern.test(content)) findings.push(`${file}: ${rule.name}`);
}

if (findings.length > 0) {
  process.stderr.write(`Public repository privacy scan failed:\n${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public repository privacy scan passed for ${tracked.length} tracked files.\n`);
}
