/*
 * Assemble www/ — les fichiers embarques dans l'app native.
 *
 * Tap No Stress est un jeu d'un seul fichier : il n'y a AUCUN code serveur a
 * exclure, contrairement a une app classique. On copie donc une liste blanche
 * explicite plutot que de pointer Capacitor sur la racine — non par peur de
 * fuiter un secret (il n'y en a pas), mais pour que le bundle natif ne
 * contienne QUE ce que la page charge vraiment, et rien d'incident.
 *
 * Usage : npm run build:web
 */
import { cp, rm, mkdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WWW = join(HERE, 'www');

// Ce que la page charge : le jeu, le manifeste PWA, le service worker et les
// icones. C'est tout ce qui existe cote client.
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js'];
const DIRS = ['icons'];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  await rm(WWW, { recursive: true, force: true });
  await mkdir(WWW, { recursive: true });

  for (const f of FILES) {
    const src = join(REPO, f);
    if (!(await exists(src))) {
      console.error(`::error:: fichier attendu absent : ${f}`);
      process.exit(1);
    }
    await cp(src, join(WWW, f));
    console.log(`  + ${f}`);
  }

  for (const d of DIRS) {
    const src = join(REPO, d);
    if (!(await exists(src))) {
      console.error(`::error:: repertoire attendu absent : ${d}`);
      process.exit(1);
    }
    await cp(src, join(WWW, d), { recursive: true });
    console.log(`  + ${d}/`);
  }

  console.log('www/ assemble.');
}

main().catch((e) => { console.error(e); process.exit(1); });
