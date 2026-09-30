// ============================================================
// app-3d-events.js – CP Engineer Pro
// Gestion des événements 3D (sélecteur de système, mini-carte,
// moduleChanged, refreshGIS3D, version applicative).
//
// Ce fichier a été extrait du <script> inline historiquement
// présent dans index.html afin de permettre la suppression de
// 'unsafe-inline' dans la directive CSP script-src.
//
// Chargé en defer, APRÈS app.js et simulation3d.js.
// ============================================================

(function() {
    'use strict';

    // === Gestion du sélecteur de système 3D ===
    const vis3dSelector = document.getElementById('vis3dSystemSelector');
    const vis3dLoadBtn = document.getElementById('vis3dLoadSystemBtn');

    if (vis3dSelector) {
        vis3dSelector.addEventListener('change', function() {
            const sysId = this.value;
            // Appliquer le filtre à la 3D
            if (window.Gis3D && typeof window.Gis3D.setSystemFilter === 'function') {
                window.Gis3D.setSystemFilter(sysId || null);
            }
            // Recharger les données
            if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                const projectId = window.ProjectManager?.getCurrentProjectId() || '__all__';
                window.Gis3D.loadData(projectId);
            }
        });
    }

    if (vis3dLoadBtn) {
        vis3dLoadBtn.addEventListener('click', function() {
            const sysId = vis3dSelector?.value;
            // Appliquer le filtre à la 3D
            if (window.Gis3D && typeof window.Gis3D.setSystemFilter === 'function') {
                window.Gis3D.setSystemFilter(sysId || null);
            }
            // Recharger les données
            if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                const projectId = window.ProjectManager?.getCurrentProjectId() || '__all__';
                window.Gis3D.loadData(projectId);
            }
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('✅ Données 3D rechargées', 'success');
            }
        });
    }

    // === Bouton de réinitialisation de la vue ===
    const resetViewBtn = document.getElementById('btnResetView');
    if (resetViewBtn) {
        resetViewBtn.addEventListener('click', function() {
            if (window.Gis3D && typeof window.Gis3D.resetView === 'function') {
                window.Gis3D.resetView();
            }
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('Vue réinitialisée', 'info');
            }
        });
    }

    // === Bouton d'affichage de la mini-carte ===
    const toggleMapBtn = document.getElementById('btnToggleMap');
    if (toggleMapBtn) {
        toggleMapBtn.addEventListener('click', function() {
            const container = document.getElementById('miniMapContainer');
            if (container) {
                const isVisible = container.style.display !== 'none';
                container.style.display = isVisible ? 'none' : 'block';
                this.innerHTML = isVisible ? 
                    '<i class="fas fa-map"></i> Afficher carte' : 
                    '<i class="fas fa-map"></i> Masquer carte';
                // Mettre à jour les marqueurs si la carte devient visible
                if (!isVisible && window.GisSync && typeof window.GisSync.updateMarkers === 'function') {
                    setTimeout(window.GisSync.updateMarkers, 300);
                }
            }
        });
    }

    function setupFullscreenToggle(buttonId, targetId, onResize) {
        const button = document.getElementById(buttonId);
        const target = document.getElementById(targetId);
        if (!button || !target) return;

        const updateState = () => {
            const active = document.fullscreenElement === target;
            button.classList.toggle('is-fullscreen', active);
            button.setAttribute('aria-label', active ? 'Quitter le plein écran' : button.dataset.defaultLabel);
            button.innerHTML = active
                ? '<i class="fas fa-compress" aria-hidden="true"></i><span>Réduire</span>'
                : button.dataset.defaultContent;
            if (typeof onResize === 'function') setTimeout(onResize, 80);
        };

        button.dataset.defaultLabel = button.getAttribute('aria-label') || 'Plein écran';
        button.dataset.defaultContent = button.innerHTML;
        button.addEventListener('click', async () => {
            try {
                if (document.fullscreenElement === target) await document.exitFullscreen();
                else await target.requestFullscreen();
            } catch (error) {
                console.warn('[Fullscreen] Impossible d\'activer le plein écran:', error);
                if (window.UI && typeof window.UI.showToast === 'function') {
                    window.UI.showToast('Le plein écran n’est pas disponible dans ce navigateur.', 'warning');
                }
            }
        });
        document.addEventListener('fullscreenchange', updateState);
    }

    setupFullscreenToggle('mapFullscreenBtn', 'mapWrapper', () => {
        const map = window.GisIntegration?.getMap?.();
        if (map && typeof map.invalidateSize === 'function') map.invalidateSize({ animate: false });
    });

    setupFullscreenToggle('threeFullscreenBtn', 'threeViewport', () => {
        const renderer = window.Gis3D?.getRenderer?.();
        const camera = window.Gis3D?.getCamera?.();
        const container = document.getElementById('threeContainer');
        if (!renderer || !camera || !container) return;
        const width = container.clientWidth || window.innerWidth;
        const height = container.clientHeight || window.innerHeight;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    });

    // === Gestion du chargement du module 3D ===
    document.addEventListener('moduleChanged', function(e) {
        const moduleId = e.detail?.moduleId;
        if (moduleId === 'visualisation3d') {
            // Peupler le sélecteur de système
            if (window.UI && typeof window.UI.populateVis3dSystemSelector === 'function') {
                setTimeout(window.UI.populateVis3dSystemSelector, 300);
            }
            // Initialiser la 3D
            if (window.Gis3D && typeof window.Gis3D.init === 'function') {
                setTimeout(function() {
                    window.Gis3D.init();
                    const projectId = window.ProjectManager?.getCurrentProjectId() || '__all__';
                    if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                        window.Gis3D.loadData(projectId);
                    }
                }, 400);
            }
        }
    });

    // === Initialisation au chargement de la page ===
    document.addEventListener('DOMContentLoaded', function() {
        const module3d = document.getElementById('module-visualisation3d');
        if (module3d && module3d.classList.contains('active')) {
            setTimeout(function() {
                if (window.UI && typeof window.UI.populateVis3dSystemSelector === 'function') {
                    window.UI.populateVis3dSystemSelector();
                }
                if (window.Gis3D && typeof window.Gis3D.init === 'function') {
                    window.Gis3D.init();
                    setTimeout(function() {
                        const projectId = window.ProjectManager?.getCurrentProjectId() || '__all__';
                        if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                            window.Gis3D.loadData(projectId);
                        }
                    }, 300);
                }
            }, 500);
        }
    });

    // === Écoute de l'événement refreshGIS3D ===
    document.addEventListener('refreshGIS3D', function() {
        if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
            const projectId = window.ProjectManager?.getCurrentProjectId() || '__all__';
            // Récupérer le filtre système actuel
            const sysId = document.getElementById('vis3dSystemSelector')?.value;
            if (window.Gis3D && typeof window.Gis3D.setSystemFilter === 'function') {
                window.Gis3D.setSystemFilter(sysId || null);
            }
            window.Gis3D.loadData(projectId);
        }
    });

    // === Affichage dynamique de la version applicative (SSOT) ===
    document.addEventListener('DOMContentLoaded', function() {
        const v = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.VERSION)
            ? APP_CONFIG.VERSION
            : '9.6.0';
        const el = document.getElementById('sidebarVersion');
        if (el) el.textContent = 'v' + v + ' — Industrial Release';
    });

})();