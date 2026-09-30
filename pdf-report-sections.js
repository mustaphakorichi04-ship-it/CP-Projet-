// ============================================================
// pdf-report-sections.js – CP Engineer Pro
// Génération complète des sections du rapport PDF
// Version 6.3 – Professional Engineering Report Sections
// ============================================================
// CORRECTIONS v6.3 (INTÉGRATION PATCH) :
//   ✅ INTÉGRATION pdf-report-nomenclature-patch.js v1.0
//      → Ajout de la méthode PDFReportSections.generateNomenclature()
//      → 8 groupes thématiques de symboles (Courants, Surfaces,
//        Revêtement, Durées de vie, Tensions, Puissance, Résistances,
//        Résistivité & géométrie)
//      → Le moteur (pdf-report-engine.js) appellera directement
//        cette méthode — plus de monkey-patching
//
// CORRECTIONS v6.2 (conservées) :
//   ✅ Correction 6 : "mAh/m2" → "mA/m2" partout
//   ✅ Helper défensif _normalizeDensityUnit() ajouté
//   ✅ generateExecutiveSummary() utilise _normalizeDensityUnit()
// ============================================================
// CORRECTIONS v6.1 (conservées) :
//   P0-02 : Densité anodique en A/m² (canonique)
//   P0-05 : Traçabilité rhoProject / rhoGroundbed
//   P1-02 : KPI "Rectifier Power" utilise powerDesign
//   P1-05 : KPI "ICCP Life" affiche lifeDesign + tooltip
//   B-06 : "Groundbed" partout
// ============================================================
(function() {
    'use strict';

    /**
     * Générateur de sections pour le rapport PDF
     * @namespace PDFReportSections
     */
    const PDFReportSections = {

        // Version des sections PDF (cycle de vie indépendant)
        VERSION: '6.4.0',

        // ========================================================
        // HELPERS INTERNES
        // ========================================================
        _safeFormat: function(value, formatter, zeroFallback) {
            if (value === undefined || value === null || value === '') {
                return zeroFallback !== undefined ? zeroFallback : '—';
            }
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) {
                return zeroFallback !== undefined ? zeroFallback : '—';
            }
            if (num === 0 && zeroFallback !== undefined) {
                return zeroFallback;
            }
            return formatter(num);
        },

        _formatOrDash: function(value, suffix) {
            if (value === undefined || value === null || value === '' ||
                value === 0 || value === '0' || value === 0.0) {
                return '—';
            }
            const num = Number(value);
            if (isNaN(num) || !isFinite(num)) return '—';
            if (suffix) return num.toString() + ' ' + suffix;
            return num.toString();
        },

        _hasValue: function(value) {
            if (value === undefined || value === null || value === '') return false;
            if (value === 0 || value === '0') return false;
            return true;
        },

        _getPrimaryGroundbed: function(data) {
            const groundbeds = (data && data.groundbeds) || [];
            const systems = (data && data.cpSystems) || [];
            const selectedSystem = systems.find(function(system) {
                return system && system.groundbedId;
            });
            const selected = selectedSystem && groundbeds.find(function(groundbed) {
                return groundbed && groundbed.id === selectedSystem.groundbedId;
            });
            return selected || groundbeds[0] || null;
        },

        /**
         * Normalise une chaîne d'unité de densité de courant.
         * GARANTIE : "mAh/m2", "mAh/m²" → "mA/m2".
         */
        _normalizeDensityUnit: function(unitString) {
            if (unitString === undefined || unitString === null) return '';
            let str = String(unitString);
            str = str.replace(/mAh\/m²/g, 'mA/m2');
            str = str.replace(/mAh\/m2/g, 'mA/m2');
            str = str.replace(/mAh\/m\^2/g, 'mA/m2');
            str = str.replace(/mAh\s*\/\s*m²/g, 'mA/m2');
            str = str.replace(/mAh\s*\/\s*m2/g, 'mA/m2');
            return str;
        },

        // ========================================================
        // 1. PAGE DE GARDE PROFESSIONNELLE
        // ========================================================
        generateCoverPage: function(data, helpers) {
            const doc = helpers.doc;
            const styles = helpers.styles;
            const margin = helpers.margin;
            const pageWidth = helpers.pageWidth;
            const pageHeight = helpers.pageHeight;

            const primaryRgb = helpers.hexToRgb(styles.colors.primary);
            doc.setFillColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            doc.rect(0, 0, pageWidth, 40, 'F');

            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(20);
            doc.setTextColor(255, 255, 255);
            try {
                doc.text('CP ENGINEER PRO', pageWidth / 2, 20, { align: 'center' });
            } catch (e) {}
            doc.setFontSize(10);
            doc.setFont(styles.typography.fontFamily, 'normal');
            try {
                doc.text('Cathodic Protection Engineering Solutions', pageWidth / 2, 28, { align: 'center' });
            } catch (e) {}

            let y = 65;
            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.coverTitle);
            doc.setTextColor(11, 37, 69);
            try {
                doc.text('CATHODIC PROTECTION SYSTEM', pageWidth / 2, y, { align: 'center' });
            } catch (e) {}
            y += 12;

            doc.setFontSize(styles.typography.sizes.coverSubtitle);
            doc.setTextColor(19, 49, 92);
            try {
                doc.text('DESIGN, CALCULATION AND', pageWidth / 2, y, { align: 'center' });
            } catch (e) {}
            y += 8;
            try {
                doc.text('DIMENSIONING REPORT', pageWidth / 2, y, { align: 'center' });
            } catch (e) {}

            y += 15;
            const accentRgb = helpers.hexToRgb(styles.colors.accent);
            doc.setDrawColor(accentRgb[0], accentRgb[1], accentRgb[2]);
            doc.setLineWidth(1);
            doc.line(margin + 30, y, pageWidth - margin - 30, y);
            doc.setLineWidth(0.3);
            doc.line(margin + 50, y + 3, pageWidth - margin - 50, y + 3);

            y += 15;
            const boxX = margin + 20;
            const boxWidth = pageWidth - 2 * margin - 40;
            const boxHeight = 90;

            const bgRgb = helpers.hexToRgb(styles.colors.secondary);
            doc.setFillColor(bgRgb[0], bgRgb[1], bgRgb[2]);
            doc.roundedRect(boxX, y, boxWidth, boxHeight, 3, 3, 'F');

            doc.setFillColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            doc.rect(boxX, y, 4, boxHeight, 'F');

            let contentY = y + 10;
            const labelX = boxX + 12;
            const valueX = boxX + 65;

            const rawProjectId = helpers._cleanText(data.project.id || 'N/A');
            const projectId = styles.normalizeId
                ? styles.normalizeId(rawProjectId)
                : rawProjectId;

            const rawDocId = 'CP-' + projectId + '-DES-001';
            const docId = styles.normalizeId
                ? styles.normalizeId(rawDocId)
                : rawDocId;

            const dateStr = styles.formatDate(new Date());

            const projectInfo = [
                ['PROJECT', helpers._cleanText(data.project.name || 'N/A')],
                ['PROJECT ID', projectId],
                ['DOCUMENT No.', docId],
                ['SYSTEM TYPE', (data.project.cpSystemType || 'ICCP').toUpperCase()],
                ['REVISION', '00'],
                ['DATE', dateStr],
                ['STATUS', 'ISSUED FOR REVIEW']
            ];

            projectInfo.forEach(function(item) {
                const label = item[0];
                const value = item[1];

                doc.setFont(styles.typography.fontFamily, 'bold');
                doc.setFontSize(styles.typography.sizes.coverInfo);
                doc.setTextColor(11, 37, 69);
                try {
                    doc.text(label + ':', labelX, contentY);
                } catch (e) {}

                doc.setFont(styles.typography.fontFamily, 'normal');
                doc.setTextColor(26, 26, 26);
                try {
                    doc.text(String(value), valueX, contentY, { maxWidth: boxWidth - 70 });
                } catch (e) {
                    try { doc.text(String(value), valueX, contentY); } catch (e2) {}
                }
                contentY += 10;
            });

            y += boxHeight + 20;
            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.sectionTitle);
            doc.setTextColor(11, 37, 69);
            try {
                doc.text('DOCUMENT APPROVAL', pageWidth / 2, y, { align: 'center' });
            } catch (e) {}
            y += 10;

            const approvalBlocks = [
                { role: 'Prepared by', line1: 'Ing. Corrosion', line2: 'CP Engineer Pro' },
                { role: 'Checked by', line1: '________________', line2: 'QA / QC Engineer' },
                { role: 'Approved by', line1: '________________', line2: 'Technical Director' }
            ];

            const colWidth = (pageWidth - 2 * margin) / 3;

            approvalBlocks.forEach(function(block, i) {
                const x = margin + i * colWidth;

                doc.setFont(styles.typography.fontFamily, 'bold');
                doc.setFontSize(styles.typography.sizes.small);
                doc.setTextColor(74, 85, 104);
                try {
                    doc.text(block.role, x + colWidth / 2, y, { align: 'center' });
                } catch (e) {}

                doc.setFont(styles.typography.fontFamily, 'normal');
                doc.setTextColor(26, 26, 26);
                try {
                    doc.text(block.line1, x + colWidth / 2, y + 8, { align: 'center' });
                } catch (e) {}

                doc.setFontSize(styles.typography.sizes.caption);
                doc.setTextColor(74, 85, 104);
                try {
                    doc.text(block.line2, x + colWidth / 2, y + 14, { align: 'center' });
                } catch (e) {}

                if (i === 0) {
                    try {
                        doc.text(dateStr, x + colWidth / 2, y + 19, { align: 'center' });
                    } catch (e) {}
                }
            });

            const footerY = pageHeight - 25;
            doc.setFillColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            doc.rect(0, footerY, pageWidth, 25, 'F');

            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.small);
            doc.setTextColor(255, 255, 255);
            try {
                doc.text('CONFIDENTIAL - FOR PROJECT USE ONLY', pageWidth / 2, footerY + 10, { align: 'center' });
            } catch (e) {}

            doc.setFont(styles.typography.fontFamily, 'normal');
            doc.setFontSize(styles.typography.sizes.caption);
            try {
                doc.text('CP Engineer Pro - International Engineering Standards',
                         pageWidth / 2, footerY + 17, { align: 'center' });
            } catch (e) {}

            doc.setTextColor(26, 26, 26);

            doc.addPage();
            helpers.resetY();
            return helpers.y;
        },

        // ========================================================
        // 2. CONTRÔLE DOCUMENTAIRE
        // ========================================================
        generateDocumentControl: function(data, helpers) {
            helpers.addSectionTitle('DOCUMENT CONTROL', 1);
            helpers.y += 4;

            const styles = helpers.styles;
            const rawProjectId = helpers._cleanText(data.project.id || 'N/A');
            const projectId = styles.normalizeId
                ? styles.normalizeId(rawProjectId)
                : rawProjectId;

            const rawDocId = 'CP-' + projectId + '-DES-001';
            const docId = styles.normalizeId
                ? styles.normalizeId(rawDocId)
                : rawDocId;

            const controlFields = [
                ['Project Name', data.project.name || 'N/A'],
                ['Project ID', projectId],
                ['Document Number', docId],
                ['Document Title', 'Cathodic Protection Design & Calculation Report'],
                ['Discipline', 'Cathodic Protection'],
                ['Document Type', 'Design Calculation'],
                ['Revision', '00'],
                ['Status', 'Issued for Review'],
                ['Date', styles.formatDate(new Date())],
                ['Prepared By', 'Ing. Corrosion, CP Engineer Pro'],
                ['Checked By', '________________'],
                ['Approved By', '________________']
            ];

            const rows = controlFields.map(function(item) {
                return [item[0], String(item[1])];
            });

            helpers.addTable(['Field', 'Value'], rows, { colWidths: [60, 120] });
            helpers.y += 6;
            return helpers.y;
        },

        // ========================================================
        // 3. HISTORIQUE DES RÉVISIONS
        // ========================================================
        generateRevisionHistory: function(helpers) {
            helpers.addSectionTitle('DOCUMENT REVISION HISTORY', 1);
            helpers.y += 4;

            const today = helpers.styles.formatDate(new Date());
            const rows = [
                ['00', today, 'Initial Issue', 'Ing. Corrosion', '______', '______'],
                ['01', '', 'Revised', '', '', ''],
                ['02', '', 'Revised', '', '', '']
            ];

            helpers.addTable(
                ['Rev.', 'Date', 'Description', 'Prepared', 'Checked', 'Approved'],
                rows,
                { colWidths: [15, 25, 50, 30, 25, 25] }
            );

            helpers.y += 6;
            return helpers.y;
        },

        // ========================================================
        // 4. TABLE DES MATIÈRES DYNAMIQUE
        // ========================================================
        generateTableOfContents: function(chapters, helpers) {
            const doc = helpers.doc;
            const styles = helpers.styles;
            const margin = helpers.margin;
            const pageWidth = helpers.pageWidth;

            helpers.addSectionTitle('TABLE OF CONTENTS', 1);
            helpers.y += 6;

            doc.setFont(styles.typography.fontFamily, 'normal');
            doc.setFontSize(styles.typography.sizes.body);
            doc.setTextColor(26, 26, 26);

            chapters.forEach(function(chapter) {
                if (!chapter.title || chapter.title === '') {
                    helpers.y += 4;
                    return;
                }

                const title = helpers._cleanText(chapter.title);
                const page = chapter.page;

                helpers.addNewPageIfNeeded(8);

                const titleWidth = doc.getTextWidth(title);
                const pageWidthNum = doc.getTextWidth(String(page));

                const availableWidth = pageWidth - 2 * margin - titleWidth - pageWidthNum - 10;
                const dotWidth = doc.getTextWidth('.');
                const dotCount = Math.max(0, Math.floor(availableWidth / dotWidth));

                let dots = '';
                for (let i = 0; i < dotCount; i++) dots += '.';

                try {
                    doc.text(title, margin, helpers.y);
                } catch (e) {}
                doc.setTextColor(113, 128, 150);
                try {
                    doc.text(dots, margin + titleWidth + 2, helpers.y);
                } catch (e) {}
                doc.setTextColor(26, 26, 26);
                try {
                    doc.text(String(page), pageWidth - margin, helpers.y, { align: 'right' });
                } catch (e) {}

                helpers.y += 6;
            });

            helpers.y += 6;
            return helpers.y;
        },

        // ========================================================
        // 5. SYNTHÈSE EXÉCUTIVE
        // ========================================================
        generateExecutiveSummary: function(data, helpers) {
            const doc = helpers.doc;
            const styles = helpers.styles;
            const margin = helpers.margin;
            const contentWidth = helpers.contentWidth;

            helpers.addSectionTitle('EXECUTIVE ENGINEERING SUMMARY', 1);
            helpers.y += 6;

            const iccp = data.iccp || {};
            const sacp = data.sacp || {};
            const interference = data.interference || {};

            const cardWidth = (contentWidth / 2) - 4;
            const col1X = margin;
            const col2X = margin + cardWidth + 8;

            let rowY = helpers.y;

            const currentFormatted = this._hasValue(iccp.current)
                ? (styles.formatAmp ? styles.formatAmp(iccp.current) : iccp.current.toFixed(2))
                : '—';

            const rectifierVoltage = iccp.rectifierVoltage || iccp.voltageFinal || iccp.voltage || 0;
            const voltageFormatted = this._hasValue(rectifierVoltage)
                ? (styles.formatVolt ? styles.formatVolt(rectifierVoltage) : rectifierVoltage.toFixed(1))
                : '—';

            helpers.addKPICard(
                'DESIGN CURRENT',
                currentFormatted,
                'A',
                iccp.current > 0 ? 'PASS' : 'WARNING',
                col1X, rowY, cardWidth,
                'ICCP total current'
            );

            helpers.addKPICard(
                'RECTIFIER VOLTAGE',
                voltageFormatted,
                'V',
                rectifierVoltage > 0 ? 'PASS' : 'WARNING',
                col2X, rowY, cardWidth,
                'Recommended final output voltage'
            );

            rowY += 30;

            const resistanceFormatted = this._hasValue(iccp.groundbedResistance)
                ? (styles.formatOhm ? styles.formatOhm(iccp.groundbedResistance) : iccp.groundbedResistance.toFixed(4))
                : '—';

            const anodeCountFormatted = this._hasValue(sacp.count)
                ? (styles.formatUnitCount ? styles.formatUnitCount(sacp.count) : String(sacp.count))
                : '—';

            helpers.addKPICard(
                'GROUNDBED RESISTANCE',
                resistanceFormatted,
                'Ohm',
                iccp.groundbedResistance > 0 ? 'PASS' : 'NA',
                col1X, rowY, cardWidth,
                'Total circuit resistance'
            );

            helpers.addKPICard(
                'SACP ANODES',
                anodeCountFormatted,
                'units',
                sacp.count > 0 ? 'PASS' : 'NA',
                col2X, rowY, cardWidth,
                'Sacrificial anode count'
            );

            rowY += 30;

            const powerDesignVal = (iccp.powerDesign !== undefined && iccp.powerDesign !== null)
                ? iccp.powerDesign
                : ((iccp.powerInitial !== undefined && iccp.powerInitial !== null)
                    ? iccp.powerInitial
                    : (iccp.power || 0));
            const powerInitialVal = (iccp.powerInitial !== undefined && iccp.powerInitial !== null)
                ? iccp.powerInitial
                : (iccp.power || 0);
            const safetyFactorPowerVal = iccp.safetyFactorPower || 1.15;

            const powerFormatted = this._hasValue(powerDesignVal)
                ? styles.formatNumber(powerDesignVal, 0)
                : '—';

            const lifeDesignVal = (iccp.lifeDesign !== undefined && iccp.lifeDesign !== null)
                ? iccp.lifeDesign
                : (iccp.lifeEstimate || 0);
            const lifeTheoryVal = iccp.lifeTheoretical || 0;
            const designLifeTargetVal = (data.designLifeTarget !== undefined)
                ? data.designLifeTarget
                : 25;

            const lifeFormatted = this._hasValue(lifeDesignVal)
                ? styles.formatNumber(lifeDesignVal, 1)
                : '—';

            helpers.addKPICard(
                'RECTIFIER POWER',
                powerFormatted,
                'W',
                powerDesignVal > 0 ? 'PASS' : 'NA',
                col1X, rowY, cardWidth,
                'P_brut = ' + styles.formatNumber(powerInitialVal, 0) +
                ' W x SF = ' + styles.formatNumber(safetyFactorPowerVal, 2)
            );

                        // F-13 : Affichage coherent de la duree de vie theorique.
            // Si lifeTheoretical == 0, cela signifie que le calcul n'a pas
            // ete effectue (et NON que la duree est nulle). Afficher "N/A".
            const lifeTheoryDisplay = (lifeTheoryVal > 0)
                ? styles.formatNumber(lifeTheoryVal, 1) + ' ans'
                : 'N/A (non calculee)';

            const lifeSubtitle = (lifeDesignVal > 0)
                ? 'Conception (cap ' + designLifeTargetVal + ' ans) — ' +
                  'Theorique : ' + lifeTheoryDisplay
                : 'Calcul non effectue — verifier donnees d\'entree';

            helpers.addKPICard(
                'ICCP LIFE',
                lifeFormatted,
                'ans',
                (lifeDesignVal >= designLifeTargetVal) ? 'PASS' :
                (lifeDesignVal > 0 ? 'WARNING' : 'NA'),
                col2X, rowY, cardWidth,
                lifeSubtitle
            );

            rowY += 34;
            helpers.y = rowY;

            helpers.addNewPageIfNeeded(42);
            helpers.addSectionTitle('ICCP CALCULATED NEED VS SELECTED TR', 2);
            helpers.y += 4;

            const requirements = iccp.calculatedRequirements || {};
            const selectedTR = (iccp.transformerRectifierSelection || {}).selected || null;
            const formatValue = (value, decimals) => this._hasValue(value)
                ? styles.formatNumber(Number(value), decimals) : 'N/A';
            const selectionStatus = selectedTR
                ? 'COMPATIBLE WITH CALCULATED NEED'
                : 'NO VALIDATED TR SELECTED';
            const trName = selectedTR
                ? ((selectedTR.manufacturer || '') + ' ' + (selectedTR.model || '')).trim()
                : 'Catalog to be completed and validated';
            const trDetails = selectedTR
                ? [selectedTR.supplyVoltage, selectedTR.phases ? selectedTR.phases + ' phases' : null,
                    selectedTR.frequencyHz ? selectedTR.frequencyHz + ' Hz' : null,
                    selectedTR.technology, selectedTR.regulation, selectedTR.cooling,
                    selectedTR.enclosureProtection].filter(Boolean).join(' | ')
                : 'N/A';

            helpers.addTable(
                ['Parameter', 'ICCP calculated need', 'Selected TR nominal', 'Status'],
                [
                    ['Voltage', formatValue(requirements.voltage, 1) + ' V', selectedTR ? formatValue(selectedTR.nominalVoltage, 1) + ' V' : 'N/A', selectedTR && selectedTR.nominalVoltage >= requirements.voltage ? 'OK' : 'N/A'],
                    ['Current', formatValue(requirements.current, 2) + ' A', selectedTR ? formatValue(selectedTR.nominalCurrent, 2) + ' A' : 'N/A', selectedTR && selectedTR.nominalCurrent >= requirements.current ? 'OK' : 'N/A'],
                    ['Power', formatValue(requirements.power, 0) + ' W', selectedTR ? formatValue(selectedTR.nominalPower, 0) + ' W' : 'N/A', selectedTR && selectedTR.nominalPower >= requirements.power ? 'OK' : 'N/A'],
                    ['TR reference', 'Calculated requirement', trName, selectionStatus],
                    ['TR characteristics', 'N/A', trDetails, selectedTR ? 'INFO' : 'N/A']
                ],
                { colWidths: [42, 42, 42, 54] }
            );
            helpers.y += 4;
            helpers.y = helpers.addInfoBox(
                'TR selection traceability',
                selectedTR
                    ? 'Selection policy: technical ratings only. Nominal voltage, current and power must each be greater than or equal to the calculated ICCP requirement. Selected: ' + trName + '.'
                    : 'No validated manufacturer record is available. The ICCP values above remain calculated requirements and must not be interpreted as TR nominal ratings.',
                margin, helpers.y, contentWidth, selectedTR ? 'success' : 'warning'
            );
            helpers.y += 6;

            helpers.addNewPageIfNeeded(40);
            helpers.addSectionTitle('Soil Resistivity Provenance', 2);
            helpers.y += 4;

            const shared = (data && data.project && data.project.shared) || {};
            const rhoProjectVal = (data.projectSoilResistivity !== undefined && data.projectSoilResistivity !== null)
                ? data.projectSoilResistivity
                : ((shared.soilResistivity !== undefined) ? shared.soilResistivity : 100);
            const rhoGroundbedFromData = (data.groundbedFormationResistivity !== undefined && data.groundbedFormationResistivity !== null)
                ? data.groundbedFormationResistivity
                : null;
            const primaryGroundbed = this._getPrimaryGroundbed(data);
            const primaryGroundbedResults = primaryGroundbed && primaryGroundbed.results;
            const rhoGroundbedVal = (primaryGroundbedResults &&
                                       primaryGroundbedResults.rhoGroundbed !== undefined &&
                                       primaryGroundbedResults.rhoGroundbed !== null)
                ? primaryGroundbedResults.rhoGroundbed
                : (rhoGroundbedFromData !== null ? rhoGroundbedFromData : rhoProjectVal);

            const rhoEffVal = (primaryGroundbedResults &&
                                primaryGroundbedResults.rho_eff !== undefined &&
                                primaryGroundbedResults.rho_eff !== null)
                ? primaryGroundbedResults.rho_eff
                : rhoGroundbedVal;

            // GAP-RESIST-01 : affichage du modèle multicouche (bornes série/parallèle)
            const rhoArith = (primaryGroundbedResults &&
                              primaryGroundbedResults.rho_arithmetic !== undefined &&
                              primaryGroundbedResults.rho_arithmetic !== null)
                ? primaryGroundbedResults.rho_arithmetic
                : null;
            const rhoHarm = (primaryGroundbedResults &&
                             primaryGroundbedResults.rho_harmonic !== undefined &&
                             primaryGroundbedResults.rho_harmonic !== null)
                ? primaryGroundbedResults.rho_harmonic
                : null;
            const sensitivityRatio = (primaryGroundbedResults &&
                                      primaryGroundbedResults.layerSensitivityRatio !== undefined &&
                                      primaryGroundbedResults.layerSensitivityRatio !== null)
                ? primaryGroundbedResults.layerSensitivityRatio
                : null;

            const soilRows = [
                ['Project Soil Resistivity (source of truth)',
                 styles.formatNumber(rhoProjectVal, 1) + ' Ohm.m',
                 'Valeur de conception projet'],
                ['Groundbed Formation Resistivity',
                 styles.formatNumber(rhoGroundbedVal, 1) + ' Ohm.m',
                 'Couche d\'installation des anodes'],
                ['Effective Resistivity (weighted)',
                 styles.formatNumber(rhoEffVal, 1) + ' Ohm.m',
                 'Moyenne pondee des couches']
            ];

            // Ajout des bornes multicouches si disponibles
            if (rhoArith !== null) {
                soilRows.push([
                    'rho_serie (borne superieure — pessimiste)',
                    styles.formatNumber(rhoArith, 1) + ' Ohm.m',
                    'Moyenne arithm. ponderee — ISO 15589-1 Ann.A'
                ]);
            }
            if (rhoHarm !== null) {
                soilRows.push([
                    'rho_parallele (borne inferieure — optimiste)',
                    styles.formatNumber(rhoHarm, 1) + ' Ohm.m',
                    'Moyenne harmonique ponderee — Sunde (1968)'
                ]);
            }
            if (sensitivityRatio !== null) {
                const sensitivityStatus = sensitivityRatio > 1.25
                    ? '⚠ > 1.25 : etude numerique (FEM/BEM) requise'
                    : 'OK (≤ 1.25)';
                soilRows.push([
                    'Sensitivity Ratio (rho_arith / rho_harm)',
                    styles.formatNumber(sensitivityRatio, 2),
                    sensitivityStatus
                ]);
            }

            helpers.addTable(
                ['Parameter', 'Value', 'Provenance'],
                soilRows,
                { colWidths: [60, 30, 80] }
            );
            helpers.y += 6;

            helpers.addNewPageIfNeeded(40);
            helpers.addSectionTitle('Interference Assessment', 2);
            helpers.y += 4;

            const acStatusDisplay = this._hasValue(interference.acStatus) &&
                                    interference.acStatus !== 'Non calcule' &&
                                    interference.acStatus !== 'Non calculate'
                ? interference.acStatus
                : 'Non calcule';

            const dcStatusDisplay = this._hasValue(interference.dcStatus) &&
                                    interference.dcStatus !== 'Non calcule' &&
                                    interference.dcStatus !== 'Non calculate'
                ? interference.dcStatus
                : 'Non calcule';

            const sacpDensityA = sacp.currentDensity || 0;
            const sacpDensityMA = (sacp.currentDensity_mA !== undefined && sacp.currentDensity_mA !== null)
                ? sacp.currentDensity_mA
                : (sacpDensityA * 1000);
            const sacpDensityDisplay = this._normalizeDensityUnit(
                (Math.abs(sacpDensityA) >= 1)
                    ? styles.formatNumber(sacpDensityA, 3) + ' A/m2'
                    : styles.formatNumber(sacpDensityMA, 1) + ' mA/m2'
            );

            const summaryRows = [
                ['Protected Assets', String(data.assets ? data.assets.length : 0), '-', ''],
                ['CP Technology', (data.project.cpSystemType || 'ICCP').toUpperCase(), '-', ''],
                ['SACP Current Density', sacpDensityDisplay, '-',
                    sacp.densityOk ? '[OK]' : '[WARN]'],
                ['AC Induced Voltage',
                    styles.formatNumber ? styles.formatNumber(interference.acInduced, 2) : String(interference.acInduced || 0),
                    'V',
                    acStatusDisplay],
                ['DC Stray Current',
                    styles.formatNumber ? styles.formatNumber(interference.dcStray, 3) : String(interference.dcStray || 0),
                    'A',
                    dcStatusDisplay]
            ];

            helpers.addTable(
                ['Parameter', 'Value', 'Unit', 'Status'],
                summaryRows,
                { colWidths: [50, 30, 20, 70] }
            );

            helpers.y += 8;

            const hasICCP = iccp.current > 0;
            const hasSACP = sacp.count > 0;
            let statusMessage = '';
            let boxType = 'info';

            if (hasICCP || hasSACP) {
                statusMessage = 'A cathodic protection system is configured for this project.';
                if (hasICCP) {
                    const formattedCurrent = styles.formatAmp
                        ? styles.formatAmp(iccp.current)
                        : iccp.current.toFixed(2);
                    statusMessage += ' The ICCP system is designed for ' + formattedCurrent + ' A.';
                }
                if (hasSACP) {
                    const formattedAnodes = styles.formatUnitCount
                        ? styles.formatUnitCount(sacp.count)
                        : String(sacp.count);
                    statusMessage += ' The SACP system includes ' + formattedAnodes + ' anodes.';
                }
                boxType = 'success';
            } else {
                statusMessage = 'No cathodic protection system is configured. ' +
                                'Please perform the necessary calculations in the dedicated modules.';
                boxType = 'warning';
            }

            helpers.y = helpers.addInfoBox('Overall System Status', statusMessage,
                                            margin, helpers.y, contentWidth, boxType);

            helpers.y += 6;
            return helpers.y;
        },

        // ========================================================
        // 6. SECTION 1 : OBJET DE L'ÉTUDE
        // ========================================================
        generateSection1_Scope: function(data, helpers) {
            helpers.addSectionTitle('1. OBJECT OF THE STUDY', 1);
            helpers.y += 4;

            const styles = helpers.styles;
            const projectName = helpers._cleanText(data.project.name || '');
            const rawProjectId = helpers._cleanText(data.project.id || '');
            const projectId = styles.normalizeId
                ? styles.normalizeId(rawProjectId)
                : rawProjectId;

            const designLifeTarget = data.designLifeTarget !== undefined &&
                data.designLifeTarget !== null &&
                Number(data.designLifeTarget) > 0
                ? Number(data.designLifeTarget)
                : 25;
            const designLifeFormatted = styles.formatNumber
                ? styles.formatNumber(designLifeTarget, 1)
                : String(designLifeTarget);
            const assetCount = data.assets ? data.assets.length : 0;

            const scopeLines = [
                'This study aims at the design, calculation and dimensioning of the cathodic protection system',
                'for the project ' + projectName + ' (ID: ' + projectId + ').',
                '',
                'The objectives of the study are as follows:',
                '  - Define the type of cathodic protection system adapted (SACP, ICCP or hybrid)',
                '  - Determine the protection current requirement',
                '  - Dimension the anode system (number, type, layout)',
                '  - Dimension the rectifier / CP station for ICCP systems',
                '  - Establish protection and compliance criteria',
                '  - Define commissioning tests and maintenance',
                '',
                'The system must ensure cathodic protection compliant with applicable standards',
                'during the design life of the facility, estimated at ' + designLifeFormatted + ' years.',
                '',
                'The structure to be protected consists of ' + assetCount + ' assets.'
            ];

            scopeLines.forEach(function(line) {
                helpers.addNewPageIfNeeded(6);
                helpers.addText(line, helpers.margin, helpers.y);
                helpers.y += 5;
            });

            helpers.y += 6;
            return helpers.y;
        },

        // ========================================================
        // 7. SECTION 2 : DESCRIPTION DE L'OUVRAGE
        // ========================================================
               generateSection2_Assets: function(data, helpers) {
            const styles = helpers.styles;
            const margin = helpers.margin;

            helpers.addSectionTitle('2. DESCRIPTION OF THE FACILITY', 1);
            helpers.y += 4;

            helpers.addSectionTitle('2.1 Asset Summary', 2);
            helpers.y += 2;

            // F-03 : Schémas séparés par TYPE d'équipement.
            // Chaque catégorie possède ses propres propriétés canoniques.
            // INTERDIT d'appliquer material/wallThickness/coatingType
            // (propriétés pipeline) à un rectifier, groundbed, anode, testpost.
            const EQUIPMENT_SCHEMAS = {
                pipeline: {
                    types: ['pipeline_enterre', 'pipeline_offshore'],
                    fields: [
                        { key: 'surface',          label: 'Surface (m2)',        unit: 'm2' },
                        { key: 'material',         label: 'Material',            unit: '' },
                        { key: 'wallThickness',    label: 'Wall Thickness',      unit: 'mm' },
                        { key: 'coatingType',      label: 'Coating Type',        unit: '' },
                        { key: 'coatingCondition', label: 'Coating Condition',   unit: '' },
                        { key: 'coatingThickness', label: 'Coating Thickness',   unit: 'mm' },
                        { key: 'soilResistivity',  label: 'Soil Resistivity',    unit: 'Ohm.m' }
                    ]
                },
                rectifier: {
                    types: ['rectifier'],
                    fields: [
                        { key: 'surface',    label: 'Surface (m2)',      unit: 'm2' },
                        { key: 'dimensions', label: 'Dimensions',        unit: '' },
                        { key: 'systemId',   label: 'Associated system', unit: '' }
                    ]
                },
                groundbed: {
                    types: ['groundbed'],
                    fields: [
                        { key: 'dimensions', label: 'Dimensions',        unit: '' },
                        { key: 'systemId',   label: 'Associated system', unit: '' }
                    ]
                },
                anode: {
                    types: ['anode'],
                    fields: [
                        { key: 'dimensions', label: 'Dimensions',     unit: '' },
                        { key: 'material',   label: 'Anode Material', unit: '' }
                    ]
                },
                testpost: {
                    types: ['testpost'],
                    fields: [
                        { key: 'coordinates', label: 'GPS Coordinates',   unit: '' },
                        { key: 'systemId',    label: 'Associated system', unit: '' }
                    ]
                },
                generic: {
                    types: ['autre', 'well_casing', 'fourreau', 'support_metallique', 'pieux'],
                    fields: [
                        { key: 'surface',  label: 'Surface (m2)', unit: 'm2' },
                        { key: 'material', label: 'Material',     unit: '' }
                    ]
                }
            };

            var _resolveSchemaForAsset = function(asset) {
                const t = (asset.type || '').toLowerCase();
                for (const key of Object.keys(EQUIPMENT_SCHEMAS)) {
                    if (EQUIPMENT_SCHEMAS[key].types.indexOf(t) !== -1) {
                        return { key: key, schema: EQUIPMENT_SCHEMAS[key] };
                    }
                }
                return { key: 'generic', schema: EQUIPMENT_SCHEMAS.generic };
            };

            var _formatAssetField = function(asset, field, styles) {
                const v = asset[field.key];
                if (v === undefined || v === null || v === '' || v === 0) {
                    return '—';
                }
                if (field.unit === 'm2') {
                    return styles.formatSurface ? styles.formatSurface(v) + ' m2' : v.toFixed(2) + ' m2';
                }
                if (field.unit === 'mm') {
                    return styles.formatNumber ? styles.formatNumber(v, 1) + ' mm' : v.toFixed(1) + ' mm';
                }
                if (field.unit === 'Ohm.m') {
                    return styles.formatNumber ? styles.formatNumber(v, 1) + ' Ohm.m' : v.toFixed(1) + ' Ohm.m';
                }
                if (field.key === 'dimensions' && typeof v === 'object') {
                    return Object.keys(v).length > 0
                        ? Object.entries(v).map(function(pair) { return pair[0] + ': ' + pair[1]; }).join(', ')
                        : '—';
                }
                if (field.key === 'coordinates' && typeof v === 'object') {
                    return 'GPS available';
                }
                return String(v);
            };

            const assetSummary = data.assets.map(function(a) {
                const resolved = _resolveSchemaForAsset(a);
                const surfaceDisplay = (a.surface && a.surface > 0)
                    ? (styles.formatSurface ? styles.formatSurface(a.surface) : a.surface.toFixed(1))
                    : '—';
                const coatDisplay = (a.coatingType && a.surface > 0)
                    ? a.coatingType
                    : '—';
                const cpStatus = a.cpCalculated ? '[OK]' : '[NC]';
                return [
                    a.tag || 'N/A',
                    a.type || 'N/A',
                    resolved.key,
                    surfaceDisplay,
                    coatDisplay,
                    cpStatus
                ];
            });

            if (assetSummary.length > 0) {
                helpers.addTable(
                    ['Tag', 'Type', 'Schema', 'Surface (m2)', 'Coating', 'CP Calculated'],
                    assetSummary,
                    { colWidths: [28, 32, 20, 24, 24, 24] }
                );
            } else {
                helpers.addText('No asset registered.', margin, helpers.y, {
                    fontSize: styles.typography.sizes.small,
                    style: 'italic',
                    color: styles.colors.textLight
                });
                helpers.y += 6;
            }

            data.assets.forEach(function(asset, index) {
                helpers.addNewPageIfNeeded(50);
                const resolved = _resolveSchemaForAsset(asset);
                const schemaName = resolved.key.charAt(0).toUpperCase() + resolved.key.slice(1);

                helpers.addSectionTitle(
                    '2.' + (index + 2) + ' ' + (asset.tag || 'Asset ' + (index + 1)) +
                    ' (' + schemaName + ')',
                    2
                );

                const headerRows = [
                    ['Tag', asset.tag || 'N/A'],
                    ['Type', asset.type || 'N/A'],
                    ['Schema', schemaName],
                    ['Included in calculations', asset.included ? 'Yes' : 'No']
                ];
                helpers.addTable(['Parameter', 'Value'], headerRows,
                                  { colWidths: [60, 60] });
                helpers.y += 4;

                const specificRows = resolved.schema.fields.map(function(f) {
                    return [f.label, _formatAssetField(asset, f, styles)];
                });
                if (specificRows.length > 0) {
                    helpers.addTable(['Parameter', 'Value'], specificRows,
                                      { colWidths: [60, 60] });
                }

                helpers.y += 4;
            });

            helpers.y += 4;
            return helpers.y;
        },

        // ========================================================
        // 8. SECTION 3 : ENVIRONNEMENT
        // ========================================================
        generateSection3_Environment: function(data, helpers) {
            const styles = helpers.styles;
            const margin = helpers.margin;

            helpers.addSectionTitle('3. ENVIRONMENT', 1);
            helpers.y += 4;

            const env = data.environment;

            const envRows = [
                ['Environment', env.environment || 'N/A'],
                ['Soil Resistivity', styles.formatNumber ? styles.formatNumber(env.soilResistivity, 1) + ' Ohm.m' : String(env.soilResistivity)],
                ['pH', styles.formatNumber ? styles.formatNumber(env.soilPh, 1) : String(env.soilPh)],
                ['Moisture', (styles.formatNumber ? styles.formatNumber(env.soilMoisture, 0) : String(env.soilMoisture)) + ' %'],
                ['Chlorides', (styles.formatNumber ? styles.formatNumber(env.soilChlorides, 0) : String(env.soilChlorides)) + ' ppm'],
                ['Sulfates', (styles.formatNumber ? styles.formatNumber(env.soilSulfates, 0) : String(env.soilSulfates)) + ' ppm'],
                ['Redox Potential', (styles.formatNumber ? styles.formatNumber(env.soilRedox, 0) : String(env.soilRedox)) + ' mV']
            ];

            helpers.addTable(['Parameter', 'Value'], envRows, { colWidths: [60, 60] });
            helpers.y += 6;

            const shared = (data && data.project && data.project.shared) || {};
            const rhoProjectVal = (data.projectSoilResistivity !== undefined && data.projectSoilResistivity !== null)
                ? data.projectSoilResistivity
                : ((shared.soilResistivity !== undefined) ? shared.soilResistivity : 100);
            const rhoGroundbedVal = (data.groundbedFormationResistivity !== undefined && data.groundbedFormationResistivity !== null)
                ? data.groundbedFormationResistivity
                : rhoProjectVal;

            if (rhoGroundbedVal !== rhoProjectVal) {
                helpers.addSectionTitle('3.1 Soil Resistivity Provenance', 2);
                helpers.y += 2;
                helpers.addText(
                    'Note : la resistivite de conception du projet differe de celle de la couche d\'installation des anodes.',
                    margin, helpers.y, { style: 'italic', color: styles.colors.textMedium }
                );
                helpers.y += 5;
                const provRows = [
                    ['Project Soil Resistivity', styles.formatNumber(rhoProjectVal, 1) + ' Ohm.m',
                     'Valeur de conception projet (source de verite)'],
                    ['Groundbed Formation Resistivity', styles.formatNumber(rhoGroundbedVal, 1) + ' Ohm.m',
                     'Couche geologique d\'installation des anodes'],
                    ['Model', 'ISO 15589-1:2017 Annexe A / Sunde (1968)',
                     'Serie (rho_arith) / Parallele (rho_harm)']
                ];
                helpers.addTable(['Parameter', 'Value', 'Note'], provRows,
                                  { colWidths: [55, 30, 85] });
                helpers.y += 2;
                helpers.y = helpers.addInfoBox(
                    'Soil Resistivity Model',
                    'Two bounds are calculated (ISO 15589-1 Annex A): ' +
                    'rho_serie (arithmetic average, pessimistic — upper bound for current density calculation) ' +
                    'and rho_parallele (harmonic average, optimistic — lower bound for resistance calculation). ' +
                    'If the sensitivity ratio rho_arith / rho_harm > 1.25, a numerical soil study (FEM/BEM) is required.',
                    margin, helpers.y, helpers.contentWidth, 'info'
                );
                helpers.y += 4;
            }

            helpers.addSectionTitle('Aqueous Environment', 2);
            helpers.y += 2;

            const waterRows = [
                ['Salinity', (styles.formatNumber ? styles.formatNumber(env.waterSalinity, 1) : String(env.waterSalinity)) + ' g/L'],
                ['Conductivity', (styles.formatNumber ? styles.formatNumber(env.waterConductivity, 0) : String(env.waterConductivity)) + ' uS/cm'],
                ['Temperature', (styles.formatNumber ? styles.formatNumber(env.waterTemperature, 0) : String(env.waterTemperature)) + ' °C'],
                ['Dissolved Oxygen', (styles.formatNumber ? styles.formatNumber(env.waterDO, 1) : String(env.waterDO)) + ' mg/L']
            ];

            helpers.addTable(['Parameter', 'Value'], waterRows, { colWidths: [60, 60] });
            helpers.y += 6;

            const resistivity = Number(env.soilResistivity) || 0;
            let corrosivity = 'Low';
            if (resistivity < 10) corrosivity = 'Very High';
            else if (resistivity < 30) corrosivity = 'High';
            else if (resistivity < 100) corrosivity = 'Medium';

            helpers.addNewPageIfNeeded(10);
            helpers.addText('NACE Corrosivity Classification:', margin, helpers.y,
                            { style: 'bold' });
            helpers.addText('Resistivity = ' +
                            (styles.formatNumber ? styles.formatNumber(resistivity, 0) : String(resistivity)) +
                            ' Ohm.m  -->  ' + corrosivity,
                            margin + 70, helpers.y);

            helpers.y += 8;
            return helpers.y;
        },

        // ========================================================
        // 9. SECTION 4 : NORMES APPLICABLES
        // ========================================================
                generateSection4_Standards: function(data, helpers) {
            const styles = helpers.styles;

            helpers.addSectionTitle('4. APPLICABLE CODES AND STANDARDS', 1);
            helpers.y += 4;

            // F-14 : Matrice normative tracable.
            // Chaque norme declare : Edition, Applicability, Section Used, Purpose.
            // Une norme declaree "Applicable" sans section utilisee est suspecte.
            const NORMATIVE_MATRIX = [
                {
                    standard: 'ISO 15589-1:2017',
                    edition: '2017',
                    applicability: 'Buried/immersed pipelines',
                    section: '§6, §7, §9',
                    purpose: 'CP design criteria, current requirement'
                },
                {
                    standard: 'NACE SP0169-2013',
                    edition: '2013',
                    applicability: 'Buried/immersed metallic structures',
                    section: '§6, §7',
                    purpose: 'CP criteria, monitoring'
                },
                {
                    standard: 'DNV-RP-B401',
                    edition: '2021',
                    applicability: 'Offshore/subsea structures',
                    section: '§6, §7',
                    purpose: 'Anode sizing (offshore)'
                },
                {
                    standard: 'ISO 15589-2:2012',
                    edition: '2012',
                    applicability: 'Offshore pipelines',
                    section: '§6, §8',
                    purpose: 'Offshore CP design'
                },
                {
                    standard: 'EN 12473:2014',
                    edition: '2014',
                    applicability: 'General CP principles',
                    section: '§4, §5',
                    purpose: 'General principles'
                },
                {
                    standard: 'AMPP SP0177-2019',
                    edition: '2019',
                    applicability: 'AC interference',
                    section: '§5, §6',
                    purpose: 'AC mitigation design'
                },
                {
                    standard: 'ISO 18086:2019',
                    edition: '2019',
                    applicability: 'AC corrosion',
                    section: '§4, §5',
                    purpose: 'AC corrosion criteria'
                },
                {
                    standard: 'EN 15280:2013',
                    edition: '2013',
                    applicability: 'AC corrosion likelihood',
                    section: '§6, §7, §8',
                    purpose: 'AC corrosion risk assessment'
                },
                {
                    standard: 'IEC 60479-1:2018',
                    edition: '2018',
                    applicability: 'Electrical safety (touch voltage)',
                    section: '§5',
                    purpose: 'Touch voltage zones'
                }
            ];

            const usedStandards = (data.standards && data.standards.selected && data.standards.selected.length > 0)
                ? data.standards.selected
                : NORMATIVE_MATRIX.map(function(n) { return n.standard; });

            const matrixRows = NORMATIVE_MATRIX
                .filter(function(n) {
                    return usedStandards.some(function(u) {
                        return n.standard.indexOf(u) !== -1 ||
                               u.indexOf(n.standard.split(':')[0]) !== -1;
                    });
                })
                .map(function(n) {
                    return [n.standard, n.edition, n.applicability, n.section, n.purpose];
                });

            helpers.addTable(
                ['Standard', 'Edition', 'Applicability', 'Section Used', 'Purpose'],
                matrixRows,
                { colWidths: [32, 14, 38, 24, 52] }
            );

            helpers.y += 4;
            helpers.addText(
                'Note : seules les normes effectivement citees dans les fiches ' +
                'de calcul (Section 9) sont listees ci-dessus. Toute norme ' +
                'declaree "Applicable" sans section utilisee doit etre ' +
                'justifiee dans le document.',
                helpers.margin, helpers.y,
                { style: 'italic', color: styles.colors.textLight }
            );
            helpers.y += 6;

            return helpers.y;
        },

        // ========================================================
        // 10. SECTION 5 : CRITÈRES DE CONCEPTION
        // ========================================================
                generateSection5_Criteria: function(data, helpers) {
            const styles = helpers.styles;

            helpers.addSectionTitle('5. CP DESIGN CRITERIA', 1);
            helpers.y += 4;

            const criteria = data.criteria || {};
            const designLifeTarget = (data.designLifeTarget !== undefined)
                ? data.designLifeTarget
                : 25;

            // F-06 : Toujours preciser l'electrode de reference.
            //        "-850 mV" seul est ambigu et non conforme ISO 15589-1.
            const REF_ELECTRODE_LABEL = 'vs Cu/CuSO4 saturated reference electrode';

            const targetPotVal = (criteria.targetPotential !== undefined && criteria.targetPotential !== null)
                ? criteria.targetPotential
                : -850;

            const rows = [
                ['PROJECT DESIGN LIFE (target)',
                    designLifeTarget + ' ans (exigence projet)'],
                ['Target Protection Potential',
                    (styles.formatMillivolt ? styles.formatMillivolt(targetPotVal) : String(targetPotVal)) +
                    ' mV ' + REF_ELECTRODE_LABEL],
                ['NACE OFF Potential Criterion',
                    (styles.formatMillivolt ? styles.formatMillivolt(criteria.naceOffPotential) : String(criteria.naceOffPotential)) +
                    ' mV ' + REF_ELECTRODE_LABEL +
                    ' (' + (criteria.source === 'DEFAULT_PRESET' ? 'default preset' : 'project criterion') + ')'],
                ['NACE Polarization Criterion',
                    (styles.formatNumber ? styles.formatNumber(criteria.nacePolarization, 0) : String(criteria.nacePolarization)) +
                    ' mV (polarisation minimale, mesure Instant-Off)'],
                ['Native Potential (reference)',
                    'A mesurer sur site (non suppose)'],
                ['ON Potential (reference)',
                    'A mesurer apres stabilisation'],
                ['Current Density (design)',
                    (styles.formatNumber ? styles.formatNumber(criteria.currentDensity, 1) : String(criteria.currentDensity || 5)) +
                    ' mA/m2 (surface exposee)'],
                ['Primary Norm', criteria.norm || 'ISO 15589-1'],
                ['Reference Electrode',
                    'Cu/CuSO4 saturated (electrode de reference standard)']
            ];

            helpers.addTable(['Criterion', 'Value'], rows, { colWidths: [70, 90] });

            helpers.y += 6;
            return helpers.y;
        },

        // ========================================================
        // 11. SECTION 12 : DEEP WELL GROUNDBED (SCHÉMA)
        // ========================================================
        _drawGroundbedSchema: function(gb, helpers, x, y, width, height) {
            try {
                const doc = helpers.doc;
                const styles = helpers.styles;
                const params = gb.parameters || {};

                const totalDepth = Number(params.totalDepth) || 200;
                const activeDepth = Number(params.activeDepth) || 150;
                const anodeCount = Math.max(1, Number(params.anodeCount) || 16);

                const bgRgb = helpers.hexToRgb(styles.colors.secondary);
                doc.setFillColor(bgRgb[0], bgRgb[1], bgRgb[2]);
                doc.roundedRect(x, y, width, height, 2, 2, 'F');

                const borderRgb = helpers.hexToRgb(styles.colors.border);
                doc.setDrawColor(borderRgb[0], borderRgb[1], borderRgb[2]);
                doc.setLineWidth(0.3);
                doc.roundedRect(x, y, width, height, 2, 2, 'S');

                doc.setFont(styles.typography.fontFamily, 'bold');
                doc.setFontSize(8);
                const primaryRgb = helpers.hexToRgb(styles.colors.primary);
                doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
                try {
                    doc.text('Groundbed Well Schematic', x + width / 2, y + 4, { align: 'center' });
                } catch (e) {}

                const schemaX = x + 15;
                const schemaY = y + 8;
                const schemaW = width - 30;
                const schemaH = height - 15;

                const wellX = schemaX + schemaW * 0.5 - 3;
                const wellY = schemaY;
                const wellW = 6;
                const wellH = schemaH;

                doc.setDrawColor(100, 116, 139);
                doc.setLineWidth(0.5);
                doc.rect(wellX, wellY, wellW, wellH, 'S');

                const anodeAreaTop = wellY + (wellH * (1 - activeDepth / totalDepth));
                const anodeAreaH = wellH * (activeDepth / totalDepth);
                const anodeSpacing = anodeAreaH / (anodeCount + 1);
                const anodeRgb = helpers.hexToRgb(styles.colors.accent);
                doc.setFillColor(anodeRgb[0], anodeRgb[1], anodeRgb[2]);

                const displayAnodes = Math.min(anodeCount, 20);
                for (let i = 0; i < displayAnodes; i++) {
                    const anodeY = anodeAreaTop + (i + 1) * anodeSpacing;
                    doc.circle(wellX + wellW / 2, anodeY, 0.8, 'F');
                }

                doc.setFont(styles.typography.fontFamily, 'normal');
                doc.setFontSize(6);
                const textRgb = helpers.hexToRgb(styles.colors.textMedium);
                doc.setTextColor(textRgb[0], textRgb[1], textRgb[2]);

                const coteX = wellX + wellW + 3;
                try {
                    doc.text('0 m', coteX, wellY + 3);
                } catch (e) {}
                try {
                    doc.text(styles.formatNumber ? styles.formatNumber(totalDepth, 0) + ' m' : totalDepth + ' m',
                             coteX, wellY + wellH);
                } catch (e) {}

                doc.setDrawColor(200, 200, 200);
                doc.setLineWidth(0.2);
                doc.line(wellX - 3, anodeAreaTop, coteX - 1, anodeAreaTop);

                try {
                    doc.text('Active: ' +
                             (styles.formatNumber ? styles.formatNumber(activeDepth, 0) : activeDepth) +
                             ' m', x + 2, anodeAreaTop + 2);
                } catch (e) {}

                doc.setFont(styles.typography.fontFamily, 'bold');
                doc.setFontSize(6);
                doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
                try {
                    doc.text(displayAnodes + ' anodes', x + 2, y + height - 3);
                } catch (e) {}

                doc.setTextColor(26, 26, 26);
                return y + height + 4;

            } catch (err) {
                console.warn('[Sections] Erreur schema groundbed:', err);
                return y + height + 4;
            }
        },

        // ========================================================
        // 12. SECTION 17 : GIS / LOCATION (SNAPSHOT)
        // ========================================================
        _insertChartSnapshots: function(helpers) {
            try {
                const doc = helpers.doc;
                const styles = helpers.styles;
                const margin = helpers.margin;
                const contentWidth = helpers.contentWidth;

                const chartIds = [
                    { id: 'dashboardChart1', label: 'Figure 1 - Current per CP System' },
                    { id: 'dashboardChart3', label: 'Figure 2 - OFF Potential History' },
                    { id: 'dashboardChart4', label: 'Figure 3 - Current Trend' }
                ];

                let insertedCount = 0;

                for (let i = 0; i < chartIds.length; i++) {
                    const chartInfo = chartIds[i];
                    const canvas = document.getElementById(chartInfo.id);
                    if (!canvas) continue;

                    let dataUrl = null;
                    try {
                        dataUrl = canvas.toDataURL('image/png');
                    } catch (e) {
                        console.warn('[Sections] Impossible de capturer ' + chartInfo.id + ':', e.message);
                        continue;
                    }

                    if (!dataUrl || dataUrl === 'data:,') continue;

                    helpers.addNewPageIfNeeded(70);

                    const imgWidth = contentWidth;
                    const imgHeight = 50;

                    try {
                        doc.addImage(dataUrl, 'PNG', margin, helpers.y, imgWidth, imgHeight);
                    } catch (e) {
                        console.warn('[Sections] addImage echoue pour ' + chartInfo.id + ':', e.message);
                        continue;
                    }

                    helpers.y += imgHeight + 2;

                    doc.setFont(styles.typography.fontFamily, 'italic');
                    doc.setFontSize(styles.typography.sizes.caption);
                    const textLightRgb = helpers.hexToRgb(styles.colors.textLight);
                    doc.setTextColor(textLightRgb[0], textLightRgb[1], textLightRgb[2]);
                    try {
                        doc.text(chartInfo.label, margin + contentWidth / 2, helpers.y + 3, { align: 'center' });
                    } catch (e) {}
                    doc.setTextColor(26, 26, 26);
                    helpers.y += 8;

                    insertedCount++;
                }

                if (insertedCount > 0) {
                    console.log('[Sections] ' + insertedCount + ' graphique(s) insere(s)');
                }

                return helpers.y;

            } catch (err) {
                console.warn('[Sections] Erreur insertChartSnapshots:', err);
                return helpers.y;
            }
        },

        // ========================================================
        // 13. SECTION 23 : ANNEXES
        // ========================================================
        generateSection23_Annexes: function(data, helpers) {
            const doc = helpers.doc;
            const styles = helpers.styles;
            const margin = helpers.margin;
            const contentWidth = helpers.contentWidth;

            helpers.addSectionTitle('23. ANNEXES', 1);
            helpers.y += 4;

            helpers.addSectionTitle('Annexe A - References normatives', 2);
            helpers.y += 2;

            const standards = (data.standards && data.standards.all) || [
                'ISO 15589-1', 'NACE SP0169', 'DNV-RP-B401', 'ISO 15589-2',
                'EN 12473', 'ASTM G57', 'AMPP SP0177', 'ISO 18086'
            ];
            const selectedStandards = (data.standards && data.standards.selected) || [];

            const standardRows = standards.map(function(s) {
                const selected = selectedStandards.some(function(item) {
                    return String(item).indexOf(String(s).split(':')[0]) !== -1 ||
                        String(s).indexOf(String(item).split(':')[0]) !== -1;
                });
                return [s, selected ? 'Selected' : 'Reference only'];
            });

            helpers.addTable(['Standard', 'Statut'], standardRows,
                              { colWidths: [80, 80] });
            helpers.y += 6;

            helpers.addNewPageIfNeeded(40);
            helpers.addSectionTitle('Annexe B - Inventaire des equipements', 2);
            helpers.y += 2;

            const assets = data.assets || [];
            if (assets.length > 0) {
                const assetRows = assets.map(function(a) {
                    const surfaceDisplay = (a.surface && a.surface > 0)
                        ? (styles.formatSurface ? styles.formatSurface(a.surface) : a.surface.toFixed(1))
                        : '—';
                    const coatDisplay = (a.coatingType && a.surface > 0)
                        ? a.coatingType
                        : '—';
                    return [
                        a.tag || 'N/A',
                        a.type || 'N/A',
                        surfaceDisplay,
                        coatDisplay,
                        a.cpCalculated ? '[OK]' : '[NC]'
                    ];
                });
                helpers.addTable(
                    ['Tag', 'Type', 'Surface (m2)', 'Revetement', 'CP calcule'],
                    assetRows,
                    { colWidths: [30, 40, 25, 30, 35] }
                );
            } else {
                helpers.addText('Aucun equipement enregistre.', margin, helpers.y, {
                    fontSize: styles.typography.sizes.small,
                    style: 'italic',
                    color: styles.colors.textLight
                });
                helpers.y += 6;
            }
            helpers.y += 6;

            helpers.addNewPageIfNeeded(40);
            helpers.addSectionTitle('Annexe C - Recapitulatif des calculs', 2);
            helpers.y += 2;

            const calculations = data.calculations || [];
            if (calculations.length > 0) {
                const calcRows = calculations.map(function(c) {
                    return [
                        c.id || 'N/A',
                        styles.truncate ? styles.truncate(c.name || 'N/A', 30) : (c.name || 'N/A'),
                        styles.formatNumberSmart
                            ? styles.formatNumberSmart(c.result)
                            : (styles.formatNumber ? styles.formatNumber(c.result, 3) : String(c.result)),
                        styles.formatUnit ? styles.formatUnit(c.unit || '') : (c.unit || ''),
                        styles.formatStatus ? styles.formatStatus(c.status) : String(c.status)
                    ];
                });
                helpers.addTable(
                    ['ID', 'Calcul', 'Resultat', 'Unite', 'Statut'],
                    calcRows,
                    { colWidths: [30, 55, 25, 20, 40] }
                );
            } else {
                helpers.addText('Aucun calcul disponible.', margin, helpers.y, {
                    fontSize: styles.typography.sizes.small,
                    style: 'italic',
                    color: styles.colors.textLight
                });
                helpers.y += 6;
            }
            helpers.y += 6;

            helpers.addNewPageIfNeeded(40);
            helpers.addSectionTitle('Annexe C-bis - Densites canoniques', 2);
            helpers.y += 2;

            const iccp = data.iccp || {};
            const sacp = data.sacp || {};

            const sacpDensityA = sacp.currentDensity || 0;
            const sacpDensityMA = (sacp.currentDensity_mA !== undefined && sacp.currentDensity_mA !== null)
                ? sacp.currentDensity_mA
                : (sacpDensityA * 1000);

            const iccpDensityA = iccp.currentDensity || 0;
            const iccpDensityMA = (iccp.currentDensity_mA !== undefined && iccp.currentDensity_mA !== null)
                ? iccp.currentDensity_mA
                : (iccpDensityA * 1000);

            const densityRows = [
                ['SACP anode density (A/m2)',
                 this._normalizeDensityUnit(styles.formatNumber(sacpDensityA, 3) + ' A/m2'),
                 'Canonical : I_initial / S_anode'],
                ['SACP anode density (mA/m2)',
                 this._normalizeDensityUnit(styles.formatNumber(sacpDensityMA, 1) + ' mA/m2'),
                 'Equivalent (x 1000)'],
                ['ICCP anode density (A/m2)',
                 this._normalizeDensityUnit(styles.formatNumber(iccpDensityA, 3) + ' A/m2'),
                 'Canonical : I_anode / S_anode'],
                ['ICCP anode density (mA/m2)',
                 this._normalizeDensityUnit(styles.formatNumber(iccpDensityMA, 1) + ' mA/m2'),
                 'Equivalent (x 1000)']
            ];

            helpers.addTable(['Parameter', 'Value', 'Note'], densityRows,
                              { colWidths: [55, 35, 80] });
            helpers.y += 6;

            helpers.addNewPageIfNeeded(40);
            helpers.addSectionTitle('Annexe D - Coordonnees GPS', 2);
            helpers.y += 2;

            if (data.gis && data.gis.totalWithCoords > 0) {
                const coordRows = data.gis.equipmentWithCoords.map(function(eq) {
                    const c = eq.coordinates;
                    let lat = 'N/A';
                    let lon = 'N/A';
                    if (c) {
                        if (Array.isArray(c) && c.length > 0) {
                            lat = styles.formatNumber ? styles.formatNumber(c[0].lat, 6) : String(c[0].lat);
                            lon = styles.formatNumber ? styles.formatNumber(c[0].lon, 6) : String(c[0].lon);
                        } else if (c.lat !== undefined) {
                            lat = styles.formatNumber ? styles.formatNumber(c.lat, 6) : String(c.lat);
                            lon = styles.formatNumber ? styles.formatNumber(c.lon, 6) : String(c.lon);
                        }
                    }
                    return [eq.tag || 'N/A', eq.type || 'N/A', lat, lon];
                });
                helpers.addTable(
                    ['Tag', 'Type', 'Latitude', 'Longitude'],
                    coordRows,
                    { colWidths: [40, 40, 40, 40] }
                );
            } else {
                helpers.addText('Aucune donnee GPS disponible.', margin, helpers.y, {
                    fontSize: styles.typography.sizes.small,
                    style: 'italic',
                    color: styles.colors.textLight
                });
                helpers.y += 6;
            }

            helpers.y += 8;
            helpers.addHorizontalLine(helpers.y, contentWidth, styles.colors.border, 0.3);
            helpers.y += 6;

            doc.setFont(styles.typography.fontFamily, 'italic');
            doc.setFontSize(styles.typography.sizes.small);
            const lightRgb = helpers.hexToRgb(styles.colors.textLight);
            doc.setTextColor(lightRgb[0], lightRgb[1], lightRgb[2]);
            try {
                doc.text('End of document - CP Engineer Pro v6.3',
                         helpers.pageWidth / 2, helpers.y, { align: 'center' });
            } catch (e) {}
            doc.setTextColor(26, 26, 26);

            return helpers.y;
        },

        // ========================================================
        // 13-bis. v6.3 : NOMENCLATURE DES PARAMÈTRES DE CALCUL
        // --------------------------------------------------------
        // INTÉGRATION : pdf-report-nomenclature-patch.js v1.0
        // --------------------------------------------------------
        // Appelée par pdf-report-engine.js AVANT le registre des
        // calculs (Section 9.1).
        //
        // Contenu : 8 groupes thématiques de symboles couvrant tous
        //           les paramètres utilisés dans les formules du
        //           rapport (courants, surfaces, revêtement, durées
        //           de vie, tensions, puissance, résistances,
        //           résistivité & géométrie).
        // ========================================================
        generateNomenclature: function(data, helpers) {
            const doc = helpers.doc;
            const styles = helpers.styles;
            const margin = helpers.margin;

            // ---- Titre de la sous-section ----
            helpers.addSectionTitle('9.1 NOMENCLATURE DES PARAMETRES DE CALCUL', 2);
            helpers.y += 2;

            // ---- Texte introductif ----
            helpers.addText(
                'Cette nomenclature regroupe tous les symboles utilises dans les formules ' +
                'de calcul presentees dans ce rapport (Section 9).',
                margin, helpers.y,
                {
                    fontSize: styles.typography.sizes.small,
                    style: 'italic',
                    color: styles.colors.textLight,
                    maxWidth: helpers.contentWidth
                }
            );
            helpers.y += 6;

            // ============================================================
            // Structure de la nomenclature (groupes thematiques)
            // ============================================================
            const nomenclatureGroups = [

                // ---------- Courants ----------
                {
                    category: 'Courants (A)',
                    items: [
                        ['I',         'Courant de protection (general)',              'A'],
                        ['I_req',     'Courant de protection requis',                 'A'],
                        ['I_total',   'Courant total du systeme de protection',       'A'],
                        ['I_initial', 'Courant initial du systeme (debut de vie)',    'A'],
                        ['I_final',   'Courant final du systeme (fin de vie)',        'A'],
                        ['I_avg',     'Courant moyen sur la duree de vie',            'A'],
                        ['I_anode',   'Courant unitaire par anode',                   'A'],
                        ['I_stray',   'Courant vagabond DC',                          'A'],
                        ['I_AC',      'Courant alternatif de la ligne source',        'A']
                    ]
                },

                // ---------- Surfaces et densites ----------
                {
                    category: 'Surfaces (m2) et densites de courant',
                    items: [
                        ['S',        'Surface de structure exposee',                 'm2'],
                        ['S_anode',  'Surface unitaire d\'anode',                    'm2'],
                        ['S_cable',  'Section transversale du cable DC',             'mm2'],
                        ['J',        'Densite de courant de protection',             'mA/m2'],
                        ['J_anode',  'Densite de courant anodique',                  'A/m2'],
                        ['J_limit',  'Densite de courant limite du materiau',        'A/m2']
                    ]
                },

                // ---------- Revetement et facteurs ----------
                {
                    category: 'Revetement et facteurs de conception',
                    items: [
                        ['eps',      'Efficacite du revetement (0 a 1)',             '-'],
                        ['DF',       'Densite de defauts du revetement (0 a 1)',     '-'],
                        ['k',        'Facteur de vieillissement du revetement',      '-'],
                        ['u',        'Facteur d\'utilisation de l\'anode (0 a 1)',   '-'],
                        ['SF',       'Facteur de securite global',                   '-'],
                        ['SF_p',     'Facteur de securite sur la puissance',         '-']
                    ]
                },

                // ---------- Duree de vie, masse et anodes ----------
                {
                    category: 'Duree de vie, masse et anodes',
                    items: [
                        ['T',        'Duree de vie de conception',                   'ans'],
                        ['T_target', 'Duree de vie cible du projet',                 'ans'],
                        ['M_total',  'Masse totale d\'anodes',                       'kg'],
                        ['m',        'Masse unitaire d\'anode',                      'kg'],
                        ['C',        'Capacite electrochimique du materiau',         'Ah/kg'],
                        ['N',        'Nombre d\'anodes',                             'unites'],
                        ['N_curr',   'Nombre d\'anodes (critere courant)',           'unites'],
                        ['N_mass',   'Nombre d\'anodes (critere masse)',             'unites']
                    ]
                },

                // ---------- Tensions ----------
                {
                    category: 'Tensions (V) et potentiels (mV)',
                    items: [
                        ['V',         'Tension du redresseur',                       'V'],
                        ['V_backEMF', 'Force contre-electromotrice',                 'V'],
                        ['V_design',  'Tension de conception du circuit',           'V'],
                        ['V_AC',      'Tension AC induite par la ligne HT',          'V'],
                        ['V_touch',   'Tension de contact AC (securite)',            'V'],
                        ['DeltaV',    'Difference de potentiel (DC)',                'mV']
                    ]
                },

                // ---------- Puissance ----------
                {
                    category: 'Puissance (W)',
                    items: [
                        ['P',        'Puissance du redresseur (brute)',              'W'],
                        ['P_design', 'Puissance de conception (avec SF)',            'W'],
                        ['P_brut',   'Puissance brute (sans SF)',                    'W']
                    ]
                },

                // ---------- Resistances ----------
                {
                    category: 'Resistances electriques (Ohm)',
                    items: [
                        ['R_total',  'Resistance totale du circuit CP',              'Ohm'],
                        ['R_group',  'Resistance du groupe d\'anodes (Sunde)',       'Ohm'],
                        ['R_well',   'Resistance du puits anodique (Dwight)',        'Ohm'],
                        ['R_cable',  'Resistance des cables DC (aller-retour)',      'Ohm'],
                        ['R_struct', 'Resistance de la structure protegee',          'Ohm'],
                        ['R_path',   'Resistance du chemin de circulation DC',       'Ohm'],
                        ['R_anode',  'Resistance unitaire d\'anode (Dwight)',        'Ohm'],
                        ['R_final',  'Resistance d\'anode en fin de vie',            'Ohm']
                    ]
                },

                // ---------- Resistivite et geometrie ----------
                {
                    category: 'Resistivite du sol (Ohm.m) et geometrie (m)',
                    items: [
                        ['rho',           'Resistivite du sol',                       'Ohm.m'],
                        ['rho_project',   'Resistivite de conception du projet',      'Ohm.m'],
                        ['rho_groundbed', 'Resistivite de la couche d\'installation', 'Ohm.m'],
                        ['rho_eff',       'Resistivite effective (moyenne ponderee)', 'Ohm.m'],
                        ['L',             'Longueur (anode, pipeline, cable)',        'm'],
                        ['d',             'Diametre (anode, pipeline)',               'm'],
                        ['L_parallel',    'Longueur de parallelisme avec la ligne AC','m'],
                        ['Z',             'Impedance par unite de longueur',          'Ohm/m'],
                        ['depth_total',   'Profondeur totale du puits',               'm'],
                        ['depth_active',  'Profondeur active du puits',               'm'],
                        ['L_cable',       'Longueur de cable DC',                     'm']
                    ]
                }
            ];

            // ============================================================
            // Rendu : un tableau par groupe thematique
            // ============================================================
            nomenclatureGroups.forEach(function(group) {
                helpers.addNewPageIfNeeded(30);

                helpers.addSectionTitle(group.category, 3);
                helpers.y += 2;

                const rows = group.items.map(function(item) {
                    return [item[0], item[1], item[2]];
                });

                helpers.addTable(
                    ['Symbole', 'Designation', 'Unite'],
                    rows,
                    { colWidths: [24, 106, 20] }
                );

                helpers.y += 3;
            });

            // ---- Note de bas de nomenclature ----
            helpers.addNewPageIfNeeded(15);
            helpers.y += 2;

            const primaryRgb = helpers.hexToRgb(styles.colors.primary);
            doc.setFont(styles.typography.fontFamily, 'italic');
            doc.setFontSize(styles.typography.sizes.caption);
            const lightRgb = helpers.hexToRgb(styles.colors.textLight);
            doc.setTextColor(lightRgb[0], lightRgb[1], lightRgb[2]);

            try {
                doc.text(
                    'Reference : ISO 15589-1 / NACE SP0169 / DNV-RP-B401 / AMPP SP0177',
                    margin, helpers.y,
                    { maxWidth: helpers.contentWidth }
                );
            } catch (e) {}
            helpers.y += 5;

            doc.setTextColor(26, 26, 26);

            helpers.y += 4;
            return helpers.y;
        },

        // ========================================================
        // 14. HEADERS ET FOOTERS PROFESSIONNELS
        // ========================================================
        drawHeader: function(data, helpers) {
            const doc = helpers.doc;
            const styles = helpers.styles;
            const margin = helpers.margin;
            const pageWidth = helpers.pageWidth;
            const y = margin - 8;

            doc.setFont(styles.typography.fontFamily, 'bold');
            doc.setFontSize(styles.typography.sizes.header);
            const primaryRgb = helpers.hexToRgb(styles.colors.primary);
            doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            try {
                doc.text('CP DESIGN REPORT', margin, y);
            } catch (e) {}

            let projectName = 'N/A';
            if (data && data.project && data.project.name) {
                projectName = String(data.project.name);
            }
            const truncatedName = projectName.length > 30
                ? projectName.substring(0, 27) + '...'
                : projectName;

            try {
                doc.text(truncatedName, pageWidth - margin, y, { align: 'right' });
            } catch (e) {}

            const borderRgb = helpers.hexToRgb(styles.colors.border);
            doc.setDrawColor(borderRgb[0], borderRgb[1], borderRgb[2]);
            doc.setLineWidth(0.3);
            doc.line(margin, y + 2, pageWidth - margin, y + 2);

            doc.setTextColor(26, 26, 26);
        },

        drawFooter: function(data, helpers, pageNumber, totalPages) {
            const doc = helpers.doc;
            const styles = helpers.styles;
            const margin = helpers.margin;
            const pageWidth = helpers.pageWidth;
            const pageHeight = helpers.pageHeight;
            const y = pageHeight - 10;

            const borderRgb = helpers.hexToRgb(styles.colors.border);
            doc.setDrawColor(borderRgb[0], borderRgb[1], borderRgb[2]);
            doc.setLineWidth(0.3);
            doc.line(margin, y - 4, pageWidth - margin, y - 4);

            doc.setFont(styles.typography.fontFamily, 'normal');
            doc.setFontSize(styles.typography.sizes.footer);
            const lightRgb = helpers.hexToRgb(styles.colors.textLight);
            doc.setTextColor(lightRgb[0], lightRgb[1], lightRgb[2]);

            let projectId = 'PRJ';
            if (data && data.project && data.project.id) {
                projectId = String(data.project.id);
            }
            const rawDocId = 'CP-' + projectId + '-DES-001';
            const docId = styles.normalizeId
                ? styles.normalizeId(rawDocId)
                : rawDocId;

            try {
                doc.text(docId, margin, y, { align: 'left' });
            } catch (e) {}

            try {
                doc.text('Rev. 00', pageWidth / 2, y, { align: 'center' });
            } catch (e) {}

            try {
                doc.text('Page ' + pageNumber + ' / ' + totalPages,
                         pageWidth - margin, y, { align: 'right' });
            } catch (e) {}

            doc.setTextColor(26, 26, 26);
        }
    };

    // ========================================================
    // 15. EXPOSITION GLOBALE
    // ========================================================
    if (typeof window !== 'undefined') {
        window.PDFReportSections = PDFReportSections;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PDFReportSections;
    }

    console.log('[PDF Sections] ===================================================');
    console.log('[PDF Sections] v6.3 Professional Engineering Sections charge.');
    console.log('[PDF Sections] ===================================================');
    console.log('[PDF Sections] ✅ v6.3 : generateNomenclature() integre (Section 9.1)');
    console.log('[PDF Sections]    - 8 groupes thematiques de symboles');
    console.log('[PDF Sections]    - Plus de monkey-patching (integration native)');
    console.log('[PDF Sections] AUDIT v6.2 : "mAh/m2" -> "mA/m2" confirme absent');
    console.log('[PDF Sections] Defense : _normalizeDensityUnit() actif');
    console.log('[PDF Sections] P0-02 : Densite anodique en A/m2 (canonique)');
    console.log('[PDF Sections] P0-05 : Tracabilite rho_project / rho_groundbed');
    console.log('[PDF Sections] P1-02 : KPI Rectifier Power = powerDesign');
    console.log('[PDF Sections] P1-05 : KPI ICCP Life = lifeDesign (cap)');
    console.log('[PDF Sections] generateCoverPage() : normalizeId + approbations');
    console.log('[PDF Sections] generateExecutiveSummary() : KPI cards 2x2');
    console.log('[PDF Sections] _drawGroundbedSchema() : schema vectoriel');
    console.log('[PDF Sections] _insertChartSnapshots() : graphiques Chart.js');
    console.log('[PDF Sections] ===================================================');

})();
// ============================================================
// FIN DU FICHIER pdf-report-sections.js (VERSION 6.3)
// ============================================================