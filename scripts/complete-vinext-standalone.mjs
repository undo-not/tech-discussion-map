import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(repositoryRoot, 'app');
const targetNodeModules = join(appRoot, 'dist', 'standalone', 'node_modules');
const resolver = createRequire(join(appRoot, 'package.json'));
const requiredPeers = ['react', 'react-dom', 'react-server-dom-webpack'];

function readPackage(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolvePackageJson(packageName, packageResolver) {
  try { return packageResolver.resolve(`${packageName}/package.json`); }
  catch {
    const entry = packageResolver.resolve(packageName);
    let directory = dirname(entry);
    for (;;) {
      const candidate = join(directory, 'package.json');
      if (existsSync(candidate) && readPackage(candidate).name === packageName) return candidate;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error(`Unable to resolve standalone runtime package: ${packageName}`);
  }
}

if (!existsSync(targetNodeModules)) throw new Error('Vinext standalone output is missing.');
const queue = requiredPeers.map((name) => ({ name, resolver, optional: false }));
const copied = new Set();
while (queue.length > 0) {
  const current = queue.shift();
  if (!current || copied.has(current.name)) continue;
  let packageJson;
  try { packageJson = resolvePackageJson(current.name, current.resolver); }
  catch (error) {
    if (current.optional) continue;
    throw error;
  }
  const sourceRoot = dirname(realpathSync(packageJson));
  const metadata = readPackage(join(sourceRoot, 'package.json'));
  const destination = join(targetNodeModules, current.name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(sourceRoot, destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (source) => !relative(sourceRoot, source).split(/[\\/]/).includes('node_modules'),
  });
  copied.add(current.name);
  const childResolver = createRequire(join(sourceRoot, 'package.json'));
  const optionalDependencies = new Set(Object.keys(metadata.optionalDependencies ?? {}));
  for (const name of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies })) {
    queue.push({ name, resolver: childResolver, optional: optionalDependencies.has(name) });
  }
}

for (const packageName of requiredPeers) {
  if (!existsSync(join(targetNodeModules, packageName, 'package.json'))) throw new Error(`Standalone runtime package is missing after completion: ${packageName}`);
}
process.stdout.write(`Completed Vinext standalone runtime dependencies: ${[...copied].sort().join(', ')}\n`);
