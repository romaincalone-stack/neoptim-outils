import { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

// ─── Fields ───────────────────────────────────────────────────────────────────
const FIELDS = [
  { key: "etablissement", label: "Établissement" },
  { key: "matricule",     label: "Matricule" },
  { key: "type_contrat",  label: "Type de contrat" },
  { key: "fonction",      label: "Fonction" },
  { key: "regime",        label: "Régime de cotisation" },
  { key: "mois",          label: "Mois" },
  { key: "annee",         label: "Année" },
  { key: "heures",        label: "Heures rémunérées" },
  { key: "base_ss",       label: "Base SS Maladie (€)" },
  { key: "exonerations",  label: "Exonérations employeur (€)" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const MOIS_NOMS = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
const MOIS_MAP  = { "01":"Janvier","02":"Février","03":"Mars","04":"Avril","05":"Mai","06":"Juin","07":"Juillet","08":"Août","09":"Septembre","10":"Octobre","11":"Novembre","12":"Décembre" };

function capitalizeMois(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s; }

function normalizeMois(raw) {
  if (!raw) return "";
  raw = raw.trim();
  const mmyyyy = raw.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (mmyyyy) { const m = MOIS_MAP[mmyyyy[1].padStart(2,"0")]; return m ? `${m} ${mmyyyy[2]}` : raw; }
  const named = raw.match(new RegExp(`(${MOIS_NOMS.join("|")})\\s+(\\d{4})`, "i"));
  if (named) return `${capitalizeMois(named[1])} ${named[2]}`;
  return raw;
}

// Split "Janvier 2023" → { mois:"Janvier", annee:"2023" }
function splitMoisAnnee(combined) {
  if (!combined) return { mois: "", annee: "" };
  const m = combined.match(/^(\S+)\s+(20\d{2})$/);
  if (m) return { mois: m[1], annee: m[2] };
  return { mois: combined, annee: "" };
}

// Map statut + profil → régime
function computeRegime(statut, profil) {
  const s = (statut||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const p = (profil||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  if (s.includes("titulaire") || s.includes("stagiaire")) return "CNRACL";
  if (s.includes("contractuel")) {
    if (p.includes("fonctionnaire")) return "IRCANTEC";
    if (p.includes("general") || p.includes("général")) return "Régime général";
    return "Régime général"; // fallback contractuel
  }
  // Fallback on profil seul
  if (p.includes("fonctionnaire")) return "CNRACL";
  if (p.includes("general") || p.includes("général")) return "Régime général";
  return "";
}

// ─── Line-aware PDF text extraction ──────────────────────────────────────────
// Groups items by Y coordinate — returns arrays of items (preserving X positions).
// Used both for text reconstruction and for historique column parsing.
function groupItemsByY(items, tolerance = 2) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => {
    const yDiff = b.transform[5] - a.transform[5];
    if (Math.abs(yDiff) > tolerance) return yDiff;
    return a.transform[4] - b.transform[4];
  });
  const rows = [];
  let cur = [], lastY = null;
  for (const item of sorted) {
    const y = Math.round(item.transform[5]);
    if (lastY !== null && Math.abs(y - lastY) > tolerance) { rows.push(cur); cur = []; }
    cur.push(item);
    lastY = y;
  }
  if (cur.length) rows.push(cur);
  return rows.filter(r => r.some(i => i.str && i.str.trim()));
}

function itemsToLines(items) {
  return groupItemsByY(items)
    .map(row => row.map(i => i.str).join(" ").trim())
    .filter(l => l.length > 0)
    .join("\n");
}

// ─── Établissement : multi-strategy search ───────────────────────────────────
function findEtablissement(text) {
  // Strategy 1 (Boueni/Mairie format): "EMPLOYEUR\n[Nom]\n[adresse]..."
  const empLabel = text.match(/EMPLOYEUR\s*\n\s*(.{3,60}?)(?:\n|$)/im);
  if (empLabel) {
    const c = empLabel[1].trim().replace(/\s+/g," ");
    if (c.length >= 3 && !/^\d/.test(c)) return c.substring(0,60);
  }

  // Strategy 2 (B.PAMS / Biviers): scan backward from SIRET line
  const siretIdx = text.search(/(?:N[°o]?\s*)?SIRET[:\s]+\d{9}/i);
  if (siretIdx > 0) {
    const SKIP = [
      /^D\s+U\s+P\s+L\s+I/, /^\d{5}[\s\-]/,
      /^\d{1,4}\s+(RUE|AV|BD|CH\.|IMP|ALL\.|PL\.|RT\.|LOT)/i,
      /^(Tél|Fax|Tel:|SIREN|RCS|BP|RIB|BIC|IBAN)\b/i,
      /^(Paiement|Banque|Virement|par\s+Vir|par\s+Che)/i,
      /^(BULLETIN|P[eé]riode|PERIODE|Paiement)/i,
      /^(Mme|M\.\s|Mlle|Monsieur|Madame|Mr\.)\s/i,
      /^\d{2}[\/\-]\d{2}[\/\-]/, /^APE[\/\s]/i,
      /^(agent#|CODE|SERVICE|GRADE|STATUT|TEMPS)/i,
    ];
    const lines = text.substring(0, siretIdx).split("\n").map(l=>l.trim()).filter(l=>l.length>1);
    for (let i = lines.length-1; i >= Math.max(0, lines.length-10); i--) {
      const raw = lines[i];
      if (/^\d/.test(raw) || SKIP.some(p=>p.test(raw))) continue;
      const candidate = raw.replace(/\s{3,}.*$/,"").replace(/\s+IB\s*\/.*$/,"").replace(/\s+APE.*$/,"").trim();
      if (candidate.length >= 3 && /[A-ZÀ-Ü]/.test(candidate)) return candidate.substring(0,60);
    }
  }

  // Strategy 3 (Sage/Foyer): first meaningful non-digit, non-header line
  for (const l of text.split("\n").map(l=>l.trim())) {
    if (l.length < 4 || /^\d/.test(l)) continue;
    if (/^(D\s+U\s+P|agent#|Mme|M\.\s|BULLETIN|P[eé]riode|PERIODE|Paiement|EMPLOYEUR)/i.test(l)) continue;
    if (/[A-ZÀ-Ü]/.test(l)) return l.replace(/\s{3,}.*$/,"").trim().substring(0,60);
  }
  return "";
}

// ─── Normalise statut brut → Titulaire / Contractuel / Stagiaire ─────────────
function normalizeStatut(raw) {
  if (!raw) return "";
  const t = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  if (t.includes("titulaire")) return "Titulaire";
  if (t.includes("stagiaire")) return "Stagiaire";
  if (t.match(/\b(cont|contractuel|cdd|cdi|cae|cui|vacation|remplacant|remplac|accomp)/)) return "Contractuel";
  return capitalizeMois(raw.split(/[\s\-,(]/)[0]);
}

// Mois canoniques sans accents pour matcher les caps accentués du PDF Boueni
const MOIS_SANS_ACCENT = ["janvier","fevrier","mars","avril","mai","juin","juillet","aout","septembre","octobre","novembre","decembre"];

// ─── Field extraction from reconstructed lines ───────────────────────────────
function extractFromLines(text) {
  const r = {};

  // ── Établissement ──
  r.etablissement = findEtablissement(text);

  // ── Matricule — alphanumeric (DOUEMI, 00100, 576…) ──
  // Format B.PAMS/Biviers:  "Matricule 576"
  // Format MARPA:           "Matricule :\nDOUEMI" or "Matricule : DOUEMI"
  // Format Historique/EHPAD: "MATRICULE : 001564"
  const mat = text.match(/Matricule\s*[:\-]?\s*([A-Z0-9]{2,15})/i);
  if (mat) r.matricule = mat[1].trim();

  // ── Statut / Type de contrat ──
  // Format Boueni: "STATUT  CONT - Collaborateur de Cabinet" / "STATUT  Titulaire (FPT)"
  // Format B.PAMS: "Statut Contractuel"
  const statAll = text.match(/STATUT\s+(.{3,80}?)(?:\n|$)/im)
                || text.match(/Statut\s+(Contractuel(?:le)?|Titulaire|Stagiaire)/i);
  if (statAll) r.type_contrat = normalizeStatut(statAll[1].trim());

  // ── Profil de cotisations (B.PAMS) ──
  const profil = text.match(/Profil\s+de\s+cotisations\s+(R[eé]gime\s+\w+(?:\s+\w+)?)/i);
  const profilVal = profil ? profil[1] : "";

  // ── Régime ──
  r.regime = computeRegime(r.type_contrat||"", profilVal);
  if (!r.regime) {
    const regM = text.match(/\b(CNRACL|IRCANTEC|R[eé]gime\s+g[eé]n[eé]ral|MSA)\b/i);
    if (regM) r.regime = regM[1];
  }
  if (!r.regime && /ASSURANCE\s+CHOMAGE|P[oô]le\s+Emploi/i.test(text)) r.regime = "Régime général";

  // ── Fonction ──
  // Priority 1 — Boueni: "GRADE  ATSEM Pal 2Cl" (label GRADE in caps, standalone line)
  const gradeMatch = text.match(/^GRADE\s+(.{3,60}?)(?:\n|$)/im);
  if (gradeMatch) {
    r.fonction = gradeMatch[1].trim().replace(/\s+/g," ");
  } else {
    // Priority 2 — MARPA + Sage:
    //   Inline: "Emploi : AGENT POLYVALENT D'ACCOMP QUAL"
    //   Split:  "Emploi :\nAGENT POLYVALENT D'ACCOMP QUAL"  (label/value in separate columns)
    //   Sage:   "Emploi  Secrétaire comptable  Indice 1657"
    let fonctionVal = "";
    // 2a — colon present, value on same line
    //   Stop ONLY on civility prefix or "Indice N" or newline — NOT on 3+ spaces
    //   (pdfjs can insert multiple spaces between words of the job title)
    //   .replace(/\s+/g," ") normalises the spaces afterwards
    const emploiInline = text.match(/Emploi\s*:\s*([^\n]+?)(?=\s+(?:Madame?|Monsieur|Mme?\.?|Mlle?\.?)\s|\s+Indice\s+\d|\n|$)/im);
    if (emploiInline && emploiInline[1].trim().length > 0) {
      fonctionVal = emploiInline[1].trim().replace(/\s+/g," ");
    }
    // 2b — colon present but value is on next line (MARPA column layout)
    if (!fonctionVal) {
      const emploiNextLine = text.match(/Emploi\s*:\s*\n\s*([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ][^\n]{2,80})/im);
      if (emploiNextLine) fonctionVal = emploiNextLine[1].trim().replace(/\s+/g," ");
    }
    // 2c — no colon, double-space separated (Sage): "Emploi  Secrétaire  Indice"
    if (!fonctionVal) {
      const emploiSage = text.match(/Emploi\s{2,}(.+?)(?=\s{2,}|\s+Indice\s+\d|\n|$)/im);
      if (emploiSage) fonctionVal = emploiSage[1].trim().replace(/\s+/g," ");
    }
    if (fonctionVal) {
      r.fonction = fonctionVal;
    } else {
      // Priority 3 — B.PAMS: "Fonction Aide soignant"
      const fn = text.match(/(?:Fonction|Poste|Cadre\s+d['']emploi)\s+(.{3,60}?)(?:\n|$)/im);
      if (fn) r.fonction = fn[1].trim().replace(/\s+/g," ");
      else {
        const lb = text.match(/libell[eé]\s+(?:emploi|poste|grade)\s*[:\-]?\s*(.{3,60}?)(?:\n|$)/im);
        if (lb) r.fonction = lb[1].trim().replace(/\s+/g," ");
      }
    }
  }

  // ── Mois + Année (stored separately) ──
  let moisCombined = "";

  // Priority 1 — Boueni: "PERIODE DE PAIE  DÉCEMBRE 2023"
  const periodePaie = text.match(/PERIODE\s+DE\s+PAIE\s+([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ]{3,12})\s+(20\d{2})/i);
  if (periodePaie) {
    const nomNorm = periodePaie[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
    const idx = MOIS_SANS_ACCENT.indexOf(nomNorm);
    moisCombined = idx >= 0 ? `${capitalizeMois(MOIS_NOMS[idx])} ${periodePaie[2]}`
                            : `${capitalizeMois(periodePaie[1].toLowerCase())} ${periodePaie[2]}`;
  }
  // Priority 2 — MARPA/Sage: "Période : Janvier 2023" or "Période: janvier 2023"
  if (!moisCombined) {
    const periodeColon = text.match(/[Pp][eé]riode\s*[:\-]\s*([A-ZÀ-Üa-zà-ü]+)\s+(20\d{2})/);
    if (periodeColon) {
      const nom = periodeColon[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
      const idx = MOIS_SANS_ACCENT.indexOf(nom);
      moisCombined = idx >= 0 ? `${capitalizeMois(MOIS_NOMS[idx])} ${periodeColon[2]}`
                              : `${capitalizeMois(periodeColon[1])} ${periodeColon[2]}`;
    }
  }
  // Priority 3 — Named month lowercase/mixed in text: "août 2025"
  if (!moisCombined) {
    const moisNamed = text.match(new RegExp(`(${MOIS_NOMS.join("|")})\\s+(20\\d{2})`, "i"));
    if (moisNamed) moisCombined = `${capitalizeMois(moisNamed[1])} ${moisNamed[2]}`;
  }
  // Priority 4 — "Période du DD/MM/YY(YY)"
  if (!moisCombined) {
    const per = text.match(/[Pp][eé]riode\s+du\s+\d{1,2}[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (per) {
      const year = per[2].length === 2 ? "20"+per[2] : per[2];
      const m = MOIS_MAP[per[1].padStart(2,"0")];
      moisCombined = m ? `${m} ${year}` : `${per[1]}/${year}`;
    }
  }
  // Priority 5 — MM/YYYY standalone
  if (!moisCombined) {
    const mmyyyy = text.match(/\b(0[1-9]|1[0-2])\/(20\d{2})\b/);
    if (mmyyyy) { const m = MOIS_MAP[mmyyyy[1]]; moisCombined = m ? `${m} ${mmyyyy[2]}` : `${mmyyyy[1]}/${mmyyyy[2]}`; }
  }

  const { mois: moisVal, annee: anneeVal } = splitMoisAnnee(moisCombined);
  r.mois  = moisVal;
  r.annee = anneeVal;

  // ── Heures ──
  // Priority 1 — Boueni: "HEURES\nDU MOIS   151.67"
  const heuresDuMois = text.match(/(?:HEURES\s+)?DU\s+MOIS\s+([\d]{1,3}[.,][\d]{2})/i);
  if (heuresDuMois) {
    r.heures = heuresDuMois[1].replace(",",".");
  } else {
    // Priority 2 — B.PAMS TOTAUX row: "Mois  18,00  235,22..."
    const heuresMois = text.match(/\bMois\s+([\d]{1,3}[.,][\d]{2})\s+[\d.,]/);
    if (heuresMois) {
      r.heures = heuresMois[1].replace(",",".");
    } else {
      // Priority 3 — Sage: "Horaire  151,6700"
      const horaire = text.match(/Horaire\s+([\d]{2,3}[,\.][\d]{2})/i);
      if (horaire) {
        r.heures = horaire[1].replace(",",".");
      } else {
        // Priority 4 — Nb Heures header (Historique): "Nb Heures   151,67  151,67..."
        const nbHeurs = text.match(/Nb\s+Heures\s+([\d]{2,3}[,\.][\d]{2})/i);
        if (nbHeurs) {
          r.heures = nbHeurs[1].replace(",",".");
        } else {
          // Priority 5 — generic labels
          const hFall = text.match(/(?:nb\.?\s*h\.?|volume\s+horaire|heures?\s+r[eé]mun[eé]r[eé]es?|h\.\s*rem\.?|heures?\s+travaill[eé]es?)\s*[:\-]?\s*([\d]+[,.][\d]+)/i);
          if (hFall) {
            r.heures = hFall[1].replace(",",".");
          } else {
            // Priority 6 — MARPA/Code du Travail format: "Salaire de base  112.67  12.0589  ..."
            // First numeric token on the salaire de base line = nb heures contractuelles
            const salaireBase = text.match(/[Ss]alaire\s+de\s+base\s+([\d]{2,3}[,\.][\d]{2})/);
            if (salaireBase) r.heures = salaireBase[1].replace(",",".");
          }
        }
      }
    }
  }

  // ── Assiette = Brut ──
  // Priority 1 — Boueni: rubrique "4930  SALAIRE BRUT  4997.64"
  const salaireBrut = text.match(/SALAIRE\s+BRUT\s+([\d\s]{2,15}[,\.][\d]{2})/i);
  if (salaireBrut) {
    r.assiette = salaireBrut[1].replace(/\s/g,"").replace(",",".");
  } else {
    // Priority 2 — Sage: "TOTAL BRUT  2841,30"
    const totalBrut = text.match(/TOTAL\s+BRUT\s+([\d\s]{2,15}[,\.][\d]{2})/i);
    if (totalBrut) {
      r.assiette = totalBrut[1].replace(/\s/g,"").replace(",",".");
    } else {
      // Priority 3 — B.PAMS: standalone "Brut  235,22" line
      const brutLine = text.match(/^Brut\s+([\d\s]{1,12}[.,]\d{2})$/im);
      if (brutLine) {
        r.assiette = brutLine[1].replace(/\s/g,"").replace(",",".");
      } else {
        // Priority 4 — fallback: Brut not followed by disqualifying words
        const brutFall = text.match(/\bBrut\b(?!\s+(?:Fiscal|Imposable|Total|Plafonnée|social|net|impôts?))\s+([\d\s]{2,12}[.,]\d{2})/i);
        if (brutFall) r.assiette = brutFall[1].replace(/\s/g,"").replace(",",".");
      }
    }
  }

  // ── Base SS Maladie ──
  // Format MARPA/privé: base sur les lignes SS plafonnée, déplafonnée, complémentaire tranche 1,
  // ou complémentaire incap/inval/décès.
  // Ces lignes ont la structure: "[libellé]   [base]   [taux]   [montant salarié]..."
  // La base est le premier montant (≥ 3 chiffres) sur la ligne.
  // On prend la première ligne qui matche — la base est identique sur toutes.
  if (!r.base_ss) {
    const basePat = /(?:S[eé]curit[eé]\s+[Ss]ociale\s+(?:plafonn[eé]e|d[eé]plafonn[eé]e)|[Cc]ompl[eé]mentaire\s+(?:Tranche\s+1|[Ii]ncap\.?[^,\n]{0,20}[Dd][eé]c[eè]s))\s+([\d][\d\s]{1,10}[,\.][\d]{2})/i;
    const mSS = text.match(basePat);
    if (mSS) r.base_ss = mSS[1].replace(/\s/g,"").replace(",",".");
  }
  // ── Exonérations de cotisations employeur ──
  // Convention comptable : l'exonération est une RÉDUCTION de charges patronales.
  // Dans le PDF, elle apparaît soit avec "- XX.XX" (c'est une déduction = montant positif côté Neoptim)
  // soit sans signe (rare, erreur de logiciel).
  // Règle : si le PDF affiche "- XX.XX" → stocker +XX.XX (réduction réelle)
  //         si le PDF affiche "+XX.XX" ou juste "XX.XX" sans tiret → stocker -XX.XX (anomalie)
  if (!r.exonerations) {
    // Pattern avec tiret (cas normal) : capturer la valeur absolue → positive
    const exoNeg = /[Ee]xon[eé]rations?\s+de\s+cotisations?\s+employeur[^\n\d\-]*-\s*([\d\s]+[,\.][\d]{2})/i;
    const mNeg = text.match(exoNeg);
    if (mNeg) {
      r.exonerations = mNeg[1].replace(/\s/g,"").replace(",",".");
    } else {
      // Pattern sans tiret (cas inversé) : valeur positive dans le PDF → stocker négative
      const exoPos = /[Ee]xon[eé]rations?\s+de\s+cotisations?\s+employeur[^\n\d\-]*\+?\s*([\d\s]+[,\.][\d]{2})/i;
      const mPos = text.match(exoPos);
      if (mPos) r.exonerations = "-" + mPos[1].replace(/\s/g,"").replace(",",".");
    }
  }
  // Format Allègement (Sage/Foyer): "Allègement des cotisations employeur  XXX.XX" → toujours positif
  if (!r.exonerations) {
    const allPat = /[Aa]ll[eè]gements?\s+(?:de\s+)?(?:cotisations?\s+)?(?:employeur)?\s*[:\-]?\s*([\d\s]+[,\.][\d]{2})/i;
    const mAll = text.match(allPat);
    if (mAll) r.exonerations = mAll[1].replace(/\s/g,"").replace(",",".");
  }

  return r;
}
async function loadPDFJS() {
  if (window.pdfjsLib) return window.pdfjsLib;
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.integrity = "sha512-q7h5gXVAv3bkLhHqrpNqh1LPW2ovlcVifB97KFpakqHZBXzMVQOXbdnkCpLuvWVKQbVlMPOTJ9JY2T3vOEMJg==";
    s.crossOrigin = "anonymous";
    s.referrerPolicy = "no-referrer";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      res(window.pdfjsLib);
    };
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

let _tessWorker = null;
async function getTessWorker() {
  if (_tessWorker) return _tessWorker;
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      // Version épinglée exacte — évite le chargement d'une version inconnue via @5 flottant.
      // Pour vérifier l'intégrité : sha384 de https://unpkg.com/tesseract.js@5.0.4/dist/tesseract.min.js
      s.src = "https://unpkg.com/tesseract.js@5.0.4/dist/tesseract.min.js";
      s.crossOrigin = "anonymous";
      s.referrerPolicy = "no-referrer";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  _tessWorker = await window.Tesseract.createWorker("fra", 1, { logger: () => {} });
  return _tessWorker;
}

async function ocrPage(pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 2.0 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width; canvas.height = viewport.height;
  await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  const w = await getTessWorker();
  const { data: { text } } = await w.recognize(canvas);
  return text;
}

// ─── RGPD — worker cleanup ────────────────────────────────────────────────────
export function terminateTessWorker() {
  if (_tessWorker) { _tessWorker.terminate(); _tessWorker = null; }
}

// ─── RGPD — sanitisation du texte brut ───────────────────────────────────────
// Supprime les données à caractère personnel avant tout stockage en mémoire :
// NIR, IBAN, coordonnées (adresses, téléphones, emails), noms propres en contexte
// d'identification directe. Limite à 20 lignes pour réduire la surface d'exposition.
function sanitizeRawText(text) {
  if (!text) return "";
  return text
    // NIR (numéro de sécurité sociale)
    .replace(/[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}/g, "[NIR masqué]")
    // IBAN / RIB
    .replace(/\b[A-Z]{2}\d{2}[\s\dA-Z]{10,32}\b/g, "[IBAN masqué]")
    // Téléphone (formats FR)
    .replace(/\b0[1-9](?:[\s.\-]?\d{2}){4}\b/g, "[Tél masqué]")
    // Email
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[Email masqué]")
    // Adresse postale : numéro + rue/avenue/etc.
    .replace(/\d{1,4}\s+(?:rue|avenue|av\.|bd|boulevard|impasse|chemin|allée|route|voie|place|résidence|lieu[- ]dit)[^,\n]{0,60}/gi, "[Adresse masquée]")
    // Code postal + ville (pattern FR)
    .replace(/\b\d{5}\s+[A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ][A-ZÀ-Üa-z\s\-]{2,40}\b/g, "[Ville masquée]")
    // Civilité + nom : "Mme/M./Monsieur/Madame DUPONT Prénom" ou "Mme DUPONT"
    .replace(/\b(?:Mme?\.?|Mlle?\.?|Monsieur|Madame|M\.)\s+[A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ][A-Za-zÀ-ÿ\s\-]{1,40}/g, "[Identité masquée]")
    // Noms en MAJUSCULES précédés d'un prénom (ex: "DUPONT Jean")
    .replace(/\b[A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ]{2,}(?:\s+[A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ]{2,})*\s+[A-ZÀÂÉÈÊËÎÏÔÙÛÜÇ][a-zàâéèêëîïôùûüç]{2,}/g, "[Identité masquée]")
    // Numéro de sécurité sociale sans tirets (15 chiffres continus)
    .replace(/\b\d{15}\b/g, "[NIR masqué]")
    // Limiter à 20 lignes
    .split("\n").slice(0, 20).join("\n");
}

// ─── HISTORIQUE DE PAIE parser ───────────────────────────────────────────────
// Parses annual historique format: 1 employee = multi-page table, 12 month columns.
// Returns one bulletin per month with data.

const MOIS_SANS_ACCENT_HIST = ["janvier","fevrier","mars","avril","mai","juin","juillet","aout","septembre","octobre","novembre","decembre"];

function parseHistoriqueEmployee({ matricule, year, allItems }) {
  const rows = groupItemsByY(allItems);
  const fullText = allItems.map(i => i.str).join(" ");

  // ── Établissement from "EH XXXXX EHPAD DU HAUT LEON" line ──
  let etablissement = "";
  for (const row of rows) {
    const txt = row.map(i => i.str).join(" ").trim();
    const m = txt.match(/^EH\s+\d+\s+(.{3,60}?)(?:\s{3,}|PH7|DATE|$)/);
    if (m) { etablissement = m[1].trim(); break; }
  }

  // ── Régime & type contrat from cotisation codes ──
  let regime = "", typeContrat = "";
  if (/\bCNRACL\b/.test(fullText))                                   { regime = "CNRACL";         typeContrat = "Titulaire"; }
  else if (/\bIRCANTEC\b/.test(fullText))                            { regime = "IRCANTEC";        typeContrat = "Contractuel"; }
  else if (/Assurance\s+[Cc]hom|P[ôo]le\s+[Ee]mploi/.test(fullText)){ regime = "Régime général";  typeContrat = "Contractuel"; }

  // ── Find month column header row → X positions ──
  let monthXMap = {}; // moisIdx (0-11) → X coordinate of column header
  for (const row of rows) {
    const rowTexts = row.map(i =>
      i.str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim()
    );
    if (rowTexts.includes("janvier") && rowTexts.includes("fevrier")) {
      for (const item of row) {
        const norm = item.str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
        const idx = MOIS_SANS_ACCENT_HIST.indexOf(norm);
        if (idx >= 0) monthXMap[idx] = item.transform[4];
      }
      break;
    }
  }

  if (Object.keys(monthXMap).length === 0) return [];

  // Sort month columns by X (they should already be left→right)
  const monthCols = Object.entries(monthXMap)
    .map(([idx, x]) => ({ idx: Number(idx), x }))
    .sort((a, b) => a.x - b.x);

  const lastColX = monthCols[monthCols.length - 1].x;

  // Given an item's X, return which month column it belongs to (-1 = TOTAL/outside)
  function xToMonthIdx(x) {
    if (x > lastColX + 50) return -1; // TOTAL column or beyond
    let best = -1, bestDist = Infinity;
    for (const { idx, x: colX } of monthCols) {
      const d = Math.abs(x - colX);
      if (d < bestDist) { bestDist = d; best = idx; }
    }
    return bestDist < 80 ? best : -1;
  }

  // ── Parse data rows ──
  const monthData = {}; // moisIdx → { heures, assiette, base_ss }

  for (const row of rows) {
    const rowText = row.map(i => i.str).join(" ");
    const isNbHeures = /\bNb\s+Heures\b/i.test(rowText);
    const isTotalBrut = /\*{3}\s*TOTAL\s+BRUT\s*\*{3}/i.test(rowText);
    const isBaseSS    = /\b720\b/.test(rowText.substring(0, 8)) && /Base\s+S\.?S\b/i.test(rowText);
    if (!isNbHeures && !isTotalBrut && !isBaseSS) continue;

    for (const item of row) {
      const raw = item.str.trim();
      // Match monetary/hour values: "151,67" "2798,46" "3010,30" (but not codes like "100/100")
      if (!/^-?\d{1,6}[,\.]\d{2}$/.test(raw)) continue;
      const val = raw.replace(",", ".");
      const mIdx = xToMonthIdx(item.transform[4]);
      if (mIdx < 0) continue;
      if (!monthData[mIdx]) monthData[mIdx] = {};
      if (isNbHeures  && !monthData[mIdx].heures)   monthData[mIdx].heures   = val;
      if (isTotalBrut && !monthData[mIdx].brut)     monthData[mIdx].brut     = val;
      if (isBaseSS    && !monthData[mIdx].base_ss)   monthData[mIdx].base_ss  = val;
    }
  }

  // ── Build one bulletin per month with data ──
  const bulletins = [];
  for (let mIdx = 0; mIdx < 12; mIdx++) {
    const md = monthData[mIdx];
    if (!md || !md.brut || parseFloat(md.brut) === 0) continue;
    bulletins.push({
      data: {
        etablissement,
        matricule,
        type_contrat: typeContrat,
        fonction:     "",
        regime,
        mois:         capitalizeMois(MOIS_NOMS[mIdx]),
        annee:        year,
        heures:       md.heures       || "",
        base_ss:      md.base_ss      || "",
        exonerations: md.exonerations || "",
      },
      rawText: sanitizeRawText(`[HISTORIQUE] ${etablissement} — Matricule ${matricule} — ${capitalizeMois(MOIS_NOMS[mIdx])} ${year}`),
    });
  }
  return bulletins;
}

async function extractHistorique(pdf, total, onProgress) {
  const employees = []; // { matricule, year, allItems }
  let current = null;

  for (let i = 1; i <= total; i++) {
    onProgress && onProgress(`Page ${i}/${total}`, Math.round((i-1)/total*90), false);
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items   = content.items.filter(it => it.str && it.str.trim());
    const text    = items.map(it => it.str).join(" ");

    const matMatch = text.match(/MATRICULE\s*[:\s]+(\d{3,10})/i);
    if (matMatch) {
      const mat = matMatch[1].trim();
      if (!current || current.matricule !== mat) {
        if (current) employees.push(current);
        const yearMatch = text.match(/\b(202\d)\b/);
        current = { matricule: mat, year: yearMatch ? yearMatch[1] : "2023", allItems: [...items] };
      } else {
        current.allItems.push(...items);
      }
    } else if (current) {
      current.allItems.push(...items); // continuation page
    }
  }
  if (current) employees.push(current);

  const all = [];
  for (const emp of employees) all.push(...parseHistoriqueEmployee(emp));

  onProgress && onProgress("Terminé", 100, false);
  return all.length > 0 ? all : [{}];
}

// ─── BULLETIN ANNUALISÉ parser (salebulind / CCAS type) ─────────────────────
// Handles both single-agent and multi-agent (batch) files.
// Each agent occupies 2-N pages; matricule changes = new agent.

const BASE_SS_RUBRIQUES_ANNUEL = new Set(["44","4082","45","46","389","47","50","52","1965"]);

function extractAnnualiseHeader(pageItems, sharedEtablissement) {
  const lines = groupItemsByY(pageItems);
  const text  = lines.map(l => l.map(i => i.str).join(" ").trim()).filter(Boolean).join("\n");

  let etablissement = sharedEtablissement || "";
  if (!etablissement) {
    const bpIdx = text.search(/BULLETIN\s+DE\s+PAIE/i);
    if (bpIdx > 0) {
      const before = text.substring(0, bpIdx).trim().split("\n").map(l=>l.trim()).filter(Boolean);
      for (const l of before) {
        if (/^(CCAS|MAIRIE|Centre\s+communal)/i.test(l)) { etablissement = l; break; }
      }
      if (!etablissement && before.length > 0) etablissement = before[0];
    }
  }

  let annee = "";
  const pm = text.match(/(\d{2})-(\d{2})-(\d{4})\s*[-–]\s*\d{2}-\d{2}-\d{4}/);
  if (pm) annee = pm[3];

  let matricule = "";
  for (const l of lines) {
    const txt = l.map(i => i.str).join(" ").trim();
    const m = txt.match(/^(\d{3,10})\s+[A-Z]\s+\d{10,}\s/);
    if (m) { matricule = m[1]; break; }
  }

  let regime = "", typeContrat = "";
  for (const l of lines) {
    const txt = l.map(i => i.str).join(" ").trim();
    if (/Titulaire\s+CNRACL/i.test(txt))                   { typeContrat = "Titulaire";   regime = "CNRACL";         break; }
    if (/Tit\.\s+CNR/i.test(txt))                           { typeContrat = "Titulaire";   regime = "CNRACL";         break; }
    if (/Titulaire\s+IRCANTEC/i.test(txt))                  { typeContrat = "Titulaire";   regime = "IRCANTEC";       break; }
    if (/Contractuel\s+(?:indic\.|permanent|Remplaçant)/i.test(txt)) { typeContrat = "Contractuel"; regime = "Régime général"; break; }
    if (/Contractuel[le]?\s+CNRACL/i.test(txt))             { typeContrat = "Contractuel"; regime = "CNRACL";         break; }
    if (/Horaire\s+indiciaire/i.test(txt))                  { typeContrat = "Contractuel"; regime = "Régime général"; break; }
    if (/Cong[eé]\s+parental/i.test(txt))                     { typeContrat = "Contractuel"; regime = "Régime général"; break; }
    if (/Apprenti/i.test(txt) && !typeContrat)              { typeContrat = "Apprenti";    regime = "Régime général"; break; }
    if (/Contractuel/i.test(txt) && !typeContrat)           { typeContrat = "Contractuel";                            }
  }
  if (!regime && /IRCANTEC/i.test(text)) regime = "IRCANTEC";
  if (!regime && /CNRACL/i.test(text))   regime = "CNRACL";
  if (!regime) regime = "Régime général";

  let fonction = "";
  for (const l of lines) {
    const txt = l.map(i => i.str).join(" ").trim();
    const fm = txt.match(/^(.+?)\s+(\d{2})\s+([\d\s]+\.\d{2})\s*$/);
    if (fm) {
      const candidate = fm[1].trim();
      if (/^[A-Za-zÀ-ÿ]/.test(candidate) && candidate.length >= 4) { fonction = candidate; break; }
    }
  }

  return { etablissement, annee, matricule, regime, typeContrat, fonction };
}

function extractAnnualiseFinancials(agentPageItems) {
  const BASE_X_MIN = 265, BASE_X_MAX = 340;
  // For RG agents, base SS rubriques are different (59/1510 or 61/64/1525 in BASE col)
  const BASE_SS_RG = new Set(["59","1510","61","64","1525"]);
  let heures = "", base_ss = "";
  let regimeFromCode = ""; // detected from rubrique 48 or 67

  for (const pageItems of agentPageItems) {
    const lines = groupItemsByY(pageItems);
    for (const line of lines) {
      if (!line.length) continue;
      const sorted = line.sort((a, b) => a.transform[4] - b.transform[4]);
      const firstWord = sorted[0].str.trim();

      // ── Régime from rubriques ──
      // 48 C.N.R.A.C.L Retraite → CNRACL
      // 67 Retraite Ircantec    → IRCANTEC
      if (!regimeFromCode && firstWord === "48") regimeFromCode = "CNRACL";
      if (!regimeFromCode && firstWord === "67") regimeFromCode = "IRCANTEC";

      // ── Base SS — CNRACL rubriques ──
      if (BASE_SS_RUBRIQUES_ANNUEL.has(firstWord) && !base_ss) {
        const baseParts = sorted.filter(i => i.transform[4] >= BASE_X_MIN && i.transform[4] <= BASE_X_MAX);
        const baseStr = baseParts.map(i => i.str.replace(/\s/g,"")).join("").replace(",",".");
        if (baseStr && /\d/.test(baseStr)) base_ss = baseStr;
      }

      // ── Base SS — Régime Général rubriques ──
      if (BASE_SS_RG.has(firstWord) && !base_ss) {
        const baseParts = sorted.filter(i => i.transform[4] >= BASE_X_MIN && i.transform[4] <= BASE_X_MAX);
        const baseStr = baseParts.map(i => i.str.replace(/\s/g,"")).join("").replace(",",".");
        if (baseStr && /\d/.test(baseStr) && parseFloat(baseStr) > 100) base_ss = baseStr;
      }

      // ── Heures — from totaux row at bottom ──
      if (!heures) {
        const decItems = sorted.filter(i => /^\d+[.,]\d{2}$/.test(i.str.trim()));
        if (decItems.length >= 4 && decItems[0].transform[4] < 150) {
          const hDecItem = decItems.find(i => i.transform[4] >= 255 && i.transform[4] <= 325);
          if (hDecItem) {
            const hVal = parseFloat(hDecItem.str.replace(",","."));
            if (hVal > 0 && hVal < 3000) {
              const leading = sorted.filter(i => /^\d+$/.test(i.str.trim())
                && i.transform[4] < hDecItem.transform[4]
                && i.transform[4] >= hDecItem.transform[4] - 40);
              const h = leading.length > 0
                ? parseFloat(leading[leading.length-1].str + hDecItem.str.replace(",","."))
                : hVal;
              if (h > 0 && h < 3000) heures = h.toFixed(2);
            }
          }
        }
      }
    }
  }
  return { heures, base_ss, regimeFromCode };
}

function getPageMatricule(pageItems) {
  const lines = groupItemsByY(pageItems);
  for (const l of lines) {
    const txt = l.map(i => i.str).join(" ").trim();
    const m = txt.match(/^(\d{3,10})\s+[A-Z]\s+\d{10,}\s/);
    if (m) return m[1];
  }
  return null;
}

async function extractAnnualise(pdf, total, onProgress) {
  const allPageItems = [];
  for (let i = 1; i <= total; i++) {
    onProgress && onProgress(`Page ${i}/${total}`, Math.round((i-1)/total*90), false);
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    allPageItems.push(content.items);
  }

  // Extract établissement once from first page
  let sharedEtablissement = "";
  {
    const p1Text = groupItemsByY(allPageItems[0]).map(l=>l.map(i=>i.str).join(" ").trim()).filter(Boolean).join("\n");
    const bpIdx  = p1Text.search(/BULLETIN\s+DE\s+PAIE/i);
    if (bpIdx > 0) {
      const before = p1Text.substring(0,bpIdx).trim().split("\n").map(l=>l.trim()).filter(Boolean);
      for (const l of before) {
        if (/^(CCAS|MAIRIE|Centre\s+communal)/i.test(l)) { sharedEtablissement = l; break; }
      }
      if (!sharedEtablissement && before.length > 0) sharedEtablissement = before[0];
    }
  }

  // Group consecutive pages by matricule
  const agentGroups = [];
  let currentMat = null, currentPages = [];
  for (const pageItems of allPageItems) {
    const mat = getPageMatricule(pageItems);
    if (!mat) continue;
    if (mat !== currentMat) {
      if (currentPages.length > 0) agentGroups.push({ matricule: currentMat, pages: currentPages });
      currentMat = mat;
      currentPages = [pageItems];
    } else {
      currentPages.push(pageItems);
    }
  }
  if (currentPages.length > 0) agentGroups.push({ matricule: currentMat, pages: currentPages });

  // Build one bulletin per agent
  const results = [];
  for (const { pages } of agentGroups) {
    const h   = extractAnnualiseHeader(pages[0], sharedEtablissement);
    const fin = extractAnnualiseFinancials(pages);
    // Régime from rubrique codes (48=CNRACL, 67=IRCANTEC) is authoritative
    const regime = fin.regimeFromCode || h.regime;
    const rawText = sanitizeRawText(`[ANNUALISÉ] ${h.etablissement} — Mat. ${h.matricule} — ${h.annee}`);
    results.push({
      data: {
        etablissement: h.etablissement || sharedEtablissement,
        matricule:     h.matricule,
        type_contrat:  h.typeContrat,
        fonction:      h.fonction,
        regime,
        mois:          "",
        annee:         h.annee,
        heures:        fin.heures,
        base_ss:       fin.base_ss,
        exonerations:  "",
      },
      rawText,
    });
  }

  onProgress && onProgress("Terminé", 100, false);
  return results;
}

async function extractFromPDF(file, onProgress) {
  const pdfjsLib = await loadPDFJS();
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const total = pdf.numPages;

  // Detect format from first page
  const firstPage = await pdf.getPage(1);
  const firstText = (await firstPage.getTextContent()).items.map(it => it.str).join(" ");
  if (/HISTORIQUE\s+DE\s+PAIE/i.test(firstText)) {
    return await extractHistorique(pdf, total, onProgress);
  }
  // Annualisé format: period "DD-MM-YYYY - DD-MM-YYYY" with no month name, uses rubrique codes
  if (/\d{2}-\d{2}-\d{4}\s*[-–]\s*\d{2}-\d{2}-\d{4}/.test(firstText) && /salebulind|PERIODE\s+DE\s+PAIE/i.test(firstText)) {
    return await extractAnnualise(pdf, total, onProgress);
  }

  let globalCtx = {};
  const bulletins = new Map(); // "matricule__mois" → data

  for (let i = 1; i <= total; i++) {
    const pct = Math.round((i-1)/total * 90);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const charCount = content.items.reduce((n,it) => n + (it.str||"").replace(/\s/g,"").length, 0);
    let text;
    if (charCount < 40) {
      onProgress && onProgress(`Page ${i}/${total} — OCR scan…`, pct, true);
      try { text = await ocrPage(page); }
      catch { text = itemsToLines(content.items); }
    } else {
      onProgress && onProgress(`Page ${i}/${total}`, pct, false);
      text = itemsToLines(content.items);
    }

    const ex = extractFromLines(text);

    // Skip pages that don't look like bulletins
    if (!ex.matricule && !ex.mois) continue;

    // Merge: prefer page-specific values, fall back on globalCtx for stable fields
    const merged = {
      etablissement: ex.etablissement || globalCtx.etablissement || "",
      matricule:     ex.matricule     || globalCtx.matricule     || "",
      type_contrat:  ex.type_contrat  || globalCtx.type_contrat  || "",
      fonction:      ex.fonction      || globalCtx.fonction      || "",
      regime:        ex.regime        || globalCtx.regime        || "",
      mois:          ex.mois          || "",
      annee:         ex.annee         || "",
      heures:        ex.heures        || "",
      base_ss:       ex.base_ss      || "",
      exonerations:  ex.exonerations || "",
    };

    // Update stable context (fields that don't change per page in a batch)
    ["etablissement","type_contrat","fonction","regime"].forEach(k => { if (merged[k]) globalCtx[k] = merged[k]; });
    if (merged.matricule) globalCtx.matricule = merged.matricule;

    const key = `${merged.matricule}__${merged.mois}__${merged.annee}`;
    if (bulletins.has(key)) {
      const prev = bulletins.get(key);
      FIELDS.forEach(f => { if (!prev.data[f.key] && merged[f.key]) prev.data[f.key] = merged[f.key]; });
      prev.rawText = sanitizeRawText(prev.rawText + "\n\n--- page suivante ---\n\n" + text);
    } else {
      bulletins.set(key, { data: { ...merged }, rawText: sanitizeRawText(text) });
    }
  }

  onProgress && onProgress("Terminé", 100, false);
  return bulletins.size > 0 ? Array.from(bulletins.values()) : [{ data: {}, rawText: "" }];
}

// ─── Excel extraction ─────────────────────────────────────────────────────────
const EXCEL_MAPPINGS = {
  etablissement: ["etablissement","nom etablissement","societe","employeur","raison sociale","structure","collectivite"],
  matricule:     ["matricule","mat","numero salarie","id salarie","numero employe","num agent","n agent"],
  type_contrat:  ["type contrat","contrat","nature contrat","statut","titulaire","contractuel","categorie"],
  fonction:      ["fonction","poste","emploi","libelle emploi","qualification","grade","cadre emploi"],
  regime:        ["regime","regime cotisation","caisse","cnracl","ircantec"],
  mois:          ["mois","periode","mois paie","periode paie","date paie","mois de paie"],
  annee:         ["annee","année","an","year"],
  heures:        ["heures","nb heures","nombre heures","h remunerees","horaire","volume horaire","heures mensuelles","heures travaillees","total heures"],
  base_ss:       ["base ss","base ss maladie","base maladie","720 base","base securite sociale"],
  exonerations:  ["exonerations","exoneration","allegement","allegements cotisations","reduction fillon"],
};

function matchExcelHeader(h) {
  const n = h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
  for (const [f, aliases] of Object.entries(EXCEL_MAPPINGS)) {
    if (aliases.some(a => n.includes(a) || a.includes(n))) return f;
  }
  return null;
}

function extractFromExcel(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type:"array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:"" });
        if (!rows.length) { res([]); return; }
        let hRow = 0;
        for (let i = 0; i < Math.min(5, rows.length); i++) {
          if (rows[i].filter(c => c && String(c).trim()).length >= 3) { hRow = i; break; }
        }
        const mapping = {};
        rows[hRow].forEach((h, idx) => { const f = matchExcelHeader(String(h)); if (f) mapping[f] = idx; });
        const results = [];
        for (let r = hRow+1; r < rows.length; r++) {
          const row = rows[r];
          if (!row.some(c => c !== "")) continue;
          const entry = {};
          FIELDS.forEach(({ key }) => {
            const raw = mapping[key] !== undefined ? String(row[mapping[key]]||"").trim() : "";
            entry[key] = key === "mois" ? normalizeMois(raw) : raw;
          });
          if (!entry.regime && entry.type_contrat) entry.regime = computeRegime(entry.type_contrat, "");
          results.push(entry);
        }
        res(results);
      } catch(err) { rej(err); }
    };
    reader.onerror = rej;
    reader.readAsArrayBuffer(file);
  });
}

// ─── CSV export ───────────────────────────────────────────────────────────────
const NUMERIC_FIELDS = new Set(["heures","base_ss","exonerations"]);

function generateCSV(rows) {
  const BOM = "\uFEFF";
  const hdr = FIELDS.map(f => f.label).join(";");
  const lines = rows.map(row =>
    FIELDS.map(f => {
      let v = row.data[f.key] || "";
      // Virgule comme séparateur décimal pour les champs numériques
      if (NUMERIC_FIELDS.has(f.key) && v) v = v.replace(".", ",");
      return (v.includes(";") || v.includes('"')) ? `"${v.replace(/"/g,'""')}"` : v;
    }).join(";")
  );
  return BOM + [hdr, ...lines].join("\r\n");
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function ProgressBar({ value }) {
  return (
    <div style={{ height:3, background:"#F0F3F7", borderRadius:2, overflow:"hidden", marginTop:5 }}>
      <div style={{ height:"100%", width:`${value}%`, borderRadius:2, transition:"width 0.3s",
        background:"linear-gradient(90deg,#1d4ed8,#0ea5e9)" }} />
    </div>
  );
}

function StatusBadge({ status }) {
  const M = {
    waiting:["#1e293b","#94a3b8","En attente"], processing:["#1e3a5f","#60a5fa","Traitement…"],
    ocr:["#1a2e44","#f59e0b","OCR scan…"], done:["#14532d","#4ade80","Extrait"], error:["#450a0a","#f87171","Erreur"],
  };
  const [bg,color,label] = M[status]||M.waiting;
  return <span style={{ padding:"2px 10px", borderRadius:20, fontSize:11, fontWeight:700,
    background:bg, color, letterSpacing:0.5, textTransform:"uppercase", whiteSpace:"nowrap" }}>{label}</span>;
}

function EditableCell({ value, onChange, missing }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef();
  useEffect(() => setDraft(value), [value]);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);
  return editing ? (
    <input ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); onChange(draft); }}
      onKeyDown={e => { if(e.key==="Enter"){setEditing(false);onChange(draft);} if(e.key==="Escape"){setEditing(false);setDraft(value);} }}
      style={{ width:"100%", background:"#FFFFFF", color:"#203860", border:"1px solid #E86410",
        borderRadius:4, padding:"3px 6px", fontSize:12, outline:"none", fontFamily:"inherit" }} />
  ) : (
    <div onClick={() => setEditing(true)} title="Cliquer pour modifier"
      style={{ cursor:"text", padding:"3px 6px", borderRadius:4, minHeight:24,
        background: missing ? "rgba(232,100,16,0.08)" : "transparent",
        color: missing ? "#E86410" : value ? "#203860" : "#C8D4E0",
        border:"1px solid transparent", fontSize:12, transition:"border-color 0.15s" }}
      onMouseEnter={e => e.currentTarget.style.borderColor="#E8ECF0"}
      onMouseLeave={e => e.currentTarget.style.borderColor="transparent"}>
      {value || <span style={{ fontStyle:"italic", fontSize:11 }}>—</span>}
    </div>
  );
}

function DiagModal({ row, onClose }) {
  if (!row) return null;
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(32,56,96,0.4)", zIndex:1000,
      display:"flex", alignItems:"center", justifyContent:"center", padding:20, backdropFilter:"blur(2px)" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:"#FFFFFF", border:"1px solid #E8ECF0",
        borderRadius:12, width:"100%", maxWidth:860, maxHeight:"85vh", display:"flex", flexDirection:"column",
        overflow:"hidden", boxShadow:"0 8px 40px rgba(32,56,96,0.15)" }}>
        {/* Header */}
        <div style={{ padding:"14px 20px", borderBottom:"1px solid #E8ECF0", display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ fontSize:14, color:"#E86410", fontWeight:700,
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>🔍 Texte brut extrait</span>
          <span style={{ fontSize:11, color:"#8A97A8", flex:1,
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            {row.fileName} — {row.data.matricule} {row.data.mois} {row.data.annee}
          </span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#A0AABC",
            cursor:"pointer", fontSize:18, lineHeight:1 }}>×</button>
        </div>
        {/* Fields summary */}
        <div style={{ padding:"10px 20px", borderBottom:"1px solid #E8ECF0", display:"flex", flexWrap:"wrap", gap:"6px 16px",
          background:"#F7F8FA" }}>
          {FIELDS.map(f => (
            <span key={f.key} style={{ fontSize:11, fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
              <span style={{ color:"#8A97A8" }}>{f.label}: </span>
              <span style={{ color: row.data[f.key] ? "#2E7D52" : "#C0392B", fontWeight:600 }}>
                {row.data[f.key] || "—"}
              </span>
            </span>
          ))}
        </div>
        {/* Raw text */}
        <div style={{ flex:1, overflowY:"auto", padding:"14px 20px" }}>
          <div style={{ fontSize:10, color:"#A0AABC", marginBottom:8, letterSpacing:1, textTransform:"uppercase",
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            Texte reconstruit par pdfjs (base des extractions)
          </div>
          <pre style={{ fontSize:11, color:"#203860", whiteSpace:"pre-wrap", wordBreak:"break-word",
            background:"#F7F8FA", padding:"12px 14px", borderRadius:8, border:"1px solid #E8ECF0",
            margin:0, lineHeight:1.6, fontFamily:"'DM Mono','Courier New',monospace" }}>
            {row.rawText || "(texte non disponible — format Excel ou Historique)"}
          </pre>
        </div>
        <div style={{ padding:"10px 20px", borderTop:"1px solid #E8ECF0", fontSize:11, color:"#A0AABC",
          fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
          Cliquez en dehors pour fermer — copiez le texte et partagez-le pour corriger les patterns
        </div>
      </div>
    </div>
  );
}
function ExtractionAAD() {
  const [files, setFiles]         = useState([]);
  const [rows, setRows]           = useState([]);
  const [dragging, setDragging]   = useState(false);
  const [inclIncomp, setInclIncomp] = useState(false);
  const [diagRow, setDiagRow]     = useState(null);
  const fileInputRef = useRef();
  const nextId = useRef(1);

  // Correction 1 — préchargement CDN pdfjs au montage (silencieux)
  useEffect(() => { loadPDFJS().catch(() => {}); }, []);

  // Correction 2 — destruction du worker Tesseract au démontage
  useEffect(() => () => { terminateTessWorker(); }, []);

  const patchFile = useCallback((id, patch) =>
    setFiles(prev => prev.map(f => f.id===id ? {...f,...patch} : f)), []);

  const processFiles = useCallback(async newFiles => {
    const entries = Array.from(newFiles).map(f => ({
      id:nextId.current++, name:f.name, status:"waiting",
      error:null, progress:0, pageInfo:"", count:0, file:f,
    }));
    setFiles(prev => [...prev, ...entries]);

    for (const entry of entries) {
      patchFile(entry.id, { status:"processing", progress:5 });
      try {
        const ext = entry.name.split(".").pop().toLowerCase();
        let extracted = [];
        if (ext === "pdf") {
          const dataRows = await extractFromPDF(entry.file, (info, pct, isOCR) =>
            patchFile(entry.id, { status:isOCR?"ocr":"processing", pageInfo:info, progress:pct })
          );
          extracted = dataRows.map(r => ({ id:nextId.current++, fileName:entry.name, data: r.data || r, rawText: r.rawText || "", missing:[] }));
        } else if (["xlsx","xls","csv"].includes(ext)) {
          const dataRows = await extractFromExcel(entry.file);
          extracted = dataRows.map(data => ({ id:nextId.current++, fileName:entry.name, data, rawText: "", missing:[] }));
        } else {
          throw new Error("Format non supporté");
        }
        extracted = extracted.map(r => ({ ...r, missing: FIELDS.filter(f => !r.data[f.key]).map(f=>f.key) }));
        setRows(prev => [...prev, ...extracted]);
        patchFile(entry.id, { status:"done", progress:100, count:extracted.length, pageInfo:"" });
      } catch(err) {
        patchFile(entry.id, { status:"error", error:err.message, progress:0 });
      }
    }
  }, [patchFile]);

  const handleDrop = useCallback(e => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); }, [processFiles]);

  // Correction 2 — purge mémoire + worker à la réinitialisation
  const handleClearAll = useCallback(() => {
    setFiles([]);
    setRows([]);
    terminateTessWorker();
  }, []);

  const updateCell = (rowId, field, value) =>
    setRows(prev => prev.map(r => {
      if (r.id!==rowId) return r;
      const d = {...r.data, [field]:value};
      // Re-derive regime if statut changes
      if (field==="type_contrat") { const x = computeRegime(value,""); if(x) d.regime=x; }
      return { ...r, data:d, missing:FIELDS.filter(f=>!d[f.key]).map(f=>f.key) };
    }));

  const exportCSV = () => {
    const toExport = inclIncomp ? rows : rows.filter(r => !r.missing || r.missing.length === 0);
    const csv  = generateCSV(toExport);
    const blob = new Blob([csv], { type:"text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const d    = new Date();
    a.href     = url;
    a.download = `extraction_paie_${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}.csv`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const totalRows  = rows.length;
  const doneFiles  = files.filter(f=>f.status==="done").length;
  const errFiles   = files.filter(f=>f.status==="error").length;
  const missRows   = rows.filter(r=>r.missing?.length>0).length;
  const hasOCR     = files.some(f=>f.status==="ocr");

  return (
    <div style={{ fontFamily:"'DM Mono','Courier New',monospace", background:"#F7F8FA", minHeight:"100vh", color:"#203860" }}>
      <DiagModal row={diagRow} onClose={() => setDiagRow(null)} />

      {/* Header — charte Neoptim */}
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #E8ECF0",
        padding:"16px 28px", display:"flex", alignItems:"center", gap:14,
        boxShadow:"0 1px 4px rgba(32,56,96,0.04)" }}>
        <div style={{ width:38, height:38, borderRadius:8, background:"#203860",
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>📊</div>
        <div>
          <div style={{ fontSize:14, fontWeight:700, color:"#203860",
            fontFamily:"'Montserrat','Segoe UI',sans-serif", letterSpacing:"-0.01em" }}>
            Extraction Bulletins — CS AAD
          </div>
          <div style={{ fontSize:11, color:"#8A97A8", marginTop:2,
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            PDF (texte + scan) · XLSX · XLS · CSV — 1 ligne / matricule / mois
          </div>
        </div>
        {totalRows > 0 && (
          <div style={{ marginLeft:"auto", display:"flex", gap:16, fontSize:11,
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            <span style={{ color:"#2E7D52", fontWeight:600 }}>{totalRows} ligne{totalRows>1?"s":""}</span>
            <span style={{ color:"#203860" }}>{doneFiles} fichier{doneFiles>1?"s":""}</span>
            {missRows>0 && <span style={{ color:"#E86410", fontWeight:600 }}>{missRows} incomplet{missRows>1?"s":""}</span>}
            {errFiles>0  && <span style={{ color:"#C0392B", fontWeight:600 }}>{errFiles} erreur{errFiles>1?"s":""}</span>}
          </div>
        )}
      </div>

      <div style={{ padding:"20px 28px", display:"flex", flexDirection:"column", gap:14, background:"#F7F8FA" }}>

        {/* Drop zone */}
        <div onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)}
          onDrop={handleDrop} onClick={()=>fileInputRef.current.click()}
          style={{ border:`2px dashed ${dragging?"#E86410":"#D4DCE8"}`, borderRadius:10, padding:"26px 20px",
            textAlign:"center", cursor:"pointer", transition:"all 0.2s",
            background:dragging?"rgba(232,100,16,0.04)":"#FFFFFF",
            boxShadow:dragging?"0 0 20px rgba(232,100,16,0.1)":"none" }}>
          <div style={{ fontSize:26, marginBottom:6 }}>📂</div>
          <div style={{ fontSize:13, color:"#6A7A8A", marginBottom:3 }}>Glissez vos fichiers ici, ou cliquez pour parcourir</div>
          <div style={{ fontSize:11, color:"#A0AABC" }}>PDF sélectionnable ou scanné · XLSX · XLS · CSV — plusieurs fichiers acceptés</div>
          <input ref={fileInputRef} type="file" multiple accept=".pdf,.xlsx,.xls,.csv"
            onChange={e=>{processFiles(e.target.files);e.target.value="";}} style={{ display:"none" }} />
        </div>

        {/* OCR notice */}
        {hasOCR && (
          <div style={{ background:"rgba(232,100,16,0.06)", border:"1px solid rgba(232,100,16,0.2)",
            borderRadius:8, padding:"10px 14px", fontSize:12, color:"#E86410", display:"flex", gap:8 }}>
            <span>⚙️</span>
            <span>OCR en cours — moteur Tesseract (~10 Mo) téléchargé au premier usage, puis extraction page par page.</span>
          </div>
        )}

        {/* File list */}
        {files.length > 0 && (
          <div style={{ background:"#FFFFFF", borderRadius:10, border:"1px solid #E8ECF0", overflow:"hidden",
            boxShadow:"0 1px 4px rgba(32,56,96,0.04)" }}>
            {files.map((f,i) => (
              <div key={f.id} style={{ padding:"8px 14px", borderBottom:i<files.length-1?"1px solid #F0F3F7":"none",
                background:["processing","ocr"].includes(f.status)?"rgba(232,100,16,0.03)":"transparent" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontSize:13 }}>{f.name.toLowerCase().endsWith(".pdf")?"📄":"📊"}</span>
                  <span style={{ flex:1, fontSize:12, color:"#6A7A8A", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</span>
                  {f.count>0  && <span style={{ fontSize:11, color:"#2E7D52", marginRight:4, fontWeight:600 }}>{f.count} bulletin{f.count>1?"s":""}</span>}
                  {f.pageInfo && <span style={{ fontSize:10, color:"#A0AABC", marginRight:4 }}>{f.pageInfo}</span>}
                  {f.error    && <span style={{ fontSize:11, color:"#C0392B", marginRight:4 }}>{f.error}</span>}
                  <span style={{ padding:"2px 10px", borderRadius:20, fontSize:10, fontWeight:700, letterSpacing:0.5, textTransform:"uppercase", whiteSpace:"nowrap",
                    background:f.status==="done"?"rgba(46,125,82,0.1)":f.status==="error"?"rgba(192,57,43,0.1)":f.status==="ocr"?"rgba(232,100,16,0.1)":"rgba(32,56,96,0.06)",
                    color:f.status==="done"?"#2E7D52":f.status==="error"?"#C0392B":f.status==="ocr"?"#E86410":"#8A97A8",
                    border:`1px solid ${f.status==="done"?"#2E7D5240":f.status==="error"?"#C0392B40":f.status==="ocr"?"#E8641040":"#D4DCE8"}` }}>
                    {f.status==="done"?"Extrait":f.status==="error"?"Erreur":f.status==="ocr"?"OCR scan…":f.status==="processing"?"Traitement…":"En attente"}
                  </span>
                </div>
                {["processing","ocr"].includes(f.status) && (
                  <div style={{ height:2, background:"#F0F3F7", borderRadius:2, overflow:"hidden", marginTop:5 }}>
                    <div style={{ height:"100%", width:`${f.progress}%`, borderRadius:2, transition:"width 0.3s",
                      background:"linear-gradient(90deg,#203860,#E86410)" }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Results table */}
        {rows.length > 0 && (
          <div style={{ background:"#FFFFFF", borderRadius:10, border:"1px solid #E8ECF0", overflow:"hidden",
            boxShadow:"0 1px 4px rgba(32,56,96,0.04)" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ background:"#F7F8FA", borderBottom:"2px solid #E8ECF0" }}>
                    <th style={{ padding:"8px 10px", textAlign:"left", color:"#8A97A8", fontWeight:700,
                      fontSize:10, letterSpacing:1, whiteSpace:"nowrap", borderRight:"1px solid #E8ECF0",
                      fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>SOURCE</th>
                    {FIELDS.map(f => (
                      <th key={f.key} style={{ padding:"8px 8px", textAlign:"left", color:"#8A97A8",
                        fontWeight:700, fontSize:10, letterSpacing:0.4, whiteSpace:"nowrap",
                        fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
                        {f.label.toUpperCase()}
                      </th>
                    ))}
                    <th style={{ width:52 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={row.id} style={{ borderBottom:"1px solid #F0F3F7",
                      background:i%2===0?"#FFFFFF":"#FAFBFC" }}>
                      <td style={{ padding:"4px 10px", color:"#A0AABC", fontSize:10, whiteSpace:"nowrap",
                        maxWidth:110, overflow:"hidden", textOverflow:"ellipsis", borderRight:"1px solid #E8ECF0" }}
                        title={row.fileName}>{row.fileName}</td>
                      {FIELDS.map(f => (
                        <td key={f.key} style={{ padding:"2px 4px", minWidth:88 }}>
                          <EditableCell value={row.data[f.key]||""} missing={row.missing?.includes(f.key)}
                            onChange={v => updateCell(row.id, f.key, v)} />
                        </td>
                      ))}
                      <td style={{ padding:"4px 6px", textAlign:"center", whiteSpace:"nowrap" }}>
                        <button onClick={() => setDiagRow(row)} title="Voir le texte brut extrait"
                          style={{ background:"none", border:"none", color:"#C8D4E0", cursor:"pointer",
                            fontSize:13, padding:"2px 3px", transition:"color 0.15s" }}
                          onMouseEnter={e=>e.currentTarget.style.color="#E86410"}
                          onMouseLeave={e=>e.currentTarget.style.color="#C8D4E0"}>🔍</button>
                        <button onClick={() => setRows(p => p.filter(r => r.id!==row.id))}
                          style={{ background:"none", border:"none", color:"#C8D4E0", cursor:"pointer",
                            fontSize:14, padding:"2px 3px", transition:"color 0.15s" }}
                          onMouseEnter={e=>e.currentTarget.style.color="#C0392B"}
                          onMouseLeave={e=>e.currentTarget.style.color="#C8D4E0"}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Legend */}
        {rows.length > 0 && (
          <div style={{ display:"flex", gap:20, fontSize:11, color:"#A0AABC", flexWrap:"wrap",
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            <span>
              <span style={{ display:"inline-block", width:10, height:10, marginRight:5, borderRadius:2,
                background:"rgba(232,100,16,0.1)", border:"1px solid #E86410" }}></span>
              Champ non trouvé — cliquer pour saisir manuellement
            </span>
            <span>🔍 Loupe = voir le texte brut extrait du PDF</span>
            <span style={{ marginLeft:"auto", color:"#C8D4E0" }}>Cliquer sur une cellule pour la modifier</span>
          </div>
        )}

        {/* Action bar */}
        <div style={{ display:"flex", alignItems:"center", gap:12, paddingTop:4 }}>
          {rows.length > 0 ? (
            <>
              <button onClick={handleClearAll}
                style={{ padding:"9px 18px", background:"transparent", border:"1px solid #D4DCE8",
                  color:"#8A97A8", borderRadius:7, cursor:"pointer", fontSize:12, fontFamily:"inherit",
                  fontWeight:600, transition:"all 0.15s" }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="#203860";e.currentTarget.style.color="#203860";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="#D4DCE8";e.currentTarget.style.color="#8A97A8";}}>
                Tout effacer
              </button>
              <label style={{ display:"flex", alignItems:"center", gap:7, fontSize:12, color:"#8A97A8",
                cursor:"pointer", userSelect:"none", fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
                <input type="checkbox" checked={inclIncomp} onChange={e=>setInclIncomp(e.target.checked)}
                  style={{ accentColor:"#E86410" }} />
                Inclure les lignes incomplètes
              </label>
              <button onClick={exportCSV}
                style={{ marginLeft:"auto", padding:"9px 22px",
                  background:"#E86410", border:"none", color:"#fff",
                  borderRadius:7, cursor:"pointer", fontSize:12, fontFamily:"'Montserrat','Segoe UI',sans-serif",
                  fontWeight:700, boxShadow:"0 2px 12px rgba(232,100,16,0.3)", transition:"all 0.15s" }}
                onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 20px rgba(232,100,16,0.45)"}
                onMouseLeave={e=>e.currentTarget.style.boxShadow="0 2px 12px rgba(232,100,16,0.3)"}>
                ↓ Exporter en CSV
              </button>
            </>
          ) : (
            <div style={{ fontSize:12, color:"#A0AABC", fontStyle:"italic",
              fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
              Importez des fichiers pour commencer l'extraction
            </div>
          )}
        </div>

        {/* Mention RGPD */}
        <div style={{ borderTop:"1px solid #E8ECF0", paddingTop:12, marginTop:4 }}>
          <p style={{ margin:0, fontSize:10, color:"#C8D4E0", lineHeight:1.6,
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            🔒 Toutes les données sont traitées localement dans votre navigateur.
            Aucune information n'est envoyée à un serveur externe.
            Aucune donnée n'est conservée après fermeture de l'application.
            {" "}<span style={{ color:"#A0AABC" }}>Les fichiers exportés contiennent des données personnelles — à traiter conformément à votre politique interne.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════════

const FIELDS_ANIM = [
  { key: "nom",       label: "Nom" },
  { key: "service",   label: "Service" },
  { key: "fonction",  label: "Fonction" },
  { key: "vacations", label: "Nb vacations" },
  { key: "brut",      label: "Brut (euros)" },
  { key: "debut",     label: "Debut de periode" },
  { key: "fin",       label: "Fin de periode" },
  { key: "mois",      label: "Mois de recrutement" },
  { key: "annee",     label: "Annee" },
];

function itemsToLinesAnim(items) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    return Math.abs(dy) > 3 ? dy : a.transform[4] - b.transform[4];
  });
  const groups = []; let cur = [], lastY = null;
  for (const it of sorted) {
    const y = Math.round(it.transform[5]);
    if (lastY !== null && Math.abs(y - lastY) > 3) { groups.push(cur); cur = []; }
    cur.push(it); lastY = y;
  }
  if (cur.length) groups.push(cur);
  return groups.map(g => {
    const s = [...g].sort((a, b) => a.transform[4] - b.transform[4]);
    return { text: s.map(i => i.str).join(" ").trim(), x: s[0].transform[4], y: s[0].transform[5] };
  }).filter(l => l.text.length > 0);
}

function normalizeDateAnim(raw) {
  if (!raw) return "";
  return raw.replace(/-/g, "/").replace(/(\d{1,2})\/(\d{1,2})\/(\d{2})$/, (_, d, m, y) => d + "/" + m + "/20" + y);
}

function extractFieldsAnim(lines, pageWidth) {
  const r = { nom:"", service:"", fonction:"", vacations:"", brut:"", debut:"", fin:"", mois:"", annee:"" };
  const warnings = [];
  const pw = pageWidth || 600;
  const mid = pw / 2;
  const byYDesc = [...lines].sort((a, b) => b.y - a.y);
  const maxY = byYDesc[0] ? byYDesc[0].y : 800;
  const topThresh = maxY * 0.65;
  const topAll   = byYDesc.filter(l => l.y >= topThresh);
  const leftTop  = topAll.filter(l => l.x < mid * 0.65);
  const rightTop = topAll.filter(l => l.x >= mid * 0.55);
  const fullText = lines.map(l => l.text).join("\n");
  // NOM
  for (const l of rightTop) {
    const t = l.text.trim();
    if (t.length >= 4 && t.split(/\s+/).length >= 2 && !/\d/.test(t) &&
        !/^(BULLETIN|PAIE|MOIS|PERIODE|SERVICE|EMPLOI|GRADE|FONCTION|TOTAL|BRUT|NET|REF|MAIRIE)/i.test(t) &&
        /[A-Za-z]/.test(t)) { r.nom = t; break; }
  }
  if (!r.nom) { const m = fullText.match(/^(?:Nom|NOM)\s*[:\-]?\s*(.+)$/im); if (m) r.nom = m[1].trim(); }
  // SERVICE
  for (let i = 0; i < leftTop.length; i++) {
    const t = leftTop[i].text;
    const m = t.match(/^(?:Service|SERVICE)\s*[:\-]?\s*(.{2,60})/i);
    if (m && m[1].trim().length > 1) { r.service = m[1].trim(); break; }
    if (/^(?:Service|SERVICE)\s*[:\-]?\s*$/i.test(t.trim()) && leftTop[i+1]) { r.service = leftTop[i+1].text.trim(); break; }
  }
  if (!r.service) { const m = fullText.match(/^(?:Service|SERVICE)\s*[:\-]?\s*(.+)$/im); if (m) r.service = m[1].trim(); }
  // FONCTION
  const fnRe = /^(?:Fonction|FONCTION|Emploi|EMPLOI|Grade|GRADE|Poste|POSTE)\s*[:\-]?\s*/i;
  for (let i = 0; i < leftTop.length; i++) {
    const t = leftTop[i].text;
    const m = t.match(new RegExp(fnRe.source + "(.{2,60})", "i"));
    if (m) { r.fonction = m[1].trim(); break; }
    if (fnRe.test(t.trim()) && leftTop[i+1]) { r.fonction = leftTop[i+1].text.trim(); break; }
  }
  if (!r.fonction) { const m = fullText.match(/^(?:Fonction|FONCTION|Emploi|EMPLOI|Grade|GRADE)\s*[:\-]?\s*(.+)$/im); if (m) r.fonction = m[1].trim(); }
  // VACATIONS
  const vacPat1 = /VACATIONS?\s+(\d+(?:[,.]\d+)?)/i;
  for (const l of lines) {
    const m = l.text.match(vacPat1);
    if (m) { const val = m[1].replace(",","."); const num = parseFloat(val); r.vacations = Number.isInteger(num) ? String(num) : val; break; }
  }
  if (!r.vacations) {
    const lines2 = fullText.split("\n");
    for (let i = 0; i < lines2.length; i++) {
      if (/^VACATIONS?\s*$/i.test(lines2[i].trim())) {
        for (let j = i+1; j <= Math.min(i+3, lines2.length-1); j++) {
          const numMatch = lines2[j].match(/^(\d+(?:[,.]\d+)?)/);
          if (numMatch) { const val = numMatch[1].replace(",","."); const num = parseFloat(val); r.vacations = Number.isInteger(num) ? String(num) : val; break; }
        }
        if (r.vacations) break;
      }
    }
  }
  // BRUT
  const brutPatterns = [
    /SALAIRE\s+BRUT\s+([\d\s]{2,15}[,.]\d{2})/i,
    /TOTAL\s+BRUT\s+([\d\s]{2,15}[,.]\d{2})/i,
    /^Brut\s+([\d\s]{1,12}[,.]\d{2})$/im,
    /\bBrut\b(?!\s+(?:Fiscal|Imposable|Total|social|net))\s+([\d\s]{2,12}[,.]\d{2})/i,
  ];
  const brutFound = [];
  for (const pat of brutPatterns) { const m = fullText.match(pat); if (m) brutFound.push(m[1].replace(/\s/g,"").replace(",",".")); }
  if (brutFound.length >= 1) r.brut = brutFound[0];
  if (brutFound.length > 1) warnings.push("brut");
  // DATES
  const datePat = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/g;
  const pMatch = fullText.match(/[Pp][eé]riode\s+du\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+au\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (pMatch) { r.debut = normalizeDateAnim(pMatch[1]); r.fin = normalizeDateAnim(pMatch[2]); }
  else {
    const du = fullText.match(/\bDu\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    const au = fullText.match(/\bAu\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
    if (du) r.debut = normalizeDateAnim(du[1]);
    if (au) r.fin   = normalizeDateAnim(au[1]);
    if (!r.debut || !r.fin) {
      const zoneText = rightTop.map(l => l.text).join("\n");
      const zDates = [...zoneText.matchAll(datePat)].map(m => m[1]);
      if (!r.debut && zDates[0]) r.debut = normalizeDateAnim(zDates[0]);
      if (!r.fin   && zDates[1]) r.fin   = normalizeDateAnim(zDates[1]);
    }
    if (!r.debut || !r.fin) {
      const allDates = [...new Set([...fullText.matchAll(datePat)].map(m => m[1]))];
      if (!r.debut && allDates[0]) r.debut = normalizeDateAnim(allDates[0]);
      if (!r.fin   && allDates[1]) r.fin   = normalizeDateAnim(allDates[1]);
    }
  }
  // MOIS + ANNEE
  if (r.debut) {
    const parts = r.debut.split("/");
    if (parts.length === 3) {
      const mIdx = parseInt(parts[1], 10) - 1;
      const MOIS = ["Janvier","Fevrier","Mars","Avril","Mai","Juin","Juillet","Aout","Septembre","Octobre","Novembre","Decembre"];
      r.mois  = MOIS[mIdx] || "";
      r.annee = parts[2].length === 2 ? "20" + parts[2] : parts[2];
    }
  }
  return { data: r, warnings };
}

let _tessAnim = null;
async function getTessAnim() {
  if (_tessAnim) return _tessAnim;
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      // Version épinglée exacte — même version que getTessWorker pour cohérence.
      s.src = "https://unpkg.com/tesseract.js@5.0.4/dist/tesseract.min.js";
      s.crossOrigin = "anonymous";
      s.referrerPolicy = "no-referrer";
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }
  _tessAnim = await window.Tesseract.createWorker("fra", 1, { logger: () => {} });
  return _tessAnim;
}
function terminateTessAnim() { if (_tessAnim) { _tessAnim.terminate(); _tessAnim = null; } }

async function ocrPageAnim(page) {
  const vp = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  const w = await getTessAnim();
  const { data: { text } } = await w.recognize(canvas);
  return text.split("\n").map((t, i) => ({ text: t.trim(), x: 0, y: 1000 - i*15 })).filter(l => l.text.length > 0);
}

async function extractFromPDFAnim(file, onProgress) {
  const pdfjs = await loadPDFJS();
  let pdf;
  try { pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise; }
  catch (e) {
    if (e.message && e.message.includes("password")) throw new Error("Fichier protege - deverrouiller avant import");
    throw e;
  }
  const total = pdf.numPages;
  const bulletins = [];
  for (let i = 1; i <= total; i++) {
    const pct = Math.round((i-1)/total*90);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pw = page.getViewport({ scale: 1 }).width;
    const charCount = content.items.reduce((n, it) => n + (it.str||"").replace(/\s/g,"").length, 0);
    let lines; let isOCR = false;
    if (charCount < 40) {
      onProgress && onProgress("Page " + i + "/" + total + " - OCR...", pct, true);
      try { lines = await ocrPageAnim(page); isOCR = true; } catch { lines = itemsToLinesAnim(content.items); }
    } else {
      onProgress && onProgress("Page " + i + "/" + total, pct, false);
      lines = itemsToLinesAnim(content.items);
    }
    const ft = lines.map(l => l.text).join("\n");
    const looks = /BULLETIN|PAIE|SALAIRE|BRUT|GRADE|FONCTION|SERVICE|MATRICULE|MAIRIE|VACATION/i.test(ft) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(ft);
    if (!looks && total > 1) continue;
    const { data, warnings } = extractFieldsAnim(lines, pw);
    bulletins.push({ data, warnings, isOCR });
  }
  onProgress && onProgress("Termine", 100, false);
  if (!bulletins.length) throw new Error("Aucun bulletin identifiable - verifier le format du PDF");
  return bulletins;
}

async function exportXLSXAnim(rows) {
  let XLSXlib = window.XLSX;
  if (!XLSXlib) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      s.crossOrigin = "anonymous";
      s.referrerPolicy = "no-referrer";
      s.onload = () => res(window.XLSX); s.onerror = rej; document.head.appendChild(s);
    });
    XLSXlib = window.XLSX;
  }
  const headers = ["Source", ...FIELDS_ANIM.map(f => f.label)];
  const data = rows.map(r => [r.fileName || "", ...FIELDS_ANIM.map(f => r.data[f.key] || "")]);
  const ws = XLSXlib.utils.aoa_to_sheet([headers, ...data]);
  ws["!cols"] = [{ wch:28 },{ wch:26 },{ wch:18 },{ wch:26 },{ wch:12 },{ wch:12 },{ wch:14 },{ wch:14 },{ wch:18 },{ wch:10 }];
  const wb = XLSXlib.utils.book_new();
  XLSXlib.utils.book_append_sheet(wb, ws, "Bulletins");
  const d = new Date();
  XLSXlib.writeFile(wb, "extraction_animateurs_" + d.getFullYear() + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0") + ".xlsx");
}

function CellAnim({ value, onChange, missing, warn }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef();
  useEffect(() => setDraft(value), [value]);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);
  const bg  = missing ? "rgba(232,100,16,0.08)" : warn ? "rgba(232,100,16,0.04)" : "transparent";
  const col = missing ? "#E86410" : warn ? "#C07010" : value ? "#203860" : "#C8D4E0";
  if (editing) return (
    <input ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
      onBlur={() => { setEditing(false); onChange(draft); }}
      onKeyDown={e => { if (e.key==="Enter"){setEditing(false);onChange(draft);} if(e.key==="Escape"){setEditing(false);setDraft(value);} }}
      style={{ width:"100%", background:"#FFFFFF", color:"#203860", border:"1px solid #E86410",
        borderRadius:4, padding:"3px 7px", fontSize:12, outline:"none", fontFamily:"inherit" }} />
  );
  return (
    <div onClick={() => setEditing(true)}
      style={{ cursor:"text", padding:"3px 7px", borderRadius:4, minHeight:24, background:bg, color:col,
        border:"1px solid transparent", fontSize:12, transition:"border-color 0.15s" }}
      onMouseEnter={e => e.currentTarget.style.borderColor="#E8ECF0"}
      onMouseLeave={e => e.currentTarget.style.borderColor="transparent"}>
      {warn && <span style={{ fontSize:10, marginRight:4, color:"#E86410" }}>(!)</span>}
      {value || <span style={{ fontStyle:"italic", fontSize:11, color:"#C8D4E0" }}>-</span>}
    </div>
  );
}

function ExtractionAnimateur() {
  const [files, setFiles]       = useState([]);
  const [rows, setRows]         = useState([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();
  const nextId  = useRef(1);

  useEffect(() => { loadPDFJS().catch(() => {}); }, []);
  useEffect(() => () => { terminateTessAnim(); }, []);

  const patch = useCallback((id, p) =>
    setFiles(prev => prev.map(f => f.id===id ? {...f,...p} : f)), []);

  const process = useCallback(async newFiles => {
    const entries = Array.from(newFiles)
      .filter(f => f.name.toLowerCase().endsWith(".pdf"))
      .map(f => ({ id:nextId.current++, name:f.name, status:"waiting", error:null, progress:0, pageInfo:"", count:0, file:f, hasOCR:false }));
    if (!entries.length) return;
    setFiles(prev => [...prev, ...entries]);
    for (const entry of entries) {
      patch(entry.id, { status:"processing", progress:5 });
      try {
        const bulletins = await extractFromPDFAnim(entry.file, (info, pct, isOCR) =>
          patch(entry.id, { status:isOCR?"ocr":"processing", pageInfo:info, progress:pct })
        );
        const newRows = bulletins.map(b => ({
          id:nextId.current++, fileName:entry.name, data:b.data,
          warnings:b.warnings, isOCR:b.isOCR,
          missing:FIELDS_ANIM.filter(f => !b.data[f.key]).map(f => f.key),
        }));
        setRows(prev => [...prev, ...newRows]);
        patch(entry.id, { status:"done", progress:100, count:bulletins.length, pageInfo:"", hasOCR:bulletins.some(b=>b.isOCR) });
      } catch(err) {
        patch(entry.id, { status:"error", error:err.message, progress:0 });
      }
    }
  }, [patch]);

  const handleDrop = useCallback(e => { e.preventDefault(); setDragging(false); process(e.dataTransfer.files); }, [process]);
  const handleClearAll = useCallback(() => { setFiles([]); setRows([]); terminateTessAnim(); }, []);
  const updateCell = (rowId, field, val) =>
    setRows(prev => prev.map(r => {
      if (r.id!==rowId) return r;
      const d = {...r.data, [field]:val};
      return { ...r, data:d, missing:FIELDS_ANIM.filter(f=>!d[f.key]).map(f=>f.key) };
    }));

  const total   = rows.length;
  const missing = rows.filter(r => r.missing && r.missing.length > 0).length;
  const errors  = files.filter(f => f.status==="error").length;
  const hasOCR  = files.some(f => f.status==="ocr" || f.hasOCR);

  return (
    <div style={{ fontFamily:"'DM Mono','Courier New',monospace", background:"#F7F8FA", minHeight:"100vh", color:"#203860" }}>
      <div style={{ background:"#FFFFFF", borderBottom:"1px solid #E8ECF0",
        padding:"16px 28px", display:"flex", alignItems:"center", gap:16,
        boxShadow:"0 1px 4px rgba(32,56,96,0.04)" }}>
        <div style={{ width:38, height:38, borderRadius:8, background:"#203860",
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>🏛️</div>
        <div>
          <div style={{ fontSize:14, fontWeight:700, color:"#203860",
            fontFamily:"'Montserrat','Segoe UI',sans-serif", letterSpacing:"-0.01em" }}>
            Extraction — Animateur (Collectivité)
          </div>
          <div style={{ fontSize:11, color:"#8A97A8", marginTop:2,
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            PDF texte + OCR · Nom, Service, Fonction, Vacations, Brut, Période · Export Excel
          </div>
        </div>
        {total > 0 && (
          <div style={{ marginLeft:"auto", display:"flex", gap:16, fontSize:11, alignItems:"center",
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            <span style={{ color:"#2E7D52", fontWeight:600 }}><b>{total}</b> bulletin{total>1?"s":""}</span>
            {missing > 0 && <span style={{ color:"#E86410", fontWeight:600 }}><b>{missing}</b> incomplet{missing>1?"s":""}</span>}
            {errors  > 0 && <span style={{ color:"#C0392B", fontWeight:600 }}><b>{errors}</b> erreur{errors>1?"s":""}</span>}
          </div>
        )}
      </div>
      <div style={{ padding:"20px 28px", display:"flex", flexDirection:"column", gap:14, background:"#F7F8FA" }}>
        <div onDragOver={e=>{e.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)}
          onDrop={handleDrop} onClick={()=>fileRef.current.click()}
          style={{ border:`2px dashed ${dragging?"#E86410":"#D4DCE8"}`, borderRadius:10, padding:"28px 20px",
            textAlign:"center", cursor:"pointer", transition:"all 0.2s",
            background:dragging?"rgba(232,100,16,0.04)":"#FFFFFF",
            boxShadow:dragging?"0 0 20px rgba(232,100,16,0.1)":"none" }}>
          <div style={{ fontSize:28, marginBottom:8 }}>📂</div>
          <div style={{ fontSize:13, color:"#6A7A8A", marginBottom:3 }}>Glissez vos PDF ici, ou cliquez pour parcourir</div>
          <div style={{ fontSize:11, color:"#A0AABC" }}>Bulletins collectivité territoriale — libellé VACATION ou VACATIONS</div>
          <input ref={fileRef} type="file" multiple accept=".pdf"
            onChange={e=>{process(e.target.files);e.target.value="";}} style={{ display:"none" }} />
        </div>
        {hasOCR && (
          <div style={{ background:"rgba(232,100,16,0.06)", border:"1px solid rgba(232,100,16,0.2)",
            borderRadius:8, padding:"10px 14px", fontSize:12, color:"#E86410", display:"flex", gap:8 }}>
            <span>⚙️</span><span>OCR actif — Tesseract charge automatiquement, extraction page par page.</span>
          </div>
        )}
        {files.length > 0 && (
          <div style={{ background:"#FFFFFF", borderRadius:10, border:"1px solid #E8ECF0", overflow:"hidden",
            boxShadow:"0 1px 4px rgba(32,56,96,0.04)" }}>
            {files.map((f,i) => (
              <div key={f.id} style={{ padding:"9px 16px",
                borderBottom:i<files.length-1?"1px solid #F0F3F7":"none",
                background:["processing","ocr"].includes(f.status)?"rgba(232,100,16,0.03)":"transparent" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <span style={{ fontSize:14 }}>📄</span>
                  <span style={{ flex:1, fontSize:12, color:"#6A7A8A", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</span>
                  {f.count>0 && <span style={{ fontSize:11, color:"#2E7D52", marginRight:4, fontWeight:600 }}>{f.count} bulletin{f.count>1?"s":""}</span>}
                  {f.pageInfo && <span style={{ fontSize:10, color:"#A0AABC", marginRight:4 }}>{f.pageInfo}</span>}
                  {f.error && <span style={{ fontSize:11, color:"#C0392B", marginRight:4 }}>{f.error}</span>}
                  <span style={{ padding:"2px 10px", borderRadius:20, fontSize:10, fontWeight:700,
                    letterSpacing:0.8, textTransform:"uppercase", whiteSpace:"nowrap",
                    background:f.status==="done"?"rgba(46,125,82,0.1)":f.status==="error"?"rgba(192,57,43,0.1)":f.status==="ocr"?"rgba(232,100,16,0.1)":"rgba(32,56,96,0.06)",
                    color:f.status==="done"?"#2E7D52":f.status==="error"?"#C0392B":f.status==="ocr"?"#E86410":"#8A97A8",
                    border:`1px solid ${f.status==="done"?"#2E7D5240":f.status==="error"?"#C0392B40":f.status==="ocr"?"#E8641040":"#D4DCE8"}` }}>
                    {f.status==="done"?(f.hasOCR?"OCR OK":"Extrait"):f.status==="error"?"Erreur":f.status==="ocr"?"OCR...":"Traitement..."}
                  </span>
                </div>
                {["processing","ocr"].includes(f.status) && (
                  <div style={{ height:2, background:"#F0F3F7", borderRadius:2, overflow:"hidden", marginTop:6 }}>
                    <div style={{ height:"100%", width:`${f.progress}%`, borderRadius:2, transition:"width 0.3s",
                      background:"linear-gradient(90deg,#203860,#E86410)" }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {rows.length > 0 && (
          <div style={{ background:"#FFFFFF", borderRadius:10, border:"1px solid #E8ECF0", overflow:"hidden",
            boxShadow:"0 1px 4px rgba(32,56,96,0.04)" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ background:"#F7F8FA", borderBottom:"2px solid #E8ECF0" }}>
                    <th style={{ padding:"9px 12px", textAlign:"left", color:"#8A97A8", fontWeight:700,
                      fontSize:10, letterSpacing:0.8, whiteSpace:"nowrap", borderRight:"1px solid #E8ECF0",
                      fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>SOURCE</th>
                    {FIELDS_ANIM.map(f => (
                      <th key={f.key} style={{ padding:"9px 10px", textAlign:"left", fontWeight:700,
                        fontSize:10, letterSpacing:0.6, whiteSpace:"nowrap",
                        fontFamily:"'Montserrat','Segoe UI',sans-serif",
                        color:f.key==="vacations"?"#E86410":"#8A97A8" }}>
                        {f.label.toUpperCase()}
                      </th>
                    ))}
                    <th style={{ width:32 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row,i) => (
                    <tr key={row.id} style={{ borderBottom:"1px solid #F0F3F7",
                      background:i%2===0?"#FFFFFF":"#FAFBFC" }}>
                      <td style={{ padding:"4px 12px", color:"#A0AABC", fontSize:10, whiteSpace:"nowrap",
                        maxWidth:130, overflow:"hidden", textOverflow:"ellipsis",
                        borderRight:"1px solid #E8ECF0" }} title={row.fileName}>
                        {row.isOCR && <span style={{ color:"#E86410", marginRight:4 }}>◉</span>}
                        {row.fileName}
                      </td>
                      {FIELDS_ANIM.map(f => (
                        <td key={f.key} style={{ padding:"2px 4px", minWidth:f.key==="vacations"?80:100 }}>
                          <CellAnim value={row.data[f.key]||""} missing={row.missing&&row.missing.includes(f.key)}
                            warn={row.warnings&&row.warnings.includes(f.key)} onChange={v=>updateCell(row.id,f.key,v)} />
                        </td>
                      ))}
                      <td style={{ padding:"4px 6px", textAlign:"center" }}>
                        <button onClick={()=>setRows(p=>p.filter(r=>r.id!==row.id))}
                          style={{ background:"none", border:"none", color:"#C8D4E0",
                            cursor:"pointer", fontSize:15, padding:2, transition:"color 0.15s" }}
                          onMouseEnter={e=>e.currentTarget.style.color="#C0392B"}
                          onMouseLeave={e=>e.currentTarget.style.color="#C8D4E0"}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {rows.length > 0 && (
          <div style={{ display:"flex", gap:20, fontSize:11, color:"#A0AABC", flexWrap:"wrap", alignItems:"center",
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            <span style={{ display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ width:10, height:10, borderRadius:2,
                background:"rgba(232,100,16,0.1)", border:"1px solid #E86410" }}></span>
              Champ non trouvé — cliquer pour saisir
            </span>
            <span style={{ display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ color:"#E86410", fontWeight:700, fontSize:10 }}>NB VACATIONS</span>
              Lu sur la ligne VACATION / VACATIONS du tableau de paie
            </span>
            <span style={{ marginLeft:"auto", color:"#C8D4E0", fontStyle:"italic" }}>Cliquer sur une cellule pour modifier</span>
          </div>
        )}
        <div style={{ display:"flex", alignItems:"center", gap:12, paddingTop:4 }}>
          {rows.length > 0 ? (
            <>
              <button onClick={handleClearAll}
                style={{ padding:"9px 18px", background:"transparent", border:"1px solid #D4DCE8",
                  color:"#8A97A8", borderRadius:7, cursor:"pointer", fontSize:12,
                  fontFamily:"'Montserrat','Segoe UI',sans-serif", fontWeight:600, transition:"all 0.15s" }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="#203860";e.currentTarget.style.color="#203860";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="#D4DCE8";e.currentTarget.style.color="#8A97A8";}}>
                Tout effacer
              </button>
              <span style={{ fontSize:11, color:"#C8D4E0", fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
                {total} bulletin{total>1?"s":""}
                {missing>0?" · "+missing+" incomplet"+(missing>1?"s":""):""}
              </span>
              <button onClick={()=>exportXLSXAnim(rows)}
                style={{ marginLeft:"auto", padding:"9px 24px", background:"#E86410",
                  border:"none", color:"#fff", borderRadius:7, cursor:"pointer", fontSize:12,
                  fontFamily:"'Montserrat','Segoe UI',sans-serif", fontWeight:700,
                  boxShadow:"0 2px 12px rgba(232,100,16,0.3)", transition:"all 0.15s" }}
                onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 20px rgba(232,100,16,0.45)"}
                onMouseLeave={e=>e.currentTarget.style.boxShadow="0 2px 12px rgba(232,100,16,0.3)"}>
                Exporter en Excel (.xlsx)
              </button>
            </>
          ) : (
            <div style={{ fontSize:12, color:"#A0AABC", fontStyle:"italic",
              fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
              Importez des PDF de bulletins collectivité territoriale
            </div>
          )}
        </div>

        {/* Mention RGPD */}
        <div style={{ borderTop:"1px solid #E8ECF0", paddingTop:12, marginTop:4 }}>
          <p style={{ margin:0, fontSize:10, color:"#C8D4E0", lineHeight:1.6,
            fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
            🔒 Toutes les données sont traitées localement dans votre navigateur.
            Aucune information n'est envoyée à un serveur externe.
            Aucune donnée n'est conservée après fermeture de l'application.
            {" "}<span style={{ color:"#A0AABC" }}>Les fichiers exportés contiennent des données personnelles — à traiter conformément à votre politique interne.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════════
// Couleurs extraites pixel par pixel du logo officiel fourni
// Orange primaire : #E86410  |  Shadow : #C05008  |  Navy : #203860
// ═══════════════════════════════════════════════════════════════════════════════

// SVG du N Neoptim — géométrie reconstruite d'après analyse pixel exacte du logo.
// Silhouette en 10 points (polygon concave avec 2 encoches triangulaires),
// jambe droite assombrie pour l'effet ruban 3D, reflet brillant en haut.
function NeoptimN({ size = 40 }) {
  const id = `nn${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" fill="none"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={`${id}m`} x1="45" y1="0" x2="100" y2="200" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#F07020"/>
          <stop offset="50%"  stopColor="#E86410"/>
          <stop offset="100%" stopColor="#D05808"/>
        </linearGradient>
        <linearGradient id={`${id}s`} x1="185" y1="0" x2="145" y2="200" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#CC5008"/>
          <stop offset="100%" stopColor="#A83E06"/>
        </linearGradient>
        <linearGradient id={`${id}f`} x1="45" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#F88838"/>
          <stop offset="100%" stopColor="#F07020"/>
        </linearGradient>
      </defs>

      {/* Corps principal du N — 10 sommets, deux encoches concaves */}
      <path d="M45 0 L91 0 L123 83 L170 0 L200 0 L155 200 L104 200 L74 122 L32 200 L0 200 Z"
            fill={`url(#${id}m)`}/>

      {/* Jambe droite en ombre — face latérale droite du ruban */}
      <path d="M170 0 L200 0 L155 200 L130 200 Z"
            fill={`url(#${id}s)`}/>

      {/* Reflet pli supérieur — bande lumineuse sur le bord du haut */}
      <path d="M45 0 L200 0 L195 16 L170 0 L105 16 L91 0 Z"
            fill={`url(#${id}f)`} opacity="0.55"/>
    </svg>
  );
}

// Logo complet : N + wordmark "neoptim"
function NeoptimLogo({ size = "md" }) {
  const conf = { sm: { n:28, txt:13, gap:8 }, md: { n:40, txt:18, gap:10 }, lg: { n:64, txt:28, gap:14 } };
  const c = conf[size] || conf.md;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:c.gap }}>
      <NeoptimN size={c.n} />
      <span style={{ fontSize:c.txt, fontWeight:700, color:"#203860", letterSpacing:"-0.02em",
        fontFamily:"'Montserrat','Trebuchet MS','Segoe UI',sans-serif", lineHeight:1 }}>
        neoptim
      </span>
    </div>
  );
}

const LEVIERS = [
  {
    id: "aad",
    label: "CS — AAD",
    sublabel: "Aide à Domicile",
    description: "Exonération cotisations patronales pour les intervenants à domicile auprès de publics fragiles",
    tag: "Art. L.241-10 CSS",
    component: ExtractionAAD,
  },
  {
    id: "animateur",
    label: "Animateur",
    sublabel: "Collectivité Territoriale",
    description: "Extraction des vacations, brut, périodes et fonctions pour les animateurs en collectivité",
    tag: "FPT",
    component: ExtractionAnimateur,
  },
];

// Barre de navigation persistante — style site Neoptim (fond blanc, bordure basse subtile)
function NavBar({ levier, onBack }) {
  const L = levier ? LEVIERS.find(l => l.id === levier) : null;
  return (
    <div style={{ background:"#FFFFFF", borderBottom:"1px solid #E8ECF0", padding:"0 32px",
      height:60, display:"flex", alignItems:"center", gap:16,
      position:"sticky", top:0, zIndex:100,
      boxShadow:"0 1px 4px rgba(32,56,96,0.06)" }}>
      <NeoptimLogo size="sm" />
      {L && <>
        <div style={{ width:1, height:20, background:"#E8ECF0", margin:"0 4px" }} />
        <span style={{ fontSize:11, color:"#8A97A8", fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
          Extraction bulletins
        </span>
        <span style={{ fontSize:11, color:"#8A97A8" }}>›</span>
        <span style={{ fontSize:12, fontWeight:600, color:"#203860",
          fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>{L.label}</span>
        <button onClick={onBack}
          style={{ marginLeft:"auto", padding:"7px 16px", background:"transparent",
            border:"1px solid #E86410", color:"#E86410", borderRadius:6,
            cursor:"pointer", fontSize:11, fontWeight:600,
            fontFamily:"'Montserrat','Segoe UI',sans-serif", transition:"all 0.15s",
            letterSpacing:"0.01em" }}
          onMouseEnter={e=>{ e.currentTarget.style.background="#E8641012"; }}
          onMouseLeave={e=>{ e.currentTarget.style.background="transparent"; }}>
          ← Changer de levier
        </button>
      </>}
      {!L && <span style={{ marginLeft:"auto", fontSize:11, color:"#8A97A8",
        fontFamily:"'Montserrat','Segoe UI',sans-serif" }}>
        Outil interne — Extraction de bulletins de paie
      </span>}
    </div>
  );
}

export default function App() {
  const [levier, setLevier] = useState(null);

  if (levier) {
    const L = LEVIERS.find(l => l.id === levier);
    const Module = L.component;
    return (
      <div style={{ fontFamily:"'DM Mono','Courier New',monospace", background:"#F7F8FA", minHeight:"100vh" }}>
        <NavBar levier={levier} onBack={() => setLevier(null)} />
        <Module />
      </div>
    );
  }

  return (
    <div style={{ fontFamily:"'Montserrat','Segoe UI',sans-serif", background:"#F7F8FA", minHeight:"100vh" }}>
      <NavBar levier={null} onBack={null} />

      {/* Hero */}
      <div style={{ background:"linear-gradient(160deg,#203860 0%,#2A4A7A 60%,#1A3050 100%)",
        padding:"64px 32px 72px", textAlign:"center", position:"relative", overflow:"hidden" }}>
        {/* Subtle geometric accent */}
        <div style={{ position:"absolute", top:-60, right:-60, width:240, height:240,
          borderRadius:"50%", background:"rgba(232,100,16,0.12)", pointerEvents:"none" }} />
        <div style={{ position:"absolute", bottom:-40, left:-40, width:180, height:180,
          borderRadius:"50%", background:"rgba(232,100,16,0.08)", pointerEvents:"none" }} />
        <div style={{ position:"relative", display:"flex", flexDirection:"column", alignItems:"center", gap:20 }}>
          <NeoptimN size={72} />
          <div>
            <h1 style={{ margin:0, fontSize:30, fontWeight:700, color:"#FFFFFF", letterSpacing:"-0.03em", lineHeight:1.2 }}>
              Extraction de Bulletins de Paie
            </h1>
            <p style={{ margin:"10px 0 0", fontSize:14, color:"rgba(255,255,255,0.65)", letterSpacing:"0.01em" }}>
              Sélectionnez le levier d'optimisation à appliquer
            </p>
          </div>
        </div>
      </div>

      {/* Cards */}
      <div style={{ maxWidth:780, margin:"0 auto", padding:"48px 24px 64px" }}>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:20 }}>
          {LEVIERS.map(l => (
            <button key={l.id} onClick={() => setLevier(l.id)}
              style={{ background:"#FFFFFF", border:"1px solid #E4E9F0", borderRadius:12,
                padding:"28px 24px", cursor:"pointer", textAlign:"left",
                display:"flex", flexDirection:"column", gap:14, transition:"all 0.2s",
                boxShadow:"0 2px 8px rgba(32,56,96,0.06)", fontFamily:"inherit" }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor="#E86410";
                e.currentTarget.style.boxShadow="0 6px 24px rgba(232,100,16,0.14)";
                e.currentTarget.style.transform="translateY(-2px)";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor="#E4E9F0";
                e.currentTarget.style.boxShadow="0 2px 8px rgba(32,56,96,0.06)";
                e.currentTarget.style.transform="translateY(0)";
              }}>
              {/* Tag badge */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase",
                  color:"#E86410", background:"rgba(232,100,16,0.08)", padding:"3px 10px",
                  borderRadius:4, border:"1px solid rgba(232,100,16,0.2)" }}>
                  {l.tag}
                </span>
                <span style={{ fontSize:18, color:"#C8D4E0" }}>→</span>
              </div>
              {/* Title */}
              <div>
                <div style={{ fontSize:17, fontWeight:700, color:"#203860", marginBottom:4, letterSpacing:"-0.01em" }}>
                  {l.label}
                </div>
                <div style={{ fontSize:12, fontWeight:600, color:"#E86410", marginBottom:8 }}>
                  {l.sublabel}
                </div>
                <div style={{ fontSize:12, color:"#6A7A8A", lineHeight:1.5 }}>
                  {l.description}
                </div>
              </div>
              {/* CTA */}
              <div style={{ marginTop:"auto", padding:"9px 0 0", borderTop:"1px solid #F0F3F7",
                display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <span style={{ fontSize:12, fontWeight:600, color:"#203860" }}>Accéder à l'outil</span>
                <div style={{ width:28, height:28, borderRadius:6, background:"#E86410",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:13, color:"#fff", fontWeight:700 }}>→</div>
              </div>
            </button>
          ))}

          {/* Carte placeholder "à venir" */}
          <div style={{ background:"#FAFBFC", border:"1px dashed #D4DCE8", borderRadius:12,
            padding:"28px 24px", display:"flex", flexDirection:"column", gap:14,
            alignItems:"center", justifyContent:"center", textAlign:"center", opacity:0.7 }}>
            <div style={{ width:44, height:44, borderRadius:10, background:"#EEF1F5",
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:20, color:"#B0BBC8" }}>+</div>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:"#8A97A8", marginBottom:4 }}>Nouveau levier</div>
              <div style={{ fontSize:11, color:"#A0AABC" }}>D'autres leviers seront disponibles prochainement</div>
            </div>
          </div>
        </div>

        {/* Footer mention */}
        <div style={{ marginTop:48, textAlign:"center" }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:8 }}>
            <NeoptimLogo size="sm" />
          </div>
          <p style={{ margin:"10px 0 0", fontSize:11, color:"#A0AABC" }}>
            Outil interne Neoptim Consulting — Optimisation des charges sociales
          </p>
          <p style={{ margin:"8px 0 0", fontSize:10, color:"#C8D4E0",
            maxWidth:560, marginLeft:"auto", marginRight:"auto", lineHeight:1.6 }}>
            🔒 Toutes les données sont traitées localement dans votre navigateur.
            Aucune information n'est envoyée à un serveur externe.
            Aucune donnée n'est conservée après fermeture de l'application.{" "}
            <span style={{ color:"#A0AABC" }}>Les fichiers exportés contiennent des données personnelles — à traiter conformément à votre politique interne.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
