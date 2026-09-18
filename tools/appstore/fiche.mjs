/*
 * La fiche App Store, pilotée depuis le dépôt : captures et métadonnées.
 *
 * POURQUOI CET OUTIL EXISTE
 * -------------------------
 * Tout ce qui compose la fiche — description, mots-clés, nouveautés, captures,
 * coordonnées de vérification — se saisissait à la main dans App Store Connect.
 * Rien n'en restait dans le dépôt : impossible de relire ce qu'on a publié,
 * impossible de refaire la même fiche après un revers, et une soumission
 * refusée se corrigeait de mémoire. `fiche.json` porte désormais l'état voulu,
 * versionné avec le code, et cet outil le pousse.
 *
 * IL SE SERT DE LA CLÉ QUI EXISTE DÉJÀ. `ios-build.yml` téléverse les builds
 * avec `altool` et trois secrets — `APPSTORE_ISSUER_ID`, `APPSTORE_KEY_ID`,
 * `APPSTORE_PRIVATE_KEY`. Ce sont les mêmes ici, sous les mêmes noms : aucune
 * clé supplémentaire à créer, aucun secret à confier à qui que ce soit.
 *
 * CE QU'IL N'ÉCRIT JAMAIS
 * -----------------------
 *   - Le MOT DE PASSE du compte de démonstration. Il n'est ni exporté (il est
 *     remplacé par null même si l'API le renvoie), ni lu depuis `fiche.json`.
 *     Il se pose depuis la variable `APPSTORE_DEMO_MDP`, que celui qui lance la
 *     commande fournit lui-même ; sans elle le champ n'est pas touché. Un mot
 *     de passe n'a pas sa place dans un dépôt, fût-il privé.
 *   - Rien du tout sans `--appliquer`. Par défaut chaque commande CONSTATE et
 *     affiche l'écart ; c'est un aiguillage explicite qui écrit.
 *   - La soumission. `fiche.mjs` prépare la version, il ne l'envoie pas en
 *     vérification : c'est une décision, pas une étape de build.
 *
 * CE QU'IL VÉRIFIE AVANT D'ENVOYER, ET POURQUOI
 * ---------------------------------------------
 *   - Les LIMITES de longueur (nom 30, sous-titre 30, mots-clés 100, texte
 *     promotionnel 170, description et nouveautés 4000). Dépassées, l'API rend
 *     une erreur générique où l'on ne voit pas quel champ est en cause.
 *   - Les DIMENSIONS réelles des captures, relues dans l'en-tête PNG. Un rendu
 *     à la mauvaise taille est déjà arrivé (980×2125 au lieu de 1290×2796,
 *     faute d'une balise viewport) : le fichier est un PNG valide, seule la
 *     mesure le démasque. Les tailles acceptées se déclarent dans `fiche.json`
 *     — on ne code pas en dur une table d'Apple qui bouge.
 *   - La COUCHE ALPHA. Les captures produites par `capture.js` sortent en RGB
 *     (type couleur 2, mesuré), mais une source retouchée peut arriver en RGBA
 *     et Apple refuse la transparence. On avertit sans bloquer : c'est un
 *     refus côté Apple, pas une certitude côté outil.
 *   - L'ÉTAT DE LIVRAISON de chaque capture après envoi. L'API répond 201 puis
 *     traite l'image de son côté ; un échec ne se voit qu'en interrogeant
 *     `assetDeliveryState`. Sans cette attente, on croit avoir déposé.
 *
 * USAGE
 *   node tools/appstore/fiche.mjs etat
 *   node tools/appstore/fiche.mjs exporter            # écrit fiche.json depuis l'existant
 *   node tools/appstore/fiche.mjs metadonnees [--appliquer]
 *   node tools/appstore/fiche.mjs captures [--remplacer] [--appliquer]
 *
 * Options : --fiche=<chemin>  --version=<1.0>  --langue=<fr-FR>  --bundle=<id>
 *
 * Sans `--bundle` ni `fiche.json`, l'app est identifiée par l'`appId` de
 * `mobile/capacitor.config.json` — le fichier qui la nomme déjà pour iOS.
 *
 * Il n'y a pas de `fiche.json` livré avec l'outil, et c'est délibéré : un
 * gabarit rempli de valeurs plausibles finirait par être appliqué tel quel.
 * `exporter` le fabrique depuis ce que le compte contient vraiment.
 */
import { createHash, createSign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const DEPOT = resolve(ICI, '..', '..');
const API = 'https://api.appstoreconnect.apple.com';

const args = process.argv.slice(2);
const commande = args.find((a) => !a.startsWith('-'));
const opt = (nom, defaut = null) => {
  const t = args.find((a) => a.startsWith(`--${nom}=`));
  return t ? t.slice(nom.length + 3) : defaut;
};
const drapeau = (nom) => args.includes(`--${nom}`);

const APPLIQUER = drapeau('appliquer');
const FICHE = resolve(opt('fiche', join(ICI, 'fiche.json')));

/* Longueurs maximales imposées par App Store Connect. Elles sont ici parce
   qu'un dépassement ne rend pas « champ trop long » mais une erreur de
   validation d'entité, sans nommer le champ. */
const LIMITES = {
  name: 30, subtitle: 30, keywords: 100, promotionalText: 170,
  description: 4000, whatsNew: 4000,
};

/* ------------------------------------------------------------------ auth */

function clePrivee() {
  const fichier = process.env.APPSTORE_PRIVATE_KEY_FILE;
  if (fichier) return readFileSync(fichier, 'utf8');
  const brut = process.env.APPSTORE_PRIVATE_KEY;
  if (!brut) {
    throw new Error(
      'Clé absente. Fournir APPSTORE_PRIVATE_KEY (contenu du .p8) ou ' +
      'APPSTORE_PRIVATE_KEY_FILE (chemin), avec APPSTORE_KEY_ID et ' +
      'APPSTORE_ISSUER_ID. Ce sont les trois secrets de ios-build.yml.');
  }
  /* Un .p8 collé dans une variable d'environnement perd souvent ses retours
     à la ligne au profit de la séquence \n littérale. */
  return brut.includes('\\n') ? brut.replace(/\\n/g, '\n') : brut;
}
const b64url = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let jetonCache = null;
function jeton() {
  if (jetonCache && jetonCache.exp > Date.now() / 1000 + 60) return jetonCache.val;
  const kid = process.env.APPSTORE_KEY_ID;
  if (!kid) throw new Error('APPSTORE_KEY_ID absent.');
  const iss = process.env.APPSTORE_ISSUER_ID;
  const maintenant = Math.floor(Date.now() / 1000);
  const exp = maintenant + 900; // Apple plafonne à 20 minutes.
  const entete = { alg: 'ES256', kid, typ: 'JWT' };
  /* Une clé d'équipe s'identifie par son émetteur ; une clé individuelle n'en
     a pas et se déclare `sub: user`. Les deux existent dans les comptes
     récents, et l'erreur en cas de confusion est un 401 muet. */
  const charge = iss
    ? { iss, iat: maintenant, exp, aud: 'appstoreconnect-v1' }
    : { sub: 'user', iat: maintenant, exp, aud: 'appstoreconnect-v1' };
  const entree = `${b64url(JSON.stringify(entete))}.${b64url(JSON.stringify(charge))}`;
  /* ES256 exige une signature au format brut R||S (P1363). Le format DER, que
     Node produit par défaut, est refusé par Apple avec le même 401. */
  const sig = createSign('SHA256').update(entree)
    .sign({ key: clePrivee(), dsaEncoding: 'ieee-p1363' });
  jetonCache = { val: `${entree}.${b64url(sig)}`, exp };
  return jetonCache.val;
}

/* ------------------------------------------------------------------- api */

async function api(chemin, { methode = 'GET', corps = null } = {}) {
  const url = chemin.startsWith('http') ? chemin : API + chemin;
  const r = await fetch(url, {
    method: methode,
    headers: {
      Authorization: `Bearer ${jeton()}`,
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (r.status === 204) return null;
  const texte = await r.text();
  let data = null;
  try { data = texte ? JSON.parse(texte) : null; } catch { /* pas du JSON */ }
  if (!r.ok) {
    const details = (data?.errors ?? []).map(
      (e) => `  ${e.status} ${e.code}\n    ${e.title}\n    ${e.detail ?? ''}`).join('\n');
    /* Le 403 mérite d'être nommé : une clé créée pour téléverser des builds a
       souvent le rôle « Developer », qui LIT la fiche mais ne l'écrit pas. */
    const indice = r.status === 403
      ? '\n  → rôle insuffisant : écrire la fiche exige « App Manager » ou « Admin ».'
      : '';
    throw new Error(`${methode} ${chemin} → HTTP ${r.status}\n${details || texte}${indice}`);
  }
  return data;
}

/* Une collection App Store Connect est paginée ; sans suivre `next` on croit
   avoir tout vu dès que le compte dépasse la page par défaut. */
async function tout(chemin) {
  let page = await api(chemin);
  const lignes = [...(page?.data ?? [])];
  while (page?.links?.next) {
    page = await api(page.links.next);
    lignes.push(...(page?.data ?? []));
  }
  return lignes;
}

/* -------------------------------------------------------------- contexte */

/* Le bundle vient de `mobile/capacitor.config.json`, pas d'une constante ici.
   C'est le fichier qui nomme l'app pour iOS ET pour Android ; le recopier
   ouvrait la porte a deux verites. Ordre : ce qu'on demande en ligne de
   commande, puis `fiche.json`, puis le projet natif.

   AU DEBUT IL N'Y AVAIT AUCUN REPLI, ET C'ETAIT UN BLOCAGE CIRCULAIRE : `etat`
   exigeait `fiche.json`, que seul `exporter` sait ecrire -- et `exporter`
   exigeait la meme chose. Le premier lancement, le 07/09, s'est arrete sur
   « bundleId inconnu » sans jamais joindre Apple. */
function bundleDuProjet() {
  const chemin = join(DEPOT, 'mobile', 'capacitor.config.json');
  if (!existsSync(chemin)) return null;
  try {
    return JSON.parse(readFileSync(chemin, 'utf8')).appId ?? null;
  } catch {
    return null;
  }
}

async function contexte(fiche) {
  const bundle = opt('bundle') ?? fiche?.app?.bundleId ?? bundleDuProjet();
  if (!bundle) {
    throw new Error('bundleId inconnu : le déclarer dans fiche.json, passer --bundle=, '
      + 'ou renseigner appId dans mobile/capacitor.config.json.');
  }
  const apps = await tout(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundle)}`);
  if (!apps.length) throw new Error(`Aucune app pour le bundle ${bundle} sur ce compte.`);
  const app = apps[0];

  const plateforme = fiche?.app?.plateforme ?? 'IOS';
  const versions = await tout(
    `/v1/apps/${app.id}/appStoreVersions?filter[platform]=${plateforme}&limit=20`);
  const voulue = opt('version', fiche?.version?.versionString ?? null);
  /* On vise la version MODIFIABLE. Une version publiée n'accepte plus
     d'écriture, et l'erreur ne dit pas pourquoi. */
  const modifiable = versions.filter((v) => ETATS_MODIFIABLES.has(
    v.attributes.appVersionState ?? v.attributes.appStoreState));
  const version = voulue
    ? versions.find((v) => v.attributes.versionString === voulue)
    : (modifiable[0] ?? versions[0]);
  if (!version) throw new Error(`Version ${voulue ?? '(modifiable)'} introuvable.`);
  return { app, version, plateforme };
}

const ETATS_MODIFIABLES = new Set([
  'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED',
  'INVALID_BINARY', 'WAITING_FOR_REVIEW', 'READY_FOR_REVIEW',
]);

/* ------------------------------------------------------------------ etat */

async function cmdEtat() {
  const fiche = existsSync(FICHE) ? JSON.parse(await readFile(FICHE, 'utf8')) : {};
  const { app, version } = await contexte(fiche);
  const a = app.attributes;
  const v = version.attributes;
  console.log(`App        ${a.name}  (${a.bundleId})  id ${app.id}`);
  console.log(`           SKU ${a.sku} — langue principale ${a.primaryLocale}`);
  console.log(`Version    ${v.versionString}  état ${v.appVersionState ?? v.appStoreState}`);
  console.log(`           diffusion ${v.releaseType}${v.earliestReleaseDate ? ` au ${v.earliestReleaseDate}` : ''}`);
  console.log(`           copyright ${v.copyright ?? '(vide)'}`);

  const build = await api(`/v1/appStoreVersions/${version.id}/build`).catch(() => null);
  console.log(`Build       ${build?.data ? `${build.data.attributes.version} (id ${build.data.id})` : '— AUCUN build associé'}`);

  const phase = await api(`/v1/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`).catch(() => null);
  console.log(`Déploiement ${phase?.data ? `progressif (${phase.data.attributes.phasedReleaseState})` : 'immédiat'}`);

  const infos = await tout(`/v1/apps/${app.id}/appInfos`);
  for (const info of infos) {
    const notation = await api(`/v1/appInfos/${info.id}/ageRatingDeclaration`).catch(() => null);
    const locs = await tout(`/v1/appInfos/${info.id}/appInfoLocalizations`);
    console.log(`\nFiche (appInfo ${info.id} — ${info.attributes.state})`);
    for (const l of locs) {
      const x = l.attributes;
      console.log(`  [${x.locale}] nom « ${x.name} » · sous-titre « ${x.subtitle ?? ''} »`);
      console.log(`           confidentialité ${x.privacyPolicyUrl ?? '(vide)'}`);
    }
    if (notation?.data) {
      const remplis = Object.entries(notation.data.attributes)
        .filter(([, val]) => val !== null && val !== false).length;
      console.log(`  classification d'âge : ${remplis} déclarations non nulles`);
    }
  }

  const locs = await tout(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  for (const l of locs) {
    const x = l.attributes;
    console.log(`\nVersion ${v.versionString} [${x.locale}]`);
    for (const champ of ['description', 'keywords', 'promotionalText', 'whatsNew', 'marketingUrl', 'supportUrl']) {
      const val = x[champ];
      console.log(`  ${champ.padEnd(16)} ${val === null || val === '' ? '(vide)' : `${val.length} car. — ${apercu(val)}`}`);
    }
    const jeux = await tout(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets`);
    for (const jeu of jeux) {
      const caps = await tout(`/v1/appScreenshotSets/${jeu.id}/appScreenshots`);
      console.log(`  captures ${jeu.attributes.screenshotDisplayType} : ${caps.length}`);
      for (const c of caps) {
        const d = c.attributes;
        console.log(`    ${String(d.fileName).padEnd(28)} ${d.imageAsset ? `${d.imageAsset.width}×${d.imageAsset.height}` : '?'} ${d.assetDeliveryState?.state}`);
      }
    }
  }

  const det = await api(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`).catch(() => null);
  if (det?.data) {
    const d = det.data.attributes;
    console.log('\nVérification');
    console.log(`  contact  ${d.contactFirstName ?? ''} ${d.contactLastName ?? ''} · ${d.contactEmail ?? ''} · ${d.contactPhone ?? ''}`);
    console.log(`  démo     ${d.demoAccountRequired ? `exigée — compte « ${d.demoAccountName ?? ''} »` : 'non exigée'}`);
    console.log(`  notes    ${d.notes ? apercu(d.notes) : '(vides)'}`);
  }
}

const apercu = (s) => {
  const p = String(s).replace(/\s+/g, ' ').trim();
  return p.length > 70 ? `${p.slice(0, 70)}…` : p;
};

/* -------------------------------------------------------------- exporter */

async function cmdExporter() {
  const amorce = existsSync(FICHE) ? JSON.parse(await readFile(FICHE, 'utf8')) : {};
  const { app, version, plateforme } = await contexte(amorce);
  const v = version.attributes;

  const sortie = {
    _lisez_moi: 'État voulu de la fiche App Store. Produit par `fiche.mjs exporter`, '
      + 'puis modifié à la main et poussé par `fiche.mjs metadonnees --appliquer`. '
      + 'Aucun mot de passe ici : celui du compte de démonstration se passe par '
      + 'la variable APPSTORE_DEMO_MDP.',
    app: { bundleId: app.attributes.bundleId, plateforme },
    version: {
      versionString: v.versionString,
      copyright: v.copyright ?? null,
      releaseType: v.releaseType ?? null,
      build: null,
    },
    fiche: {},
    versionLocalisations: {},
    verification: null,
    captures: {},
  };

  const build = await api(`/v1/appStoreVersions/${version.id}/build`).catch(() => null);
  if (build?.data) sortie.version.build = build.data.attributes.version;

  const infos = await tout(`/v1/apps/${app.id}/appInfos`);
  const info = infos.find((i) => i.attributes.state !== 'READY_FOR_DISTRIBUTION') ?? infos[0];
  for (const l of await tout(`/v1/appInfos/${info.id}/appInfoLocalizations`)) {
    const x = l.attributes;
    sortie.fiche[x.locale] = {
      name: x.name ?? null, subtitle: x.subtitle ?? null,
      privacyPolicyUrl: x.privacyPolicyUrl ?? null,
      privacyChoicesUrl: x.privacyChoicesUrl ?? null,
    };
  }

  for (const l of await tout(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)) {
    const x = l.attributes;
    sortie.versionLocalisations[x.locale] = {
      description: x.description ?? null, keywords: x.keywords ?? null,
      promotionalText: x.promotionalText ?? null, whatsNew: x.whatsNew ?? null,
      marketingUrl: x.marketingUrl ?? null, supportUrl: x.supportUrl ?? null,
    };
    sortie.captures[x.locale] = {};
    for (const jeu of await tout(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets`)) {
      const caps = await tout(`/v1/appScreenshotSets/${jeu.id}/appScreenshots`);
      const t = jeu.attributes.screenshotDisplayType;
      sortie.captures[x.locale][t] = {
        /* Les tailles acceptées sont RELEVÉES sur ce qui est déjà en ligne, pas
           recopiées d'une table d'Apple : c'est le compte qui fait foi. */
        dimensions: [...new Set(caps.filter((c) => c.attributes.imageAsset)
          .map((c) => `${c.attributes.imageAsset.width}x${c.attributes.imageAsset.height}`))]
          .map((s) => s.split('x').map(Number)),
        enLigne: caps.map((c) => c.attributes.fileName),
        fichiers: [],
      };
    }
  }

  const det = await api(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`).catch(() => null);
  if (det?.data) {
    const d = det.data.attributes;
    sortie.verification = {
      contactFirstName: d.contactFirstName ?? null, contactLastName: d.contactLastName ?? null,
      contactPhone: d.contactPhone ?? null, contactEmail: d.contactEmail ?? null,
      demoAccountRequired: d.demoAccountRequired ?? false,
      demoAccountName: d.demoAccountName ?? null,
      /* JAMAIS le mot de passe, même si l'API le renvoyait. */
      demoAccountPassword: null,
      notes: d.notes ?? null,
    };
  }

  await writeFile(FICHE, `${JSON.stringify(sortie, null, 2)}\n`, 'utf8');
  console.log(`Écrit : ${FICHE}`);
  console.log('Relire, corriger, committer — puis `metadonnees` pour constater l\'écart.');
}

/* ----------------------------------------------------------- metadonnees */

async function cmdMetadonnees() {
  const fiche = await lireFiche();
  const { app, version } = await contexte(fiche);
  const langue = opt('langue');
  let ecarts = 0;

  const poser = (quoi, champ, avant, apres) => {
    if (apres === undefined || apres === null) return false;      // non déclaré = non touché
    if (String(avant ?? '') === String(apres)) return false;
    const max = LIMITES[champ];
    if (max && String(apres).length > max) {
      throw new Error(`${quoi} · ${champ} : ${String(apres).length} caractères pour ${max} maximum.`);
    }
    ecarts += 1;
    console.log(`~ ${quoi} · ${champ}`);
    console.log(`    avant : ${avant === null || avant === '' ? '(vide)' : apercu(avant)}`);
    console.log(`    après : ${apercu(apres)}`);
    return true;
  };

  /* --- fiche (vaut pour toutes les versions) --- */
  const infos = await tout(`/v1/apps/${app.id}/appInfos`);
  const info = infos.find((i) => i.attributes.state !== 'READY_FOR_DISTRIBUTION') ?? infos[0];
  const ficheLocs = await tout(`/v1/appInfos/${info.id}/appInfoLocalizations`);
  for (const l of ficheLocs) {
    const voulu = fiche.fiche?.[l.attributes.locale];
    if (!voulu || (langue && langue !== l.attributes.locale)) continue;
    const chgt = {};
    for (const champ of ['name', 'subtitle', 'privacyPolicyUrl', 'privacyChoicesUrl']) {
      if (poser(`fiche [${l.attributes.locale}]`, champ, l.attributes[champ], voulu[champ])) {
        chgt[champ] = voulu[champ];
      }
    }
    if (APPLIQUER && Object.keys(chgt).length) {
      await api(`/v1/appInfoLocalizations/${l.id}`, {
        methode: 'PATCH',
        corps: { data: { type: 'appInfoLocalizations', id: l.id, attributes: chgt } },
      });
    }
  }

  /* Localisations DECLAREES dans fiche.json mais ABSENTES du store : creees.
     `metadonnees` ne mettait a jour que l'existant, donc une langue neuve
     (ex. en-US) restait invisible. On la POST ici, meme controle de longueur ;
     les champs null/undefined sont omis. */
  const ficheExistantes = new Set(ficheLocs.map((l) => l.attributes.locale));
  for (const [locale, voulu] of Object.entries(fiche.fiche ?? {})) {
    if (ficheExistantes.has(locale) || (langue && langue !== locale)) continue;
    const attrs = { locale };
    for (const champ of ['name', 'subtitle', 'privacyPolicyUrl', 'privacyChoicesUrl']) {
      const v = voulu[champ];
      if (v === undefined || v === null) continue;
      const max = LIMITES[champ];
      if (max && String(v).length > max) {
        throw new Error(`fiche [${locale}] · ${champ} : ${String(v).length} caracteres pour ${max} maximum.`);
      }
      attrs[champ] = v;
    }
    if (Object.keys(attrs).length <= 1) continue;
    ecarts += 1;
    console.log(`+ fiche [${locale}] creee · ${Object.keys(attrs).filter((k) => k !== 'locale').join(', ')}`);
    if (APPLIQUER) {
      await api('/v1/appInfoLocalizations', {
        methode: 'POST',
        corps: {
          data: {
            type: 'appInfoLocalizations', attributes: attrs,
            relationships: { appInfo: { data: { type: 'appInfos', id: info.id } } },
          },
        },
      });
    }
  }

  /* --- localisations de la version --- */
  const versionLocs = await tout(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  for (const l of versionLocs) {
    const voulu = fiche.versionLocalisations?.[l.attributes.locale];
    if (!voulu || (langue && langue !== l.attributes.locale)) continue;
    const chgt = {};
    for (const champ of ['description', 'keywords', 'promotionalText', 'whatsNew', 'marketingUrl', 'supportUrl']) {
      if (poser(`version [${l.attributes.locale}]`, champ, l.attributes[champ], voulu[champ])) {
        chgt[champ] = voulu[champ];
      }
    }
    if (APPLIQUER && Object.keys(chgt).length) {
      await api(`/v1/appStoreVersionLocalizations/${l.id}`, {
        methode: 'PATCH',
        corps: { data: { type: 'appStoreVersionLocalizations', id: l.id, attributes: chgt } },
      });
    }
  }

  /* Meme logique pour les localisations de VERSION absentes du store. */
  const versionExistantes = new Set(versionLocs.map((l) => l.attributes.locale));
  for (const [locale, voulu] of Object.entries(fiche.versionLocalisations ?? {})) {
    if (versionExistantes.has(locale) || (langue && langue !== locale)) continue;
    const attrs = { locale };
    for (const champ of ['description', 'keywords', 'promotionalText', 'whatsNew', 'marketingUrl', 'supportUrl']) {
      const v = voulu[champ];
      if (v === undefined || v === null) continue;
      const max = LIMITES[champ];
      if (max && String(v).length > max) {
        throw new Error(`version [${locale}] · ${champ} : ${String(v).length} caracteres pour ${max} maximum.`);
      }
      attrs[champ] = v;
    }
    if (Object.keys(attrs).length <= 1) continue;
    ecarts += 1;
    console.log(`+ version [${locale}] creee · ${Object.keys(attrs).filter((k) => k !== 'locale').join(', ')}`);
    if (APPLIQUER) {
      await api('/v1/appStoreVersionLocalizations', {
        methode: 'POST',
        corps: {
          data: {
            type: 'appStoreVersionLocalizations', attributes: attrs,
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } },
          },
        },
      });
    }
  }

  /* --- attributs de la version --- */
  const chgtV = {};
  for (const champ of ['copyright', 'releaseType', 'earliestReleaseDate', 'versionString']) {
    if (poser('version', champ, version.attributes[champ], fiche.version?.[champ])) {
      chgtV[champ] = fiche.version[champ];
    }
  }
  if (APPLIQUER && Object.keys(chgtV).length) {
    await api(`/v1/appStoreVersions/${version.id}`, {
      methode: 'PATCH',
      corps: { data: { type: 'appStoreVersions', id: version.id, attributes: chgtV } },
    });
  }

  /* --- build associé --- */
  const buildVoulu = fiche.version?.build;
  if (buildVoulu) {
    const actuel = await api(`/v1/appStoreVersions/${version.id}/build`).catch(() => null);
    if (actuel?.data?.attributes?.version !== String(buildVoulu)) {
      const builds = await tout(
        `/v1/builds?filter[app]=${app.id}&sort=-version&limit=50`);
      const cible = builds.find((b) => b.attributes.version === String(buildVoulu));
      if (!cible) throw new Error(`Build ${buildVoulu} introuvable pour cette app.`);
      ecarts += 1;
      console.log(`~ version · build : ${actuel?.data?.attributes?.version ?? '(aucun)'} → ${buildVoulu}`);
      if (APPLIQUER) {
        await api(`/v1/appStoreVersions/${version.id}/relationships/build`, {
          methode: 'PATCH', corps: { data: { type: 'builds', id: cible.id } },
        });
      }
    }
  }

  /* --- coordonnées de vérification --- */
  if (fiche.verification) {
    const det = await api(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`).catch(() => null);
    const voulu = { ...fiche.verification };
    /* Le mot de passe ne vient JAMAIS du fichier : il n'y est pas. */
    delete voulu.demoAccountPassword;
    const mdp = process.env.APPSTORE_DEMO_MDP;
    const chgt = {};
    for (const [champ, val] of Object.entries(voulu)) {
      if (typeof val === 'boolean') {
        if (det?.data?.attributes?.[champ] !== val) {
          ecarts += 1;
          console.log(`~ vérification · ${champ} : ${det?.data?.attributes?.[champ]} → ${val}`);
          chgt[champ] = val;
        }
        continue;
      }
      if (poser('vérification', champ, det?.data?.attributes?.[champ], val)) chgt[champ] = val;
    }
    if (mdp) {
      /* On ne peut pas comparer : l'API ne rend pas le mot de passe. On le pose
         donc à chaque fois qu'il est fourni, et on ne l'affiche pas. */
      chgt.demoAccountPassword = mdp;
      ecarts += 1;
      console.log('~ vérification · demoAccountPassword : fourni par APPSTORE_DEMO_MDP (non affiché)');
    }
    if (APPLIQUER && Object.keys(chgt).length) {
      if (det?.data) {
        await api(`/v1/appStoreReviewDetails/${det.data.id}`, {
          methode: 'PATCH',
          corps: { data: { type: 'appStoreReviewDetails', id: det.data.id, attributes: chgt } },
        });
      } else {
        await api('/v1/appStoreReviewDetails', {
          methode: 'POST',
          corps: {
            data: {
              type: 'appStoreReviewDetails', attributes: chgt,
              relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } },
            },
          },
        });
      }
    }
  }

  console.log(`\n${ecarts} écart(s).`);
  if (ecarts && !APPLIQUER) console.log('Rien n\'a été écrit. Relancer avec --appliquer.');
}

/* -------------------------------------------------------------- captures */

async function cmdCaptures() {
  const fiche = await lireFiche();
  const { version } = await contexte(fiche);
  const langue = opt('langue');
  const remplacer = drapeau('remplacer');
  let envoyees = 0;

  for (const l of await tout(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)) {
    const loc = l.attributes.locale;
    const voulu = fiche.captures?.[loc];
    if (!voulu || (langue && langue !== loc)) continue;

    const jeux = await tout(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets`);
    for (const [type, decl] of Object.entries(voulu)) {
      const fichiers = decl.fichiers ?? [];
      if (!fichiers.length) {
        console.log(`[${loc}] ${type} : aucun fichier déclaré — rien à faire.`);
        continue;
      }

      /* Mesurer AVANT d'ouvrir la moindre connexion : une taille fausse doit
         arrêter la commande, pas la laisser déposer trois images sur quatre. */
      const prets = [];
      for (const rel of fichiers) {
        const chemin = resolve(DEPOT, rel);
        if (!existsSync(chemin)) throw new Error(`Capture introuvable : ${rel}`);
        const octets = await readFile(chemin);
        const mesure = mesurerPng(octets);
        if (decl.dimensions?.length) {
          const ok = decl.dimensions.some(([w, h]) => w === mesure.largeur && h === mesure.hauteur);
          if (!ok) {
            throw new Error(
              `${rel} mesure ${mesure.largeur}×${mesure.hauteur}, non déclarée pour ${type} `
              + `(${decl.dimensions.map(([w, h]) => `${w}×${h}`).join(', ')}).`);
          }
        }
        if (mesure.alpha) {
          console.log(`  ⚠ ${basename(chemin)} porte une couche alpha — Apple refuse la transparence.`);
        }
        prets.push({ rel, chemin, octets, mesure });
      }

      let jeu = jeux.find((j) => j.attributes.screenshotDisplayType === type);
      console.log(`\n[${loc}] ${type} — ${prets.length} image(s)${jeu ? '' : ' (jeu à créer)'}`);
      for (const p of prets) {
        console.log(`  ${p.rel} · ${p.mesure.largeur}×${p.mesure.hauteur} · ${(p.octets.length / 1024).toFixed(0)} Ko`);
      }
      if (!APPLIQUER) { console.log('  (constat seul — --appliquer pour déposer)'); continue; }

      if (!jeu) {
        const cree = await api('/v1/appScreenshotSets', {
          methode: 'POST',
          corps: {
            data: {
              type: 'appScreenshotSets',
              attributes: { screenshotDisplayType: type },
              relationships: {
                appStoreVersionLocalization: {
                  data: { type: 'appStoreVersionLocalizations', id: l.id },
                },
              },
            },
          },
        });
        jeu = cree.data;
      }

      if (remplacer) {
        for (const c of await tout(`/v1/appScreenshotSets/${jeu.id}/appScreenshots`)) {
          await api(`/v1/appScreenshots/${c.id}`, { methode: 'DELETE' });
          console.log(`  supprimé : ${c.attributes.fileName}`);
        }
      }

      const ids = [];
      for (const p of prets) {
        ids.push(await deposer(jeu.id, p));
        envoyees += 1;
      }
      /* L'ordre d'affichage est celui de la relation, pas celui des envois. */
      await api(`/v1/appScreenshotSets/${jeu.id}/relationships/appScreenshots`, {
        methode: 'PATCH',
        corps: { data: ids.map((id) => ({ type: 'appScreenshots', id })) },
      });
      console.log('  ordre fixé.');
    }
  }
  console.log(`\n${envoyees} capture(s) déposée(s).`);
  if (!APPLIQUER) console.log('Rien n\'a été écrit. Relancer avec --appliquer.');
}

async function deposer(jeuId, { chemin, octets }) {
  const nom = basename(chemin);
  const reserve = await api('/v1/appScreenshots', {
    methode: 'POST',
    corps: {
      data: {
        type: 'appScreenshots',
        attributes: { fileName: nom, fileSize: octets.length },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: jeuId } } },
      },
    },
  });
  const id = reserve.data.id;

  /* Apple découpe le téléversement en opérations : une seule pour nos tailles,
     mais la boucle est gratuite et le jour où un fichier dépasse le seuil, une
     implémentation mono-morceau enverrait une image tronquée. */
  for (const op of reserve.data.attributes.uploadOperations ?? []) {
    const entetes = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]));
    const r = await fetch(op.url, {
      method: op.method,
      headers: entetes,
      body: octets.subarray(op.offset, op.offset + op.length),
    });
    if (!r.ok) throw new Error(`Envoi de ${nom} : HTTP ${r.status} ${await r.text()}`);
  }

  await api(`/v1/appScreenshots/${id}`, {
    methode: 'PATCH',
    corps: {
      data: {
        type: 'appScreenshots', id,
        attributes: { uploaded: true, sourceFileChecksum: createHash('md5').update(octets).digest('hex') },
      },
    },
  });

  /* L'API a répondu 200 ; Apple traite l'image ENSUITE. Sans cette attente on
     annonce un dépôt réussi alors que la fiche affichera une erreur. */
  for (let i = 0; i < 30; i += 1) {
    const r = await api(`/v1/appScreenshots/${id}`);
    const etat = r.data.attributes.assetDeliveryState;
    if (etat?.state === 'COMPLETE') { console.log(`  déposé : ${nom}`); return id; }
    if (etat?.state === 'FAILED') {
      throw new Error(`${nom} refusé par Apple : ${JSON.stringify(etat.errors ?? etat)}`);
    }
    await new Promise((r2) => { setTimeout(r2, 2000); });
  }
  throw new Error(`${nom} : état de livraison toujours en cours après 60 s.`);
}

/* Lecture de l'en-tête PNG : largeur, hauteur, présence d'une couche alpha.
   On relit les OCTETS plutôt que de faire confiance au producteur — c'est ce
   qui a rattrapé un rendu à 980×2125 qui se présentait comme un PNG valide. */
function mesurerPng(b) {
  if (b.length < 26 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('Ce n\'est pas un PNG.');
  const typeCouleur = b[25];
  return {
    largeur: b.readUInt32BE(16),
    hauteur: b.readUInt32BE(20),
    alpha: typeCouleur === 4 || typeCouleur === 6,
  };
}

async function lireFiche() {
  if (!existsSync(FICHE)) {
    throw new Error(
      `${FICHE} absent. Le produire d'abord : node tools/appstore/fiche.mjs exporter`);
  }
  return JSON.parse(await readFile(FICHE, 'utf8'));
}

/* ------------------------------------------------------------------ main */

const COMMANDES = {
  etat: cmdEtat, exporter: cmdExporter, metadonnees: cmdMetadonnees, captures: cmdCaptures,
};

if (!COMMANDES[commande]) {
  console.error('usage : node tools/appstore/fiche.mjs <etat|exporter|metadonnees|captures> [--appliquer]');
  process.exit(2);
}
try {
  await COMMANDES[commande]();
} catch (e) {
  console.error(`\nÉCHEC — ${e.message}`);
  process.exit(1);
}
