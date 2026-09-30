// ============================================================
// pdf-report-helpers.js – CP Engineer Pro
// Utilitaires jsPDF avancés pour rapports PDF
// Version 6.2 – PROFESSIONAL ENGINEERING HELPERS & TABLE ENGINE
// ============================================================
// CORRECTIONS MAJEURES v6.2 :
//   ✅ CORRECTION 1 (ROLE.txt) : addFormulaBox() renforcé
//      - Pipeline complet garanti : _cleanText → stripLatex
//        → normalizeText → split → _cleanText ligne/ligne
//      - Filtrage des lignes vides après nettoyage
//      - try/catch explicite sur splitTextToSize()
//      → AUCUNE notation LaTeX brute ne peut atteindre le rendu
// ============================================================
// CORRECTIONS MAJEURES v6.1 (conservées) :
//   ✅ FIX CRITIQUE : ReferenceError "currentBottom is not defined"
//      dans addTable() — la variable n'était pas déclarée.
//      Correction : this.y = currentY + 4;
// ============================================================
// CORRECTIONS MAJEURES v6.0 (conservées) :
//   ✅ _cleanText() : utilise styles.normalizeText() si disponible
//   ✅ addKPICard() : refonte vectorielle complète
//   ✅ addTable() : largeurs dynamiques + word-wrap + badges vectoriels
//   ✅ _detectStatusInCell() / _drawStatusBadgeInCell()
//   ✅ addInfoBox() : splitTextToSize robuste
// ============================================================
(function() {
    'use strict';

    /**
     * Utilitaires avancés pour la génération PDF
     * @namespace PDFReportHelpers
     */
    const PDFReportHelpers = {

        // Version des helpers PDF (cycle de vie indépendant)
        VERSION: '6.2.0',

        // ========================================================
        // PROPRIÉTÉS INTERNES
        // ========================================================
        doc: null,
        styles: null,
        margin: 0,
        pageWidth: 0,
        pageHeight: 0,
        y: 0,
        contentWidth: 0,

        // ========================================================
        // 1. INITIALISATION
        // ========================================================
        init: function(doc, styles, margin, pageWidth, pageHeight) {
            this.doc = doc;
            this.styles = styles;
            this.margin = margin;
            this.pageWidth = pageWidth;
            this.pageHeight = pageHeight;
            this.contentWidth = pageWidth - 2 * margin;
            this.y = margin + styles.layout.headerHeight;
            return this;
        },

        resetY: function() {
            this.y = this.margin + this.styles.layout.headerHeight;
        },

        addPage: function() {
            this.doc.addPage();
            this.resetY();
        },

        addNewPageIfNeeded: function(requiredSpace) {
            const maxY = this.pageHeight - this.margin - this.styles.layout.footerHeight;
            if (this.y + requiredSpace > maxY) {
                this.addPage();
                return true;
            }
            return false;
        },

        // ========================================================
        // 2. UTILITAIRES DE TEXTE
        // ========================================================
        _cleanText: function(text) {
            if (text === undefined || text === null) return '';
            let str = String(text);

            if (this.styles && typeof this.styles.normalizeText === 'function') {
                str = this.styles.normalizeText(str);
            } else {
                str = str.replace(/<br\s*\/?>/gi, ' ');
                str = str.replace(/<\/?[^>]+>/g, '');
                if (this.styles && typeof this.styles.sanitizeUnicode === 'function') {
                    str = this.styles.sanitizeUnicode(str);
                }
                str = str.replace(/^\s*#+\s*/gm, '');
                str = str.replace(/#/g, '');
                str = str.replace(/\s+/g, ' ').trim();
            }

            return str;
        },

        addText: function(text, x, y, options) {
            const opts = options || {};
            const doc = this.doc;
            const s = this.styles;

            const cleanText = this._cleanText(text);
            if (cleanText === '') return;

            doc.setFont(opts.font || s.typography.fontFamily, opts.style || 'normal');
            doc.setFontSize(opts.fontSize || s.typography.sizes.body);

            if (opts.color) {
                const rgb = this.hexToRgb(opts.color);
                doc.setTextColor(rgb[0], rgb[1], rgb[2]);
            } else {
                doc.setTextColor(26, 26, 26);
            }

            const textOptions = {};
            if (opts.align) textOptions.align = opts.align;
            if (opts.maxWidth && opts.maxWidth > 0) {
                textOptions.maxWidth = opts.maxWidth;
            }

            try {
                doc.text(cleanText, x, y, textOptions);
            } catch (e) {
                console.warn('[Helpers] addText erreur:', e.message,
                             '| texte:', cleanText.substring(0, 50));
                try {
                    doc.text(cleanText, x, y);
                } catch (e2) {}
            }

            doc.setTextColor(26, 26, 26);
        },

        addSectionTitle: function(title, level) {
            const lvl = level || 1;
            const s = this.styles;
            const sizes = s.typography.sizes;
            const cleanTitle = this._cleanText(title);

            let fontSize, marginTop, marginBottom;
            if (lvl === 1) {
                fontSize = sizes.chapterTitle;
                marginTop = 8;
                marginBottom = 4;
            } else if (lvl === 2) {
                fontSize = sizes.sectionTitle;
                marginTop = 6;
                marginBottom = 2;
            } else {
                fontSize = sizes.subsectionTitle;
                marginTop = 4;
                marginBottom = 2;
            }

            const requiredSpace = fontSize * 0.4 + marginTop + marginBottom + (lvl === 1 ? 6 : 0);
            this.addNewPageIfNeeded(requiredSpace);

            this.y += marginTop;

            const doc = this.doc;
            doc.setFont(s.typography.fontFamily, 'bold');
            doc.setFontSize(fontSize);
            const primaryRgb = this.hexToRgb(s.colors.primary);
            doc.setTextColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);

            try {
                doc.text(cleanTitle, this.margin, this.y);
            } catch (e) {
                console.warn('[Helpers] addSectionTitle erreur:', e.message);
            }
            this.y += fontSize * 0.4;

            if (lvl === 1) {
                doc.setDrawColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
                doc.setLineWidth(0.5);
                doc.line(this.margin, this.y, this.margin + 40, this.y);
                this.y += 4;
            } else {
                this.y += 2;
            }

            doc.setTextColor(26, 26, 26);
            doc.setLineWidth(0.2);
            this.y += marginBottom;
        },

        addHorizontalLine: function(y, width, color, lineWidth) {
            const doc = this.doc;
            const w = width || this.contentWidth;
            const c = color || this.styles.colors.border;
            const rgb = this.hexToRgb(c);
            doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
            doc.setLineWidth(lineWidth || 0.2);
            const yPos = (y !== undefined && y !== null) ? y : this.y;
            doc.line(this.margin, yPos, this.margin + w, yPos);
        },

        // ========================================================
        // 3. UTILITAIRES DE DÉTECTION
        // ========================================================
        _isNumeric: function(text) {
            if (text === undefined || text === null) return false;
            const str = String(text).trim();
            if (str === '' || str === 'N/A' || str === '-' || str === '—') return false;
            const clean = str.replace(/[,\s%°A-Za-z/²³]+/g, '').trim();
            if (clean === '') return false;
            const num = parseFloat(clean);
            return !isNaN(num) && isFinite(num);
        },

        _detectStatusInCell: function(text) {
            if (!text) return null;
            const upper = String(text).toUpperCase().trim();

            if (upper.indexOf('[FAIL]') === 0 || upper.indexOf('NON CONFORME') === 0) {
                return 'FAIL';
            }
            if (upper.indexOf('[WARN]') === 0 || upper.indexOf('AVERTISSEMENT') === 0) {
                return 'WARNING';
            }
            if (upper.indexOf('[N/A]') === 0 || upper === 'N/A') {
                return 'NA';
            }
            if (upper.indexOf('[NC]') === 0 || upper.indexOf('NON CALCULE') === 0) {
                return 'NC';
            }
            if (upper.indexOf('[OK]') === 0 || upper === 'CONFORME') {
                return 'PASS';
            }

            if (upper === 'PASS' || upper === 'OK') return 'PASS';
            if (upper === 'WARNING' || upper === 'WARN') return 'WARNING';
            if (upper === 'FAIL') return 'FAIL';
            if (upper === 'NC') return 'NC';

            return null;
        },

        // ========================================================
        // 4. MOTEUR DE TABLEAUX AVANCÉ (v6.1)
        // ========================================================
        _computeColumnWidths: function(headers, rows, totalWidth, fontSize) {
            const doc = this.doc;
            const s = this.styles;
            const padding = s.table.cellPadding.h * 2;
            const minW = s.table.minColumnWidth;

            doc.setFont(s.typography.fontFamily, 'normal');
            doc.setFontSize(fontSize);

            const naturalWidths = headers.map(function(h, i) {
                let maxW = doc.getTextWidth(String(h)) * 0.3528;
                for (let r = 0; r < rows.length; r++) {
                    const cellText = rows[r][i] !== undefined ? String(rows[r][i]) : '';
                    const w = doc.getTextWidth(cellText) * 0.3528;
                    if (w > maxW) maxW = w;
                }
                return maxW + padding;
            });

            const sumNatural = naturalWidths.reduce(function(a, b) { return a + b; }, 0);

            if (sumNatural <= totalWidth) {
                const extra = totalWidth - sumNatural;
                const perCol = extra / naturalWidths.length;
                return naturalWidths.map(function(w) {
                    return w + perCol;
                });
            }

            const scale = totalWidth / sumNatural;
            const scaled = naturalWidths.map(function(w) {
                return Math.max(w * scale, minW);
            });

            const sumScaled = scaled.reduce(function(a, b) { return a + b; }, 0);
            if (sumScaled > totalWidth) {
                const factor = totalWidth / sumScaled;
                return scaled.map(function(w) { return w * factor; });
            }
            return scaled;
        },

        _wrapCellText: function(text, maxWidth) {
            if (text === undefined || text === null) return [''];
            const str = String(text);
            if (str === '') return [''];

            const safeMaxWidth = Math.max(5, maxWidth);

            try {
                const lines = this.doc.splitTextToSize(str, safeMaxWidth);
                if (Array.isArray(lines) && lines.length > 0) {
                    return lines;
                }
                return [str];
            } catch (e) {
                return [str];
            }
        },

        _drawStatusBadgeInCell: function(statusType, x, y, width) {
            const s = this.styles;
            const config = s.status[statusType] || s.status.NA;

            const bgRgb = this.hexToRgb(config.bgColor);
            const textRgb = this.hexToRgb(config.color);
            const borderRgb = this.hexToRgb(config.borderColor || config.color);

            const badgeHeight = 4.5;
            const badgeWidth = Math.min(width, 30);
            const badgeX = x;
            const badgeY = y - badgeHeight / 2;

            this.doc.setFillColor(bgRgb[0], bgRgb[1], bgRgb[2]);
            this.doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 0.8, 0.8, 'F');

            this.doc.setDrawColor(borderRgb[0], borderRgb[1], borderRgb[2]);
            this.doc.setLineWidth(0.2);
            this.doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 0.8, 0.8, 'S');

            const label = this._cleanText(config.label);
            this.doc.setFont(s.typography.fontFamily, 'bold');
            this.doc.setFontSize(6.5);
            this.doc.setTextColor(textRgb[0], textRgb[1], textRgb[2]);

            try {
                this.doc.text(label, badgeX + badgeWidth / 2, y + 1.3, { align: 'center' });
            } catch (e) {
                try { this.doc.text(label, badgeX + badgeWidth / 2, y + 1.3); } catch (e2) {}
            }

            this.doc.setTextColor(26, 26, 26);
            this.doc.setLineWidth(0.2);
        },

        addTable: function(headers, rows, options) {
            const opts = options || {};

            if (!headers || headers.length === 0) {
                console.warn('[Helpers] addTable: aucune en-tête fournie');
                return;
            }

            if (!rows || rows.length === 0) {
                this.addText('Aucune donnee disponible.', this.margin, this.y, {
                    fontSize: this.styles.typography.sizes.small,
                    style: 'italic',
                    color: this.styles.colors.textLight
                });
                this.y += 8;
                return;
            }

            const doc = this.doc;
            const s = this.styles;
            const margin = this.margin;
            const contentWidth = this.contentWidth;

            // ===== 1. Taille de police adaptative =====
            const numCols = headers.length;
            let fontSize = opts.fontSize || s.typography.sizes.tableCell;
            if (numCols >= 6) fontSize = Math.min(fontSize, 7.5);
            else if (numCols >= 5) fontSize = Math.min(fontSize, 8);
            else if (numCols >= 4) fontSize = Math.min(fontSize, 8.5);

            // ===== 2. Calcul des largeurs =====
            let colWidths = opts.colWidths;
            if (!colWidths || colWidths.length !== numCols) {
                colWidths = this._computeColumnWidths(headers, rows, contentWidth, fontSize);
            } else {
                const sum = colWidths.reduce(function(a, b) { return a + b; }, 0);
                if (Math.abs(sum - contentWidth) > 1) {
                    const ratio = contentWidth / sum;
                    colWidths = colWidths.map(function(w) { return w * ratio; });
                }
            }

            // ===== 3. Constantes de hauteur =====
            const headerHeight = opts.headerHeight || s.table.headerHeight;
            const baseRowHeight = opts.rowHeight || s.table.rowHeight;
            const cellPadding = s.table.cellPadding.h;
            const cellPaddingV = s.table.cellPadding.v;
            const lineHeight = fontSize * 0.45;

            // ===== 4. Pré-calcul du nombre de lignes par cellule =====
            const self = this;
            const rowMeta = rows.map(function(row) {
                let maxLines = 1;
                const cells = [];
                for (let i = 0; i < numCols; i++) {
                    const rawText = (row[i] !== undefined && row[i] !== null) ? String(row[i]) : '';
                    const cleanText = self._cleanText(rawText);
                    const statusType = self._detectStatusInCell(cleanText);
                    const isStatus = !!statusType;

                    let lines;
                    if (isStatus) {
                        lines = [cleanText];
                    } else {
                        const maxW = Math.max(5, colWidths[i] - cellPadding * 2);
                        lines = self._wrapCellText(cleanText, maxW);
                    }
                    if (lines.length > maxLines) maxLines = lines.length;
                    cells.push({
                        lines: lines,
                        isStatus: isStatus,
                        statusType: statusType,
                        isNumeric: !isStatus && self._isNumeric(cleanText)
                    });
                }
                const rowHeight = Math.max(
                    baseRowHeight,
                    maxLines * lineHeight + cellPaddingV * 2
                );
                return { cells: cells, height: rowHeight };
            });

            // ===== 5. Fonction interne : dessiner l'en-tête =====
            const drawHeader = function(yPos) {
                const headerBg = self.hexToRgb(s.colors.tableHeaderBg);
                doc.setFillColor(headerBg[0], headerBg[1], headerBg[2]);
                doc.rect(margin, yPos, contentWidth, headerHeight, 'F');

                doc.setFont(s.typography.fontFamily, 'bold');
                doc.setFontSize(fontSize);
                doc.setTextColor(255, 255, 255);

                let x = margin;
                for (let i = 0; i < headers.length; i++) {
                    const headerText = self._cleanText(headers[i]);
                    const maxW = Math.max(5, colWidths[i] - cellPadding * 2);
                    try {
                        doc.text(headerText, x + cellPadding,
                                 yPos + headerHeight / 2 + fontSize * 0.12,
                                 { maxWidth: maxW });
                    } catch (e) {
                        try {
                            doc.text(headerText, x + cellPadding,
                                     yPos + headerHeight / 2 + 1);
                        } catch (e2) {}
                    }
                    x += colWidths[i];
                }
                const headerBorderRgb = self.hexToRgb(s.colors.border);
                doc.setDrawColor(headerBorderRgb[0], headerBorderRgb[1], headerBorderRgb[2]);
                doc.setLineWidth(0.5);
                doc.line(margin, yPos + headerHeight, margin + contentWidth, yPos + headerHeight);
                doc.setTextColor(26, 26, 26);
                return yPos + headerHeight;
            };

            const drawTableBorder = function(top, bottom) {
                const borderRgb = self.hexToRgb(s.colors.border);
                doc.setDrawColor(borderRgb[0], borderRgb[1], borderRgb[2]);
                doc.setLineWidth(0.3);
                doc.rect(margin, top, contentWidth, Math.max(0, bottom - top), 'S');
            };

            // ===== 6. Fonction interne : dessiner une ligne =====
            const drawRow = function(meta, yPos, isEven) {
                const h = meta.height;

                if (isEven) {
                    const stripeRgb = self.hexToRgb(s.colors.tableStripe);
                    doc.setFillColor(stripeRgb[0], stripeRgb[1], stripeRgb[2]);
                    doc.rect(margin, yPos, contentWidth, h, 'F');
                }

                const borderRgb = self.hexToRgb(s.colors.border);
                doc.setDrawColor(borderRgb[0], borderRgb[1], borderRgb[2]);
                doc.setLineWidth(0.1);
                doc.line(margin, yPos + h, margin + contentWidth, yPos + h);

                let x = margin;
                for (let i = 0; i < numCols; i++) {
                    const cell = meta.cells[i];
                    const cellW = colWidths[i];

                    if (cell.isStatus && cell.statusType) {
                        const badgeX = x + cellPadding;
                        const badgeW = Math.min(cellW - cellPadding * 2, 30);
                        const badgeYCenter = yPos + h / 2;
                        self._drawStatusBadgeInCell(cell.statusType, badgeX, badgeYCenter, badgeW);
                    } else {
                        doc.setFont(s.typography.fontFamily, 'normal');
                        doc.setFontSize(fontSize);
                        doc.setTextColor(26, 26, 26);

                        const isNum = cell.isNumeric;
                        const align = isNum ? 'right' : 'left';
                        const xText = isNum
                            ? x + cellW - cellPadding
                            : x + cellPadding;

                        const totalTextHeight = cell.lines.length * lineHeight;
                        const firstLineY = yPos + (h - totalTextHeight) / 2 + lineHeight * 0.75;

                        for (let li = 0; li < cell.lines.length; li++) {
                            const lineText = cell.lines[li];
                            const yLine = firstLineY + li * lineHeight;
                            try {
                                doc.text(lineText, xText, yLine, { align: align });
                            } catch (e) {
                                try { doc.text(lineText, xText, yLine); } catch (e2) {}
                            }
                        }
                    }
                    x += cellW;
                }
                return yPos + h;
            };

            // ===== 7. Réservation d'espace =====
            this.addNewPageIfNeeded(headerHeight + baseRowHeight * 2);

            let tableTop = this.y;
            let currentY = drawHeader(this.y);

            // ===== 8. Dessin des lignes =====
            const maxY = this.pageHeight - this.margin - s.layout.footerHeight - 5;

            for (let r = 0; r < rowMeta.length; r++) {
                const meta = rowMeta[r];
                if (currentY + meta.height > maxY) {
                    drawTableBorder(tableTop, currentY);
                    this.addPage();
                    currentY = drawHeader(this.y);
                    tableTop = this.y;
                }
                currentY = drawRow(meta, currentY, r % 2 === 1);
            }

            // ===== 9. Bordure extérieure =====
            const tableBottom = currentY;
            drawTableBorder(tableTop, tableBottom);

            // Reset
            doc.setLineWidth(0.2);
            this.y = currentY + 4;
        },

        // ========================================================
        // 5. BADGES DE STATUT VECTORIELS
        // ========================================================
        addStatusBadge: function(status, x, y, width) {
            const s = this.styles;
            const statusConfig = s.status[String(status).toUpperCase()] || s.status.NA;

            const bgRgb = this.hexToRgb(statusConfig.bgColor);
            const textRgb = this.hexToRgb(statusConfig.color);
            const borderRgb = this.hexToRgb(statusConfig.borderColor || statusConfig.color);

            const badgeWidth = width || 35;
            const badgeHeight = 6;

            this.doc.setFillColor(bgRgb[0], bgRgb[1], bgRgb[2]);
            this.doc.roundedRect(x, y - 4, badgeWidth, badgeHeight, 1, 1, 'F');

            this.doc.setDrawColor(borderRgb[0], borderRgb[1], borderRgb[2]);
            this.doc.setLineWidth(0.3);
            this.doc.roundedRect(x, y - 4, badgeWidth, badgeHeight, 1, 1, 'S');

            const label = this._cleanText(statusConfig.label);
            this.doc.setFont(s.typography.fontFamily, 'bold');
            this.doc.setFontSize(s.typography.sizes.small);
            this.doc.setTextColor(textRgb[0], textRgb[1], textRgb[2]);

            try {
                this.doc.text(label, x + badgeWidth / 2, y, { align: 'center' });
            } catch (e) {
                try { this.doc.text(label, x + badgeWidth / 2, y); } catch (e2) {}
            }

            this.doc.setTextColor(26, 26, 26);
            this.doc.setLineWidth(0.2);
        },

        // ========================================================
        // 6. KPI CARDS
        // ========================================================
        addKPICard: function(label, value, unit, status, x, y, width, subtitle) {
            const s = this.styles;
            const w = width || (this.contentWidth / 2 - 4);
            const h = 26;

            if (this.addNewPageIfNeeded(h + 4)) y = this.y;

            const bgRgb = this.hexToRgb(s.colors.backgroundAlt || s.colors.secondary);
            this.doc.setFillColor(bgRgb[0], bgRgb[1], bgRgb[2]);
            this.doc.roundedRect(x, y, w, h, 2, 2, 'F');

            const borderRgb = this.hexToRgb(s.colors.border);
            this.doc.setDrawColor(borderRgb[0], borderRgb[1], borderRgb[2]);
            this.doc.setLineWidth(0.2);
            this.doc.roundedRect(x, y, w, h, 2, 2, 'S');

            let statusColorHex = s.colors.accent;
            if (status) {
                statusColorHex = s.getStatusColorHex(status);
            }
            const statusRgb = this.hexToRgb(statusColorHex);
            this.doc.setFillColor(statusRgb[0], statusRgb[1], statusRgb[2]);
            this.doc.rect(x, y, 3, h, 'F');

            const cleanLabel = this._cleanText(label);
            this.doc.setFont(s.typography.fontFamily, 'bold');
            this.doc.setFontSize(s.typography.sizes.kpiLabel);
            const textMediumRgb = this.hexToRgb(s.colors.textMedium);
            this.doc.setTextColor(textMediumRgb[0], textMediumRgb[1], textMediumRgb[2]);

            try {
                this.doc.text(cleanLabel, x + 7, y + 6, { maxWidth: w - 12 });
            } catch (e) {
                try { this.doc.text(cleanLabel, x + 7, y + 6); } catch (e2) {}
            }

            const cleanValue = this._cleanText(value);
            this.doc.setFont(s.typography.fontFamily, 'bold');
            this.doc.setFontSize(s.typography.sizes.kpiValue);
            const textDarkRgb = this.hexToRgb(s.colors.textDark);
            this.doc.setTextColor(textDarkRgb[0], textDarkRgb[1], textDarkRgb[2]);

            try {
                this.doc.text(cleanValue, x + 7, y + 17);
            } catch (e) {
                try { this.doc.text(cleanValue, x + 7, y + 17); } catch (e2) {}
            }

            let valueWidth = 0;
            try {
                valueWidth = this.doc.getTextWidth(cleanValue);
            } catch (e) {
                valueWidth = cleanValue.length * 3;
            }

            const cleanUnit = this._cleanText(unit || '');
            if (cleanUnit) {
                this.doc.setFont(s.typography.fontFamily, 'normal');
                this.doc.setFontSize(s.typography.sizes.body);
                this.doc.setTextColor(textMediumRgb[0], textMediumRgb[1], textMediumRgb[2]);

                try {
                    this.doc.text(cleanUnit, x + 7 + valueWidth + 2, y + 17);
                } catch (e) {}
            }

            if (subtitle) {
                const cleanSubtitle = this._cleanText(subtitle);
                this.doc.setFont(s.typography.fontFamily, 'italic');
                this.doc.setFontSize(s.typography.sizes.caption);
                const textLightRgb = this.hexToRgb(s.colors.textLight);
                this.doc.setTextColor(textLightRgb[0], textLightRgb[1], textLightRgb[2]);

                try {
                    this.doc.text(cleanSubtitle, x + 7, y + 23, { maxWidth: w - 12 });
                } catch (e) {}
            }

            this.doc.setTextColor(26, 26, 26);
            this.doc.setLineWidth(0.2);
            return y + h + 4;
        },

        // ========================================================
        // 7. INFO BOXES
        // ========================================================
        addInfoBox: function(title, content, x, y, width, type) {
            const s = this.styles;
            const w = width || this.contentWidth;
            const boxType = type || 'info';

            let bgColorHex = s.colors.infoBg;
            let borderColorHex = s.colors.info;
            let titleColorHex = s.colors.info;

            if (boxType === 'warning') {
                bgColorHex = s.colors.warningBg;
                borderColorHex = s.colors.warning;
                titleColorHex = s.colors.warning;
            } else if (boxType === 'error') {
                bgColorHex = s.colors.dangerBg;
                borderColorHex = s.colors.danger;
                titleColorHex = s.colors.danger;
            } else if (boxType === 'success') {
                bgColorHex = s.colors.successBg;
                borderColorHex = s.colors.success;
                titleColorHex = s.colors.success;
            }

            const cleanContent = this._cleanText(content);
            this.doc.setFont(s.typography.fontFamily, 'normal');
            this.doc.setFontSize(s.typography.sizes.body);

            let lines = [];
            try {
                lines = this.doc.splitTextToSize(cleanContent, w - 12);
            } catch (e) {
                lines = [cleanContent];
            }
            if (!Array.isArray(lines)) lines = [String(lines)];
            if (lines.length === 0) lines = [''];

            const h = 12 + lines.length * 5;

            if (this.addNewPageIfNeeded(h + 4)) y = this.y;

            const bgRgb = this.hexToRgb(bgColorHex);
            this.doc.setFillColor(bgRgb[0], bgRgb[1], bgRgb[2]);
            this.doc.roundedRect(x, y, w, h, 2, 2, 'F');

            const borderRgb = this.hexToRgb(borderColorHex);
            this.doc.setFillColor(borderRgb[0], borderRgb[1], borderRgb[2]);
            this.doc.rect(x, y, 2.5, h, 'F');

            const cleanTitle = this._cleanText(title);
            const titleRgb = this.hexToRgb(titleColorHex);
            this.doc.setFont(s.typography.fontFamily, 'bold');
            this.doc.setFontSize(s.typography.sizes.body);
            this.doc.setTextColor(titleRgb[0], titleRgb[1], titleRgb[2]);

            try {
                this.doc.text(cleanTitle, x + 7, y + 6, { maxWidth: w - 14 });
            } catch (e) {
                try { this.doc.text(cleanTitle, x + 7, y + 6); } catch (e2) {}
            }

            this.doc.setFont(s.typography.fontFamily, 'normal');
            this.doc.setFontSize(s.typography.sizes.small);
            this.doc.setTextColor(26, 26, 26);

            try {
                this.doc.text(lines, x + 7, y + 12);
            } catch (e) {
                for (let i = 0; i < lines.length; i++) {
                    try {
                        this.doc.text(lines[i], x + 7, y + 12 + i * 5);
                    } catch (e2) {}
                }
            }

            this.doc.setTextColor(26, 26, 26);
            this.doc.setLineWidth(0.2);
            return y + h + 4;
        },

        // ========================================================
        // 8. ENCADRÉ DE FORMULE (CORRECTION v6.2)
        // ========================================================
        /**
         * Ajoute un encadré de formule avec nettoyage LaTeX garanti.
         *
         * PIPELINE DE NETTOYAGE (v6.2) :
         *   1. _cleanText(formula)        → pipeline complet (LaTeX + Unicode + #)
         *   2. stripLatex()                → défensif (résidus LaTeX)
         *   3. normalizeText()             → défensif (pipeline complet)
         *   4. splitTextToSize()           → découpage en lignes
         *   5. _cleanText() ligne/ligne    → ⭐ GARANTIE : chaque ligne nettoyée
         *   6. filter(l !== '')            → suppression des lignes vides
         *   7. Rendu PDF
         *
         * @param {string} formula - Formule à afficher
         * @param {number} x - Position X
         * @param {number} y - Position Y
         * @param {number} width - Largeur (défaut : contentWidth)
         * @returns {number} Nouvelle position Y
         */
        addFormulaBox: function(formula, x, y, width) {
            const s = this.styles;
            const w = width || this.contentWidth;

            // ============================================================
            // ÉTAPE 1 : nettoyage principal via _cleanText (pipeline complet)
            // ============================================================
            let cleanFormula = this._cleanText(formula);

            // ============================================================
            // ÉTAPE 2 (défensif) : stripLatex() explicite
            // ------------------------------------------------------------
            // Si _cleanText n'a pas appliqué stripLatex (ex : styles v5.0),
            // on force le nettoyage LaTeX ici.
            // ============================================================
            if (s && typeof s.stripLatex === 'function') {
                cleanFormula = s.stripLatex(cleanFormula);
            }

            // ============================================================
            // ÉTAPE 3 (défensif) : normalizeText() explicite
            // ------------------------------------------------------------
            // Garantit le pipeline complet (Unicode + # + espaces).
            // ============================================================
            if (s && typeof s.normalizeText === 'function') {
                cleanFormula = s.normalizeText(cleanFormula);
            }

            // ============================================================
            // ÉTAPE 4 : mesure + découpage
            // ============================================================
            this.doc.setFont(s.typography.fontFamily, 'italic');
            this.doc.setFontSize(s.typography.sizes.body + 1);

            let lines = [];
            try {
                lines = this.doc.splitTextToSize(cleanFormula, w - 14);
            } catch (e) {
                console.warn('[PDF Helpers] splitTextToSize failed:', e);
                lines = [cleanFormula];
            }
            if (!Array.isArray(lines)) lines = [String(lines)];

            // ============================================================
            // ÉTAPE 5 (CORRECTION v6.2) : nettoyage de CHAQUE LIGNE
            // ------------------------------------------------------------
            // ESSENTIEL : après split, jsPDF peut avoir introduit des
            // coupures qui exposent des fragments LaTeX (ex : "\frac{a}"
            // coupé en "\frac{a" et "}"). On re-nettoie chaque ligne
            // individuellement pour garantir qu'AUCUNE notation LaTeX
            // brute ne peut atteindre le rendu PDF.
            //
            // NOTE : On utilise `this._cleanText(line)` et non une
            // transformation supplémentaire, afin de préserver la
            // cohérence avec le pipeline global de l'application.
            // ============================================================
            lines = lines
                .map(line => this._cleanText(line))
                .filter(line => line !== '');

            // ============================================================
            // ÉTAPE 6 : garde-fou (au moins une ligne pour le rendu)
            // ============================================================
            if (lines.length === 0) lines = [''];

            const h = 10 + lines.length * 5;

            this.addNewPageIfNeeded(h + 2);

            // ============================================================
            // ÉTAPE 7 : rendu graphique
            // ============================================================
            const bgRgb = this.hexToRgb(s.colors.secondary);
            this.doc.setFillColor(bgRgb[0], bgRgb[1], bgRgb[2]);
            this.doc.roundedRect(x, y, w, h, 2, 2, 'F');

            const primaryRgb = this.hexToRgb(s.colors.primary);
            this.doc.setFillColor(primaryRgb[0], primaryRgb[1], primaryRgb[2]);
            this.doc.rect(x, y, 3, h, 'F');

            const textDarkRgb = this.hexToRgb(s.colors.textDark);
            this.doc.setTextColor(textDarkRgb[0], textDarkRgb[1], textDarkRgb[2]);

            try {
                this.doc.text(lines, x + 8, y + 6);
            } catch (e) {
                for (let i = 0; i < lines.length; i++) {
                    try {
                        this.doc.text(lines[i], x + 8, y + 6 + i * 5);
                    } catch (e2) {}
                }
            }

            this.doc.setTextColor(26, 26, 26);
            return y + h + 2;
        },

        // ========================================================
        // 9. ENCADRÉ DE RÉSULTAT
        // ========================================================
        addResultBox: function(result, unit, x, y, width) {
            const s = this.styles;
            const w = width || this.contentWidth;
            const h = 14;

            this.addNewPageIfNeeded(h + 2);

            const infoBgRgb = this.hexToRgb(s.colors.infoBg);
            this.doc.setFillColor(infoBgRgb[0], infoBgRgb[1], infoBgRgb[2]);
            this.doc.roundedRect(x, y, w, h, 2, 2, 'F');

            const infoRgb = this.hexToRgb(s.colors.info);
            this.doc.setFillColor(infoRgb[0], infoRgb[1], infoRgb[2]);
            this.doc.rect(x, y, 4, h, 'F');

            const cleanResult = this._cleanText(result);
            const cleanUnit = this._cleanText(unit || '');
            const text = 'RESULT: ' + cleanResult + (cleanUnit ? ' ' + cleanUnit : '');

            this.doc.setFont(s.typography.fontFamily, 'bold');
            this.doc.setFontSize(s.typography.sizes.body + 1);
            this.doc.setTextColor(infoRgb[0], infoRgb[1], infoRgb[2]);

            try {
                this.doc.text(text, x + 10, y + 9, { maxWidth: w - 14 });
            } catch (e) {
                try { this.doc.text(text, x + 10, y + 9); } catch (e2) {}
            }

            this.doc.setTextColor(26, 26, 26);
            return y + h + 4;
        },

        // ========================================================
        // 10. CONVERSION HEX → RGB
        // ========================================================
        hexToRgb: function(hex) {
            if (!hex) return [0, 0, 0];
            if (Array.isArray(hex)) return hex;
            let h = String(hex).replace(/^#/, '');
            if (h.length === 3) {
                h = h.split('').map(function(c) { return c + c; }).join('');
            }
            const bigint = parseInt(h, 16);
            if (isNaN(bigint)) return [0, 0, 0];
            return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
        },

        // ========================================================
        // 11. ÉCRITURE MULTI-LIGNES
        // ========================================================
        addParagraph: function(text, x, options) {
            const opts = options || {};
            const s = this.styles;
            const marginX = (x !== undefined && x !== null) ? x : this.margin;
            const maxWidth = opts.maxWidth || this.contentWidth;
            const fontSize = opts.fontSize || s.typography.sizes.body;

            const cleanText = this._cleanText(text);
            if (cleanText === '') return this.y;

            this.doc.setFont(s.typography.fontFamily, opts.style || 'normal');
            this.doc.setFontSize(fontSize);

            if (opts.color) {
                const rgb = this.hexToRgb(opts.color);
                this.doc.setTextColor(rgb[0], rgb[1], rgb[2]);
            } else {
                this.doc.setTextColor(26, 26, 26);
            }

            let lines = [];
            try {
                lines = this.doc.splitTextToSize(cleanText, maxWidth);
            } catch (e) {
                lines = [cleanText];
            }
            if (!Array.isArray(lines)) lines = [String(lines)];

            const lineHeight = opts.lineHeight || 5;

            for (let i = 0; i < lines.length; i++) {
                this.addNewPageIfNeeded(lineHeight + 2);
                try {
                    this.doc.text(lines[i], marginX, this.y);
                } catch (e) {}
                this.y += lineHeight;
            }

            this.doc.setTextColor(26, 26, 26);
            return this.y;
        },

        // ========================================================
        // 12. SÉPARATEUR VISUEL DE SECTION
        // ========================================================
        addSectionSeparator: function(spacing) {
            const sp = spacing || 4;
            this.y += sp;
            this.addHorizontalLine(this.y, this.contentWidth, this.styles.colors.border, 0.3);
            this.y += sp;
        }
    };

    // ========================================================
    // EXPOSITION GLOBALE
    // ========================================================
    if (typeof window !== 'undefined') {
        window.PDFReportHelpers = PDFReportHelpers;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = PDFReportHelpers;
    }

    console.log('[PDF Helpers] v6.2 Advanced Table Engine & UI Components charge avec succes');
    console.log('[PDF Helpers] CORRECTION v6.2 : addFormulaBox() - nettoyage post-split garanti');
    console.log('[PDF Helpers]   Pipeline : _cleanText -> stripLatex -> normalizeText -> split -> _cleanText/ligne');
    console.log('[PDF Helpers] FIX v6.1 : ReferenceError currentBottom supprime (addTable)');
    console.log('[PDF Helpers] _cleanText() utilise normalizeText() (LaTeX + Unicode + #)');
    console.log('[PDF Helpers] addKPICard() : rendu vectoriel complet');
    console.log('[PDF Helpers] addTable() : word-wrap + badges vectoriels');
    console.log('[PDF Helpers] addStatusBadge() et _drawStatusBadgeInCell() : vectoriels');
})();
// ============================================================
// FIN DU FICHIER pdf-report-helpers.js (VERSION 6.2)
// ============================================================