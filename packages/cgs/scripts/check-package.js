// Packs @hypercerts-org/cgs and installs the tarball, with @atproto/lex, into
// a consumer project outside the workspace, then checks that Node imports it,
// a TypeScript consumer typechecks, and Vite bundles it for the browser. This
// catches packaging errors (bad exports, missing files, workspace: specifiers)
// that the workspace hides. Needs network access for `pnpm install`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = readJson(path.join(packageRoot, 'package.json'))

/** @param {string} name */
const pinned = (name) => {
  const version = packageJson.devDependencies?.[name]
  if (!version) throw new Error(`check-package: ${name} must be a devDependency`)
  return version
}

// Child processes must not inherit the parent's npm and pnpm settings.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')),
)

const work = mkdtempSync(path.join(tmpdir(), 'hypercerts-cgs-consumer-'))
try {
  const tarball = packPackage(work)
  const consumer = createConsumer(work, tarball)
  checkNode(consumer)
  checkTypes(consumer)
  checkBrowserBuild(consumer)
  console.log('check-package: all consumer checks passed')
} finally {
  rmSync(work, { recursive: true, force: true })
}

/** @param {string} dest */
function packPackage(dest) {
  run('pnpm', ['pack', '--pack-destination', dest], packageRoot)
  const tarball = readdirSync(dest).find((file) => /^hypercerts-org-cgs-.*\.tgz$/.test(file))
  if (!tarball) throw new Error('check-package: no tarball produced for @hypercerts-org/cgs')

  const extracted = path.join(dest, 'extracted')
  mkdirSync(extracted)
  run('tar', ['-xzf', path.join(dest, tarball), '-C', extracted], dest)
  const packedManifest = readFileSync(path.join(extracted, 'package', 'package.json'), 'utf8')
  if (packedManifest.includes('workspace:')) {
    throw new Error('check-package: packed package still contains workspace: specifiers')
  }
  return path.join(dest, tarball)
}

/** @param {string} dir @param {string} tarball */
function createConsumer(dir, tarball) {
  const consumer = path.join(dir, 'consumer')
  mkdirSync(path.join(consumer, 'src'), { recursive: true })
  writeJson(path.join(consumer, 'package.json'), {
    name: 'consumer',
    private: true,
    type: 'module',
    dependencies: {
      '@hypercerts-org/cgs': `file:${tarball}`,
      '@atproto/lex': pinned('@atproto/lex'),
    },
    devDependencies: { typescript: pinned('typescript'), vite: pinned('vite') },
  })
  writeJson(path.join(consumer, 'tsconfig.json'), {
    compilerOptions: {
      target: 'es2022',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      lib: ['es2022', 'dom'],
    },
    include: ['src'],
  })
  run(
    'pnpm',
    ['install', '--ignore-workspace', '--no-frozen-lockfile', '--config.strict-dep-builds=false'],
    consumer,
  )
  return consumer
}

/** @param {string} consumer */
function checkNode(consumer) {
  const script = `import { app } from "@hypercerts-org/cgs";
if (app.certified.groups.membership.list.main.nsid !== "app.certified.groups.membership.list") throw new Error("membership.list");
if (app.certified.group.repo.putRecord.main.nsid !== "app.certified.group.repo.putRecord") throw new Error("repo.putRecord");`
  run('node', ['--input-type=module', '-e', script], consumer)
  console.log('check-package: Node imports the package')
}

/** @param {string} consumer */
function checkTypes(consumer) {
  writeFileSync(
    path.join(consumer, 'src', 'types.ts'),
    `import { Client } from "@atproto/lex";
import { app } from "@hypercerts-org/cgs";
const cgs = new Client("https://groups.example");
export async function memberships(): Promise<app.certified.groups.membership.list.GroupMembership[]> {
  const { groups } = await cgs.call(app.certified.groups.membership.list, { limit: 50 });
  return groups;
}
export async function write() {
  return cgs.call(app.certified.group.repo.putRecord, {
    repo: "did:plc:abc123",
    collection: "app.certified.actor.profile",
    rkey: "self",
    record: { $type: "app.certified.actor.profile", displayName: "Example" },
    swapRecord: null,
  });
}
// @ts-expect-error repo, collection, rkey, and record are required
export const missing = () => cgs.call(app.certified.group.repo.putRecord, {});
`,
  )
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], consumer)
  console.log('check-package: a TypeScript consumer typechecks against the declarations')
}

/** @param {string} consumer */
function checkBrowserBuild(consumer) {
  writeFileSync(
    path.join(consumer, 'src', 'main.ts'),
    `import { Client } from "@atproto/lex";
import { app } from "@hypercerts-org/cgs";
const cgs = new Client("https://groups.example");
cgs.call(app.certified.groups.membership.list, { limit: 10 })
  .then(({ groups }) => console.log(groups.length), console.error);
`,
  )
  writeFileSync(
    path.join(consumer, 'index.html'),
    '<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>\n',
  )
  run('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], consumer)
  console.log('check-package: Vite bundles a query for the browser')
}

/** @param {string} command @param {string[]} args @param {string} cwd */
function run(command, args, cwd) {
  execFileSync(command, args, { cwd, env: childEnv, stdio: 'inherit', timeout: 300_000 })
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
