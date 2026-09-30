// ============================================================
// pdf-report-calculations.js – CP Engineer Pro
// Fiches de calcul normatives professionnelles pour rapports PDF
// Version 6.1 – International Engineering Calculation Sheets
// ============================================================
// CORRECTIONS v6.1 :
//   ✅ P0-02 : _guessUnit étendu pour les unités canoniques
//      (J_anode, J_anode_mA, currentDensityAnode,
//       currentDensityAnode_mA, currentDensity_mA)
//   ✅ P0-05 : _guessUnit pour la traçabilité de la résistivité
//      (rhoProject, rhoGroundbed, rho_eff)
//   ✅ P1-05 : _guessUnit pour la durée de vie
//      (lifeTheoretical, lifeDesign, designLifeTarget)
//   ✅ B-06 : Vérification "Grounded" → "Groundbed" (déjà OK v6.0)
// ============================================================
// CORRECTIONS MAJEURES v6.0 (conservées) :
//   ✅ _cleanFormula() : délègue à styles.stripLatex() puis
//      styles.normalizeText() si disponibles (fix B-01 définitif)
//   ✅ normativeReferences : "grounded" → "groundbed" (fix B-06)
//   ✅ generateSheet() : détection défensive des IDs dupliqués
//      avec suffixe #2, #3 pour éviter collisions (fix B-05)
//   ✅ generateRegister() : déduplication visuelle des IDs (B-05)
//   ✅ _guessUnit() étendu (formatAmp, formatVolt, formatOhm)
//   ✅ Cohérence avec styles v6.0 (formatAmp, formatVolt, formatOhm)
//   ✅ Utilisation de helpers._cleanText() v6.0 (pipeline complet)
//   ✅ Compatibilité ascendante totale avec moteur v5.0
// ============================================================
(function() {
    'use strict';

    /**
     * Moteur de génération des fiches de calcul normatives
     * @namespace PDFCalculationSheets
     * @description Génère des fiches de calcul style DNV/NACE/ISO
     *              avec formules encadrées et résultats mis en valeur
     */
    const PDFCalculationSheets = {

        // Version des fiches de calcul PDF (cycle de vie indépendant)
        VERSION: '6.1.0',

        // ========================================================
        // 1. RÉFÉRENCES NORMATIVES COMPLÈTES
        // ========================================================
        // CORRECTION B-06 : "grounded" → "groundbed" partout
        // CORRECTION B-05 : tous les IDs sont uniques et distincts
        normativeReferences: {
            'CALC-CP-001': {
                standard: 'ISO 15589-1:2017 / NACE SP0169',
                title: 'Cathodic Protection Current Requirement',
                purpose: 'Determination of the required protection current for the buried/immersed structure'
            },
            'CALC-SACP-001': {
                standard: 'DNV-RP-B401 / NACE SP0169',
                title: 'Sacrificial Anode Total Mass',
                purpose: 'Calculation of the total anode mass required for the design life'
            },
            'CALC-SACP-002': {
                standard: 'DNV-RP-B401',
                title: 'Number of Sacrificial Anodes',
                purpose: 'Determination of the required number of anodes based on mass and geometry'
            },
            'CALC-SACP-003': {
                standard: 'DNV-RP-B401 / ISO 15589-2',
                title: 'Sacrificial Anode Design Life',
                purpose: 'Verification of the anode design life against project requirements'
            },
            'CALC-ICCP-001': {
                standard: 'NACE SP0169 / ISO 15589-1',
                title: 'ICCP Total Current Requirement',
                purpose: 'Calculation of the total impressed current required for protection'
            },
            'CALC-ICCP-002': {
                standard: 'NACE SP0169',
                title: 'ICCP Rectifier Output Voltage',
                purpose: 'Determination of the required rectifier output voltage with back EMF'
            },
            'CALC-ICCP-003': {
                standard: 'NACE SP0169 / IEC 60146',
                title: 'ICCP Rectifier Power Rating',
                purpose: 'Calculation of the required rectifier power rating with safety margin'
            },
            'CALC-GB-001': {
                standard: 'Dwight Formula / NACE SP0169',
                title: 'Deep Well Groundbed Resistance',
                // CORRECTION B-06 : "grounded" → "groundbed"
                purpose: 'Calculation of the groundbed total electrical resistance'
            },
            'CALC-GB-002': {
                standard: 'NACE SP0169 / ISO 15589-1',
                title: 'Deep Well Groundbed Current Capacity',
                // CORRECTION B-06 : "grounded" → "groundbed"
                purpose: 'Determination of the groundbed maximum current output capacity'
            },
            'CALC-IF-001': {
                standard: 'AMPP SP0177 / ISO 18086',
                title: 'AC Induced Voltage Assessment',
                purpose: 'Assessment of AC interference from parallel power lines'
            },
                        'CALC-IF-002': {
                standard: 'AMPP SP0177 / ISO 18086',
                title: 'DC Stray Current Assessment',
                purpose: 'Assessment of DC stray current interference from nearby structures'
            },

            // ═══════════════════════════════════════════════════════════
            // A-01 : Références pour l'analyse de corrosion AC
            // ═══════════════════════════════════════════════════════════
            'CALC-AC-001': {
                standard: 'EN 15280:2013 §6.3',
                title: 'AC Corrosion Ratio J_AC / J_DC',
                purpose: 'Assessment of the ratio between AC and DC current densities on the pipeline surface'
            },
            'CALC-AC-002': {
                standard: 'EN 15280:2013 §6.3',
                title: 'AC Current Density Classification',
                purpose: 'Classification of the AC current density level on the pipeline'
            },
            'CALC-AC-003': {
                standard: 'IEC 60479-1:2018 §5',
                title: 'AC Touch Voltage Zone Classification',
                purpose: 'Classification of the touch voltage in IEC 60479-1 zones 1 to 4'
            },
            'CALC-AC-004': {
                standard: 'EN 15280:2013 §7',
                title: 'AC Corrosion Global Risk Level',
                purpose: 'Aggregated risk level for AC corrosion likelihood'
            },
            'CALC-AC-005': {
                standard: 'EN 15280:2013 §8',
                title: 'AC Mitigation Recommendations',
                purpose: 'Recommended mitigation measures for AC corrosion'
            },

            // ═══════════════════════════════════════════════════════════
            // A-02 : Références pour l'analyse MIC / SRB
            // ═══════════════════════════════════════════════════════════
            'CALC-MIC-001': {
                standard: 'NACE TM0212-2018 §7.3',
                title: 'SRB Activity Score',
                purpose: 'Scoring of Sulfate-Reducing Bacteria activity in soil'
            },
            'CALC-MIC-002': {
                standard: 'NACE TM0212-2018 §7.3',
                title: 'MIC Classification Level',
                purpose: 'Classification of Microbiologically Influenced Corrosion likelihood'
            },
            'CALC-MIC-003': {
                standard: 'NACE TM0212-2018 §8',
                title: 'MIC Monitoring Protocol',
                purpose: 'Recommended monitoring protocol for MIC-affected pipelines'
            }
        },

        // ========================================================
        // 2. RÉFÉRENCE AUX STYLES
        // ========================================================
        _styles: null,

        /**
         * Définit la référence aux styles (appelé par le moteur).
         *
         * @param {Object} styles - PDFReportStyles
         */
        setStyles: function(styles) {
            this._styles = styles;
        },

        // ========================================================
        // 3. GÉNÉRATION D'UNE FICHE DE CALCUL COMPLÈTE
        // ========================================================
        /**
         * Génère une fiche de calcul normative complète.
         *
         * @param {Object} calc - Données du calcul
         * @param {Object} helpers - Instance de PDFReportHelpers
         * @param {Object} [options] - Options (occurrenceIndex pour IDs dupliqués)
         * @returns {number} Nouvelle position Y
         */
        generateSheet: function(calc, helpers, options) {
            try {
                return this._generateSheetInternal(calc, helpers, options || {});
            } catch (error) {
                console.error('[PDF Calculations] Erreur generateSheet pour ' +
                              (calc && calc.id ? calc.id : 'N/A') + ':', error);
                helpers.y += 10;
                return helpers.y;
            }
        },

        /**
         * Implémentation interne de generateSheet() (protégée par try/catch).
         *
         * @private
         */
        _generateSheetInternal: function(calc, helpers, options) {
            const styles = helpers.styles;
            const doc = helpers.doc;
            const margin = helpers.margin;
            const contentWidth = helpers.contentWidth;

            if (!calc || !calc.id) {
                console.warn('[PDF Calculations] Fiche sans ID, ignorée');
                return helpers.y;
            }

            const ref = this.normativeReferences[calc.id];
            if (!ref) {
                helpers.addText('Normative reference not found: ' + calc.id,
                                margin, helpers.y, {
                    fontSize: styles.typography.sizes.small,
                    style: 'italic',
                    color: styles.colors.textLight
                });
                helpers.y += 8;
                return helpers.y;
            }

            // ================================================
            // CORRECTION B-05 : gestion défensive des IDs dupliqués
            // Si options.occurrenceIndex > 1, on affiche un suffixe #N
            // ================================================
            let displayId = calc.id;
            if (options && typeof options.occurrenceIndex === 'number' && options.occurrenceIndex > 1) {
                displayId = calc.id + ' #' + options.occurrenceIndex;
            }

            // ================================================
            // ANTI-ORPHELIN : Vérifier qu'il reste au moins 45 mm
            // ================================================
            helpers.addNewPageIfNeeded(45);

            // ================================================
            // TITRE DE LA FICHE
            // ================================================
            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.sectionTitle);
            const primaryRgb = helpers.hexToRgb(styles.colors.primary);
            doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);

                        // F-09 : empecher la coupure de l'ID en utilisant des espaces
            //        non-secables autour des tirets.
            const titleText = helpers._cleanText(displayId + ' - ' + ref.title);
            const safeTitleText = titleText
                .replace(/\s*-\s*/g, '\u00A0-\u00A0')
                .replace(/\s+/g, ' ');
            try {
                doc.text(safeTitleText, margin, helpers.y, { maxWidth: contentWidth });
            } catch (e) {
                try { doc.text(safeTitleText, margin, helpers.y); } catch (e2) {}
            }
            helpers.y += 6;

            // ================================================
            // RÉFÉRENCE NORMATIVE
            // ================================================
            doc.setFont(styles.typography.fontFamily, 'normal');
            doc.setFontSize(styles.typography.sizes.small);
            const mediumRgb = helpers.hexToRgb(styles.colors.textMedium);
            doc.setTextColor(mediumRgb[0], mediumRgb[1], mediumRgb[2]);

            try {
                doc.text('Normative Reference:', margin, helpers.y);
            } catch (e) {}

            doc.setFont(styles.typography.fontFamily, 'italic');
            const darkRgb = helpers.hexToRgb(styles.colors.textDark);
            doc.setTextColor(darkRgb[0], darkRgb[1], darkRgb[2]);

            const refText = helpers._cleanText(ref.standard);
            try {
                doc.text(refText, margin + 38, helpers.y, { maxWidth: contentWidth - 38 });
            } catch (e) {
                try { doc.text(refText, margin + 38, helpers.y); } catch (e2) {}
            }
            helpers.y += 4;

            // ================================================
            // OBJECTIF
            // ================================================
            doc.setFont(styles.typography.fontFamily, 'normal');
            doc.setTextColor(mediumRgb[0], mediumRgb[1], mediumRgb[2]);
            try {
                doc.text('Purpose:', margin, helpers.y);
            } catch (e) {}

            doc.setTextColor(darkRgb[0], darkRgb[1], darkRgb[2]);
            const purposeText = helpers._cleanText(ref.purpose);
            let purposeLines = [];
            try {
                purposeLines = doc.splitTextToSize(purposeText, contentWidth - 20);
            } catch (e) {
                purposeLines = [purposeText];
            }
            if (!Array.isArray(purposeLines)) purposeLines = [String(purposeLines)];

            try {
                doc.text(purposeLines, margin + 20, helpers.y, { maxWidth: contentWidth - 20 });
            } catch (e) {
                for (let i = 0; i < purposeLines.length; i++) {
                    try {
                        doc.text(purposeLines[i], margin + 20, helpers.y + i * 4);
                    } catch (e2) {}
                }
            }
            helpers.y += purposeLines.length * 4 + 2;

            // ================================================
            // LIGNE DE SÉPARATION
            // ================================================
            helpers.addHorizontalLine(helpers.y, contentWidth, styles.colors.border, 0.3);
            helpers.y += 4;

            // ================================================
            // DONNÉES D'ENTRÉE (TABLEAU)
            // ================================================
            helpers.addNewPageIfNeeded(30);

            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.body);
            doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            try {
                doc.text('Input Data', margin, helpers.y);
            } catch (e) {}
            helpers.y += 4;

            const inputRows = [];
            if (calc.variables && typeof calc.variables === 'object') {
                Object.keys(calc.variables).forEach(function(key) {
                    const value = calc.variables[key];
                    const displayName = styles.translateVariableName(key);
                    // CORRECTION : utilisation de formatNumberSmart si dispo
                    let formattedValue;
                    if (styles.formatNumberSmart) {
                        formattedValue = styles.formatNumberSmart(value);
                    } else {
                        formattedValue = styles.formatNumber(value, 3);
                    }
                    const unit = this._guessUnit(key);
                    inputRows.push([displayName, formattedValue, unit]);
                }, this);
            }

            if (inputRows.length > 0) {
                helpers.addTable(
                    ['Parameter', 'Value', 'Unit'],
                    inputRows,
                    { colWidths: [85, 45, 40] }
                );
            } else {
                helpers.addText('No input data available.', margin, helpers.y, {
                    fontSize: styles.typography.sizes.small,
                    style: 'italic',
                    color: styles.colors.textLight
                });
                helpers.y += 6;
            }

            // ================================================
            // FORMULE (ENCADRÉ PREMIUM)
            // ================================================
            helpers.addNewPageIfNeeded(25);
            helpers.y += 4;

            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.body);
            doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            try {
                doc.text('Design Equation', margin, helpers.y);
            } catch (e) {}
            helpers.y += 4;

            // CORRECTION B-01 : _cleanFormula() délègue à styles
            const cleanFormula = this._cleanFormula(calc.formula || 'N/A');
            helpers.y = helpers.addFormulaBox(cleanFormula, margin, helpers.y, contentWidth);

            // ================================================
            // SUBSTITUTION NUMÉRIQUE
            // ================================================
            helpers.addNewPageIfNeeded(20);

            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.body);
            doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            try {
                doc.text('Numerical Substitution', margin, helpers.y);
            } catch (e) {}
            helpers.y += 4;

            doc.setFont(styles.typography.fontFamily, 'normal');
            doc.setFontSize(styles.typography.sizes.small);
            doc.setTextColor(mediumRgb[0], mediumRgb[1], mediumRgb[2]);
            try {
                doc.text('Substitution of input values into the design equation yields:',
                         margin + 4, helpers.y, { maxWidth: contentWidth - 4 });
            } catch (e) {
                try {
                    doc.text('Substitution of input values into the design equation yields:',
                             margin + 4, helpers.y);
                } catch (e2) {}
            }
            helpers.y += 6;

            // ================================================
            // RÉSULTAT (ENCADRÉ BLEU PREMIUM)
            // ================================================
            helpers.addNewPageIfNeeded(25);

            // CORRECTION : utilisation de formatNumberSmart si dispo
            let resultValue;
            if (styles.formatNumberSmart) {
                resultValue = styles.formatNumberSmart(calc.result);
            } else {
                resultValue = styles.formatNumber(calc.result, 3);
            }
            const unit = styles.formatUnit(calc.unit || '');
            helpers.y = helpers.addResultBox(resultValue, unit, margin, helpers.y, contentWidth);

            // ================================================
            // DESIGN CHECK (TABLEAU)
            // ================================================
            helpers.addNewPageIfNeeded(25);

            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.body);
            doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            try {
                doc.text('Design Check', margin, helpers.y);
            } catch (e) {}
            helpers.y += 4;

            const checkRows = [
                ['Criterion', calc.criterion || 'Per standard requirement'],
                ['Calculated Value', resultValue + (unit ? ' ' + unit : '')],
                ['Status', styles.formatStatus(calc.status)]
            ];

            helpers.addTable(
                ['Parameter', 'Value'],
                checkRows,
                { colWidths: [60, 110] }
            );

            // ================================================
            // BADGE DE STATUT VECTORIEL
            // ================================================
            helpers.y += 4;
            helpers.addStatusBadge(calc.status, margin, helpers.y, 45);
            helpers.y += 10;

            // ================================================
            // MESSAGE DE STATUT
            // ================================================
            if (calc.statusMessage) {
                doc.setFont(styles.typography.fontFamily, 'normal');
                doc.setFontSize(styles.typography.sizes.small);
                doc.setTextColor(mediumRgb[0], mediumRgb[1], mediumRgb[2]);

                const cleanMsg = helpers._cleanText(calc.statusMessage);
                let msgLines = [];
                try {
                    msgLines = doc.splitTextToSize(cleanMsg, contentWidth);
                } catch (e) {
                    msgLines = [cleanMsg];
                }
                if (!Array.isArray(msgLines)) msgLines = [String(msgLines)];

                try {
                    doc.text(msgLines, margin, helpers.y);
                } catch (e) {
                    for (let i = 0; i < msgLines.length; i++) {
                        try {
                            doc.text(msgLines[i], margin, helpers.y + i * 4);
                        } catch (e2) {}
                    }
                }
                helpers.y += msgLines.length * 4 + 2;
            }

            // ================================================
            // LIGNE DE SÉPARATION FINALE
            // ================================================
            helpers.y += 2;
            helpers.addHorizontalLine(helpers.y, contentWidth, styles.colors.border, 0.3);
            helpers.y += 6;

            // Reset text color
            doc.setTextColor(26, 26, 26);
            return helpers.y;
        },

        // ========================================================
        // 4. NETTOYAGE DES FORMULES (CORRIGÉ v6.0 – B-01)
        // ========================================================
        /**
         * Nettoie une formule des résidus LaTeX et caractères problématiques.
         *
         * DÉLÉGATION PRIORITAIRE :
         *   1. styles.stripLatex()      → si disponible (v6.0)
         *   2. styles.normalizeText()   → si disponible (v6.0)
         *   3. Fallback interne         → si styles v5.0 uniquement
         *
         * @param {string} formula
         * @returns {string}
         */
        _cleanFormula: function(formula) {
            if (!formula) return 'N/A';
            let f = String(formula);

            // Priorité 1 : stripLatex() (styles v6.0)
            if (this._styles && typeof this._styles.stripLatex === 'function') {
                f = this._styles.stripLatex(f);
            } else {
                // Fallback : nettoyage LaTeX manuel
                f = f.replace(/\\\[/g, '');
                f = f.replace(/\\\]/g, '');
                f = f.replace(/\\\(/g, '');
                f = f.replace(/\\\)/g, '');
                f = f.replace(/\\times/g, 'x');
                f = f.replace(/\\cdot/g, '*');
                f = f.replace(/\\div/g, '/');
                f = f.replace(/\\mu/g, 'eps');
                f = f.replace(/\\epsilon/g, 'eps');
                f = f.replace(/\\Omega/g, 'Ohm');
                f = f.replace(/\\Delta/g, 'Delta');
                f = f.replace(/\\approx/g, '~=');
                f = f.replace(/\\leq/g, '<=');
                f = f.replace(/\\geq/g, '>=');
                f = f.replace(/\\neq/g, '!=');
                f = f.replace(/\\([_$&#%{}])/g, '$1');
                f = f.replace(/\\%/g, '%');
                f = f.replace(/\\&/g, '&');
                f = f.replace(/\\_/g, '_');
                f = f.replace(/\\#/g, '#');
                f = f.replace(/\\\\/g, ' ');
                f = f.replace(/\\/g, ' ');
            }

            // Priorité 2 : normalizeText() (pipeline complet)
            if (this._styles && typeof this._styles.normalizeText === 'function') {
                f = this._styles.normalizeText(f);
            } else {
                // Fallback : nettoyage minimal
                f = f.replace(/<br\s*\/?>/gi, ' ');
                f = f.replace(/<\/?[^>]+>/g, '');
                if (this._styles && typeof this._styles.sanitizeUnicode === 'function') {
                    f = this._styles.sanitizeUnicode(f);
                }
                f = f.replace(/^\s*#+\s*/gm, '');
                f = f.replace(/#/g, '');
                f = f.replace(/\s+/g, ' ').trim();
            }

            return f;
        },

        // ========================================================
        // 5. REGISTRE DES CALCULS (TABLEAU RÉCAPITULATIF)
        // ========================================================
        /**
         * Génère le tableau récapitulatif de tous les calculs.
         * CORRECTION B-05 : déduplication visuelle des IDs.
         *
         * @param {Array} calculations - Liste des calculs
         * @param {Object} helpers - Instance de PDFReportHelpers
         * @returns {number} Nouvelle position Y
         */
        generateRegister: function(calculations, helpers) {
            const styles = helpers.styles;
            const doc = helpers.doc;
            const margin = helpers.margin;

            if (!calculations || calculations.length === 0) {
                helpers.addText('No calculations available.', margin, helpers.y, {
                    fontSize: styles.typography.sizes.small,
                    style: 'italic',
                    color: styles.colors.textLight
                });
                helpers.y += 8;
                return helpers.y;
            }

            // Titre
            helpers.addSectionTitle('Calculation Register', 2);
            helpers.y += 2;

            // CORRECTION B-05 : déduplication visuelle des IDs
            // Si un ID apparaît plusieurs fois, on ajoute un suffixe #2, #3...
            const self = this;
            const idOccurrences = {};
            const displayIds = calculations.map(function(c) {
                const baseId = c.id || 'N/A';
                if (!idOccurrences[baseId]) {
                    idOccurrences[baseId] = 1;
                    return baseId;
                }
                idOccurrences[baseId]++;
                return baseId + ' #' + idOccurrences[baseId];
            });

            const rows = calculations.map(function(c, idx) {
                const ref = self.normativeReferences[c.id];
                const displayId = displayIds[idx];

                // Utilisation de formatNumberSmart si dispo
                let resultFormatted;
                if (styles.formatNumberSmart) {
                    resultFormatted = styles.formatNumberSmart(c.result);
                } else {
                    resultFormatted = styles.formatNumber(c.result, 2);
                }

                return [
                    displayId,
                    styles.truncate(c.name || 'N/A', 35),
                    resultFormatted,
                    styles.formatUnit(c.unit || ''),
                    ref ? styles.truncate(ref.standard, 22) : 'N/A',
                    styles.formatStatus(c.status)
                ];
            });

                        // F-09 : Largeurs adaptees pour eviter la coupure des IDs.
            // Un ID de calcul (ex: "CALC-SACP-001") ne doit JAMAIS etre coupe.
            // La largeur minimale de la colonne ID doit etre >= 30 mm pour
            // accueillir "CALC-SACP-001" sur une seule ligne.
            helpers.addTable(
                ['ID', 'Calculation', 'Result', 'Unit', 'Standard', 'Status'],
                rows,
                { colWidths: [30, 42, 20, 14, 36, 28] }
            );

            return helpers.y;
        },

        // ========================================================
        // 6. UTILITAIRES INTERNES
        // ========================================================
        /**
         * Devine l'unité d'une variable à partir de son nom.
         * Toutes les unités sont compatibles CP1252.
         *
         * ÉTENDU v6.1 :
         *   - P0-02 : J_anode, J_anode_mA, currentDensityAnode,
         *             currentDensityAnode_mA, currentDensity_mA
         *   - P0-05 : rhoProject, rhoGroundbed, rho_eff
         *   - P1-05 : lifeTheoretical, lifeDesign, designLifeTarget
         *
         * @param {string} varName
         * @returns {string}
         */
        _guessUnit: function(varName) {
            const unitMap = {
                // Surfaces
                'surface': 'm2',
                'S': 'm2',
                'surface_m2': 'm2',
                'surfaceArea': 'm2',

                // Sans unité (coefficients)
                'coating': '-',
                'eps': '-',
                'epsilon': '-',
                'defectDensity': '-',
                'DF': '-',
                'agingFactor': '-',
                'k': '-',
                'utilization': '-',
                'u': '-',
                'safetyFactor': '-',
                'SF': '-',
                'safetyFactorPower': '-',
                'powerDesign': 'W',       // (alias plus bas, mais sécurité)
                'powerInitial': 'W',

                // ================================================
                // P1-01 : Densité de courant CP (J) — mA/m²
                // ================================================
                'currentDensity': 'mA/m2',
                'J': 'mA/m2',

                // ================================================
                // P0-02 : Densité anodique — canonique A/m²
                // ================================================
                'J_anode': 'A/m2',
                'J_anode_mA': 'mA/m2',
                'currentDensityAnode': 'A/m2',
                'currentDensityAnode_mA': 'mA/m2',
                'currentDensity_mA': 'mA/m2',
                'densityLimit': 'A/m2',

                // ================================================
                // P0-05 : Traçabilité résistivité
                // ================================================
                'rho': 'Ohm.m',
                'rho_soil': 'Ohm.m',
                'rhoProject': 'Ohm.m',
                'rhoGroundbed': 'Ohm.m',
                'rho_eff': 'Ohm.m',
                'soilResistivity': 'Ohm.m',
                'resistivity': 'Ohm.m',

                // Dimensions
                'anodeLength': 'm',
                'L': 'm',
                'anodeDiameter': 'm',
                'd': 'm',
                'length': 'm',
                'diameter': 'm',
                'totalDepth': 'm',
                'activeDepth': 'm',
                'hauteur': 'm',
                'largeur': 'm',
                'longueur': 'm',
                'diametre': 'm',

                // Masses
                'totalMass': 'kg',
                'mass': 'kg',
                'm': 'kg',
                'anodeWeight': 'kg',
                'weight': 'kg',
                'massPerAnode': 'kg',
                'totalMassEstimate': 'kg',

                // Nombres
                'count': 'unites',
                'N': 'unites',
                'N_anodes': 'unites',
                'N_by_current': 'unites',
                'N_by_mass': 'unites',
                'anodeCount': 'unites',
                'nb_pieux': 'unites',

                // ================================================
                // P1-05 : Durées de vie
                // ================================================
                'actualLife': 'ans',
                'T': 'ans',
                'life': 'ans',
                'designLife': 'ans',
                'lifeTheoretical': 'ans',
                'lifeDesign': 'ans',
                'designLifeTarget': 'ans',
                'lifeEstimate': 'ans',

                // Courants
                'initialCurrent': 'A',
                'finalCurrent': 'A',
                'I_avg': 'A',
                'I_avg_system': 'A',
                'current': 'A',
                'I': 'A',
                'I_total': 'A',
                'I_req': 'A',
                'I_initial_total': 'A',
                'I_final_total': 'A',
                'dcStray': 'A',
                'I_stray': 'A',
                'rectifierCurrent': 'A',
                'I_required_A': 'A',
                'I_design_A': 'A',
                'margin_ratio': '-',
                'margin_percent': '%',
                'currentPerAnode': 'A',

                // Tensions
                'voltage': 'V',
                'V': 'V',
                'V_AC': 'V',
                'acInduced': 'V',
                'touchVoltage': 'V',
                'deltaV': 'mV',
                'DeltaV': 'mV',
                'targetPotential': 'mV',
                'voltageInitial': 'V',
                'voltageFinal': 'V',
                'V_initial': 'V',
                'V_final': 'V',
                'backEmfVoltage': 'V',

                // Puissances
                'power': 'W',
                'P': 'W',
                'powerInitial': 'W',
                'powerDesign': 'W',
                'powerFinal': 'W',
                'P_initial': 'W',
                'P_final': 'W',

                // Résistances
                'groundbedResistance': 'Ohm',
                'R_total': 'Ohm',
                'R_group': 'Ohm',
                'R_well': 'Ohm',
                'R_cable': 'Ohm',
                'R_struct': 'Ohm',
                'R_path': 'Ohm',
                'R_anode': 'Ohm',
                'R_single': 'Ohm',
                'R_final': 'Ohm',
                'R_groundbed_pure': 'Ohm',
                'R_groundbed': 'Ohm',
                'groupResistanceInitial': 'Ohm',
                'groupResistanceFinal': 'Ohm',
                'totalResistance': 'Ohm',
                'totalResistanceFinal': 'Ohm',

                // Capacités
                'anodeCapacity': 'A.yr/kg',
                'capacity': 'A.yr/kg',
                'capacityAhKg': 'A.yr/kg',

                // Divers
                'efficiency': '%',
                'age': 'ans',
                'anodeSurface': 'm2'
            };
            return unitMap[varName] || '-';
        },

        /**
         * Vérifie si un calcul est valide.
         *
         * @param {Object} calc
         * @returns {boolean}
         */
        isValidCalculation: function(calc) {
            if (!calc) return false;
            if (!calc.id) return false;
            if (calc.result === undefined || calc.result === null) return false;
            const num = Number(calc.result);
            if (isNaN(num)) return false;
            return true;
        },

        /**
         * Retourne la référence normative pour un ID donné, ou null.
         *
         * @param {string} id
         * @returns {Object|null}
         */
        getReference: function(id) {
            return this.normativeReferences[id] || null;
        }
    };

    // ========================================================
    // 7. EXPOSITION GLOBALE
    // ========================================================
    if (typeof window !== 'undefined') {
        window.PDFCalculationSheets = PDFCalculationSheets;

        // Auto-liaison avec les styles si déjà chargés
        if (window.PDFReportStyles) {
            PDFCalculationSheets.setStyles(window.PDFReportStyles);
        }
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PDFCalculationSheets;
    }

    console.log('[PDF Calculations] v6.1 Engineering Calculation Sheets charge avec succes');
    console.log('[PDF Calculations] P0-02 : _guessUnit etendu (J_anode, J_anode_mA, currentDensityAnode, ...)');
    console.log('[PDF Calculations] P0-05 : _guessUnit etendu (rhoProject, rhoGroundbed, rho_eff)');
    console.log('[PDF Calculations] P1-05 : _guessUnit etendu (lifeTheoretical, lifeDesign, designLifeTarget)');
    console.log('[PDF Calculations] _cleanFormula() delegue a styles.stripLatex() / normalizeText()');
    console.log('[PDF Calculations] "Grounded" -> "Groundbed" corrige dans les references');
    console.log('[PDF Calculations] generateSheet() : detection des IDs dupliques (suffixe #2, #3)');
    console.log('[PDF Calculations] generateRegister() : deduplication visuelle des IDs');
})();
// ============================================================
// FIN DU FICHIER pdf-report-calculations.js (VERSION 6.1)
// ============================================================