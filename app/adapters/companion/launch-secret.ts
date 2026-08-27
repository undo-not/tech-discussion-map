const launchSecretPattern = /^[a-f0-9]{64}$/;
let cachedLaunchSecret: Promise<string> | null = null;

export function getLocalLaunchSecret(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (cachedLaunchSecret) return cachedLaunchSecret;
  cachedLaunchSecret = fetchImpl('/api/local-launch', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request: 'local-launch-secret' }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`local-launch-${response.status}`);
    const value = await response.json() as { launchSecret?: unknown };
    if (typeof value.launchSecret !== 'string' || !launchSecretPattern.test(value.launchSecret)) throw new Error('local-launch-invalid-secret');
    return value.launchSecret;
  }).catch((error) => {
    cachedLaunchSecret = null;
    throw error;
  });
  return cachedLaunchSecret;
}
