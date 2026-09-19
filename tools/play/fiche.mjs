/*
 * Fiche Play Store, pilotée par l'API Google Play (androidpublisher/edits).
 *
 * Pousse le TEXTE (titre, brève description, description complète) et les
 * IMAGES (icône 512, image de présentation 1024×500, captures) en une seule
 * transaction d'édition, puis la valide.
 *
 * POURQUOI PAR API PLUTÔT QUE LA CONSOLE : la console ouvre un sélecteur de
 * fichiers natif pour les images, impilotable en automatisation. L'API, elle,
 * dépose les octets directement.
 *
 * SECRET REQUIS : PLAY_SERVICE_ACCOUNT_JSON — la clé JSON d'un compte de
 * service Google Cloud (API « Google Play Developer » activée), invité dans
 * « Utilisateurs et autorisations » de la Play Console avec le droit de
 * modifier les fiches. Le même que qzr : un compte de service est autorisé au
 * niveau du COMPTE développeur, donc il vaut pour toutes ses applis.
 *
 * L'auth (JWT RS256 -> jeton OAuth) est reprise telle quelle de
 * tools/play/televersement.mjs.
 *
 * Usage :
 *   node tools/play/fiche.mjs              # constat : liste sans rien écrire
 *   node tools/play/fiche.mjs --appliquer  # écrit et valide l'édition
 */
import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const DEPOT = resolve(ICI, '..', '..');
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const ENVOI = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3';
const JETON = 'https://oauth2.googleapis.com/token';
const PORTEE = 'https://www.googleapis.com/auth/androidpublisher';
const APPLIQUER = process.argv.includes('--appliquer');

function construireJwt(compte, maintenant = Math.floor(Date.now() / 1000)) {
  if (!compte || !compte.client_email || !compte.private_key) {
    throw new Error('Le compte de service doit porter client_email et private_key.');
  }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const corps = b64({ alg: 'RS256', typ: 'JWT' }) + '.' +
    b64({ iss: compte.client_email, scope: PORTEE, aud: JETON, iat: maintenant, exp: maintenant + 3600 });
  return corps + '.' + createSign('RSA-SHA256').update(corps).sign(compte.private_key).toString('base64url');
}

async function obtenirJeton(compte) {
  const r = await fetch(JETON, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: construireJwt(compte) }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('Jeton refusé (' + r.status + ') : ' + t);
  return JSON.parse(t).access_token;
}

async function appel(jeton, url, options = {}) {
  const r = await fetch(url, { ...options, headers: { Authorization: 'Bearer ' + jeton, ...(options.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error((options.method || 'GET') + ' ' + url.replace(/^https:\/\/[^/]+/, '') + ' -> ' + r.status + ' ' + t);
  return t ? JSON.parse(t) : {};
}

const cfg = JSON.parse(await readFile(join(ICI, 'listing.json'), 'utf8'));
const pkg = cfg.package;

let compte;
try { compte = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON || ''); }
catch (e) { console.error('PLAY_SERVICE_ACCOUNT_JSON absent ou JSON invalide.'); process.exit(1); }

const jeton = await obtenirJeton(compte);
console.log('application :', pkg, APPLIQUER ? '(écriture)' : '(constat — --appliquer pour écrire)');

const edit = await appel(jeton, API + '/applications/' + pkg + '/edits', { method: 'POST' });
console.log('édition', edit.id);
const base = API + '/applications/' + pkg + '/edits/' + edit.id;

try {
  for (const [loc, l] of Object.entries(cfg.listings)) {
    console.log(`~ texte [${loc}] · titre="${l.title}" · brève=${l.shortDescription.length}c · complète=${l.fullDescription.length}c`);
    if (APPLIQUER) {
      await appel(jeton, base + '/listings/' + loc, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: loc, title: l.title, shortDescription: l.shortDescription, fullDescription: l.fullDescription, video: '' }),
      });
    }
  }

  const loc = Object.keys(cfg.listings)[0];
  for (const [type, val] of Object.entries(cfg.images)) {
    const fichiers = Array.isArray(val) ? val : [val];
    console.log(`~ images [${type}] : ${fichiers.length}`);
    if (APPLIQUER) {
      // On remplace : purge des images en ligne de ce type, puis dépôt.
      await appel(jeton, base + '/listings/' + loc + '/' + type, { method: 'DELETE' }).catch(() => {});
      for (const rel of fichiers) {
        const buf = await readFile(join(DEPOT, rel));
        const res = await appel(jeton, ENVOI + '/applications/' + pkg + '/edits/' + edit.id + '/listings/' + loc + '/' + type + '?uploadType=media', {
          method: 'POST', headers: { 'Content-Type': 'image/png' }, body: buf,
        });
        console.log('   + ' + rel.split('/').pop() + (res.image?.id ? '  (' + res.image.id + ')' : ''));
      }
    }
  }

  if (APPLIQUER) {
    // changesNotSentForReview=true : on VALIDE l'édition sans l'envoyer en revue.
    // Deux raisons. D'abord la philosophie de l'outil — préparer la fiche, pas la
    // soumettre. Ensuite, une NÉCESSITÉ pour une appli sans piste de production :
    // Google refuse alors d'« envoyer en revue » (le commit nu renvoie un 403
    // « The caller does not have permission » trompeur, alors que les droits sont
    // là — c'est l'état de l'appli, pas la permission). Les changements sont posés
    // et partiront en revue avec la première publication en production.
    await appel(jeton, base + ':commit?changesNotSentForReview=true', { method: 'POST' });
    console.log('édition validée ✓  (changements posés, non envoyés en revue) — visible sur Play sous ~1 h.');
  } else {
    await appel(jeton, base, { method: 'DELETE' });
    console.log('constat terminé — édition annulée (rien écrit).');
  }
} catch (e) {
  await appel(jeton, base, { method: 'DELETE' }).catch(() => {});
  console.error('ÉCHEC — ' + e.message);
  process.exit(1);
}
