#!/usr/bin/env node
/**
 * Build the offline release bundle (11 §2) for the platform this runs on.
 *
 *   node scripts/build-bundle.mjs --node-dist <extracted official Node.js> [--version 1.2.3] [--out release] [--winsw WinSW-x64.exe] [--skip-build]
 *
 * The bundle carries its own Node.js, production node_modules only, the Prisma
 * engines and migrations, service definitions and install scripts, an SBOM,
 * third-party licences, and SHA256SUMS. Nothing is downloaded on site.
 *
 * Build on the same OS family as the target (Prisma's engines and the serial
 * module are platform-specific). Two builds of the same commit at the same
 * path with the same SOURCE_DATE_EPOCH give the same SHA256SUMS.
 * Signing SHA256SUMS (11 §2 "SHA256SUMS.sig") uses the release key, which is
 * not in CI; it is a separate, manual step.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const die = (msg) => {
  console.error(`build-bundle: ${msg}`);
  process.exit(1);
};
const run = (cmd, argv, cwd, env = {}) => execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env }, shell: process.platform === 'win32' && cmd === 'npm' }).toString();

const plat = platform();
const cpu = arch();
if (!['linux', 'win32'].includes(plat)) die(`unsupported build platform ${plat}`);
const nodeDist = args['node-dist'] ? resolve(args['node-dist']) : die('--node-dist <dir> is required (an extracted official Node.js release)');
const nodeBin = plat === 'win32' ? join(nodeDist, 'node.exe') : join(nodeDist, 'bin', 'node');
if (!existsSync(nodeBin)) die(`${nodeBin} not found`);
const bundledNode = execFileSync(nodeBin, ['--version']).toString().trim();
// npm ci below runs install scripts with this Node, so it must be the same version that ships.
if (bundledNode !== process.version) die(`bundled Node is ${bundledNode} but the builder runs ${process.version}; use the same version`);

const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? run('git', ['log', '-1', '--format=%ct'], repo).trim());
const commit = run('git', ['rev-parse', 'HEAD'], repo).trim();
const version = args.version ?? JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
if (!/^[0-9A-Za-z.+-]+$/.test(version)) die(`bad version ${version}`);
const platName = plat === 'win32' ? 'win' : plat;
const name = `lims-middleware-${version}-${platName}-${cpu}`;
const outDir = resolve(args.out ?? join(repo, 'release'));
const root = join(outDir, name);
const app = join(root, 'app');

console.log(`Building ${name} (commit ${commit.slice(0, 12)}, Node ${bundledNode})`);
if (args['skip-build'] !== 'true') run('npm', ['run', 'build'], repo);

rmSync(root, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

// 1. Application: compiled packages only, as each package's "files" lists them.
cpSync(join(repo, 'package.json'), join(app, 'package.json'));
cpSync(join(repo, 'package-lock.json'), join(app, 'package-lock.json'));
for (const dir of readdirSync(join(repo, 'packages')).sort()) {
  const src = join(repo, 'packages', dir);
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  const dest = join(app, 'packages', dir);
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, 'package.json'), join(dest, 'package.json'));
  for (const f of pkg.files ?? []) {
    if (!existsSync(join(src, f))) die(`${pkg.name}: "${f}" listed in files but missing (did the build run?)`);
    cpSync(join(src, f), join(dest, f), { recursive: true, filter: (p) => !p.endsWith('.tsbuildinfo') });
  }
}

// 2. Production dependencies from the committed lockfile, and the Prisma client for this platform.
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], app, { PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1' });
run(process.execPath, [join(app, 'node_modules', 'prisma', 'build', 'index.js'), 'generate', '--schema', join(app, 'packages', 'db', 'prisma', 'schema.prisma')], app, { CHECKPOINT_DISABLE: '1' });

// 3. Native serial module: only a prebuilt binary for this exact target, never a local compile (11 §2).
const prebuild = join(app, 'node_modules', '@serialport', 'bindings-cpp', 'prebuilds', `${plat}-${cpu}`);
if (!existsSync(prebuild)) die(`no @serialport/bindings-cpp prebuild for ${plat}-${cpu}`);
rmSync(join(app, 'node_modules', '@serialport', 'bindings-cpp', 'build'), { recursive: true, force: true });

// 4. SBOM from the lockfile, with fixed timestamp and serial so it is reproducible.
const sbom = JSON.parse(run('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev', '--package-lock-only'], app));
sbom.metadata.timestamp = new Date(epoch * 1000).toISOString();
const sbomHash = createHash('sha256').update(`${commit}:${plat}-${cpu}`).digest('hex');
sbom.serialNumber = `urn:uuid:${sbomHash.slice(0, 8)}-${sbomHash.slice(8, 12)}-4${sbomHash.slice(13, 16)}-8${sbomHash.slice(17, 20)}-${sbomHash.slice(20, 32)}`;
writeFileSync(join(root, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);

// 5. Replace workspace links with real copies, so the bundle has no symlinks or junctions.
const lisDir = join(app, 'node_modules', '@lis');
for (const n of readdirSync(lisDir)) {
  const link = join(lisDir, n);
  if (!lstatSync(link).isSymbolicLink()) continue;
  const real = realpathSync(link);
  rmSync(link, { recursive: true, force: true });
  cpSync(real, link, { recursive: true, dereference: true });
}
rmSync(join(app, 'packages'), { recursive: true, force: true });
const stray = [];
(function scan(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isSymbolicLink()) stray.push(relative(root, p));
    else if (e.isDirectory()) scan(p);
  }
})(app);
// npm's own .bin shims are symlinks on Linux; nothing on site uses them.
for (const s of stray) {
  if (s.split(sep).includes('.bin')) rmSync(join(root, s), { force: true });
  else die(`unexpected symlink in bundle: ${s}`);
}

// 6. Third-party licence texts.
const licenses = join(root, 'licenses');
(function collect(nm) {
  if (!existsSync(nm)) return;
  for (const e of readdirSync(nm).sort()) {
    if (e.startsWith('.')) continue;
    const dirs = e.startsWith('@') ? readdirSync(join(nm, e)).map((s) => join(e, s)) : [e];
    for (const d of dirs) {
      const pkgDir = join(nm, d);
      if (!existsSync(join(pkgDir, 'package.json'))) continue;
      const files = readdirSync(pkgDir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f));
      for (const f of files) {
        mkdirSync(join(licenses, d), { recursive: true });
        cpSync(join(pkgDir, f), join(licenses, d, f));
      }
      collect(join(pkgDir, 'node_modules'));
    }
  }
})(join(app, 'node_modules'));

// 7. Node.js runtime: the binary and its licence only.
const runtime = join(root, 'runtime', 'node');
if (plat === 'win32') {
  mkdirSync(runtime, { recursive: true });
  cpSync(nodeBin, join(runtime, 'node.exe'));
} else {
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  cpSync(nodeBin, join(runtime, 'bin', 'node'));
}
cpSync(join(nodeDist, 'LICENSE'), join(licenses, 'node.js', 'LICENSE'), { recursive: true });

// 8. Services, CLI wrappers, install scripts, example config.
const pk = join(repo, 'packaging');
mkdirSync(join(root, 'service'));
mkdirSync(join(root, 'bin'));
mkdirSync(join(root, 'scripts'));
mkdirSync(join(root, 'config'));
cpSync(join(pk, 'common', 'lims.env.example'), join(root, 'config', 'lims.env.example'));
if (plat === 'win32') {
  for (const f of ['lims-web.xml', 'lims-jobs.xml', 'lims-analyzer.xml.template']) cpSync(join(pk, 'windows', f), join(root, 'service', f));
  for (const f of ['lims.cmd', 'lims-web.cmd']) cpSync(join(pk, 'windows', f), join(root, 'bin', f));
  cpSync(join(pk, 'windows', 'install.ps1'), join(root, 'scripts', 'install.ps1'));
  if (args.winsw) cpSync(resolve(args.winsw), join(root, 'service', 'WinSW-x64.exe'));
  else console.warn('warning: no --winsw given; install.ps1 needs service\\WinSW-x64.exe');
} else {
  for (const f of ['lims-web.service', 'lims-jobs.service', 'lims-analyzer@.service']) cpSync(join(pk, 'linux', f), join(root, 'service', f));
  for (const f of ['lims', 'lims-web']) cpSync(join(pk, 'linux', f), join(root, 'bin', f));
  cpSync(join(pk, 'linux', 'install.sh'), join(root, 'scripts', 'install.sh'));
}

// 9. Manifest, then checksums over every file.
const migrations = readdirSync(join(app, 'node_modules', '@lis', 'db', 'prisma', 'migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
writeFileSync(
  join(root, 'manifest.json'),
  `${JSON.stringify({ name: 'lims-middleware', version, commit, platform: plat, arch: cpu, node: bundledNode, migrations, builtAt: new Date(epoch * 1000).toISOString() }, null, 2)}\n`,
);
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(relative(root, p).split(sep).join('/'));
  }
})(root);
files.sort();
const sums = files.map((f) => `${createHash('sha256').update(readFileSync(join(root, f))).digest('hex')}  ${f}`).join('\n');
writeFileSync(join(root, 'SHA256SUMS'), `${sums}\n`);

// Fixed modification times, so the archive does not depend on when it was built.
const t = new Date(epoch * 1000);
(function touch(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) touch(p);
    utimesSync(p, t, t);
  }
})(root);
utimesSync(root, t, t);

// 10. Archive (Linux): sorted entries, fixed owner and time, gzip without a timestamp.
if (plat === 'linux') {
  const tgz = join(outDir, `${name}.tar.gz`);
  execFileSync('sh', ['-c', `tar --sort=name --mtime=@${epoch} --owner=0 --group=0 --numeric-owner -cf - "${name}" | gzip -n -9 > "${tgz}"`], { cwd: outDir, stdio: 'inherit' });
  const h = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  writeFileSync(`${tgz}.sha256`, `${h}  ${name}.tar.gz\n`);
  console.log(`Archive: ${tgz} (${(statSync(tgz).size / 1048576).toFixed(1)} MiB) sha256 ${h}`);
}
console.log(`Bundle: ${root} (${files.length} files)`);
