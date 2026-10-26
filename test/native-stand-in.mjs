/**
 * Copies of the package with something resolvable at `./packvium-native.node`, for tests
 * that must watch `index.js` decide at load time whether to use an addon.
 *
 * Shared by `force-fallback.test.mjs` and `native-binding.test.mjs`: a copy is built from
 * the manifest's `files` rather than a hand-written list, because a hand-written copy
 * silently stops being a copy of the package the day a module is added.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'));

/** The version a stand-in reports unless told otherwise: the one this package ships at. */
export const PACKAGE_VERSION = MANIFEST.version;

function packageCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packvium-native-stand-in-'));
  for (const name of MANIFEST.files.filter((file) => file.endsWith('.js'))) {
    fs.copyFileSync(path.join(PACKAGE, name), path.join(root, name));
  }
  // A declared directory of modules the entry point imports, such as `result-validation/`;
  // `examples/` only imports the package and is left out.
  const isModuleDirectory = (file) => file !== 'examples' && fs.existsSync(path.join(PACKAGE, file))
    && fs.statSync(path.join(PACKAGE, file)).isDirectory();
  for (const name of MANIFEST.files.filter(isModuleDirectory)) {
    fs.cpSync(path.join(PACKAGE, name), path.join(root, name), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  return root;
}

/**
 * A copy whose addon is plain JavaScript, with `SUITE_VERSION` bound to `version` for its
 * source to report. It is a *directory* named `packvium-native.node`: a file ending in
 * `.node` is handed to `dlopen`, while a directory resolves through its `package.json` like
 * any package -- and `index.js` asks nothing of the addon that machine code would answer
 * differently.
 */
export function packageWithNativeStandIn(moduleSource, version = PACKAGE_VERSION) {
  const root = packageCopy();
  const addon = path.join(root, 'packvium-native.node');
  fs.mkdirSync(addon);
  fs.writeFileSync(path.join(addon, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  fs.writeFileSync(path.join(addon, 'index.cjs'),
    `const SUITE_VERSION = ${JSON.stringify(version)};\n${moduleSource}\n`);
  return root;
}

/** A copy with a real compiled addon (a built `cdylib`) beside it. */
export function packageWithNativeAddon(addonPath) {
  const root = packageCopy();
  fs.copyFileSync(addonPath, path.join(root, 'packvium-native.node'));
  return root;
}
