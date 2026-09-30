// ============================================================
// pdf-report-styles.js – CP Engineer Pro
// Design System & Styles documentaires pour rapports PDF
// Version 6.1 – PROFESSIONAL ENGINEERING STANDARD (UNICODE & LATEX SAFE)
// ============================================================
// CORRECTIONS MAJEURES v6.1 :
//   ✅ sanitizeUnicode() renforcé (fix B-03 définitif) :
//      - Étape 5 : suppression des SÉQUENCES LONGUES (>10) de caractères
//        dans la plage \u00A0-\u00FF (signature d'une corruption CP1252).
//        Le français légitime n'a JAMAIS 10 accents consécutifs.
//      - Étape 6 : suppression des plages étendues non désirées
//        (\u0080-\u009F C1, \u2000-\u206F ponctuation Unicode,
//         \uFFF0-\uFFFF zone privée).
//      - Les accents français (é, è, ê, à, ù, ç) restent PRÉSERVÉS
//        car ils sont dans la plage \u00C0-\u00FF supportée par CP1252.
// ============================================================
// CORRECTIONS MAJEURES v6.0 (conservées) :
//   ✅ sanitizeUnicode() étendu (filtres C0/C1 de base)
//   ✅ stripLatex() : nettoyage exhaustif des résidus LaTeX
//   ✅ normalizeText() : pipeline complet (LaTeX + Unicode + #)
//   ✅ Fonctions de formatage métier standardisées (B-24)
//   ✅ formatUnit() : 'degC' → '°C' (fix B-25)
// ============================================================

(function() {
    'use strict';

    // ============================================================
    // 1. TABLES DE REMPLACEMENT
    // ============================================================

    /**
     * Table de remplacement des caractères NON supportés par
     * l'encodage WinAnsi/CP1252 de jsPDF (police Helvetica par défaut).
     *
     * Ces caractères provoquent des corruptions visuelles car ils sont
     * interprétés avec l'encodage Symbol ou ignorés.
     *
     * IMPORTANT : Les accents français (é, è, ê, à, ù, ç) sont
     * DÉLIBÉRÉMENT ABSENTS de cette table car ils sont supportés
     * par CP1252 nativement.
     */
    const UNICODE_REPLACEMENTS = {
        // ===== Lettres grecques (MAJEUR) =====
        'Ω': 'Ohm',   'ω': 'Ohm',
        'ε': 'eps',   'Ε': 'E',
        'Δ': 'Delta', 'δ': 'delta',
        'Σ': 'Sum',   'σ': 'sigma',
        'α': 'alpha', 'β': 'beta',
        'γ': 'gamma', 'Γ': 'Gamma',
        'ζ': 'zeta',  'η': 'eta',
        'θ': 'theta', 'Θ': 'Theta',
        'ι': 'iota',  'κ': 'kappa',
        'Λ': 'Lambda','λ': 'lambda',
        'μ': 'mu',    'Μ': 'M',
        'ν': 'nu',    'ξ': 'xi',
        'Ξ': 'Xi',    'π': 'pi',
        'Π': 'Pi',    'ρ': 'rho',
        'Ρ': 'R',     'ς': 's',
        'τ': 'tau',   'Τ': 'T',
        'υ': 'upsilon','Υ': 'Y',
        'φ': 'phi',   'Φ': 'Phi',
        'χ': 'chi',   'Χ': 'Chi',
        'ψ': 'psi',   'Ψ': 'Psi',

        // ===== Flèches =====
        '→': '->',  '←': '<-',  '↔': '<->',
        '⇒': '=>',  '⇐': '<=',  '⇔': '<=>',
        '↑': '^',   '↓': 'v',   '⇑': '^^',  '⇓': 'vv',

        // ===== Symboles mathématiques =====
        '≤': '<=',   '≥': '>=',   '≠': '!=',
        '≈': '~=',   '≃': '~=',   '≅': '~=',
        '≡': '===',  '∝': 'prop', '∞': 'inf',
        '∅': 'empty','∈': 'in',   '∉': 'notin',
        '∀': 'forall','∃': 'exists','√': 'sqrt',
        '∑': 'Sum',  '∏': 'Prod', '∫': 'Int',
        '∂': 'd',    '∇': 'grad',
        '±': '+/-',  '∓': '-/+',
        '×': 'x',    '÷': '/',
        '⋅': '*',    '·': '*',
        '⁄': '/',    '∠': 'angle',
        '⊥': 'perp', '∼': '~',

        // ===== Ponctuation typographique =====
        '–': '-',   '—': '-',   '―': '-',
        '‘': "'",   '’': "'",   '‚': ',',
        '“': '"',   '”': '"',   '„': '"',
        '…': '...', '•': '*',   '‣': '>',
        '◦': 'o',   '‰': 'o/oo',
        '′': "'",   '″': '"',   '‴': "'''",
        '‹': '<',   '›': '>',
        '«': '<<',  '»': '>>',

        // ===== Symboles commerciaux =====
        '™': '(TM)','©': '(c)', '®': '(R)',
        '€': 'EUR', '£': 'GBP', '¥': 'YEN',
        '¢': 'c',   '₹': 'INR', '₽': 'RUB',
        '₩': 'KRW', '₪': 'ILS', '₦': 'NGN',
        '₨': 'Rs',

        // ===== Espaces et caractères invisibles =====
        '\u00A0': ' ',  // espace insécable
        '\u2007': ' ',  // espace de chiffre
        '\u202F': ' ',  // espace insécable étroit
        '\u2000': ' ',  '\u2001': ' ',  '\u2002': ' ',
        '\u2003': ' ',  '\u2004': ' ',  '\u2005': ' ',
        '\u2006': ' ',  '\u2008': ' ',  '\u2009': ' ',
        '\u200A': ' ',
        '\u200B': '',   // espace de largeur nulle
        '\u200C': '',   '\u200D': '',
        '\u2028': ' ',  '\u2029': ' ',
        '\uFEFF': '',   // BOM
        '\uFFFD': '?'   // caractère de remplacement
    };

    /**
     * Remplacements LaTeX résiduels dans les formules ou textes.
     * Ces motifs proviennent d'une ancienne génération Markdown/LaTeX
     * qui n'a pas été nettoyée à la source.
     */
    const LATEX_REPLACEMENTS = [
        // Balises d'environnement mathématique
        [/\\\[/g, ''],
        [/\\\]/g, ''],
        [/\\\(/g, ''],
        [/\\\)/g, ''],
        [/\\begin\{[^}]+\}/g, ''],
        [/\\end\{[^}]+\}/g, ''],

        // Commandes grecques et symboles
        [/\\times/g, 'x'],
        [/\\cdot/g, '*'],
        [/\\div/g, '/'],
        [/\\mu/g, 'mu'],
        [/\\epsilon/g, 'eps'],
        [/\\varepsilon/g, 'eps'],
        [/\\Omega/g, 'Ohm'],
        [/\\omega/g, 'Ohm'],
        [/\\Delta/g, 'Delta'],
        [/\\delta/g, 'delta'],
        [/\\Sigma/g, 'Sum'],
        [/\\sigma/g, 'sigma'],
        [/\\alpha/g, 'alpha'],
        [/\\beta/g, 'beta'],
        [/\\gamma/g, 'gamma'],
        [/\\pi/g, 'pi'],
        [/\\rho/g, 'rho'],
        [/\\lambda/g, 'lambda'],
        [/\\theta/g, 'theta'],

        // Opérateurs et relations
        [/\\approx/g, '~='],
        [/\\leq/g, '<='],
        [/\\geq/g, '>='],
        [/\\neq/g, '!='],
        [/\\ne\b/g, '!='],
        [/\\le\b/g, '<='],
        [/\\ge\b/g, '>='],
        [/\\pm/g, '+/-'],
        [/\\mp/g, '-/+'],
        [/\\infty/g, 'inf'],
        [/\\sqrt\{([^}]*)\}/g, 'sqrt($1)'],

        // Commandes de formatage
        [/\\text\{([^}]*)\}/g, '$1'],
        [/\\mathrm\{([^}]*)\}/g, '$1'],
        [/\\mathit\{([^}]*)\}/g, '$1'],
        [/\\mathbf\{([^}]*)\}/g, '$1'],
        [/\\left\(/g, '('],
        [/\\right\)/g, ')'],
        [/\\left\[/g, '['],
        [/\\right\]/g, ']'],
        [/\\left\|/g, '|'],
        [/\\right\|/g, '|'],

        // Fraction simple
        [/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)'],

        // Échappements résiduels
        [/\\([_$&#%{}])/g, '$1'],
        [/\\%/g, '%'],
        [/\\&/g, '&'],
        [/\\_/g, '_'],
        [/\\#/g, '#'],
        [/\\\$/g, '$'],

        // Derniers \\ isolés
        [/\\\\/g, ' '],
        [/\\/g, ' ']
    ];

    /**
     * Table de remplacement des accents français pour le mode
     * "sanitizeUnicodeStrict()".
     */
    const ACCENT_REPLACEMENTS = {
        'à': 'a', 'á': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a',
        'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
        'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
        'ò': 'o', 'ó': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o',
        'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
        'ç': 'c', 'ñ': 'n', 'ý': 'y', 'ÿ': 'y',
        'À': 'A', 'Á': 'A', 'Â': 'A', 'Ä': 'A', 'Ã': 'A', 'Å': 'A',
        'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E',
        'Ì': 'I', 'Í': 'I', 'Î': 'I', 'Ï': 'I',
        'Ò': 'O', 'Ó': 'O', 'Ô': 'O', 'Ö': 'O', 'Õ': 'O',
        'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'U',
        'Ç': 'C', 'Ñ': 'N', 'Ý': 'Y',
        'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE',
        'ß': 'ss'
    };

    /**
     * Configuration des styles pour le rapport PDF
     * @namespace PDFReportStyles
     */
    const PDFReportStyles = {

        // Version du design system PDF (cycle de vie indépendant)
        VERSION: '6.1.0',

        // ========================================================
        // 2. PALETTE DE COULEURS (Charte Ingénierie Professionnelle)
        // ========================================================
        colors: {
            primary: '#1E3A5F',
            primaryLight: '#2B4A7A',
            primaryDark: '#152B45',
            secondary: '#F4F6F8',
            secondaryDark: '#E2E8F0',
            accent: '#2B6CB0',
            textDark: '#1A202C',
            textMedium: '#4A5568',
            textLight: '#718096',
            background: '#FFFFFF',
            backgroundAlt: '#F8FAFC',
            tableHeaderBg: '#1E3A5F',
            tableHeaderText: '#FFFFFF',
            tableStripe: '#F4F6F8',
            border: '#E2E8F0',
            borderLight: '#EDF2F7',
            success: '#047857',
            successBg: '#D1FAE5',
            successBorder: '#059669',
            warning: '#D97706',
            warningBg: '#FEF3C7',
            warningBorder: '#F59E0B',
            danger: '#C53030',
            dangerBg: '#FEE2E2',
            dangerBorder: '#DC2626',
            info: '#2563EB',
            infoBg: '#DBEAFE'
        },

        // ========================================================
        // 3. TYPOGRAPHIE
        // ========================================================
        typography: {
            fontFamily: 'helvetica',
            sizes: {
                coverTitle: 24,
                coverSubtitle: 14,
                coverInfo: 10,
                chapterTitle: 18,
                sectionTitle: 14,
                subsectionTitle: 12,
                body: 10,
                small: 9,
                tableCell: 8.5,
                tableHeader: 9,
                caption: 8,
                footer: 8,
                header: 8,
                kpiValue: 24,
                kpiLabel: 9
            },
            styles: {
                normal: 'normal',
                bold: 'bold',
                italic: 'italic',
                bolditalic: 'bolditalic'
            }
        },

        // ========================================================
        // 4. MISE EN PAGE (LAYOUT)
        // ========================================================
        layout: {
            margin: {
                top: 20,
                bottom: 20,
                left: 20,
                right: 20
            },
            headerHeight: 15,
            footerHeight: 15,
            lineHeight: 1.4,
            paragraphSpacing: 4,
            sectionSpacing: 8
        },

        // ========================================================
        // 5. STYLES DE TABLEAUX
        // ========================================================
        table: {
            headerHeight: 8,
            rowHeight: 7,
            cellPadding: { v: 3, h: 3 },
            borderWidth: 0.3,
            borderColor: '#E2E8F0',
            headerBg: '#1E3A5F',
            headerTextColor: '#FFFFFF',
            stripeColor: '#F4F6F8',
            textColor: '#1A202C',
            minColumnWidth: 15,
            maxColumnWidth: 100
        },

        // ========================================================
        // 6. STATUTS
        // ========================================================
        status: {
            PASS: {
                label: 'CONFORME',
                color: '#047857',
                bgColor: '#D1FAE5',
                borderColor: '#059669',
                badge: '[OK]'
            },
            WARNING: {
                label: 'AVERTISSEMENT',
                color: '#D97706',
                bgColor: '#FEF3C7',
                borderColor: '#F59E0B',
                badge: '[WARN]'
            },
            FAIL: {
                label: 'NON CONFORME',
                color: '#C53030',
                bgColor: '#FEE2E2',
                borderColor: '#DC2626',
                badge: '[FAIL]'
            },
            NA: {
                label: 'N/A',
                color: '#718096',
                bgColor: '#F4F6F8',
                borderColor: '#E2E8F0',
                badge: '[N/A]'
            },
            NC: {
                label: 'NON CALCULE',
                color: '#718096',
                bgColor: '#F4F6F8',
                borderColor: '#E2E8F0',
                badge: '[NC]'
            },
            'NOT ASSESSABLE': {
                label: 'NON EVALUABLE',
                color: '#718096',
                bgColor: '#F4F6F8',
                borderColor: '#E2E8F0',
                badge: '[N/A]'
            }
        },

        // ========================================================
        // 7. NETTOYAGE LATEX (v6.0)
        // ========================================================
        /**
         * Supprime tous les résidus LaTeX d'une chaîne.
         *
         * Exemple :
         *   "\[I = [S\times (1 - eps)\times DF] / 1000\]"
         *   → "I = [S x (1 - eps) x DF] / 1000"
         *
         * @param {string|number} input - Texte à nettoyer
         * @returns {string} Texte sans résidus LaTeX
         */
        stripLatex: function(input) {
            if (input === undefined || input === null) return '';
            let str = String(input);
            // Application séquentielle des remplacements LaTeX
            for (let i = 0; i < LATEX_REPLACEMENTS.length; i++) {
                const pattern = LATEX_REPLACEMENTS[i][0];
                const replacement = LATEX_REPLACEMENTS[i][1];
                str = str.replace(pattern, replacement);
            }
            return str;
        },

        // ========================================================
        // 8. SANITIZE UNICODE (RENFORCÉ v6.1 – FILTRE SÉQUENCES LONGUES)
        // ========================================================
        /**
         * Remplace tous les caractères non supportés par l'encodage
         * WinAnsi/CP1252 de jsPDF par des équivalents ASCII.
         *
         * COUVERTURE v6.1 :
         *   Étape 1 : Table UNICODE_REPLACEMENTS (Ω → Ohm, etc.)
         *   Étape 2 : Filtre des caractères de contrôle C0
         *             (\x00-\x08, \x0B, \x0C, \x0E-\x1F)
         *   Étape 3 : Filtre de la plage \x7F-\x9F (contrôle C1)
         *   Étape 4 : Filtre de la plage \u0080-\u009F
         *   Étape 5 : ⭐ NOUVEAU v6.1 : suppression des SÉQUENCES LONGUES
         *             (≥ 10 caractères) dans la plage \u00A0-\u00FF.
         *             Le français légitime n'a JAMAIS 10 accents
         *             consécutifs → la présence d'une telle séquence
         *             est la signature d'une corruption d'encodage.
         *   Étape 6 : ⭐ NOUVEAU v6.1 : suppression des plages étendues
         *             \u0080-\u009F (résidus C1 non filtrés),
         *             \u2000-\u206F (ponctuation Unicode haute),
         *             \uFFF0-\uFFFF (zone privée Unicode).
         *
         * CONSERVE :
         *   - Les accents français ISOLÉS (é, è, ê, à, ù, ç) : plage
         *     \u00C0-\u00FF supportée par CP1252
         *   - Les tirets, apostrophes et guillemets convertis en ASCII
         *
         * @param {string|number} input - Texte à nettoyer
         * @returns {string} Texte nettoyé
         */
        sanitizeUnicode: function(input) {
            if (input === undefined || input === null) return '';
            let str = String(input);

            // Étape 1 : table de remplacement (caractères symboliques)
            for (const bad in UNICODE_REPLACEMENTS) {
                if (Object.prototype.hasOwnProperty.call(UNICODE_REPLACEMENTS, bad)) {
                    if (str.indexOf(bad) !== -1) {
                        str = str.split(bad).join(UNICODE_REPLACEMENTS[bad]);
                    }
                }
            }

            // Étape 2 : suppression des caractères de contrôle C0
            // (sauf \t \n \r qui sont gérés par splitTextToSize)
            str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

            // Étape 3 : suppression des caractères de contrôle C1
            // (plage \x7F-\x9F : source majeure de corruption CP1252)
            str = str.replace(/[\x7F-\x9F]/g, '');

            // Étape 4 : suppression des caractères non imprimables
            // étendus (plage \u0080-\u009F)
            str = str.replace(/[\u0080-\u009F]/g, '');

            // ============================================================
            // ⭐ Étape 5 (NOUVEAU v6.1) : suppression des SÉQUENCES LONGUES
            // ------------------------------------------------------------
            // Le français légitime n'a jamais 10 caractères accentués
            // consécutifs. Une telle séquence est la signature d'une
            // corruption d'encodage (ex : "é" × 50, "à" × 30, etc.).
            // Note : n'affecte PAS les accents isolés ("électricité"
            // contient 3 accents sur 12 caractères, jamais 10 d'affilée).
            // ============================================================
            str = str.replace(/[\u00A0-\u00FF]{10,}/g, '');

                        // ============================================================
            // ⭐ Étape 6 (NOUVEAU v6.1) : suppression des plages étendues
            // ------------------------------------------------------------
            // - \u0080-\u009F : résidus C1 non filtrés par étape 4
            // - \u2000-\u206F : ponctuation Unicode haute résiduelle
            //   (les tirets/apostrophes connus ont déjà été remplacés
            //    en étape 1 ; ce qui reste est du bruit)
            // - \uFFF0-\uFFFF : zone privée Unicode
            // ============================================================
            str = str.replace(/[\u0080-\u009F\u2000-\u206F\uFFF0-\uFFFF]/g, '');

            // ============================================================
            // ⭐ F-08 : Étape 7 (NOUVEAU) — Filtrage des emojis et
            // symboles graphiques haute Unicode qui ne sont PAS rendus
            // par la police Helvetica de jsPDF.
            // Signature observée dans le rapport : "Ø=ßá SURVEILLANCE
            // NÉCESSAIRE" (corruption emoji + caractères C1).
            // ============================================================

            // 7.1 : Remplacement des emojis de statut par équivalent ASCII
            //       AVANT la suppression brutale pour conserver le sens.
            str = str.replace(/[\u2705\u2714\u2713\u2714\uFE0F]/g, '[OK]');    // ✅ ✓
            str = str.replace(/[\u274C\u2717\u2718\u274E]/g, '[FAIL]');        // ❌ ✗
            str = str.replace(/[\u26A0\u2757\u2755\u203C]/g, '[WARN]');        // ⚠ ❗ ❕
            str = str.replace(/[\u2139\u24D8\u1F6C8]/g, '');                  // ℹ ⓘ

            // 7.2 : Suppression des emojis pictographiques (U+1F300–U+1FAFF)
            //       et emoticons (U+1F600–U+1F64F).
            //       Note : nécessite le flag 'u' pour les paires de substitution.
            str = str.replace(/[\u{1F300}-\u{1FAFF}]/gu, '');
            str = str.replace(/[\u{1F600}-\u{1F64F}]/gu, '');
            str = str.replace(/[\u{1F680}-\u{1F6FF}]/gu, '');

            // 7.3 : Suppression des symboles divers (U+2600–U+26FF) et
            //       dingbats (U+2700–U+27BF) résiduels.
            str = str.replace(/[\u2600-\u26FF]/g, '');
            str = str.replace(/[\u2700-\u27BF]/g, '');

            // 7.4 : Remplacement des caractères de remplacement Unicode.
            str = str.replace(/\uFFFD/g, '?');
            str = str.replace(/\u00BF/g, '?');

            // 7.5 : Nettoyage des espaces multiples residuels apres suppression.
            str = str.replace(/\s{2,}/g, ' ').trim();

            return str;
        },

        /**
         * Version stricte : remplace EN PLUS les accents français par
         * leur équivalent ASCII.
         *
         * À utiliser UNIQUEMENT si l'environnement jsPDF ne rend pas
         * correctement les accents.
         *
         * @param {string|number} input
         * @returns {string} Texte 100 % ASCII
         */
        sanitizeUnicodeStrict: function(input) {
            if (input === undefined || input === null) return '';
            let str = this.sanitizeUnicode(input);
            for (const bad in ACCENT_REPLACEMENTS) {
                if (Object.prototype.hasOwnProperty.call(ACCENT_REPLACEMENTS, bad)) {
                    if (str.indexOf(bad) !== -1) {
                        str = str.split(bad).join(ACCENT_REPLACEMENTS[bad]);
                    }
                }
            }
            return str;
        },

        // ========================================================
        // 9. NORMALIZE TEXT
        // ========================================================
        /**
         * Pipeline complet de nettoyage de texte :
         *   1. stripLatex()        → supprime \[ \] \times \_ \( \)
         *   2. sanitizeUnicode()   → remplace Ω → Ohm, préserve é, è, ê
         *   3. Filtre #            → supprime les # résiduels en tête
         *   4. Normalisation espace
         *
         * Cette fonction DOIT être appelée sur tout texte avant
         * doc.text().
         *
         * @param {string|number} input
         * @returns {string} Texte prêt pour jsPDF
         */
        normalizeText: function(input) {
            if (input === undefined || input === null) return '';
            let str = String(input);

            // 1. Nettoyage LaTeX
            str = this.stripLatex(str);

            // 2. Nettoyage Unicode
            str = this.sanitizeUnicode(str);

            // 3. Suppression des # en tête de ligne (résidus Markdown)
            str = str.replace(/^\s*#+\s*/gm, '');

            // 4. Suppression des # isolés
            str = str.replace(/#/g, '');

            // 5. Suppression des <br/> résiduels
            str = str.replace(/<br\s*\/?>/gi, ' ');
            str = str.replace(/<\/?[^>]+>/g, '');

            // 6. Normalisation des espaces multiples
            str = str.replace(/\s+/g, ' ').trim();

            return str;
        },

        // ========================================================
        // 10. FORMATAGE NUMÉRIQUE GÉNÉRIQUE
        // ========================================================
        /**
         * Formate un nombre avec un nombre de décimales maîtrisé.
         * Retourne 'N/A' si la valeur est invalide.
         *
         * @param {*} value - Valeur à formater
         * @param {number} [decimals=2] - Nombre de décimales
         * @param {string} [fallback='N/A'] - Valeur de repli
         * @returns {string}
         */
        formatNumber: function(value, decimals, fallback) {
            const fb = (fallback !== undefined) ? fallback : 'N/A';
            if (value === undefined || value === null || value === '') return fb;
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return fb;
            const d = (typeof decimals === 'number' && decimals >= 0) ? decimals : 2;
            return num.toFixed(d);
        },

        /**
         * Formate un nombre de manière intelligente : choisit
         * automatiquement le nombre de décimales selon la magnitude.
         *
         * @param {*} value
         * @returns {string}
         */
        formatNumberSmart: function(value) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            const abs = Math.abs(num);
            if (abs === 0) return '0';
            if (abs < 0.001) return num.toExponential(2);
            if (abs < 1) return num.toFixed(4);
            if (abs < 100) return num.toFixed(3);
            if (abs < 10000) return num.toFixed(2);
            return num.toFixed(1);
        },

        // ========================================================
        // 11. FORMATAGE MÉTIER STANDARDISÉ
        // ========================================================
        /**
         * Formate un courant (A).
         * Règle : 3 décimales si < 1 A, 2 décimales si < 100 A,
         *         1 décimale si ≥ 100 A.
         *
         * @param {number} value - Courant en A
         * @returns {string}
         */
        formatAmp: function(value) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            const abs = Math.abs(num);
            if (abs < 1) return num.toFixed(3);
            if (abs < 100) return num.toFixed(2);
            return num.toFixed(1);
        },

        /**
         * Formate une tension (V).
         * Règle : 2 décimales si < 100 V, 1 décimale si ≥ 100 V.
         *
         * @param {number} value - Tension en V
         * @returns {string}
         */
        formatVolt: function(value) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            const abs = Math.abs(num);
            if (abs < 100) return num.toFixed(2);
            return num.toFixed(1);
        },

        /**
         * Formate une résistance (Ohm).
         * Règle : toujours 4 décimales (précision métier CP).
         *
         * @param {number} value - Résistance en Ohm
         * @returns {string}
         */
        formatOhm: function(value) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            return num.toFixed(4);
        },

        /**
         * Alias de formatOhm (pour cohérence sémantique).
         */
        formatResistance: function(value) {
            return this.formatOhm(value);
        },

        /**
         * Formate une masse (kg).
         * Règle : 1 décimale si < 1000 kg, 0 décimale sinon.
         *
         * @param {number} value - Masse en kg
         * @returns {string}
         */
        formatKg: function(value) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            if (Math.abs(num) < 1000) return num.toFixed(1);
            return num.toFixed(0);
        },

        /**
         * Formate un nombre d'unités (anodes, équipements).
         * Règle : toujours entier (0 décimale).
         *
         * @param {number} value
         * @returns {string}
         */
        formatUnitCount: function(value) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            return Math.round(num).toString();
        },

        /**
         * Formate une longueur (m ou mm).
         * Règle : 2 décimales si < 10, 1 décimale si < 100, 0 sinon.
         *
         * @param {number} value - Longueur
         * @param {string} [unit='m'] - 'm' ou 'mm'
         * @returns {string}
         */
        formatLength: function(value, unit) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            const u = unit || 'm';
            const abs = Math.abs(num);
            let formatted;
            if (abs < 10) formatted = num.toFixed(2);
            else if (abs < 100) formatted = num.toFixed(1);
            else formatted = num.toFixed(0);
            return formatted + ' ' + u;
        },

        /**
         * Formate une surface (m²).
         * Règle : 2 décimales si < 100, 1 décimale si < 10000, 0 sinon.
         *
         * @param {number} value - Surface en m²
         * @returns {string}
         */
        formatSurface: function(value) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            const abs = Math.abs(num);
            if (abs < 100) return num.toFixed(2);
            if (abs < 10000) return num.toFixed(1);
            return num.toFixed(0);
        },

        /**
         * Formate un potentiel (mV vs Cu/CuSO4).
         * Règle : entier (0 décimale).
         *
         * @param {number} value - Potentiel en mV
         * @returns {string}
         */
        formatMillivolt: function(value) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            return Math.round(num).toString();
        },

        /**
         * Formate un pourcentage.
         * Règle : 1 décimale.
         *
         * @param {number} value - Valeur en %
         * @returns {string}
         */
        formatPercent: function(value) {
            if (value === undefined || value === null || value === '') return 'N/A';
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return 'N/A';
            return num.toFixed(1) + '%';
        },

        // ========================================================
        // 12. FORMATAGE STATUT
        // ========================================================
        /**
         * Formate un statut avec badge texte (compatible CP1252).
         *
         * @param {string} status - 'PASS' | 'WARNING' | 'FAIL' | 'NA' | 'NC'
         * @returns {string}
         */
        formatStatus: function(status) {
            if (!status) return '[N/A] N/A';
            const s = this.status[String(status).toUpperCase()] || this.status.NA;
            return s.badge + ' ' + s.label;
        },

        /**
         * Retourne la couleur hexadécimale d'un statut.
         *
         * @param {string} status
         * @returns {string} Couleur hex (#RRGGBB)
         */
        getStatusColorHex: function(status) {
            if (!status) return this.colors.textLight;
            const s = this.status[String(status).toUpperCase()] || this.status.NA;
            return s.color;
        },

        /**
         * Retourne la couleur de fond d'un statut.
         *
         * @param {string} status
         * @returns {string} Couleur hex (#RRGGBB)
         */
        getStatusBgColorHex: function(status) {
            if (!status) return this.colors.secondary;
            const s = this.status[String(status).toUpperCase()] || this.status.NA;
            return s.bgColor;
        },

        // ========================================================
        // 13. TRADUCTION VARIABLES TECHNIQUES
        // ========================================================
        /**
         * Convertit un nom de variable technique en label professionnel.
         *
         * @param {string} varName - Nom de la variable
         * @returns {string} Label traduit
         */
        translateVariableName: function(varName) {
            const translations = {
                // Géométrie
                'diametre_m': 'Diametre exterieur (m)',
                'longueur_m': 'Longueur (m)',
                'hauteur_m': 'Hauteur (m)',
                'largeur_m': 'Largeur (m)',
                'surface_m2': 'Surface (m2)',
                'surface': 'Surface (m2)',
                'S': 'Surface (m2)',

                // Revêtement & Corrosion
                'coating': 'Efficacite revetement (eps)',
                'eps': 'Efficacite revetement (eps)',
                'defectDensity': 'Densite de defauts (DF)',
                'DF': 'Densite de defauts (DF)',
                'agingFactor': 'Facteur vieillissement (k)',
                'k': 'Facteur vieillissement (k)',
                'currentDensity': 'Densite de courant (J)',
                'J': 'Densite de courant (J)',
                'targetPotential': 'Potentiel cible (mV)',

                // SACP / Anodes
                'totalMass': 'Masse totale (kg)',
                'anodeCount': 'Nombre d anodes',
                'count': 'Nombre d anodes',
                'N': 'Nombre d anodes',
                'anodeLength': 'Longueur anode (m)',
                'L': 'Longueur anode (m)',
                'anodeDiameter': 'Diametre anode (m)',
                'd': 'Diametre anode (m)',
                'anodeMaterial': 'Materiau anode',
                'actualLife': 'Duree de vie reelle (ans)',
                'initialCurrent': 'Courant initial (A)',
                'finalCurrent': 'Courant final (A)',
                'safetyFactor': 'Facteur de securite',

                // ICCP / Groundbed
                'rho': 'Resistivite sol (Ohm.m)',
                'soilResistivity': 'Resistivite sol (Ohm.m)',
                'totalDepth': 'Profondeur totale (m)',
                'activeDepth': 'Profondeur active (m)',
                'groundbedResistance': 'Resistance groundbed (Ohm)',
                'R_total': 'Resistance totale (Ohm)',
                'R_group': 'Resistance groupe (Ohm)',
                'R_cable': 'Resistance cable (Ohm)',
                'R_struct': 'Resistance structure (Ohm)',
                'I_total': 'Courant total (A)',
                'voltage': 'Tension (V)',
                'V': 'Tension (V)',
                'power': 'Puissance (W)',
                'P': 'Puissance (W)',
                'current': 'Courant (A)',
                'I': 'Courant (A)',

                // Interférences
                'acInduced': 'Tension AC induite (V)',
                'dcStray': 'Courant vagabond DC (A)',
                'touchVoltage': 'Tension contact (V)',
                'deltaV': 'Difference potentiel (mV)',
                'R_path': 'Resistance chemin (Ohm)',
                'J_anode': 'Densite anodique (A/m2)',
                'densityLimit': 'Limite densite (A/m2)'
            };
            return translations[varName] || varName;
        },

        // ========================================================
        // 14. FORMATAGE UNITÉS (compatible CP1252)
        // ========================================================
        /**
         * Formate une unité technique sans caractères problématiques.
         * Fix B-25 : 'degC' → '°C'.
         *
         * @param {string} unit
         * @returns {string}
         */
        formatUnit: function(unit) {
            if (!unit) return '';
            const units = {
                'ohm.m': 'Ohm.m',
                'ohm': 'Ohm',
                'ohms': 'Ohm',
                'Ω.m': 'Ohm.m',
                'Ω': 'Ohm',
                'Ohm.m': 'Ohm.m',
                'Ohm': 'Ohm',
                'A/m2': 'A/m2',
                'A/m²': 'A/m2',
                'mA/m2': 'mA/m2',
                'mA/m²': 'mA/m2',
                'm2': 'm2',
                'm²': 'm2',
                'm3': 'm3',
                'm³': 'm3',
                'V': 'V',
                'kV': 'kV',
                'W': 'W',
                'kW': 'kW',
                'kg': 'kg',
                'mm': 'mm',
                'cm': 'cm',
                'm': 'm',
                'km': 'km',
                '°C': '°C',
                'degC': '°C',
                'deg C': '°C',
                '%': '%',
                'A': 'A',
                'mA': 'mA',
                'years': 'ans',
                'year': 'an',
                'ans': 'ans',
                'units': 'unites',
                'unités': 'unites',
                'h': 'h',
                'min': 'min',
                's': 's',
                'Hz': 'Hz',
                'g/L': 'g/L',
                'ppm': 'ppm',
                'µS/cm': 'uS/cm',
                'uS/cm': 'uS/cm',
                'mS/cm': 'mS/cm',
                'mV': 'mV',
                'V vs Cu/CuSO4': 'V vs Cu/CuSO4',
                'A.yr/kg': 'A.yr/kg',
                'A·an/kg': 'A.yr/kg'
            };
            return units[unit] || unit;
        },

        // ========================================================
        // 15. CONVERSION HEX → RGB
        // ========================================================
        /**
         * Convertit une couleur hexadécimale en tableau RGB.
         *
         * @param {string|number[]} hex
         * @returns {number[]} [r, g, b]
         */
        hexToRgb: function(hex) {
            if (!hex) return [26, 32, 44];
            if (Array.isArray(hex)) return hex;
            let h = String(hex).replace(/^#/, '');
            if (h.length === 3) {
                h = h.split('').map(c => c + c).join('');
            }
            const bigint = parseInt(h, 16);
            if (isNaN(bigint)) return [26, 32, 44];
            return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
        },

        // ========================================================
        // 16. FORMATAGE DATE
        // ========================================================
        /**
         * Formate une date au format ISO (YYYY-MM-DD).
         *
         * @param {string|Date} date
         * @returns {string}
         */
        formatDate: function(date) {
            if (!date) return 'N/A';
            try {
                const d = new Date(date);
                if (isNaN(d.getTime())) return 'N/A';
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return y + '-' + m + '-' + day;
            } catch (e) {
                return 'N/A';
            }
        },

        /**
         * Formate une date au format humain "12 Sep 2026".
         *
         * @param {string|Date} date
         * @returns {string}
         */
        formatDateHuman: function(date) {
            if (!date) return 'N/A';
            try {
                const d = new Date(date);
                if (isNaN(d.getTime())) return 'N/A';
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
            } catch (e) {
                return 'N/A';
            }
        },

        // ========================================================
        // 17. TRONCATURE DE CHAÎNE
        // ========================================================
        /**
         * Tronque une chaîne à une longueur maximale en ajoutant "...".
         * Garantit qu'aucune chaîne tronquée ne dépasse maxLength.
         * Évite la troncature des termes courts comme '3LPE'.
         *
         * @param {string} str
         * @param {number} [maxLength=30]
         * @returns {string}
         */
        truncate: function(str, maxLength) {
            if (str === undefined || str === null) return '';
            const s = String(str);
            const max = (typeof maxLength === 'number' && maxLength > 3) ? maxLength : 30;
            if (s.length <= max) return s;
            return s.substring(0, max - 3) + '...';
        },

        // ========================================================
        // 18. NORMALISATION D'IDENTIFIANTS
        // ========================================================
        /**
         * Normalise un identifiant en supprimant les espaces parasites
         * autour des tirets.
         *
         * Corrige : "CP- PROJ- 001- DES- 001" → "CP-PROJ-001-DES-001"
         *           "PROJ- 001" → "PROJ-001"
         *           "2026- 09- 12" → "2026-09-12"
         *
         * @param {string} id
         * @returns {string}
         */
        normalizeId: function(id) {
            if (!id) return '';
            return String(id)
                .replace(/\s*-\s*/g, '-')
                .replace(/\s+/g, ' ')
                .trim();
        },

        // ========================================================
        // 19. DÉTECTION DE STATUT DANS UN TEXTE
        // ========================================================
        /**
         * Détecte si un texte contient un mot-clé de statut et
         * retourne la couleur correspondante.
         *
         * @param {string} text
         * @returns {string} Couleur hex
         */
        detectStatusColor: function(text) {
            if (!text) return this.colors.textDark;
            const lower = String(text).toLowerCase();
            if (lower.indexOf('conforme') !== -1 && lower.indexOf('non conforme') === -1) {
                return this.colors.success;
            }
            if (lower.indexOf('non conforme') !== -1 || lower.indexOf('fail') !== -1) {
                return this.colors.danger;
            }
            if (lower.indexOf('avertissement') !== -1 || lower.indexOf('warning') !== -1) {
                return this.colors.warning;
            }
            return this.colors.textDark;
        }
    };

    // ========================================================
    // 20. EXPOSITION GLOBALE
    // ========================================================
    if (typeof window !== 'undefined') {
        window.PDFReportStyles = PDFReportStyles;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PDFReportStyles;
    }

    console.log('[PDF Styles] v6.1 Professional Design System charge avec succes');
    console.log('[PDF Styles] Encodage securise etendu (CP1252 + C1 safe + sequences longues)');
    console.log('[PDF Styles] Table UNICODE_REPLACEMENTS : ' +
                Object.keys(UNICODE_REPLACEMENTS).length + ' caracteres');
    console.log('[PDF Styles] Table LATEX_REPLACEMENTS : ' +
                LATEX_REPLACEMENTS.length + ' motifs');
    console.log('[PDF Styles] Table ACCENT_REPLACEMENTS : ' +
                Object.keys(ACCENT_REPLACEMENTS).length + ' caracteres');
    console.log('[PDF Styles] sanitizeUnicode() v6.1 : filtre sequences longues (>= 10) actif');
    console.log('[PDF Styles] Formatage metier standardise (formatAmp, formatVolt, formatOhm, ...)');
    console.log('[PDF Styles] normalizeText() : pipeline complet (LaTeX + Unicode + #)');
})();
// ============================================================
// FIN DU FICHIER pdf-report-styles.js (VERSION 6.1)
// ============================================================