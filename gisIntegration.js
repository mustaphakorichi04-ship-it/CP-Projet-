// ============================================================
// gisIntegration.js – CP Engineer Pro – Module d'intégration GIS complet
// VERSION 8.24 – CORRECTION DÉFINITIVE : 
// - Idempotence de initMap()
// - Une seule instance Leaflet par conteneur
// - Nettoyage des layers, pas de destruction de carte
// - Gestion robuste du cycle de vie
// - Suppression des appels redondants
// - CORRECTION : Map container already initialized
// ============================================================

(function() {
    'use strict';

    // ============================================================
    // 1. CONFIGURATION
    // ============================================================
    const CONFIG = {
        maxClusterRadius: 40,
        disableClusteringAtZoom: 14,
        defaultView: { lat: 30.123456, lon: 8.123456, zoom: 5 },
        maxPointsForClustering: 1000,
        measureUnits: {
            distance: 'm',
            area: 'm²'
        },
        REFRESH_DEBOUNCE_MS: 300,
        VISIBILITY_CHECK_DELAY_MS: 500
    };

    // ============================================================
    // 2. COULEURS PAR PROJET
    // ============================================================
    const PROJECT_COLORS = {
        'PROJ-001': '#00A3E0',
        'PROJ-002': '#FF6B00',
        'PROJ-003': '#8B5CF6',
        'PROJ-004': '#10B981',
    };
    const DEFAULT_PROJECT_COLOR = '#94a3b8';

    function getProjectColor(projectId) {
        if (!projectId) return DEFAULT_PROJECT_COLOR;
        return PROJECT_COLORS[projectId] || DEFAULT_PROJECT_COLOR;
    }

    // ============================================================
    // 3. LAYER MANAGER
    // ============================================================
    const LayerManager = {
        _layers: {
            'base': {
                id: 'base',
                name: 'Base Map',
                visible: true,
                type: 'base',
                layers: ['satellite', 'terrain', 'road']
            },
            'projects': {
                id: 'projects',
                name: 'Projets',
                visible: true,
                type: 'overlay',
                data: [],
                style: { color: '#8b5cf6', weight: 2 }
            },
            'pipelines': {
                id: 'pipelines',
                name: 'Pipelines',
                visible: true,
                type: 'overlay',
                data: [],
                style: { color: '#3b82f6', weight: 3, opacity: 0.8 }
            },
            'equipment': {
                id: 'equipment',
                name: 'Équipements CP',
                visible: true,
                type: 'overlay',
                data: [],
                icons: {
                    'rectifier': '#ef4444',
                    'testpost': '#06b6d4',
                    'groundbed': '#8b5cf6',
                    'anode': '#f59e0b',
                    'pipeline_enterre': '#3b82f6',
                    'pipeline_offshore': '#3b82f6',
                    'well_casing': '#6b7280',
                    'support_metallique': '#94a3b8',
                    'autre': '#94a3b8'
                }
            },
            'groundbeds': {
                id: 'groundbeds',
                name: 'Puits anodiques',
                visible: true,
                type: 'overlay',
                data: [],
                style: { color: '#8b5cf6', weight: 2 }
            },
            'cp_systems': {
                id: 'cp_systems',
                name: 'Systèmes CP',
                visible: true,
                type: 'overlay',
                data: [],
                style: { color: '#f59e0b', weight: 2 }
            },
            'interference': {
                id: 'interference',
                name: 'Interférences',
                visible: false,
                type: 'overlay',
                data: [],
                style: { color: '#ef4444', weight: 2 }
            },
            'anomalies': {
                id: 'anomalies',
                name: 'Anomalies',
                visible: false,
                type: 'overlay',
                data: [],
                style: { color: '#ff6b6b', weight: 2 }
            }
        },
        _activeLayers: {},
        _layerControls: null,

        initUI: function() {
            const container = document.getElementById('layerControls');
            if (!container) return;

            let html = '<div class="layer-controls"><h4>Couches</h4><ul>';
            for (const [id, layer] of Object.entries(this._layers)) {
                if (layer.type === 'base') continue;
                html += `<li>
                    <label>
                        <input type="checkbox" data-layer="${id}" ${layer.visible ? 'checked' : ''}>
                        ${layer.name}
                    </label>
                </li>`;
            }
            html += '</ul></div>';
            container.innerHTML = html;

            container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const layerId = e.target.dataset.layer;
                    this.toggle(layerId, e.target.checked);
                });
            });

            const baseMapContainer = document.getElementById('baseMapControls');
            if (baseMapContainer) {
                baseMapContainer.innerHTML = `
                    <div class="base-map-controls">
                        <button data-tile="osm" class="btn btn-sm btn-secondary active">OSM</button>
                        <button data-tile="satellite" class="btn btn-sm btn-secondary">Satellite</button>
                        <button data-tile="terrain" class="btn btn-sm btn-secondary">Terrain</button>
                    </div>
                `;
                baseMapContainer.querySelectorAll('button').forEach(btn => {
                    btn.addEventListener('click', function() {
                        const tile = this.dataset.tile;
                        window.GisIntegration.changeBaseMap(tile);
                        document.querySelectorAll('.base-map-controls .btn').forEach(b => b.classList.remove('active'));
                        this.classList.add('active');
                    });
                });
            }
        },

        toggle: function(layerId, visible) {
            if (this._layers[layerId]) {
                this._layers[layerId].visible = visible;
                document.dispatchEvent(new CustomEvent('layerToggled', {
                    detail: { layerId, visible }
                }));
                if (window.GisIntegration && typeof window.GisIntegration.refreshMap === 'function') {
                    window.GisIntegration.refreshMap();
                }
            }
        },

        isVisible: function(layerId) {
            return this._layers[layerId] ? this._layers[layerId].visible : false;
        },

        getLayers: function() {
            return this._layers;
        },

        getVisibleLayers: function() {
            const result = [];
            for (const [id, layer] of Object.entries(this._layers)) {
                if (layer.visible && layer.type !== 'base') {
                    result.push(id);
                }
            }
            return result;
        }
    };

    // ============================================================
    // 4. FILTER MANAGER
    // ============================================================
    const FilterManager = {
        _filters: {
            projectId: null,
            equipmentType: null,
            included: null,
            hasGPS: null,
            cpSystem: null,
            searchQuery: null
        },

        apply: function(equipments) {
            let result = [...equipments];

            if (this._filters.projectId !== null && this._filters.projectId !== undefined && this._filters.projectId !== '__all__') {
                result = result.filter(eq => eq.projectId === this._filters.projectId);
            }
            if (this._filters.equipmentType) {
                result = result.filter(eq => eq.type === this._filters.equipmentType);
            }
            if (this._filters.included !== null) {
                result = result.filter(eq => eq.included === this._filters.included);
            }
            if (this._filters.hasGPS !== null) {
                result = result.filter(eq => {
                    const has = eq.coordinates && (
                        (Array.isArray(eq.coordinates) && eq.coordinates.length > 0) ||
                        (eq.coordinates.lat !== undefined && eq.coordinates.lon !== undefined)
                    );
                    return this._filters.hasGPS ? has : !has;
                });
            }
            if (this._filters.cpSystem) {
                result = result.filter(eq => eq.systemId === this._filters.cpSystem);
            }
            if (this._filters.searchQuery) {
                const query = this._filters.searchQuery.toLowerCase();
                result = result.filter(eq =>
                    (eq.tag && eq.tag.toLowerCase().includes(query)) ||
                    (eq.type && eq.type.toLowerCase().includes(query)) ||
                    (eq.id && eq.id.toLowerCase().includes(query))
                );
            }
            return result;
        },

        setFilter: function(key, value) {
            if (key in this._filters) {
                if (key === 'projectId' && value === '__all__') {
                    value = null;
                }
                this._filters[key] = value;
                this.syncUI();
                document.dispatchEvent(new CustomEvent('filterChanged', {
                    detail: { key, value }
                }));
                if (window.GisIntegration && typeof window.GisIntegration.refreshMap === 'function') {
                    window.GisIntegration.refreshMap();
                }
            }
        },

        getFilter: function(key) {
            return this._filters[key];
        },

        reset: function() {
            for (const key in this._filters) {
                this._filters[key] = null;
            }
            this.syncUI();
            document.dispatchEvent(new CustomEvent('filterChanged', { detail: { reset: true } }));
            if (window.GisIntegration && typeof window.GisIntegration.refreshMap === 'function') {
                window.GisIntegration.refreshMap();
            }
        },

        syncUI: function() {
            const select = document.getElementById('filterProject');
            if (!select) return;
            const projectId = this._filters.projectId;
            select.value = projectId || '__all__';
        },

        initUI: function() {
            const container = document.getElementById('filterControls');
            if (!container) return;

            const projectSelect = document.createElement('select');
            projectSelect.id = 'filterProject';

            const allOption = document.createElement('option');
            allOption.value = '__all__';
            allOption.textContent = 'Tous les projets';
            projectSelect.appendChild(allOption);

            ProjectManager.getProjectsList().forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = `${p.id} - ${p.name}`;
                projectSelect.appendChild(opt);
            });

            projectSelect.addEventListener('change', function() {
                const val = this.value;
                FilterManager.setFilter('projectId', val);
            });
            container.appendChild(projectSelect);

            const typeSelect = document.createElement('select');
            typeSelect.id = 'filterType';
            typeSelect.innerHTML = '<option value="">Tous les types</option>';
            const types = [
                'pipeline_enterre', 'pipeline_offshore',
                'reservoir_fond', 'reservoir_toit', 'ballon_souterrain',
                'tank', 'reservoir',
                'rectifier', 'testpost', 'groundbed', 'anode',
                'well_casing', 'support_metallique', 'autre'
            ];
            types.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t.replace('_', ' ');
                typeSelect.appendChild(opt);
            });
            typeSelect.addEventListener('change', function() {
                FilterManager.setFilter('equipmentType', this.value || null);
            });
            container.appendChild(typeSelect);

            const includeSelect = document.createElement('select');
            includeSelect.id = 'filterIncluded';
            includeSelect.innerHTML = `
                <option value="">Tous</option>
                <option value="true">Inclus</option>
                <option value="false">Exclus</option>
            `;
            includeSelect.addEventListener('change', function() {
                const val = this.value;
                FilterManager.setFilter('included', val === '' ? null : val === 'true');
            });
            container.appendChild(includeSelect);

            const gpsSelect = document.createElement('select');
            gpsSelect.id = 'filterGPS';
            gpsSelect.innerHTML = `
                <option value="">Tous</option>
                <option value="true">Avec GPS</option>
                <option value="false">Sans GPS</option>
            `;
            gpsSelect.addEventListener('change', function() {
                const val = this.value;
                FilterManager.setFilter('hasGPS', val === '' ? null : val === 'true');
            });
            container.appendChild(gpsSelect);

            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.id = 'filterSearch';
            searchInput.placeholder = 'Rechercher...';
            searchInput.addEventListener('input', function() {
                FilterManager.setFilter('searchQuery', this.value || null);
            });
            container.appendChild(searchInput);

            const resetBtn = document.createElement('button');
            resetBtn.className = 'btn btn-sm btn-secondary';
            resetBtn.textContent = 'Réinitialiser';
            resetBtn.addEventListener('click', function() {
                FilterManager.reset();
                document.querySelectorAll('#filterControls select').forEach(s => s.value = '');
                document.querySelector('#filterSearch').value = '';
            });
            container.appendChild(resetBtn);

            container.style.cssText = 'display:flex; gap:0.5rem; flex-wrap:wrap; padding:0.5rem;';

            this.syncUI();
        }
    };

    // ============================================================
    // 5. SEARCH MANAGER
    // ============================================================
    const SearchManager = {
        _results: [],
        _searchCallback: null,

        search: function(query, equipments) {
            if (!query || query.length < 2) {
                this._results = [];
                if (this._searchCallback) this._searchCallback([]);
                return [];
            }
            const q = query.toLowerCase();
            const results = equipments.filter(eq =>
                (eq.tag && eq.tag.toLowerCase().includes(q)) ||
                (eq.type && eq.type.toLowerCase().includes(q)) ||
                (eq.id && eq.id.toLowerCase().includes(q)) ||
                (eq.dimensions && JSON.stringify(eq.dimensions).toLowerCase().includes(q))
            );
            this._results = results;
            if (this._searchCallback) this._searchCallback(results);
            return results;
        },

        setCallback: function(callback) {
            this._searchCallback = callback;
        },

        getResults: function() {
            return this._results;
        }
    };

    // ============================================================
    // 6. MEASURE TOOL
    // ============================================================
    const MeasureTool = {
        _enabled: false,
        _points: [],
        _markers: [],
        _line: null,
        _totalDistance: 0,
        _onMeasureComplete: null,

        enable: function() {
            if (this._enabled) return;
            const map = getMapInstance();
            if (!map) {
                UI.showToast('Carte non disponible', 'error');
                return;
            }
            this._enabled = true;
            this._points = [];
            this._markers = [];
            this._totalDistance = 0;
            if (this._line) {
                map.removeLayer(this._line);
                this._line = null;
            }
            map.on('click', this._onClick.bind(this));
            UI.showToast('Cliquez sur la carte pour mesurer une distance (double-clic pour terminer)', 'info');
            document.dispatchEvent(new CustomEvent('measureStarted'));
        },

        disable: function() {
            if (!this._enabled) return;
            this._enabled = false;
            const map = getMapInstance();
            if (map) {
                map.off('click', this._onClick);
            }
            this._clear();
            UI.showToast('Mesure désactivée', 'info');
            document.dispatchEvent(new CustomEvent('measureStopped'));
        },

        _onClick: function(e) {
            const latlng = e.latlng;
            this._points.push(latlng);
            const map = getMapInstance();
            if (!map) return;
            const marker = L.marker(latlng, {
                icon: L.divIcon({
                    className: 'measure-marker',
                    html: `<div style="background:#06b6d4; width:8px; height:8px; border-radius:50%; border:2px solid white;"></div>`,
                    iconSize: [8, 8],
                    iconAnchor: [4, 4]
                })
            }).addTo(map);
            this._markers.push(marker);
            if (this._points.length >= 2) {
                if (this._line) {
                    map.removeLayer(this._line);
                }
                const latlngs = this._points.map(p => [p.lat, p.lng]);
                this._line = L.polyline(latlngs, { color: '#06b6d4', weight: 2, dashArray: '5,5' }).addTo(map);
                this._totalDistance = 0;
                for (let i = 1; i < this._points.length; i++) {
                    this._totalDistance += this._points[i - 1].distanceTo(this._points[i]);
                }
                this._showDistance();
            }
        },

        _showDistance: function() {
            const map = getMapInstance();
            if (!map) return;
            if (this._distanceLabel) {
                map.removeLayer(this._distanceLabel);
                this._distanceLabel = null;
            }
            if (this._points.length < 2) return;
            const last = this._points[this._points.length - 1];
            const label = L.marker(last, {
                icon: L.divIcon({
                    className: 'measure-label',
                    html: `<div style="background:rgba(6,182,212,0.8); color:white; padding:2px 8px; border-radius:4px; font-size:12px; font-weight:bold;">${this._totalDistance.toFixed(1)} m</div>`,
                    iconSize: [60, 20],
                    iconAnchor: [30, 10]
                })
            }).addTo(map);
            this._distanceLabel = label;
        },

        _clear: function() {
            const map = getMapInstance();
            if (!map) return;
            this._markers.forEach(m => {
                map.removeLayer(m);
            });
            this._markers = [];
            if (this._line) {
                map.removeLayer(this._line);
                this._line = null;
            }
            if (this._distanceLabel) {
                map.removeLayer(this._distanceLabel);
                this._distanceLabel = null;
            }
            this._points = [];
            this._totalDistance = 0;
        },

        finish: function() {
            if (this._points.length < 2) {
                this.disable();
                return;
            }
            const total = this._totalDistance;
            if (this._onMeasureComplete) {
                this._onMeasureComplete(total);
            }
            UI.showToast(`Distance mesurée : ${total.toFixed(1)} m`, 'success');
            this.disable();
        },

        onComplete: function(callback) {
            this._onMeasureComplete = callback;
        },

        isEnabled: function() {
            return this._enabled;
        }
    };

    // ============================================================
    // 7. GIS INTEGRATION PRINCIPAL — CORRECTION IDEMPOTENCE
    // ============================================================
    
    // === ÉTAT UNIQUE DE LA CARTE ===
    let _mapInstance = null;
    let _mapContainerId = null;
    let _isMapInitialized = false;
    let _mapContainer = null;
    let _clusterGroup = null;
    let _markers = [];
    let _equipmentMarkers = {};
    let _currentProjectId = null;
    let _isRendering = false;
    let _loadVersion = 0;
    let _refreshTimeout = null;
    let _loadTimeout = null;
    let _lastRefreshTime = 0;
    let _isInitializing = false;
    let _baseLayer = null;

    // === FONCTIONS UTILITAIRES ===
    function getMapInstance() {
        return _mapInstance;
    }

    function formatCoord(val, decimals) {
        decimals = decimals || 6;
        if (val === undefined || val === null || typeof val !== 'number' || isNaN(val)) return '?';
        return val.toFixed(decimals);
    }

    function isValidCoord(lat, lon) {
        if (typeof CoordSystem !== 'undefined' && CoordSystem.isValid) {
            return CoordSystem.isValid(lat, lon);
        }
        if (lat === undefined || lon === undefined) return false;
        if (typeof lat !== 'number' || typeof lon !== 'number') return false;
        if (isNaN(lat) || isNaN(lon)) return false;
        if (!isFinite(lat) || !isFinite(lon)) return false;
        if (lat < -90 || lat > 90) return false;
        if (lon < -180 || lon > 180) return false;
        return true;
    }

    function isZeroCoord(lat, lon) {
        return Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9;
    }

    function debounce(fn, delay) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    function isModuleVisible() {
        const moduleCarto = document.getElementById('module-cartography');
        if (!moduleCarto) return false;
        if (!moduleCarto.classList.contains('active')) return false;
        const style = window.getComputedStyle(moduleCarto);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const wrapper = document.getElementById('mapWrapper');
        if (!wrapper) return false;
        const wrapperStyle = window.getComputedStyle(wrapper);
        if (wrapperStyle.display === 'none' || wrapperStyle.visibility === 'hidden') return false;
        const rect = wrapper.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return false;
        return true;
    }

    // === CRÉATION DU CONTENEUR (UNE SEULE FOIS) ===
    function ensureMapContainer() {
        let wrapper = document.getElementById('mapWrapper');
        
        if (!wrapper) {
            const mapModule = document.getElementById('module-cartography');
            if (mapModule) {
                const cardBody = mapModule.querySelector('.card-body');
                if (cardBody) {
                    wrapper = document.createElement('div');
                    wrapper.id = 'mapWrapper';
                    wrapper.style.width = '100%';
                    wrapper.style.height = '500px';
                    wrapper.style.minHeight = '400px';
                    wrapper.style.position = 'relative';
                    cardBody.insertBefore(wrapper, cardBody.firstChild);
                }
            }
        }
        
        if (!wrapper) {
            wrapper = document.getElementById('mapWrapper');
            if (!wrapper) {
                wrapper = document.createElement('div');
                wrapper.id = 'mapWrapper';
                wrapper.style.width = '100%';
                wrapper.style.height = '500px';
                wrapper.style.minHeight = '400px';
                wrapper.style.position = 'relative';
                wrapper.style.display = 'none';
                document.body.appendChild(wrapper);
            }
        }

        let container = wrapper.querySelector('.leaflet-container');
        if (container) {
            wrapper.innerHTML = '';
            container = null;
        }

        wrapper.style.display = 'block';
        
        const newContainer = document.createElement('div');
        _mapContainerId = 'mapContainer_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        newContainer.id = _mapContainerId;
        newContainer.style.width = '100%';
        newContainer.style.height = '100%';
        newContainer.style.minHeight = '400px';
        newContainer.style.position = 'relative';
        newContainer.style.zIndex = '1';
        
        wrapper.appendChild(newContainer);
        _mapContainer = newContainer;
        console.log('[GIS] Nouveau conteneur créé:', _mapContainerId);
        return newContainer;
    }

    // === INITIALISATION IDEMPOTENTE DE LA CARTE ===
    function initMap() {
        if (_mapInstance && _isMapInitialized) {
            try {
                const size = _mapInstance.getSize();
                if (size.x > 0 && size.y > 0) {
                    const container = _mapInstance.getContainer();
                    if (container && document.body.contains(container)) {
                        console.log('[GIS] Carte existante réutilisée');
                        return _mapInstance;
                    }
                }
            } catch (e) {
                console.warn('[GIS] Carte existante invalide, recréation nécessaire');
                _mapInstance = null;
                _isMapInitialized = false;
            }
        }

        if (_isInitializing) {
            console.log('[GIS] Initialisation déjà en cours, attente...');
            return null;
        }

        if (!isModuleVisible()) {
            console.warn('[GIS] Module Cartographie non visible, report de l\'initialisation');
            return null;
        }

        if (typeof L === 'undefined') {
            console.warn('[GIS] Leaflet non chargé');
            return null;
        }

        _isInitializing = true;

        try {
            if (_mapInstance) {
                try {
                    _mapInstance.remove();
                } catch (e) {
                    console.warn('[GIS] Erreur lors du nettoyage de l\'ancienne carte:', e.message);
                }
                _mapInstance = null;
                _isMapInitialized = false;
            }

            const container = ensureMapContainer();
            if (!container) {
                throw new Error('Impossible de créer le conteneur de la carte');
            }

            container.innerHTML = '';

            let refLat = 30.123456;
            let refLon = 8.123456;
            if (typeof CoordSystem !== 'undefined' && CoordSystem.getReference) {
                const coordRef = CoordSystem.getReference();
                if (coordRef && coordRef.lat && coordRef.lon) {
                    refLat = coordRef.lat;
                    refLon = coordRef.lon;
                }
            }

            _mapInstance = L.map(container, {
                zoomControl: true,
                attributionControl: true,
                zoomAnimation: false,
                fadeAnimation: false,
                markerZoomAnimation: false,
                preferCanvas: false
            }).setView([refLat, refLon], 5);

            _baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap contributors'
            }).addTo(_mapInstance);

            _clusterGroup = L.markerClusterGroup({
                maxClusterRadius: CONFIG.maxClusterRadius,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
                zoomToBoundsOnClick: true,
                disableClusteringAtZoom: CONFIG.disableClusteringAtZoom,
                chunkedLoading: true,
                chunkInterval: 200,
                chunkDelay: 50
            });
            _mapInstance.addLayer(_clusterGroup);

            const resizeObserver = new ResizeObserver(() => {
                if (_mapInstance && _isMapInitialized && isModuleVisible()) {
                    try {
                        _mapInstance.invalidateSize();
                    } catch (e) {
                        // Ignorer
                    }
                }
            });
            resizeObserver.observe(container);

            _mapInstance.on('dblclick', function() {
                if (MeasureTool.isEnabled()) {
                    MeasureTool.finish();
                }
            });

            _isMapInitialized = true;
            window._gisMap = _mapInstance;

            console.log('[GIS] Carte initialisée avec succès (ID: ' + _mapContainerId + ')');
            return _mapInstance;

        } catch (error) {
            console.error('[GIS] Erreur lors de l\'initialisation de la carte:', error);
            _mapInstance = null;
            _isMapInitialized = false;
            return null;
        } finally {
            _isInitializing = false;
        }
    }

    // === RÉCUPÉRATION DES COORDONNÉES D'UN ÉQUIPEMENT ===
    function getEquipmentCoordinates(eq) {
        if (!eq || !eq.coordinates) return null;
        
        if (typeof window.GpsConverter !== 'undefined') {
            try {
                const result = window.GpsConverter.extractCoordinates(eq.coordinates);
                if (result && result.length > 0) {
                    return result;
                }
            } catch (err) {
                console.warn(`[GIS] Erreur GpsConverter pour ${eq.tag}:`, err);
            }
        }
        
        try {
            const coords = eq.coordinates;
            let points = [];
            
            if (Array.isArray(coords)) {
                if (coords.length >= 2 && typeof coords[0] !== 'object') {
                    points = [{ lat: coords[0], lon: coords[1], alt: coords[2] }];
                } else {
                    points = coords;
                }
            } else if (typeof coords === 'object' && coords !== null) {
                const lat = coords.lat !== undefined ? coords.lat : 
                           (coords.latitude !== undefined ? coords.latitude : 
                           (coords.Lat !== undefined ? coords.Lat : undefined));
                const lon = coords.lon !== undefined ? coords.lon : 
                           (coords.longitude !== undefined ? coords.longitude : 
                           (coords.Lon !== undefined ? coords.Lon : 
                           (coords.lng !== undefined ? coords.lng : undefined)));
                const alt = coords.alt !== undefined ? coords.alt : 
                           (coords.altitude !== undefined ? coords.altitude : 
                           (coords.Alt !== undefined ? coords.Alt : null));
                           
                if (lat !== undefined && lon !== undefined) {
                    points = [{ lat: parseFloat(lat), lon: parseFloat(lon), alt: alt !== null ? parseFloat(alt) : null }];
                } else {
                    const values = Object.values(coords).filter(v => 
                        typeof v === 'object' && v !== null && 
                        ('lat' in v || 'latitude' in v) && 
                        ('lon' in v || 'longitude' in v || 'lng' in v)
                    );
                    if (values.length > 0) {
                        points = values;
                    } else {
                        console.warn(`[GIS] Coordonnées mal formées pour l'équipement ${eq.tag}:`, coords);
                        return null;
                    }
                }
            } else {
                return null;
            }

            const valid = points.filter(p => {
                const lat = p.lat !== undefined ? parseFloat(p.lat) : 
                           (p.latitude !== undefined ? parseFloat(p.latitude) : NaN);
                const lon = p.lon !== undefined ? parseFloat(p.lon) : 
                           (p.longitude !== undefined ? parseFloat(p.longitude) : 
                           (p.lng !== undefined ? parseFloat(p.lng) : NaN));
                if (isNaN(lat) || isNaN(lon)) return false;
                if (!isValidCoord(lat, lon)) return false;
                return true;
            });

            if (valid.length === 0) {
                console.warn(`[GIS] Équipement ${eq.tag} (${eq.id}) : aucun point valide`);
                return null;
            }

            const normalized = valid.map(p => ({
                lat: parseFloat(p.lat || p.latitude),
                lon: parseFloat(p.lon || p.longitude || p.lng),
                alt: p.alt !== undefined ? parseFloat(p.alt) : 
                     (p.altitude !== undefined ? parseFloat(p.altitude) : null)
            }));

            return normalized;
        } catch (err) {
            console.warn(`[GIS] Erreur extraction GPS pour ${eq.tag}:`, err);
            return null;
        }
    }

    // === ICÔNE DES MARQUEURS ===
    function getMarkerIcon(equipment) {
        const typeColors = {
            'rectifier': '#ef4444',
            'testpost': '#06b6d4',
            'groundbed': '#8b5cf6',
            'anode': '#f59e0b',
            'pipeline_enterre': '#3b82f6',
            'pipeline_offshore': '#3b82f6',
            'reservoir_fond': '#f97316',
            'reservoir_toit': '#f97316',
            'ballon_souterrain': '#f97316',
            'tank': '#f97316',
            'reservoir': '#f97316',
            'well_casing': '#6b7280',
            'support_metallique': '#94a3b8',
            'autre': '#94a3b8'
        };
        
        const projectColor = getProjectColor(equipment.projectId);
        const typeColor = typeColors[equipment.type] || '#94a3b8';
        const color = (projectColor !== DEFAULT_PROJECT_COLOR) ? projectColor : typeColor;

        let iconHtml = '';
        const type = equipment.type || 'autre';
        
        if (type === 'rectifier') {
            iconHtml = `<div style="background:${color}; width:16px; height:16px; border-radius:4px; border:2px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 12px ${color}40; display:flex; align-items:center; justify-content:center; font-size:8px; color:white; font-weight:bold;">⚡</div>`;
        } else if (type === 'testpost') {
            iconHtml = `<div style="background:${color}; width:12px; height:16px; border-radius:2px; border:2px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 12px ${color}40;"></div>`;
        } else if (type === 'groundbed') {
            iconHtml = `<div style="background:${color}; width:16px; height:16px; border-radius:50%; border:2px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 12px ${color}40; display:flex; align-items:center; justify-content:center; font-size:8px; color:white; font-weight:bold;">⛳</div>`;
        } else if (type === 'anode') {
            iconHtml = `<div style="background:${color}; width:12px; height:12px; border-radius:50%; border:2px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 12px ${color}40;"></div>`;
        } else if (type === 'reservoir_fond' || type === 'reservoir_toit' ||
                   type === 'ballon_souterrain' || type === 'tank' || type === 'reservoir') {
            iconHtml = `<div style="background:${color}; width:18px; height:13px; border-radius:3px 3px 2px 2px; border:2px solid white; box-shadow:0 2px 8px rgba(0,0,0,0.3),0 0 12px ${color}40; position:relative;"><span style="position:absolute; left:3px; right:3px; top:-5px; height:5px; border:2px solid white; border-bottom:0; border-radius:50% 50% 0 0;"></span></div>`;
        } else {
            iconHtml = `<div style="background:${color}; width:14px; height:14px; border-radius:50%; border:2px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 12px ${color}40;"></div>`;
        }

        return L.divIcon({
            className: 'custom-marker',
            html: iconHtml,
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        });
    }

    // === RAFRAÎCHISSEMENT DE LA CARTE (AVEC DEBOUNCE) ===
    const refreshMap = debounce(function(fitBounds) {
        if (!isModuleVisible()) {
            console.log('[GIS] Module Cartographie non visible, refreshMap abandonné.');
            return;
        }

        if (_isRendering) {
            console.log('[GIS] Rendu déjà en cours, requête ignorée.');
            return;
        }

        if (!_mapInstance || !_isMapInitialized) {
            const result = initMap();
            if (!result || !_clusterGroup) {
                console.warn('[GIS] Carte non disponible pour refreshMap');
                return;
            }
        }

        try {
            _mapInstance.invalidateSize();
        } catch (e) {
            console.warn('[GIS] Erreur invalidateSize:', e.message);
        }

        _isRendering = true;

        try {
            if (_clusterGroup) {
                _clusterGroup.clearLayers();
            }
            _markers = [];
            _equipmentMarkers = {};

            const filterProjectId = FilterManager.getFilter('projectId');
            const isAllProjects = (filterProjectId === null || filterProjectId === undefined || filterProjectId === '__all__');

            let allEquipments = [];

            if (isAllProjects) {
                console.log('[GIS] Mode "Tous les projets"');
                const projects = ProjectManager.getProjectsList();
                
                const loadPromises = projects.map(async (project) => {
                    try {
                        return await StorageManager.loadEquipmentsForProject(project.id, true);
                    } catch (err) {
                        console.warn(`[GIS] Erreur chargement projet ${project.id}:`, err);
                        return [];
                    }
                });
                
                Promise.all(loadPromises).then((results) => {
                    allEquipments = results.flat();
                    console.log(`[GIS] Total équipements: ${allEquipments.length}`);
                    
                    const savedProjectFilter = FilterManager._filters.projectId;
                    FilterManager._filters.projectId = null;
                    const filtered = FilterManager.apply(allEquipments);
                    FilterManager._filters.projectId = savedProjectFilter;
                    
                    renderEquipmentsOnMap(filtered, fitBounds);
                    _isRendering = false;
                    
                    if (typeof UI !== 'undefined' && typeof UI.refreshMapPointsTable === 'function') {
                        UI.refreshMapPointsTable();
                    }
                }).catch((err) => {
                    console.error('[GIS] Erreur chargement équipements:', err);
                    if (window.UI && typeof window.UI.showToast === 'function') {
                        window.UI.showToast('⚠️ Erreur lors du chargement des équipements.', 'error');
                    }
                    _isRendering = false;
                });
                return;
            }

            const state = ProjectManager.getState();
            allEquipments = state.equipments.filter(eq => eq.projectId === filterProjectId);
            console.log(`[GIS] Projet ${filterProjectId} : ${allEquipments.length} équipements`);

            const filtered = FilterManager.apply(allEquipments);
            renderEquipmentsOnMap(filtered, fitBounds);
            _isRendering = false;

        } catch (error) {
            console.error('[GIS] Erreur lors du rafraîchissement:', error);
            _isRendering = false;
        }
    }, CONFIG.REFRESH_DEBOUNCE_MS);

    // === RENDU DES ÉQUIPEMENTS ===
    function renderEquipmentsOnMap(equipments, fitBounds) {
        if (!_mapInstance || !_clusterGroup) return;

        const equipmentLayerVisible = LayerManager.isVisible('equipment');
        const groundbedLayerVisible = LayerManager.isVisible('groundbeds');
        const pipelineLayerVisible = LayerManager.isVisible('pipelines');

        console.log(`[GIS] Layers visibles: equipment=${equipmentLayerVisible}, groundbeds=${groundbedLayerVisible}, pipelines=${pipelineLayerVisible}`);

        const equipmentsWithCoords = equipments.filter(eq => {
            const coords = getEquipmentCoordinates(eq);
            if (!coords) return false;
            if (Array.isArray(coords)) {
                return coords.length > 0 && coords.some(c => isValidCoord(c.lat, c.lon));
            }
            return isValidCoord(coords.lat, coords.lon);
        });

        console.log(`[GIS] Équipements avec coordonnées : ${equipmentsWithCoords.length}`);

        if (equipmentsWithCoords.length === 0) {
            console.warn('[GIS] Aucun équipement géolocalisé trouvé.');
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('⚠️ Aucun équipement géolocalisé trouvé.', 'warning');
            }
            refreshMapPointsTable();
            updateMapLegend();
            return;
        }

        const invalidCoordsTags = [];
        let renderedCount = 0;

        equipmentsWithCoords.forEach(eq => {
            let layerId = 'equipment';
            if (eq.type === 'pipeline_enterre' || eq.type === 'pipeline_offshore') {
                layerId = 'pipelines';
            } else if (eq.type === 'groundbed') {
                layerId = 'groundbeds';
            }
            
            if (!LayerManager.isVisible(layerId)) {
                return;
            }

            const coords = getEquipmentCoordinates(eq);
            if (!coords) {
                invalidCoordsTags.push(eq.tag || eq.id);
                return;
            }

            let layer;
            
            if (Array.isArray(coords) && coords.length > 1) {
                let latlngs = coords.map(c => [c.lat, c.lon]).filter(([lat, lon]) => isValidCoord(lat, lon));
                if (latlngs.length < 2) return;
                if (latlngs.length > 100) {
                    const step = Math.ceil(latlngs.length / 100);
                    latlngs = latlngs.filter((_, i) => i % step === 0);
                }
                const projectColor = getProjectColor(eq.projectId);
                layer = L.polyline(latlngs, {
                    color: projectColor,
                    weight: 3,
                    opacity: 0.8
                });
                const len = CoordSystem.pipelineLength ? CoordSystem.pipelineLength(coords) : '?';
                layer.bindPopup(() => {
                    const projColor = getProjectColor(eq.projectId);
                    return `<div style="border-left:4px solid ${projColor}; padding-left:8px;">
                        <strong>${Utils.escapeHtml(eq.tag)}</strong><br>
                        Type: ${Utils.escapeHtml(eq.type)}<br>
                        Projet: <span style="color:${projColor}; font-weight:bold;">${eq.projectId}</span><br>
                        Longueur: ${typeof len === 'number' ? len.toFixed(1) : len} m<br>
                        Surface: ${eq.surface || 0} m²
                    </div>`;
                });
                renderedCount++;
            } else if (coords.length === 1 && coords[0].lat !== undefined && coords[0].lon !== undefined) {
                const p = coords[0];
                if (!isValidCoord(p.lat, p.lon)) return;
                layer = L.marker([p.lat, p.lon], {
                    title: eq.tag,
                    icon: getMarkerIcon(eq)
                });
                const projectColor = getProjectColor(eq.projectId);
                layer.bindPopup(() => {
                    const technical = eq.technicalCharacteristics || {};
                    const state = (typeof ProjectManager !== 'undefined' && ProjectManager.getState)
                        ? ProjectManager.getState() : {};
                    const iccp = state.iccp || {};
                    const selected = iccp.transformerRectifierSelection?.selected || {};
                    const requirements = iccp.calculatedRequirements || {};
                    const value = (primary, fallback) => primary !== undefined && primary !== null && primary !== ''
                        ? primary : fallback;
                    const line = (label, content, unit) => {
                        if (content === undefined || content === null || content === '') return '';
                        const rendered = typeof content === 'number' ? content.toFixed(3) : String(content);
                        return `<div><strong>${Utils.escapeHtml(label)}:</strong> ${Utils.escapeHtml(rendered)}${unit ? ` ${unit}` : ''}</div>`;
                    };
                    const manufacturer = value(eq.manufacturer, selected.manufacturer);
                    const model = value(eq.model, selected.model || selected.id);
                    const nominalCurrent = value(eq.nominalCurrent, selected.nominalCurrent);
                    const nominalVoltage = value(eq.nominalVoltage, selected.nominalVoltage);
                    const nominalPower = value(eq.nominalPower, selected.nominalPower);
                    const groundbedResults = eq.results || {};
                    const groundbedParameters = eq.parameters || {};
                    const groundbedDetails = [
                        line('Résistance totale', groundbedResults.R_total, 'Ω', 4),
                        line('Résistance groupe anodes', groundbedResults.R_group, 'Ω', 4),
                        line('Résistance puits', groundbedResults.R_well, 'Ω', 4),
                        line('Résistance Groundbed pure', groundbedResults.R_groundbed_pure, 'Ω', 4),
                        line('Résistance câble', groundbedResults.R_cable, 'Ω', 4),
                        line('Résistance structure', groundbedResults.R_struct, 'Ω', 4),
                        line('Courant total', groundbedResults.I_total, 'A', 3),
                        line('Tension redresseur', groundbedResults.V_rectifier, 'V', 2),
                        line('Puissance redresseur', groundbedResults.P_rectifier, 'W', 2),
                        line('Nombre d’anodes', value(groundbedResults.anodeCount, groundbedParameters.anodeCount), null, 0),
                        line('Anodes requises', groundbedResults.requiredAnodeCount, null, 0),
                        line('Densité anodique', groundbedResults.J_anode_mA, 'mA/m²', 3),
                        line('Limite de densité', groundbedResults.densityLimit, 'A/m²', 3),
                        line('Durée de vie', value(groundbedResults.lifeWithSafety, groundbedResults.lifeDesign), 'ans', 2),
                        line('Durée demandée', value(groundbedResults.desiredLife, groundbedParameters.desiredLife), 'ans', 2),
                        line('Résistivité projet', value(groundbedResults.rhoProject, groundbedParameters.rhoProject), 'Ω·m', 2),
                        line('Résistivité Groundbed', value(groundbedResults.rhoGroundbed, groundbedParameters.rhoGroundbed || groundbedParameters.rho), 'Ω·m', 2),
                        line('Profondeur totale', value(groundbedResults.totalDepth, groundbedParameters.totalDepth), 'm', 2),
                        line('Profondeur active', value(groundbedResults.activeDepth, groundbedParameters.activeDepth), 'm', 2),
                        line('Espacement anodes', groundbedResults.spacing, 'm', 2),
                        line('Diamètre forage', groundbedResults.boreholeDiameter, 'mm', 1),
                        line('Longueur câble', groundbedParameters.cableLength, 'm', 1),
                        line('Section câble', groundbedParameters.cableSection, 'mm²', 1),
                        groundbedResults.groundbedModel ? line('Modèle Groundbed', groundbedResults.groundbedModel) : '',
                        groundbedResults.designStatus ? line('Statut conception', groundbedResults.designStatus) : '',
                        groundbedResults._warning ? line('Avertissement', groundbedResults._warning) : '',
                        groundbedResults.densityOk !== undefined ? line('Densité conforme', groundbedResults.densityOk ? 'Oui' : 'Non') : '',
                        groundbedResults.lifeOk !== undefined ? line('Durée de vie conforme', groundbedResults.lifeOk ? 'Oui' : 'Non') : ''
                    ].filter(Boolean).join('');
                    const technicalDetails = [
                        manufacturer && model ? `${manufacturer} - ${model}` : (model || manufacturer),
                        line('Courant nominal', nominalCurrent, 'A'),
                        line('Tension nominale', nominalVoltage, 'V'),
                        line('Puissance nominale', nominalPower, 'W'),
                        line('Courant requis calculé', requirements.current ?? iccp.rectifierCurrent, 'A'),
                        line('Tension requise TR', requirements.voltage ?? iccp.rectifierVoltage, 'V'),
                        line('Puissance de conception', requirements.power ?? iccp.powerDesign, 'W'),
                        line('Tension initiale', iccp.voltage, 'V'),
                        line('Tension fin de vie', iccp.voltageFinal, 'V'),
                        line('Résistance Groundbed', iccp.groundbedResistance, 'Ω'),
                        line('Courant ICCP sélectionné', iccp.selectedCurrent ?? iccp.current, 'A'),
                        line('Marge de courant', iccp.currentMarginPercent, '%'),
                        iccp.iccpSourceLabel ? line('Source du courant', iccp.iccpSourceLabel) : '',
                        technical.supplyVoltage ? line('Alimentation AC', technical.supplyVoltage) : '',
                        technical.phases ? line('Phases', technical.phases) : '',
                        technical.frequencyHz ? line('Fréquence', technical.frequencyHz, 'Hz') : '',
                        technical.technology ? line('Technologie', technical.technology) : '',
                        technical.regulation ? line('Régulation', technical.regulation) : '',
                        technical.cooling ? line('Refroidissement', technical.cooling) : '',
                        technical.enclosureProtection ? line('Indice de protection', technical.enclosureProtection) : ''
                    ].filter(Boolean).join('');
                    const popupDetails = eq.type === 'groundbed' ? groundbedDetails : technicalDetails;
                    const popupTitle = eq.type === 'groundbed'
                        ? 'Caractéristiques Groundbed et ICCP'
                        : 'Caractéristiques TR et ICCP';
                    return `<div style="border-left:4px solid ${projectColor}; padding-left:8px; min-width:250px;">
                        <strong>${Utils.escapeHtml(eq.tag)}</strong><br>
                        Type: ${Utils.escapeHtml(eq.type)}<br>
                        Projet: <span style="color:${projectColor}; font-weight:bold;">${eq.projectId}</span><br>
                        Lat: ${formatCoord(p.lat)}<br>
                        Lon: ${formatCoord(p.lon)}<br>
                        Surface: ${eq.surface || 0} m²
                        ${(eq.type === 'rectifier' || eq.type === 'groundbed') && popupDetails ? `<hr><strong>${popupTitle}</strong>${popupDetails}` : ''}
                    </div>`;
                });
                renderedCount++;
            } else if (coords.lat !== undefined && coords.lon !== undefined) {
                if (!isValidCoord(coords.lat, coords.lon)) return;
                layer = L.marker([coords.lat, coords.lon], {
                    title: eq.tag,
                    icon: getMarkerIcon(eq)
                });
                const projectColor = getProjectColor(eq.projectId);
                layer.bindPopup(() => {
                    return `<div style="border-left:4px solid ${projectColor}; padding-left:8px;">
                        <strong>${Utils.escapeHtml(eq.tag)}</strong><br>
                        Type: ${Utils.escapeHtml(eq.type)}<br>
                        Projet: <span style="color:${projectColor}; font-weight:bold;">${eq.projectId}</span><br>
                        Lat: ${formatCoord(coords.lat)}<br>
                        Lon: ${formatCoord(coords.lon)}<br>
                        Surface: ${eq.surface || 0} m²
                    </div>`;
                });
                renderedCount++;
            } else {
                return;
            }

            if (layer) {
                try {
                    _clusterGroup.addLayer(layer);
                    _markers.push(layer);
                    _equipmentMarkers[eq.id] = layer;
                } catch (e) {
                    console.warn('[GIS] Erreur ajout marqueur pour', eq.tag, e.message);
                }
            }
        });

        console.log(`[GIS] Rendu terminé : ${renderedCount} marqueurs créés sur ${equipmentsWithCoords.length} équipements`);

        if (invalidCoordsTags.length > 0) {
            const uniqueTags = [...new Set(invalidCoordsTags)];
            if (uniqueTags.length <= 5) {
                console.warn(`[GIS] Équipements sans coordonnées valides: ${uniqueTags.join(', ')}`);
            } else {
                console.warn(`[GIS] ${invalidCoordsTags.length} équipements sans coordonnées valides.`);
            }
        }

        // GROUNDBEDS
        if (LayerManager.isVisible('groundbeds')) {
            const groundbeds = ProjectManager.getGroundbeds();
            const filterProjectId = FilterManager.getFilter('projectId');
            const isAllProjects = (filterProjectId === null || filterProjectId === undefined || filterProjectId === '__all__');
            
            let filteredGroundbeds = [];
            if (isAllProjects) {
                filteredGroundbeds = groundbeds;
            } else {
                filteredGroundbeds = groundbeds.filter(gb => gb.projectId === filterProjectId);
            }

            filteredGroundbeds.forEach(gb => {
                const coords = gb.coordinates;
                if (!coords) return;
                let lat, lon;
                if (Array.isArray(coords) && coords.length > 0) {
                    lat = coords[0].lat;
                    lon = coords[0].lon;
                } else if (coords.lat !== undefined) {
                    lat = coords.lat;
                    lon = coords.lon;
                } else return;
                if (!isValidCoord(lat, lon)) return;
                
                const color = getProjectColor(gb.projectId);
                const icon = L.divIcon({
                    className: 'custom-marker',
                    html: `<div style="background:${color}; width:14px; height:14px; border-radius:50%; border:2px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.3);"></div>`,
                    iconSize: [14, 14],
                    iconAnchor: [7, 7]
                });
                const marker = L.marker([lat, lon], {
                    title: gb.name,
                    icon: icon
                });
                marker.bindPopup(() => {
                    const results = gb.results || {};
                    const parameters = gb.parameters || {};
                    const state = (typeof ProjectManager !== 'undefined' && ProjectManager.getState)
                        ? ProjectManager.getState() : {};
                    const iccp = state.iccp || {};
                    const value = (primary, fallback) => primary !== undefined && primary !== null && primary !== ''
                        ? primary : fallback;
                    const line = (label, content, unit, decimals) => {
                        if (content === undefined || content === null || content === '') return '';
                        const number = Number(content);
                        const rendered = Number.isFinite(number)
                            ? number.toFixed(decimals === undefined ? 3 : decimals)
                            : String(content);
                        return `<div><strong>${Utils.escapeHtml(label)}:</strong> ${Utils.escapeHtml(rendered)}${unit ? ` ${unit}` : ''}</div>`;
                    };
                    const currentSource = results.targetCurrentLabel ||
                        results.targetCurrentSource || iccp.iccpSourceLabel;
                    const model = results.groundbedModel || iccp.groundbedModel;
                    const status = results.designStatus || iccp.groundbedDesignStatus;
                    const technicalDetails = [
                        line('Résistance totale', results.R_total, 'Ω', 4),
                        line('Résistance groupe anodes', results.R_group, 'Ω', 4),
                        line('Résistance puits', results.R_well, 'Ω', 4),
                        line('Résistance Groundbed pure', results.R_groundbed_pure, 'Ω', 4),
                        line('Résistance câble', results.R_cable, 'Ω', 4),
                        line('Résistance structure', results.R_struct, 'Ω', 4),
                        line('Courant total', results.I_total, 'A', 3),
                        line('Tension redresseur', results.V_rectifier, 'V', 2),
                        line('Puissance redresseur', results.P_rectifier, 'W', 2),
                        line('Nombre d’anodes', value(results.anodeCount, parameters.anodeCount), null, 0),
                        line('Anodes requises', results.requiredAnodeCount, null, 0),
                        line('Densité anodique', results.J_anode_mA, 'mA/m²', 3),
                        line('Limite de densité', results.densityLimit, 'A/m²', 3),
                        line('Durée de vie', value(results.lifeWithSafety, results.lifeDesign), 'ans', 2),
                        line('Durée de vie demandée', value(results.desiredLife, parameters.desiredLife), 'ans', 2),
                        line('Résistivité projet', value(results.rhoProject, parameters.rhoProject), 'Ω·m', 2),
                        line('Résistivité Groundbed', value(results.rhoGroundbed, parameters.rhoGroundbed || parameters.rho), 'Ω·m', 2),
                        line('Profondeur totale', parameters.totalDepth, 'm', 2),
                        line('Profondeur active', parameters.activeDepth, 'm', 2),
                        line('Longueur d’anode', parameters.anodeLength, 'm', 2),
                        line('Diamètre d’anode', parameters.anodeDiameter, 'mm', 1),
                        line('Longueur câble', parameters.cableLength, 'm', 1),
                        line('Section câble', parameters.cableSection, 'mm²', 1),
                        currentSource ? line('Source du courant cible', currentSource) : '',
                        model ? line('Modèle Groundbed', model) : '',
                        status ? line('Statut de conception', status) : '',
                        results.densityOk !== undefined ? line('Densité conforme', results.densityOk ? 'Oui' : 'Non') : '',
                        results.lifeOk !== undefined ? line('Durée de vie conforme', results.lifeOk ? 'Oui' : 'Non') : ''
                    ].filter(Boolean).join('');
                    return `<div style="border-left:4px solid ${color}; padding-left:8px; min-width:270px;">
                        <strong>${Utils.escapeHtml(gb.name)}</strong><br>
                        Type: Groundbed / puits anodique<br>
                        Projet: <span style="color:${color}; font-weight:bold;">${gb.projectId}</span><br>
                        Lat: ${formatCoord(lat)}<br>
                        Lon: ${formatCoord(lon)}<br>
                        <hr><strong>Caractéristiques Groundbed et ICCP</strong>
                        ${technicalDetails || '<div>Données de calcul indisponibles</div>'}
                    </div>`;
                });
                try {
                    _clusterGroup.addLayer(marker);
                    _markers.push(marker);
                } catch (e) {}
            });
        }

        const hasVisible = _markers.length > 0;
        if (fitBounds && hasVisible) {
            try {
                const bounds = _clusterGroup.getBounds();
                if (bounds.isValid()) {
                    _mapInstance.fitBounds(bounds, { padding: [20, 20], maxZoom: 14 });
                }
            } catch (e) {}
        } else if (!hasVisible) {
            const ref = CoordSystem.getReference ? CoordSystem.getReference() : { lat: 30.123456, lon: 8.123456 };
            _mapInstance.setView([ref.lat, ref.lon], 5);
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('⚠️ Aucun équipement visible. Vérifiez les filtres ou les layers.', 'warning');
            }
        }

        refreshMapPointsTable();
        updateMapLegend();
    }

    // === MISE À JOUR DE LA LÉGENDE ===
    function updateMapLegend() {
        const legendContainer = document.querySelector('.marker-legend');
        if (!legendContainer) return;
        
        const projectIds = new Set();
        _markers.forEach(marker => {
            if (marker._eqId) {
                const eq = ProjectManager.getState().equipments.find(e => e.id === marker._eqId);
                if (eq && eq.projectId) projectIds.add(eq.projectId);
            }
        });
        
        let html = '';
        projectIds.forEach(projId => {
            const color = getProjectColor(projId);
            html += `<div class="marker-legend-item">
                <span style="display:inline-block; width:20px; height:4px; background:${color}; border-radius:2px;"></span>
                <span class="project-id" style="color:${color};">${projId}</span>
            </div>`;
        });
        
        if (html) {
            legendContainer.innerHTML = html;
        }
    }

    // === LOAD POINTS ===
    function loadPoints(projectId, fitBounds) {
        if (!isModuleVisible()) {
            console.warn('[GIS] Module Cartographie non visible, chargement des points abandonné.');
            return Promise.resolve();
        }

        if (!_mapInstance || !_isMapInitialized) {
            const result = initMap();
            if (!result) {
                console.warn('[GIS] Impossible d\'initialiser la carte');
                return Promise.resolve();
            }
        }

        try {
            _mapInstance.invalidateSize();
        } catch (e) {
            console.warn('[GIS] Erreur invalidateSize:', e.message);
        }

        let effectiveProjectId = projectId;
        if (projectId === undefined) {
            const filterProjectId = FilterManager.getFilter('projectId');
            if (filterProjectId !== null && filterProjectId !== undefined) {
                effectiveProjectId = filterProjectId;
            } else {
                effectiveProjectId = ProjectManager.getCurrentProjectId();
            }
        }

        FilterManager.setFilter('projectId', effectiveProjectId);
        _currentProjectId = effectiveProjectId;

        const currentVersion = ++_loadVersion;

        if (_loadTimeout) {
            clearTimeout(_loadTimeout);
            _loadTimeout = null;
        }

        return new Promise((resolve) => {
            _loadTimeout = setTimeout(() => {
                if (currentVersion !== _loadVersion) {
                    resolve();
                    _loadTimeout = null;
                    return;
                }
                refreshMap(fitBounds);
                setTimeout(() => {
                    try {
                        if (_mapInstance) {
                            _mapInstance.invalidateSize();
                            if (fitBounds && _markers.length > 0) {
                                const bounds = _clusterGroup.getBounds();
                                if (bounds.isValid()) {
                                    _mapInstance.fitBounds(bounds, { padding: [20, 20], maxZoom: 14 });
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('[GIS] Erreur lors du centrage:', e.message);
                    }
                    resolve();
                    _loadTimeout = null;
                }, 300);
            }, 50);
        });
    }

    // === CHANGEMENT DE FOND DE CARTE ===
    function changeBaseMap(tile) {
        if (!_mapInstance) return;
        if (_baseLayer) {
            _mapInstance.removeLayer(_baseLayer);
        }
        let layer;
        switch (tile) {
            case 'satellite':
                layer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                    maxZoom: 19,
                    attribution: '© Esri'
                });
                break;
            case 'terrain':
                layer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
                    maxZoom: 17,
                    attribution: '© OpenTopoMap'
                });
                break;
            default:
                layer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '© OpenStreetMap contributors'
                });
        }
        layer.addTo(_mapInstance);
        _baseLayer = layer;
    }

    // === GESTION DES MARQUEURS D'ÉQUIPEMENT ===
    function updateEquipmentMarker(equipment) {
        if (!_mapInstance) return;
        refreshMap(false);
    }

    function removeEquipmentMarker(equipmentId) {
        if (!_mapInstance) return;
        refreshMap(false);
    }

    // === AJOUT D'UN POINT ===
    function addPoint(type, name, lat, lon) {
        if (!_mapInstance) {
            console.warn('Carte non initialisée');
            return null;
        }
        if (!name || !name.trim()) {
            console.warn('Nom requis');
            return null;
        }
        if (!isValidCoord(lat, lon)) {
            if (window.UI && typeof window.UI.showToast === 'function') {
                window.UI.showToast('⚠️ Coordonnées invalides.', 'warning');
            }
            return null;
        }
        const projectId = ProjectManager.getCurrentProjectId();
        if (!projectId) {
            console.warn('Aucun projet actif');
            return null;
        }

        const equipmentData = {
            tag: name.trim(),
            type: type || 'other',
            surface: 0,
            projectId: projectId,
            dimensions: {},
            included: true,
            systemId: null,
            coordinates: { lat: parseFloat(lat), lon: parseFloat(lon), alt: null },
            material: 'acier',
            wallThickness: 8.0,
            coatingType: '3LPE',
            coatingCondition: 'neuf',
            coatingThickness: 0,
            soilResistivity: 0
        };

        if (window.CPController && typeof window.CPController.addEquipment === 'function') {
            return window.CPController.addEquipment(equipmentData);
        } else if (window.ProjectManager && typeof window.ProjectManager.addEquipmentDirect === 'function') {
            return window.ProjectManager.addEquipmentDirect(equipmentData);
        } else {
            console.error('Aucune méthode d\'ajout d\'équipement disponible');
            return null;
        }
    }

    function removePoint(pointId) {
        if (!pointId) {
            console.warn('[GIS] removePoint: ID de point manquant');
            return;
        }
        const state = ProjectManager.getState();
        const equipment = state.equipments.find(eq => eq.id === pointId);
        if (!equipment) {
            console.warn(`[GIS] removePoint: Équipement ${pointId} introuvable.`);
            removeEquipmentMarker(pointId);
            refreshMapPointsTable();
            return;
        }
        if (window.CPController && typeof window.CPController.deleteEquipment === 'function') {
            return window.CPController.deleteEquipment(pointId)
                .then(() => {
                    removeEquipmentMarker(pointId);
                    refreshMapPointsTable();
                    if (window.UI && typeof window.UI.showToast === 'function') {
                        window.UI.showToast(`✅ Équipement ${Utils.escapeHtml(equipment.tag)} supprimé`, 'success');
                    }
                })
                .catch((error) => {
                    console.error('[GIS] Erreur lors de la suppression:', error);
                    if (window.UI && typeof window.UI.showToast === 'function') {
                        window.UI.showToast(`❌ Erreur lors de la suppression: ${error.message}`, 'error');
                    }
                });
        } else {
            console.error('CPController.deleteEquipment non disponible');
            return null;
        }
    }

    // === RAFRAÎCHISSEMENT DU TABLEAU DES POINTS ===
    function refreshMapPointsTable() {
        let refreshTimeout = null;
        if (refreshTimeout) {
            clearTimeout(refreshTimeout);
            refreshTimeout = null;
        }
        refreshTimeout = setTimeout(async () => {
            const tbody = document.getElementById('mapPointsTableBody');
            if (!tbody) { refreshTimeout = null; return; }

            const filterProjectId = FilterManager.getFilter('projectId');
            const isAllProjects = (filterProjectId === null || filterProjectId === undefined || filterProjectId === '__all__');
            
            let equipments = [];
            
            if (isAllProjects) {
                const projects = ProjectManager.getProjectsList();
                const loadPromises = projects.map(async (project) => {
                    try {
                        return await StorageManager.loadEquipmentsForProject(project.id, true);
                    } catch (err) {
                        console.warn(`[UI] Erreur chargement projet ${project.id}:`, err);
                        return [];
                    }
                });
                const results = await Promise.all(loadPromises);
                equipments = results.flat();
                console.log(`[UI] Tableau: ${equipments.length} équipements chargés depuis IndexedDB (tous projets)`);
            } else {
                const state = ProjectManager.getState();
                equipments = state.equipments.filter(eq => eq.projectId === filterProjectId);
            }
            
            const withCoords = equipments.filter(eq => {
                const coords = getEquipmentCoordinates(eq);
                if (!coords) return false;
                if (Array.isArray(coords)) {
                    return coords.length > 0 && coords.every(c => isValidCoord(c.lat, c.lon));
                }
                return isValidCoord(coords.lat, coords.lon);
            });

            const filtered = FilterManager.apply(withCoords);

            tbody.innerHTML = '';
            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7">Aucun équipement géoréférencé correspondant aux filtres.</td></tr>';
                refreshTimeout = null;
                return;
            }

            const fragment = document.createDocumentFragment();
            filtered.forEach(eq => {
                const coords = getEquipmentCoordinates(eq);
                let latStr = '', lonStr = '', altStr = '';
                let coordDisplay = '';
                const projectColor = getProjectColor(eq.projectId);

                if (Array.isArray(coords) && coords.length > 1) {
                    const first = coords[0];
                    const last = coords[coords.length - 1];
                    latStr = `${formatCoord(first.lat)} → ${formatCoord(last.lat)}`;
                    lonStr = `${formatCoord(first.lon)} → ${formatCoord(last.lon)}`;
                    altStr = `${formatCoord(first.alt, 1)} → ${formatCoord(last.alt, 1)}`;
                    coordDisplay = `<span style="color:${projectColor};" title="Tracé de ${coords.length} points">${Utils.escapeHtml(latStr)} / ${Utils.escapeHtml(lonStr)}</span>`;
                } else if (Array.isArray(coords) && coords.length === 1) {
                    const p = coords[0];
                    latStr = formatCoord(p.lat);
                    lonStr = formatCoord(p.lon);
                    altStr = formatCoord(p.alt, 1);
                    coordDisplay = `<span style="color:${projectColor};">${latStr}, ${lonStr}</span>`;
                } else if (coords && coords.lat !== undefined) {
                    latStr = formatCoord(coords.lat);
                    lonStr = formatCoord(coords.lon);
                    altStr = formatCoord(coords.alt, 1);
                    coordDisplay = `<span style="color:${projectColor};">${latStr}, ${lonStr}</span>`;
                } else {
                    coordDisplay = '—';
                }

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><span style="color:${projectColor}; font-weight:600;">${Utils.escapeHtml(eq.tag)}</span></td>
                    <td>${Utils.escapeHtml(eq.type)}</td>
                    <td><span style="color:${projectColor}; font-weight:600;">${Utils.escapeHtml(eq.projectId)}</span></td>
                    <td>${coordDisplay}</td>
                    <td style="font-size:0.7rem; color:var(--text-muted);">${Array.isArray(coords) && coords.length > 1 ? '🔹 ' + coords.length + ' points' : 'Point unique'}</td>
                    <td>${altStr}</td>
                    <td>
                        <button class="btn btn-sm btn-info edit-equip-point" data-id="${eq.id}">Modifier</button>
                        <button class="btn btn-sm btn-danger delete-equip-point" data-id="${eq.id}">Supprimer</button>
                    </td>
                `;
                fragment.appendChild(tr);
            });
            tbody.appendChild(fragment);

            tbody.querySelectorAll('.edit-equip-point').forEach(btn => {
                btn.addEventListener('click', function() {
                    const id = this.dataset.id;
                    if (window.UI && typeof window.UI.editEquipment === 'function') {
                        window.UI.editEquipment(id);
                        document.querySelector('.nav-item[data-module="equipements"]')?.click();
                    }
                });
            });
            tbody.querySelectorAll('.delete-equip-point').forEach(btn => {
                btn.addEventListener('click', function() {
                    if (confirm('Supprimer cet équipement ?')) {
                        const id = this.dataset.id;
                        removePoint(id);
                    }
                });
            });
            refreshTimeout = null;
        }, 200);
    }

    // === EXPORT GeoJSON ===
    function exportGeoJSON() {
        const state = ProjectManager.getState();
        const filterProjectId = FilterManager.getFilter('projectId');
        let equipments = [];
        const isAllProjects = (filterProjectId === null || filterProjectId === undefined || filterProjectId === '__all__');
        
        if (isAllProjects) {
            equipments = state.equipments;
        } else {
            equipments = state.equipments.filter(eq => eq.projectId === filterProjectId);
        }
        
        const filtered = FilterManager.apply(equipments);
        const withCoords = filtered.filter(eq => getEquipmentCoordinates(eq) !== null);

        if (withCoords.length === 0) {
            console.warn('Aucun équipement géoréférencé');
            return null;
        }

        const features = withCoords.map(eq => {
            const coords = getEquipmentCoordinates(eq);
            let geometry;
            if (Array.isArray(coords)) {
                geometry = {
                    type: 'LineString',
                    coordinates: coords.filter(c => isValidCoord(c.lat, c.lon)).map(c => [c.lon, c.lat])
                };
            } else {
                geometry = { type: 'Point', coordinates: [coords.lon, coords.lat] };
            }
            return {
                type: 'Feature',
                geometry: geometry,
                properties: {
                    id: eq.id,
                    tag: eq.tag,
                    type: eq.type,
                    surface: eq.surface,
                    dimensions: eq.dimensions,
                    systemId: eq.systemId,
                    included: eq.included,
                    projectId: eq.projectId,
                    projectColor: getProjectColor(eq.projectId)
                }
            };
        });
        return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
    }

    // === CLEANUP ===
    function cleanup() {
        if (_mapInstance) {
            try {
                _mapInstance.remove();
            } catch (e) {
                console.warn('[GIS] Erreur lors du nettoyage:', e.message);
            }
            _mapInstance = null;
            _isMapInitialized = false;
            _clusterGroup = null;
            _markers = [];
            _equipmentMarkers = {};
        }
        if (_mapContainer) {
            _mapContainer.innerHTML = '';
        }
        console.log('[GIS] Nettoyage effectué');
    }

    // === API PUBLIQUE ===
    const GisIntegration = {
        // Version du module GIS (cycle de vie indépendant)
        VERSION: '8.24.0',
        init: function() { return initMap(); },
        ensureMap: function() {
            if (_mapInstance && _isMapInitialized) return Promise.resolve(_mapInstance);
            return new Promise((resolve) => {
                const result = initMap();
                resolve(result);
            });
        },
        destroy: function() {
            cleanup();
        },
        waitForMap: function(maxWait) {
            return new Promise((resolve) => {
                if (_mapInstance && _isMapInitialized) {
                    resolve(_mapInstance);
                    return;
                }
                const startTime = Date.now();
                const checkInterval = setInterval(() => {
                    if (_mapInstance && _isMapInitialized) {
                        clearInterval(checkInterval);
                        resolve(_mapInstance);
                        return;
                    }
                    if (Date.now() - startTime > (maxWait || 5000)) {
                        clearInterval(checkInterval);
                        const result = initMap();
                        resolve(result);
                    }
                }, 200);
            });
        },
        loadPoints: function(projectId, fitBounds) {
            return loadPoints(projectId, fitBounds !== undefined ? fitBounds : true);
        },
        refreshMap: function(fitBounds) {
            refreshMap(fitBounds || false);
        },
        refreshMapPointsWithoutRecenter: function(projectId) {
            loadPoints(projectId || _currentProjectId, false);
        },
        addPoint: function(type, name, lat, lon) { return addPoint(type, name, lat, lon); },
        removePoint: function(pointId) { removePoint(pointId); },
        updateEquipmentMarker: function(equipment) { updateEquipmentMarker(equipment); },
        removeEquipmentMarker: function(equipmentId) { removeEquipmentMarker(equipmentId); },
        refreshMapPointsTable: function() { refreshMapPointsTable(); },
        syncWith3D: function() {
            if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                window.Gis3D.loadData();
            }
        },
        exportGeoJSON: function() { return exportGeoJSON(); },
        getMap: function() { return _mapInstance; },
        getMarkers: function() { return _markers; },
        invalidateCache: function(equipmentId) {
            if (equipmentId) {
                const state = ProjectManager.getState();
                const eq = state.equipments.find(e => e.id === equipmentId);
                if (eq) {
                    this.updateEquipmentMarker(eq);
                }
            }
        },
        changeBaseMap: function(tile) { changeBaseMap(tile); },
        _redirectToEquipmentFormWithCoords: function(lat, lon, alt) {
            const equipModule = document.querySelector('.nav-item[data-module="equipements"]');
            if (equipModule) {
                equipModule.click();
                setTimeout(() => {
                    const container = document.getElementById('equipWaypointsContainer');
                    if (container) {
                        container.innerHTML = '';
                        if (window.UI && typeof window.UI.addEquipWaypointRow === 'function') {
                            window.UI.addEquipWaypointRow(lat, lon, alt || null, false);
                        }
                        const tagField = document.getElementById('equipTag');
                        if (tagField) tagField.focus();
                    }
                }, 300);
            }
        },
        getProjectColor: getProjectColor,
        isModuleVisible: isModuleVisible,
        getFilterManager: function() { return FilterManager; },
        cleanup: cleanup,

        measure: {
            enable: function() { MeasureTool.enable(); },
            disable: function() { MeasureTool.disable(); },
            finish: function() { MeasureTool.finish(); },
            isEnabled: function() { return MeasureTool.isEnabled(); },
            onComplete: function(callback) { MeasureTool.onComplete(callback); }
        },

        filters: {
            set: function(key, value) { FilterManager.setFilter(key, value); },
            get: function(key) { return FilterManager.getFilter(key); },
            reset: function() { FilterManager.reset(); }
        },

        layers: {
            toggle: function(layerId, visible) { LayerManager.toggle(layerId, visible); },
            isVisible: function(layerId) { return LayerManager.isVisible(layerId); },
            getLayers: function() { return LayerManager.getLayers(); }
        },

        search: function(query) {
            const state = ProjectManager.getState();
            const filterProjectId = FilterManager.getFilter('projectId');
            let equipments = [];
            const isAllProjects = (filterProjectId === null || filterProjectId === undefined || filterProjectId === '__all__');
            
            if (isAllProjects) {
                equipments = state.equipments;
            } else {
                equipments = state.equipments.filter(eq => eq.projectId === filterProjectId);
            }
            return SearchManager.search(query, equipments);
        },
        setSearchCallback: function(callback) { SearchManager.setCallback(callback); },
        getSearchResults: function() { return SearchManager.getResults(); }
    };

    // ============================================================
    // 27. EXPOSITION GLOBALE
    // ============================================================
    window.GisIntegration = GisIntegration;
    window.FilterManager = FilterManager;

    window.getEquipmentCoordinates = getEquipmentCoordinates;
    window.isValidCoord = isValidCoord;
    window.isZeroCoord = isZeroCoord;
    window.formatCoord = formatCoord;
    window.getProjectColor = getProjectColor;
    window.removePoint = removePoint;

    // ============================================================
    // 28. ÉVÉNEMENTS — RÉDUITS POUR ÉVITER LES APPELS REDONDANTS
    // ============================================================

    // DOMContentLoaded : NE PAS initialiser automatiquement
    // La carte sera initialisée à la première navigation vers le module
    document.addEventListener('DOMContentLoaded', function() {
        console.log('[GIS] Prêt, en attente de l\'activation du module Cartographie');
    });

    // moduleChanged : initialisation UNIQUEMENT si le module devient actif
    document.addEventListener('moduleChanged', function(e) {
        const moduleId = e.detail?.moduleId;
        if (moduleId === 'cartography') {
            console.log('[GIS] Module Cartographie activé, initialisation...');
            // Vérifier si la carte existe déjà
            if (_mapInstance && _isMapInitialized) {
                try {
                    const size = _mapInstance.getSize();
                    if (size.x > 0 && size.y > 0) {
                        console.log('[GIS] Carte existante réutilisée');
                        setTimeout(() => {
                            _mapInstance.invalidateSize();
                            loadPoints(FilterManager.getFilter('projectId'));
                        }, 200);
                        return;
                    }
                } catch (err) {
                    console.warn('[GIS] Carte existante invalide, réinitialisation');
                    _mapInstance = null;
                    _isMapInitialized = false;
                }
            }
            
            setTimeout(() => {
                const result = initMap();
                if (result) {
                    setTimeout(() => {
                        loadPoints(FilterManager.getFilter('projectId'));
                    }, 200);
                }
            }, 300);
        }
    });

    // MutationObserver : surveiller l'activation du module
    const moduleObserver = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                const target = mutation.target;
                if (target.id === 'module-cartography') {
                    if (target.classList.contains('active')) {
                        if (_mapInstance && _isMapInitialized) {
                            try {
                                const size = _mapInstance.getSize();
                                if (size.x > 0 && size.y > 0) {
                                    console.log('[GIS] Module Cartographie actif - carte réutilisée');
                                    setTimeout(() => {
                                        _mapInstance.invalidateSize();
                                        loadPoints(FilterManager.getFilter('projectId'));
                                    }, 200);
                                    return;
                                }
                            } catch (e) {
                                console.warn('[GIS] Carte existante invalide, réinitialisation');
                                _mapInstance = null;
                                _isMapInitialized = false;
                            }
                        }
                        
                        console.log('[GIS] Module Cartographie actif (MutationObserver), initialisation...');
                        setTimeout(() => {
                            const result = initMap();
                            if (result) {
                                setTimeout(() => {
                                    loadPoints(FilterManager.getFilter('projectId'));
                                }, 200);
                            }
                        }, 300);
                    }
                }
            }
        });
    });

    document.addEventListener('DOMContentLoaded', function() {
        const moduleCarto = document.getElementById('module-cartography');
        if (moduleCarto) {
            moduleObserver.observe(moduleCarto, { attributes: true, attributeFilter: ['class'] });
        }
    });

    // projectLoaded : mettre à jour les données, PAS recréer la carte
    document.addEventListener('projectLoaded', function(e) {
        const projectId = e.detail?.projectId;
        if (projectId) {
            const moduleCarto = document.getElementById('module-cartography');
            if (moduleCarto && moduleCarto.classList.contains('active')) {
                if (_mapInstance && _isMapInitialized) {
                    setTimeout(() => {
                        loadPoints(projectId, true);
                    }, 300);
                } else {
                    setTimeout(() => {
                        const result = initMap();
                        if (result) {
                            setTimeout(() => {
                                loadPoints(projectId, true);
                            }, 200);
                        }
                    }, 300);
                }
            }
        }
    });

    // filterChanged : mettre à jour les données, PAS recréer la carte
    document.addEventListener('filterChanged', function(e) {
        const moduleCarto = document.getElementById('module-cartography');
        if (moduleCarto && moduleCarto.classList.contains('active')) {
            if (_mapInstance && _isMapInitialized) {
                refreshMap(true);
            }
        }
    });

    // layerToggled : rafraîchir les layers
    document.addEventListener('layerToggled', function() {
        const moduleCarto = document.getElementById('module-cartography');
        if (moduleCarto && moduleCarto.classList.contains('active')) {
            if (_mapInstance && _isMapInitialized) {
                refreshMap(false);
            }
        }
    });

    // equipmentUpdated : mettre à jour les marqueurs
    document.addEventListener('equipmentUpdated', function(e) {
        const moduleCarto = document.getElementById('module-cartography');
        if (moduleCarto && moduleCarto.classList.contains('active')) {
            if (_mapInstance && _isMapInitialized) {
                refreshMap(false);
            }
        }
    });

    // dataSynced : rafraîchir les données
    document.addEventListener('dataSynced', function() {
        const moduleCarto = document.getElementById('module-cartography');
        if (moduleCarto && moduleCarto.classList.contains('active')) {
            if (_mapInstance && _isMapInitialized) {
                refreshMap(false);
            }
        }
    });

    console.log('[GIS] Module GIS v8.24 chargé - CORRECTION DÉFINITIVE : Idempotence garantie, une seule instance Leaflet.');
})();