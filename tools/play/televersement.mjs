/*
 * Téléverser l'AAB sur Google Play, depuis le dépôt.
 *
 * POURQUOI CET OUTIL EXISTE
 * -------------------------
 * `android-build.yml` produisait un AAB signé et s'arrêtait là : l'en-tête du
 * workflow disait « Ajouter l'étape d'envoi automatique quand le compte
 * existe ». Le compte organisation existe depuis le 10/09/2026, la clé de
 * téléversement aussi. Voici l'étape.
 *
 * CE QU'IL FAUT SAVOIR AVANT DE L'UTILISER, ET QUI NE SE CONTOURNE PAS
 * -------------------------------------------------------------------
 * L'API Play ne sait que MODIFIER une application qui a déjà reçu un binaire.
 * La documentation est explicite : il faut importer au moins un APK/AAB via la
 * Play Console avant de pouvoir s'en servir. Le tout PREMIER dépôt est donc
 * manuel, par construction — cet outil ne peut pas le faire, et aucun autre
 * non plus. De même, faire passer une application de « non publiée » à
 * « publiée » et remplir les déclarations légales restent des gestes de la
 * Console.
 *
 * PIÈGE À CONNAÎTRE : une modification (`edit`) ouverte est DÉTRUITE si
 * quelqu'un touche à l'application dans la Play Console pendant ce temps, et
 * ce sont les changements de la Console qui gagnent. Téléverser pendant qu'on
 * édite la fiche à la main fait donc perdre le téléversement, en silence.
 *
 * AUCUNE DÉPENDANCE. Node 22 sait signer du RS256 (`node:crypto`) et parler
 * HTTP (`fetch`). Ajouter googleapis pour trois appels REST ferait entrer un
 * arbre de dépendances entier dans un dépôt qui n'en a pas besoin — et cette
 * chaîne-là voit passer la clé du compte de service.
 *
 * MÊME DOCTRINE QUE tools/appstore/fiche.mjs
 * ------------------------------------------
 *   - Rien ne part sans `--appliquer`. Par défaut l'outil CONSTATE : il
 *     s'authentifie, ouvre une modification, relit les canaux existants, puis
 *     l'abandonne. C'est une vérification d'accès réelle qui ne change rien.
 *   - La clé du compte de service ne vient QUE de l'environnement
 *     (`PLAY_SERVICE_ACCOUNT_JSON`). Elle n'est jamais lue depuis un fichier du
 *     dépôt, jamais écrite, jamais affichée.
 *   - Le statut par défaut est `brouillon`. Publier pour de bon est une
 *     décision, pas une étape de build : `--statut=complet` doit être écrit.
 *
 * USAGE
 *   node tools/play/televersement.mjs --aab=<chemin> --canal=internal
 *   node tools/play/televersement.mjs --aab=<chemin> --canal=production --statut=complet --appliquer
 *
 * Options : --bundle=<id>     (défaut : appId de mobile/capacitor.config.json)
 *           --notes=<chemin>  (défaut : mobile/play/notes-de-version.json)
 *           --nom=<nom>      (défaut : « <versionCode> (MAJOR.MINOR.<versionCode>) »)
 */

import { createSign } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const API_ENVOI = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3';
const JETON = 'https://oauth2.googleapis.com/token';
const PORTEE = 'https://www.googleapis.com/auth/androidpublisher';

/* Les canaux que Play accepte. `interne` n'existe pas : le nom d'API est
   `internal`, et se tromper rend un 404 qui ne dit pas lequel des deux
   identifiants — application ou canal — est en cause. */
const CANAUX = ['internal', 'alpha', 'beta', 'production'];
const STATUTS = { brouillon: 'draft', complet: 'completed' };

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

/*
 * Le JWT d'un compte de service Google.
 *
 * SÉPARÉ DU RESTE POUR ÊTRE VÉRIFIABLE HORS LIGNE. La campagne App Store a
 * perdu une soirée sur une signature ES256 rendue au format DER (71 octets) là
 * où Apple attend du R||S (64) : l'erreur du serveur disait « invalid token »
 * et rien d'autre. Ici c'est du RS256, que `node:crypto` produit correctement,
 * mais le banc vérifie quand même la signature contre la clé publique — une
 * assertion hors ligne vaut mieux qu'un 401 sans explication.
 */
export function construireJwt(compte, maintenant = Math.floor(Date.now() / 1000)) {
  if (!compte || !compte.client_email || !compte.private_key) {
    throw new Error('Le compte de service doit porter client_email et private_key.');
  }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const entete = b64({ alg: 'RS256', typ: 'JWT' });
  const charge = b64({
    iss: compte.client_email,
    scope: PORTEE,
    aud: JETON,
    iat: maintenant,
    exp: maintenant + 3600,
  });
  const corps = entete + '.' + charge;
  const signature = createSign('RSA-SHA256').update(corps).sign(compte.private_key).toString('base64url');
  return corps + '.' + signature;
}

async function obtenirJeton(compte) {
  const reponse = await fetch(JETON, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: construireJwt(compte),
    }),
  });
  const texte = await reponse.text();
  if (!reponse.ok) {
    /* Le message de Google est utile ICI et nulle part ailleurs : « invalid_grant »
       veut dire horloge décalée ou clé révoquée, « unauthorized_client » veut
       dire que le compte de service n'a pas été invité dans la Play Console. */
    throw new Error('Jeton refusé (' + reponse.status + ') : ' + texte);
  }
  return JSON.parse(texte).access_token;
}

// ---------------------------------------------------------------------------
// Appels API
// ---------------------------------------------------------------------------

async function appel(jeton, url, options = {}) {
  const reponse = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + jeton, ...(options.headers || {}) },
  });
  const texte = await reponse.text();
  if (!reponse.ok) {
    throw new Error(options.method + ' ' + url.replace(/^https:\/\/[^/]+/, '') + ' -> ' + reponse.status + ' ' + texte);
  }
  return texte ? JSON.parse(texte) : {};
}

// ---------------------------------------------------------------------------
// Entrées
// ---------------------------------------------------------------------------

function opt(nom, defaut = null) {
  const prefixe = '--' + nom + '=';
  const trouve = process.argv.find((a) => a.startsWith(prefixe));
  return trouve ? trouve.slice(prefixe.length) : defaut;
}

function bundleDuProjet() {
  const chemin = join(RACINE, 'mobile', 'capacitor.config.json');
  if (!existsSync(chemin)) return null;
  try {
    return JSON.parse(readFileSync(chemin, 'utf8')).appId ?? null;
  } catch {
    return null;
  }
}

/*
 * Les notes de version, lues dans un fichier VERSIONNE.
 *
 * POURQUOI CE N'EST PAS UNE COMMODITE
 * -----------------------------------
 * `Edits.tracks.update` REMPLACE l'objet release en entier. Envoyer une release
 * sans `releaseNotes` ne « laisse pas les notes en place » : la release repart
 * SANS NOTES, et rien ne le signale. Le premier depot du 10/09/2026 l'aurait
 * constate en production — les notes saisies a la main dans la Console auraient
 * disparu au premier televersement automatique.
 *
 * Le fichier vit donc dans le depot, comme fiche.json pour Apple : ce qui part
 * sur la fiche se relit, se versionne, et se revoit en PR.
 *
 * Forme attendue : { "fr-FR": "texte", "en-US": "text" }
 * Play plafonne chaque langue a 500 caracteres et refuse le lot entier au-dela
 * sans dire laquelle : on mesure ici, pour que l'erreur nomme la langue.
 */
export function lireNotes(chemin) {
  if (!existsSync(chemin)) throw new Error('Notes de version introuvables : ' + chemin);
  let brut;
  try {
    brut = JSON.parse(readFileSync(chemin, 'utf8'));
  } catch (e) {
    throw new Error('Notes de version : JSON invalide (' + chemin + ') — ' + e.message);
  }
  const entrees = Object.entries(brut);
  if (!entrees.length) throw new Error('Notes de version : le fichier ne declare aucune langue.');
  return entrees.map(([language, text]) => {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Notes de version : la langue ' + language + ' n a pas de texte.');
    }
    if (text.length > 500) {
      throw new Error('Notes de version : ' + language + ' fait ' + text.length + ' caracteres, le plafond Play est 500.');
    }
    return { language, text };
  });
}

/*
 * Le NOM de la release, et la seule source de verite qui existe pour lui.
 *
 * CE QUE L'OMISSION A COUTE. Le premier televersement automatique du
 * 10/09/2026 a bien depose le bundle 7036, mais la release a garde le nom
 * « 7033 (1.1.7033) » — celui du depot manuel precedent. `tracks.update`
 * remplace l'objet release ; sans `name`, Play conserve l'ancien plutot que
 * d'en generer un. Il a fallu corriger a la main dans la Console, et toute
 * version suivante serait repartie avec le nom de la precedente.
 *
 * ON NE REINVENTE PAS LA NUMEROTATION. mobile/android/version.gradle compose
 * deja `versionName = MAJOR.MINOR.<nombre de commits>` en lisant MAJOR.MINOR
 * dans conf/version.php — la meme regle que tools/deploy-vps.sh pour le web.
 * On relit donc CE fichier, plutot que de coder « 1.1 » en dur ici : deux
 * sources finiraient par diverger, et c'est le genre d'ecart qui ne se voit
 * que sur la fiche publiee.
 */
export function versionMajeureMineure(chemin) {
  if (!existsSync(chemin)) throw new Error('VERSION introuvable : ' + chemin);
  const brut = readFileSync(chemin, 'utf8').trim();
  const trouve = /^([0-9]+)\.([0-9]+)/.exec(brut);
  if (!trouve) throw new Error('VERSION illisible (attendu MAJEUR.MINEUR) : ' + brut);
  return trouve[1] + '.' + trouve[2];
}

/* Le format que la Console genere elle-meme : « 7036 (1.1.7036) ». Le champ
   est plafonne a 50 caracteres cote Console ; au-dela on refuse ici plutot que
   de laisser Play tronquer ou rejeter. */
export function composerNom(versionCode, versionName) {
  const nom = String(versionCode) + ' (' + versionName + ')';
  if (nom.length > 50) {
    throw new Error('Nom de release trop long (' + nom.length + ' > 50) : ' + nom);
  }
  return nom;
}

/* Le fichier est-il un AAB plausible ? Un chemin qui existe ne prouve rien :
   un artefact tronqué, ou le mauvais fichier ramassé par `find`, se
   téléverserait et serait rejeté par Play bien plus tard. Un AAB est un ZIP,
   donc commence par « PK\x03\x04 ». */
export function verifierAab(chemin) {
  if (!existsSync(chemin)) throw new Error('AAB introuvable : ' + chemin);
  const taille = statSync(chemin).size;
  const tete = readFileSync(chemin).subarray(0, 4);
  if (!(tete[0] === 0x50 && tete[1] === 0x4b && tete[2] === 0x03 && tete[3] === 0x04)) {
    throw new Error('Ce fichier n’est pas une archive ZIP, donc pas un AAB : ' + chemin);
  }
  return taille;
}

// ---------------------------------------------------------------------------
// Programme
// ---------------------------------------------------------------------------

async function principal() {
  const brut = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!brut || !brut.trim()) {
    console.error('PLAY_SERVICE_ACCOUNT_JSON absent. C’est la cle JSON du compte de service,');
    console.error('fournie par l’environnement et jamais par un fichier du depot.');
    process.exit(1);
  }
  let compte;
  try {
    compte = JSON.parse(brut);
  } catch {
    console.error('PLAY_SERVICE_ACCOUNT_JSON n’est pas du JSON valide.');
    console.error('Le secret doit contenir le fichier ENTIER, accolades comprises.');
    process.exit(1);
  }

  const chemin = opt('aab');
  if (!chemin) { console.error('--aab=<chemin> est obligatoire.'); process.exit(1); }
  const canal = opt('canal');
  if (!CANAUX.includes(canal)) {
    console.error('--canal doit valoir : ' + CANAUX.join(', ') + ' (recu : ' + canal + ')');
    process.exit(1);
  }
  const statutDemande = opt('statut', 'brouillon');
  if (!Object.prototype.hasOwnProperty.call(STATUTS, statutDemande)) {
    console.error('--statut doit valoir : ' + Object.keys(STATUTS).join(' ou '));
    process.exit(1);
  }
  const statut = STATUTS[statutDemande];
  const bundle = opt('bundle') ?? bundleDuProjet();
  if (!bundle) { console.error('Application non identifiee : passer --bundle=<id>.'); process.exit(1); }
  const appliquer = process.argv.includes('--appliquer');
  const cheminNotes = opt('notes', join(RACINE, 'mobile', 'play', 'notes-de-version.json'));
  const notes = existsSync(cheminNotes) ? lireNotes(cheminNotes) : null;

  /* LA BASE DU NOM SE RESOUT ICI, AVANT LE PREMIER APPEL RESEAU. Le
     versionCode n'arrive qu'avec la reponse de l'envoi ; la partie
     MAJOR.MINOR, elle, se lit tout de suite. Echouer maintenant sur un
     conf/version.php illisible vaut mieux qu'echouer apres avoir televerse un
     bundle qu'on ne rattacherait a rien. `--nom=` reste l'echappatoire pour
     qui lance l'outil hors du depot. */
  const nomImpose = opt('nom');
  let baseVersion = null;
  if (!nomImpose) {
    try {
      baseVersion = versionMajeureMineure(join(RACINE, 'VERSION'));
    } catch (e) {
      console.error('Nom de release indeterminable : ' + e.message);
      console.error('Passer --nom=<nom> si l’outil tourne hors du depot.');
      process.exit(1);
    }
  }

  const taille = verifierAab(chemin);
  console.log('application : ' + bundle);
  console.log('AAB         : ' + chemin + ' (' + taille + ' octets)');
  console.log('canal       : ' + canal + ', statut ' + statutDemande + ' (' + statut + ')');
  console.log('mode        : ' + (appliquer ? 'APPLIQUER' : 'constat seul, rien ne sera envoye'));
  if (notes) {
    console.log('notes       : ' + notes.map((n) => n.language + ' (' + n.text.length + ' car.)').join(', '));
  } else {
    /* Un avertissement, pas un refus : deployer sans notes est legitime.
       Mais l'EFFACEMENT doit etre dit, sinon il passe pour un oubli de Play. */
    console.log('notes       : AUCUNE (' + cheminNotes + ' absent)');
    console.log('              ATTENTION : la release partira SANS notes de version,');
    console.log('              et celles deja saisies dans la Console seront EFFACEES.');
  }

  const jeton = await obtenirJeton(compte);
  console.log('compte de service authentifie : ' + compte.client_email);

  const edition = await appel(jeton, API + '/applications/' + bundle + '/edits', { method: 'POST' });
  console.log('modification ouverte : ' + edition.id);

  try {
    if (!appliquer) {
      const canaux = await appel(jeton, API + '/applications/' + bundle + '/edits/' + edition.id + '/tracks', { method: 'GET' });
      for (const t of canaux.tracks ?? []) {
        const versions = (t.releases ?? []).flatMap((r) => r.versionCodes ?? []);
        console.log('  canal ' + t.track + ' : ' + (versions.length ? versions.join(', ') : 'aucune version'));
      }
      console.log('\nConstat termine. Relancer avec --appliquer pour televerser.');
      return;
    }

    /* L'ENVOI REND LE versionCode, ON NE LE DEVINE PAS. Le lire dans le journal
       Gradle ou dans le manifeste du bundle serait une seconde source de
       vérité ; celle-ci est celle que Play a réellement enregistrée. */
    const envoye = await appel(
      jeton,
      API_ENVOI + '/applications/' + bundle + '/edits/' + edition.id + '/bundles?uploadType=media',
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: readFileSync(chemin) }
    );
    console.log('AAB televerse : versionCode ' + envoye.versionCode + ', sha256 ' + (envoye.sha256 ?? '?'));

    const nom = nomImpose ?? composerNom(envoye.versionCode, baseVersion + '.' + envoye.versionCode);

    /*
     * ON REGARDE CE QU'ON S'APPRETE A ECRASER.
     *
     * `tracks.update` remplace l'objet release ENTIER. La ressource Release en
     * compte sept champs (name, versionCodes, releaseNotes, status,
     * userFraction, countryTargeting, inAppUpdatePriority) ; cet outil en
     * envoie quatre. Les trois autres repartent donc a leur valeur par defaut,
     * sans que Play ne le signale — c'est exactement ainsi que les notes de
     * version avaient disparu.
     *
     * Aucun de ces trois ne s'applique a QZR aujourd'hui : le deploiement
     * progressif (`userFraction`) suppose un statut `inProgress`, le ciblage
     * par pays PAR RELEASE aussi (les 177 pays de QZR sont regles au niveau du
     * CANAL, ce que cet appel ne touche pas), et `inAppUpdatePriority` vaut 0.
     * Mais « aujourd'hui » n'est pas une garantie : on relit le canal et on
     * DIT ce qui va etre perdu, plutot que de le decouvrir en production.
     *
     * `versionCodes` merite la meme attention : la documentation precise qu'il
     * « doit inclure les codes de version a conserver des versions
     * precedentes ». QZR ne publie qu'un seul bundle, donc en remplacer la
     * liste est correct ; un jour ou il y en aurait plusieurs, ce ne le serait
     * plus.
     */
    try {
      const avant = await appel(jeton, API + '/applications/' + bundle + '/edits/' + edition.id + '/tracks/' + canal, { method: 'GET' });
      for (const r of avant.releases ?? []) {
        const perdus = [];
        if (r.userFraction !== undefined) perdus.push('userFraction=' + r.userFraction);
        if (r.countryTargeting !== undefined) perdus.push('countryTargeting');
        if (r.inAppUpdatePriority) perdus.push('inAppUpdatePriority=' + r.inAppUpdatePriority);
        const autresCodes = (r.versionCodes ?? []).filter((c) => String(c) !== String(envoye.versionCode));
        if (autresCodes.length) perdus.push('versionCodes retires : ' + autresCodes.join(', '));
        if (perdus.length) {
          console.log('ATTENTION : la release « ' + (r.name ?? '?') + ' » perd ' + perdus.join(' ; '));
        }
      }
    } catch {
      /* Un canal encore vide rend 404 : il n'y a rien a ecraser, donc rien a
         dire. On ne fait pas echouer un televersement pour un avertissement. */
    }

    await appel(jeton, API + '/applications/' + bundle + '/edits/' + edition.id + '/tracks/' + canal, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track: canal,
        releases: [{
          name: nom,
          versionCodes: [String(envoye.versionCode)],
          status: statut,
          ...(notes ? { releaseNotes: notes } : {}),
        }],
      }),
    });
    console.log('canal ' + canal + ' mis a jour en ' + statut + ', release nommee « ' + nom + ' »');

    await appel(jeton, API + '/applications/' + bundle + '/edits/' + edition.id + ':commit', { method: 'POST' });
    console.log('modification validee.');
    if (statut === 'draft') {
      console.log('\nLa version est en BROUILLON : elle attend une publication depuis la Play Console.');
    }
  } catch (erreur) {
    /* On abandonne la modification plutôt que de la laisser ouverte. Un `edit`
       en suspens n'est pas grave en soi — il expire — mais il empêche de voir
       clair, et un second essai en ouvrirait un autre. */
    try {
      await appel(jeton, API + '/applications/' + bundle + '/edits/' + edition.id, { method: 'DELETE' });
      console.error('modification ' + edition.id + ' abandonnee.');
    } catch { /* l'échec initial reste le message utile */ }
    throw erreur;
  }
}

/* Le module est importable par le banc sans rien exécuter : seule une invocation
   directe lance le programme. */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  principal().catch((erreur) => {
    console.error('\nECHEC : ' + erreur.message);
    process.exit(1);
  });
}
