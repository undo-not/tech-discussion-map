const launchSecretPattern = /^[a-f0-9]{64}$/;
let cachedLaunchSecret = '';

export function consumeLocalLaunchSecret(location: Location = window.location, historyApi: History = window.history): string {
  if (cachedLaunchSecret) return cachedLaunchSecret;
  const parameters = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
  const candidate = parameters.get('techmap-launch') ?? '';
  if (!launchSecretPattern.test(candidate)) throw new Error('local-launch-secret-required');
  cachedLaunchSecret = candidate;
  historyApi.replaceState(null, '', `${location.pathname}${location.search}`);
  return cachedLaunchSecret;
}
