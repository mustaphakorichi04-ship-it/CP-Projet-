// ============================================================
// gisSync.js – CP Engineer Pro
// Synchronisation GIS ↔ 3D ↔ UI (marqueurs, layers)
// Version 1.1 – CORRECTION : ce fichier ne doit JAMAIS
//                redéfinir PDFReportSections (qui appartient
//                à pdf-report-sections.js v3.0).
// ============================================================
(function() {
    'use strict';

    if (window.GisSync && window.GisSync.__v11) {
        console.log('[GisSync] Déjà chargé — ignoré.');
        return;
    }

    const GisSync = {
        __v11: true,
        VERSION: '1.1.0',

        /**
         * Met à jour les marqueurs de la mini-carte 3D en fonction
         * des équipements actuellement visibles.
         */
        updateMarkers: function() {
            try {
                const miniMap = (window.Gis3D && typeof window.Gis3D.getMiniMap === 'function')
                    ? window.Gis3D.getMiniMap()
                    : null;

                if (!miniMap) {
                    return; // Pas de mini-carte active → rien à faire
                }

                if (!window.L) return;

                if (!this._markerLayer) {
                    this._markerLayer = L.layerGroup().addTo(miniMap);
                }
                this._markerLayer.clearLayers();

                const state = (typeof ProjectManager !== 'undefined' && ProjectManager.getState)
                    ? ProjectManager.getState()
                    : null;
                if (!state || !state.equipments) return;

                const projectId = ProjectManager.getCurrentProjectId
                    ? ProjectManager.getCurrentProjectId()
                    : null;

                const equipments = state.equipments.filter(eq => {
                    if (projectId && projectId !== '__all__' && eq.projectId !== projectId) return false;
                    if (eq.included === false) return false;
                    if (!eq.coordinates) return false;
                    return true;
                });

                const colorMap = {
                    'rectifier': '#ef4444',
                    'groundbed': '#8b5cf6',
                    'anode': '#f59e0b',
                    'testpost': '#06b6d4',
                    'pipeline_enterre': '#3b82f6',
                    'pipeline_offshore': '#3b82f6'
                };

                equipments.forEach(eq => {
                    let lat = null, lon = null;
                    const c = eq.coordinates;
                    if (Array.isArray(c) && c.length > 0) {
                        lat = c[0].lat; lon = c[0].lon;
                    } else if (c && c.lat !== undefined) {
                        lat = c.lat; lon = c.lon;
                    }
                    if (lat === null || lon === null) return;

                    const color = colorMap[eq.type] || '#94a3b8';
                    L.circleMarker([lat, lon], {
                        radius: 3,
                        color: color,
                        fillColor: color,
                        fillOpacity: 0.8,
                        weight: 1
                    })
                    .bindTooltip(eq.tag || eq.id, { direction: 'top' })
                    .addTo(this._markerLayer);
                });

                console.log('[GisSync] Mini-carte : ' + equipments.length + ' marqueur(s) mis à jour.');
            } catch (e) {
                console.warn('[GisSync] updateMarkers erreur:', e.message);
            }
        },

        /**
         * Callback enregistré sur l'événement miniMapUpdateRequested
         * émis par Gis3D.
         */
        _onMiniMapUpdateRequested: function(evt) {
            if (evt && evt.detail && evt.detail.equipments) {
                // On peut ignorer le detail et relire depuis ProjectManager
            }
            GisSync.updateMarkers();
        }
    };

    // Écoute l'événement émis par Gis3D
    document.addEventListener('miniMapUpdateRequested', GisSync._onMiniMapUpdateRequested);

    // Met à jour après chaque chargement de projet / équipement
    document.addEventListener('projectLoaded', function() {
        setTimeout(() => GisSync.updateMarkers(), 500);
    });
    document.addEventListener('equipmentUpdated', function() {
        setTimeout(() => GisSync.updateMarkers(), 300);
    });

    window.GisSync = GisSync;
    console.log('[GisSync] v' + GisSync.VERSION + ' chargé.');
})();