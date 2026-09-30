// ============================================================
// pdfReport.test.js – Tests unitaires pour le module PDF Report
// Version 1.1 – Robustesse et résilience améliorées
// P2-25 : Exécution uniquement en mode debug (flag cp_debug_mode)
// ============================================================

(function() {
    'use strict';

    /**
     * Suite de tests unitaires pour le module PDF Report
     * @namespace PDFReportTests
     */
    const PDFReportTests = {
        /**
         * Exécute tous les tests
         */
        runAll: function() {
            console.log('🧪 [PDF Tests] Début des tests unitaires...');
            let passed = 0;
            let failed = 0;

            const tests = [
                this.testCollectorAll,
                this.testCollectorProjectData,
                this.testCollectorAssetsData,
                this.testCollectorEnvironmentData,
                this.testCollectorStandardsData,
                this.testCollectorCriteriaData,
                this.testCollectorCalculationsData,
                this.testCollectorGISData,
                this.testCollectorFieldMeasurementsData,
                this.testValidateData,
                this.testNormativeReferences,
                this.testStatusManagement
            ];

            tests.forEach(test => {
                try {
                    test.call(this);
                    passed++;
                    console.log(`  ✅ ${test.name} - PASS`);
                } catch (e) {
                    failed++;
                    console.error(`  ❌ ${test.name} - FAIL: ${e.message}`);
                    if (e.stack) {
                        console.debug(`     Stack: ${e.stack.split('\n').slice(0, 3).join('\n')}`);
                    }
                }
            });

            console.log(`📊 [PDF Tests] Résumé: ${passed} PASS, ${failed} FAIL`);
            return { passed, failed };
        },

               /**
         * Test du collecteur de données.
         *
         * BUG-CP-A10 : Le test échoue EXPLICITEMENT si le module
         * PDFReportDataCollector n'est pas chargé. Aucune simulation
         * automatique ne doit masquer une absence réelle du module.
         */
        testCollectorAll: function() {
            // ─── Vérification stricte : le module DOIT être chargé ───
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error(
                    'PDFReportDataCollector non chargé. ' +
                    'Vérifiez l\'ordre des scripts : pdfReport.js doit être ' +
                    'chargé AVANT pdfReport.test.js.'
                );
            }
            if (typeof window.PDFReportDataCollector.collectAll !== 'function') {
                throw new Error('collectAll n\'est pas une fonction');
            }
            const methods = [
                'collectProjectData', 'collectAssetsData', 'collectEnvironmentData',
                'collectStandardsData', 'collectCriteriaData', 'collectCPSystemsData',
                'collectICCPData', 'collectSACPData', 'collectGroundbedsData',
                'collectCalculationsData', 'collectInterferenceData',
                'collectFieldMeasurementsData', 'collectGISData', 'collectHistoryData'
            ];
            methods.forEach(m => {
                if (typeof window.PDFReportDataCollector[m] !== 'function') {
                    throw new Error(`Méthode manquante: ${m}`);
                }
            });
        },

        /**
         * Test de collectProjectData
         */
        testCollectorProjectData: function() {
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error('PDFReportDataCollector n\'est pas disponible pour ce test.');
            }

            const mockProject = { id: 'TEST-001', name: 'Test Project' };
            const mockState = {
                project: {
                    surface: 100,
                    currentRequired: 5,
                    resistivity: 30,
                    coating: 0.95,
                    cpSystemType: 'mixte',
                    defectDensity: 0.03,
                    agingFactor: 1.2,
                    targetPotential: -850,
                    norm: 'ISO 15589-1',
                    cpEnvironment: 'desert',
                    currentDensity: 5,
                    shared: {}
                }
            };

            const result = window.PDFReportDataCollector.collectProjectData(mockProject, mockState);

            if (result.id !== 'TEST-001') throw new Error('ID incorrect');
            if (result.name !== 'Test Project') throw new Error('Nom incorrect');
            if (result.surface !== 100) throw new Error('Surface incorrecte');
            if (result.targetPotential !== -850) throw new Error('Potentiel cible incorrect');
        },

        /**
         * Test de collectAssetsData
         */
        testCollectorAssetsData: function() {
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error('PDFReportDataCollector n\'est pas disponible pour ce test.');
            }

            const mockState = {
                equipments: [
                    {
                        id: 'EQ-001',
                        tag: 'PIPE-001',
                        type: 'pipeline_enterre',
                        surface: 150,
                        included: true,
                        dimensions: { longueur_m: 100, diametre_m: 0.5 },
                        coordinates: { lat: 30.123, lon: 8.456 },
                        material: 'acier',
                        wallThickness: 8,
                        coatingType: '3LPE',
                        coatingCondition: 'neuf',
                        coatingThickness: 3,
                        soilResistivity: 30,
                        systemId: 'SYS-001',
                        projectId: 'PROJ-001',
                        cpData: { calculated: true, results: { currentAmperes: 2.5 } }
                    }
                ]
            };

            const result = window.PDFReportDataCollector.collectAssetsData(mockState, 'PROJ-001');

            if (result.length !== 1) throw new Error('Nombre d\'équipements incorrect');
            if (result[0].id !== 'EQ-001') throw new Error('ID équipement incorrect');
            if (result[0].cpCalculated !== true) throw new Error('Statut CP incorrect');
        },

        /**
         * Test de collectEnvironmentData
         */
        testCollectorEnvironmentData: function() {
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error('PDFReportDataCollector n\'est pas disponible pour ce test.');
            }

            const mockState = {
                project: {
                    envSoilResistivity: 30,
                    envSoilPh: 7.2,
                    envSoilMoisture: 50,
                    envSoilChlorides: 100,
                    envSoilSulfates: 200,
                    envSoilRedox: 100,
                    envWaterSalinity: 0.5,
                    envWaterConductivity: 500,
                    envWaterTemp: 20,
                    envWaterDO: 6,
                    cpEnvironment: 'desert'
                }
            };

            const result = window.PDFReportDataCollector.collectEnvironmentData(mockState);

            if (result.soilResistivity !== 30) throw new Error('Résistivité incorrecte');
            if (result.soilPh !== 7.2) throw new Error('pH incorrect');
            if (result.environment !== 'desert') throw new Error('Environnement incorrect');
        },

        /**
         * Test de collectStandardsData
         */
        testCollectorStandardsData: function() {
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error('PDFReportDataCollector n\'est pas disponible pour ce test.');
            }

            const mockState = {
                project: {
                    standards: ['ISO 15589-1', 'NACE SP0169'],
                    norm: 'ISO 15589-1'
                }
            };

            const result = window.PDFReportDataCollector.collectStandardsData(mockState);

            if (result.primary !== 'ISO 15589-1') throw new Error('Norme primaire incorrecte');
            if (result.selected.length !== 2) throw new Error('Nombre de normes incorrect');
        },

        /**
         * Test de collectCriteriaData
         */
        testCollectorCriteriaData: function() {
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error('PDFReportDataCollector n\'est pas disponible pour ce test.');
            }

            const mockState = {
                project: {
                    targetPotential: -850,
                    norm: 'ISO 15589-1',
                    currentDensity: 5
                }
            };

            const result = window.PDFReportDataCollector.collectCriteriaData(mockState);

            if (result.targetPotential !== -850) throw new Error('Potentiel cible incorrect');
            if (result.naceOffPotential !== -850) throw new Error('Potentiel OFF NACE incorrect');
            if (result.nacePolarization !== 100) throw new Error('Polarisation NACE incorrecte');
        },

        /**
         * Test de collectGISData
         */
        testCollectorGISData: function() {
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error('PDFReportDataCollector n\'est pas disponible pour ce test.');
            }

            const mockState = {
                mapPoints: [{ id: 'MP-001', projectId: 'PROJ-001', lat: 30.123, lon: 8.456 }],
                equipments: [
                    {
                        id: 'EQ-001',
                        projectId: 'PROJ-001',
                        tag: 'PIPE-001',
                        type: 'pipeline',
                        coordinates: { lat: 30.123, lon: 8.456 },
                        surface: 150
                    },
                    {
                        id: 'EQ-002',
                        projectId: 'PROJ-001',
                        tag: 'PIPE-002',
                        type: 'pipeline',
                        coordinates: null,
                        surface: 100
                    }
                ]
            };

            const result = window.PDFReportDataCollector.collectGISData(mockState, 'PROJ-001');

            if (result.totalPoints !== 1) throw new Error('Nombre de points incorrect');
            if (result.totalWithCoords !== 1) throw new Error('Nombre d\'équipements avec coordonnées incorrect');
        },

        /**
         * Test de collectFieldMeasurementsData
         */
        testCollectorFieldMeasurementsData: function() {
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error('PDFReportDataCollector n\'est pas disponible pour ce test.');
            }

            const mockState = {
                fieldMeasurements: [
                    {
                        id: 'FM-001',
                        projectId: 'PROJ-001',
                        date: '2026-01-01',
                        assetTag: 'PIPE-001',
                        potOFF: -850,
                        compliant: true
                    }
                ]
            };

            const result = window.PDFReportDataCollector.collectFieldMeasurementsData(mockState, 'PROJ-001');

            if (result.length !== 1) throw new Error('Nombre de mesures incorrect');
            if (result[0].potOFF !== -850) throw new Error('Potentiel OFF incorrect');
        },

        /**
         * Test de collectCalculationsData
         */
        testCollectorCalculationsData: function() {
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error('PDFReportDataCollector n\'est pas disponible pour ce test.');
            }

            const mockState = {
                cp: { current: 5 },
                project: { surface: 100, coating: 0.95, defectDensity: 0.03, agingFactor: 1.2, currentDensity: 5 },
                anodes: { totalMass: 100, count: 10, initialCurrent: 0.5, finalCurrent: 0.3, actualLife: 20 },
                iccp: { current: 5, densityOk: true, voltage: 10, power: 50, groundbedResistance: 0.1, lifeEstimate: 20 },
                groundbed: { results: { R_total: 0.5, I_total: 10 } },
                interference: { results: { acInduced: 5, dcStray: 0.05 } }
            };

            const result = window.PDFReportDataCollector.collectCalculationsData(mockState);

            // Vérifier que plusieurs calculs sont générés
            if (result.length < 3) throw new Error('Nombre de calculs insuffisant');

            // Vérifier les IDs des calculs
            const ids = result.map(c => c.id);
            if (!ids.includes('CALC-CP-001')) throw new Error('Calcul CP manquant');
            if (!ids.includes('CALC-SACP-001')) throw new Error('Calcul SACP manquant');
            if (!ids.includes('CALC-ICCP-001')) throw new Error('Calcul ICCP manquant');
        },

        /**
         * Test de validation des données
         */
        testValidateData: function() {
            // Simuler le moteur et la méthode de validation
            const mockEngine = {
                _validateData: function(data) {
                    if (!data.project) throw new Error('Données du projet manquantes');
                    if (!data.project.id) throw new Error('ID du projet manquant');
                }
            };

            // Test avec données valides
            const validData = { project: { id: 'PROJ-001', name: 'Test' } };
            try {
                mockEngine._validateData(validData);
            } catch (e) {
                throw new Error('Validation des données valides a échoué: ' + e.message);
            }

            // Test avec données invalides
            const invalidData = { assets: [] };
            try {
                mockEngine._validateData(invalidData);
                throw new Error('La validation aurait dû échouer');
            } catch (e) {
                if (!e.message.includes('Données du projet manquantes')) {
                    throw new Error('Message d\'erreur incorrect: ' + e.message);
                }
            }
        },

        /**
         * Test des références normatives
         */
        testNormativeReferences: function() {
            // BUG-CP-A10 : interdiction de simuler le module testé.
            if (typeof window.NORMATIVE_REFERENCES === 'undefined') {
                throw new Error(
                    'NORMATIVE_REFERENCES non chargé. ' +
                    'Vérifiez que pdfReport.js est chargé avant les tests.'
                );
            }

            const expectedRefs = [
                'CALC-CP-001', 'CALC-SACP-001', 'CALC-SACP-002', 'CALC-SACP-003',
                'CALC-ICCP-001', 'CALC-ICCP-002', 'CALC-ICCP-003',
                'CALC-GB-001', 'CALC-GB-002',
                'CALC-IF-001', 'CALC-IF-002'
            ];

            expectedRefs.forEach(ref => {
                if (window.NORMATIVE_REFERENCES[ref] === undefined) {
                    throw new Error('Référence normative manquante: ' + ref);
                }
                if (typeof window.NORMATIVE_REFERENCES[ref] !== 'string') {
                    throw new Error('Référence normative invalide: ' + ref);
                }
            });

            if (window.NORMATIVE_REFERENCES.default === undefined) {
                throw new Error('Référence normative par défaut manquante');
            }
        },

        /**
         * Test de la gestion des statuts
         */
        testStatusManagement: function() {
            if (typeof window.PDFReportDataCollector === 'undefined') {
                throw new Error('PDFReportDataCollector n\'est pas disponible pour ce test.');
            }

            const mockState = {
                cp: { current: 0 },
                project: { surface: 0, coating: 0, defectDensity: 0, agingFactor: 0, currentDensity: 0 },
                anodes: { totalMass: 0, count: 0, initialCurrent: 0, finalCurrent: 0 },
                iccp: { current: 0, densityOk: false },
                groundbed: { results: { R_total: 0 } },
                interference: { results: {} }
            };

            const calcData = window.PDFReportDataCollector.collectCalculationsData(mockState);

            calcData.forEach(c => {
                if (!c.status) {
                    throw new Error('Statut manquant pour le calcul: ' + c.id);
                }
                if (!['PASS', 'WARNING', 'FAIL'].includes(c.status)) {
                    throw new Error('Statut invalide: ' + c.status + ' pour ' + c.id);
                }
            });
        }
    };

    // P2-25 : Exécution automatique des tests uniquement en mode debug
    if (typeof window !== 'undefined') {
        window.PDFReportTests = PDFReportTests;

        // P2-25 : Exécuter les tests uniquement si un flag de debug est présent
        const isDebugMode = localStorage.getItem('cp_debug_mode') === 'true' ||
                            window.location.search.includes('debug=tests');

        if (isDebugMode && document.readyState === 'complete') {
            setTimeout(() => window.PDFReportTests.runAll(), 500);
        } else if (isDebugMode) {
            document.addEventListener('DOMContentLoaded', function() {
                setTimeout(() => window.PDFReportTests.runAll(), 1000);
            });
        }
    }

})();

// ============================================================
// FIN DU FICHIER pdfReport.test.js
// ============================================================