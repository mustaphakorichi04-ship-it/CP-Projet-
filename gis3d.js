// ============================================================
// gis3d.js – CP Engineer Pro – Visualisation 3D (VERSION CORRIGÉE - DIAMÈTRE PIPELINE)
// VERSION 15.6 – CORRECTIONS :
//   - NaN dans CylinderGeometry (groundbedVisualDepthScale ajouté)
//   - Mini-carte : retry + DOM ready check
//   - disableConcurrentModules : exécution unique
//   - fitView : guard renforcé contre Box3 vide
// ============================================================

(function() {
    'use strict';

    // ============================================================
    // CONFIGURATION RÉALISTE (ÉCHELLE 1:1)
    // ============================================================
    const CONFIG = {
        containerId: 'threeContainer',
        miniMapId: 'miniMap',
        miniMapDefaultZoom: 10,

        colors: {
            pipeline: 0x8ea0b5,
            pipelineBuried: 0x718096,
            pipelineAbove: 0x9aaabd,
            rectifier: 0xff0000,
            groundbed: 0xffff00,
            anode: 0xf5b942,
            cable: 0x2e8b57,
            testPost: 0xb87333,
            wellCasing: 0x52657a,
            generic: 0x94a3b8,
            selected: 0xef4444,
            glow: 0x38bdf8,
            marker: 0xf8fafc
        },

        sizes: {
            rectifierWidth: 0.35,
            rectifierHeight: 0.65,
            rectifierDepth: 0.25,
            groundbedRadius: 0.25,
            anodeRadius: 0.06,

            // ⚠️ AJOUT : échelles visuelles du puits (CORRECTIF NaN)
            groundbedVisualDepthScale: 0.5,
            groundbedMaxDepth: 20,
            groundbedMinDepth: 0.3,

            pipelineScale: 3.0,
            pipelineLengthFactor: 3.0,

            // Rayon fixe conservé pour compatibilité, mais sera remplacé par le calcul dynamique
            forcedPipelineRadius: 1.5,
            markerRadius: 0.0,

            particleCount: 180,
            particleSize: 0.16,
            particleSpeed: 0.18,
            particleJitter: 0.10,
            particleTrailLength: 0.28,
            particleColor: 0xffff00
        },

        // Facteur d'échelle visuel pour le diamètre des pipelines
        pipelineVisualRadiusScale: 1.5,

        LOAD_DEBOUNCE_MS: 300,

        emissiveIntensity: 0.5,
        metalness: 0.2,
        roughness: 0.3,

        ambientLightIntensity: 0.9,
        directionalLightIntensity: 1.2
    };

    // ============================================================
    // ÉTAT GLOBAL DU MODULE
    // ============================================================
    let _scene = null;
    let _camera = null;
    let _renderer = null;
    let _controls = null;

    let _isInitialized = false;
    let _isReady = false;
    let _readyCallbacks = [];

    let _sceneGroup = null;
    let _objects = {};
    let _objectMap = new Map();

    let _currentProjectId = null;
    let _allProjectsMode = false;
    let _systemFilter = null;

    let _renderLoopId = null;
    let _isLoading = false;
    let _pendingProjectId = null;
    let _loadVersion = 0;
    let _clipPlane = null;

    let _particleFluxes = [];
    let _electronTexture = null;

    // ⚠️ AJOUT : variables manquantes dans l'original
    let _miniMapInstance = null;
    let _miniMapInitialized = false;
    let _concurrentModulesDisabled = false;

    // ============================================================
    // FONCTIONS UTILITAIRES
    // ============================================================

    function safeNumber(v, d) {
        if (
            v === undefined ||
            v === null ||
            v === ''
        ) {
            return d;
        }

        const n = parseFloat(
            String(v)
                .trim()
                .replace(',', '.')
        );

        return isNaN(n) ? d : n;
    }

    function isValidCoord(lat, lon) {
        if (
            lat === undefined ||
            lon === undefined
        ) {
            return false;
        }

        const latNum = parseFloat(lat);
        const lonNum = parseFloat(lon);

        if (
            isNaN(latNum) ||
            isNaN(lonNum)
        ) {
            return false;
        }

        if (
            latNum < -90 ||
            latNum > 90
        ) {
            return false;
        }

        if (
            lonNum < -180 ||
            lonNum > 180
        ) {
            return false;
        }

        return true;
    }

    function isZeroCoord(lat, lon) {
        return (
            Math.abs(lat) < 1e-9 &&
            Math.abs(lon) < 1e-9
        );
    }

    function debounce(fn, delay) {
        let timeout;

        return function(...args) {
            clearTimeout(timeout);

            timeout = setTimeout(
                () => fn.apply(this, args),
                delay
            );
        };
    }

    function getLabelPosition(
        equipment,
        defaultPos,
        meshPos
    ) {
        if (
            equipment &&
            equipment.labelPosition
        ) {

            return new THREE.Vector3(
                safeNumber(
                    equipment.labelPosition.x,
                    0
                ),

                safeNumber(
                    equipment.labelPosition.y,
                    0
                ),

                safeNumber(
                    equipment.labelPosition.z,
                    0
                )
            );
        }

        return defaultPos;
    }

    function migrateLabelPositions(
        equipments,
        objects
    ) {
        let migratedCount = 0;

        for (
            const eq of equipments
        ) {

            if (
                eq.labelPosition &&
                !eq.labelPositionIsOffset
            ) {

                const group =
                    objects[eq.id];

                if (group) {

                    const objPos =
                        group.position;

                    const offset = {
                        x:
                            safeNumber(
                                eq.labelPosition.x,
                                0
                            ) - objPos.x,

                        y:
                            safeNumber(
                                eq.labelPosition.y,
                                0
                            ) - objPos.y,

                        z:
                            safeNumber(
                                eq.labelPosition.z,
                                0
                            ) - objPos.z
                    };

                    eq.labelPosition =
                        offset;

                    eq.labelPositionIsOffset =
                        true;

                    try {

                        StorageManager
                            .saveEquipment(eq);

                    } catch (error) {

                        console.warn(
                            '[Gis3D] Impossible de sauvegarder la position du label:',
                            error
                        );
                    }

                    migratedCount++;
                }
            }
        }

        if (
            migratedCount > 0
        ) {

            console.log(
                `[Gis3D] Migration de ${migratedCount} étiquette(s) de position absolue → offset.`
            );

            try {

                ProjectManager
                    .saveCurrentProject();

            } catch (error) {

                console.warn(
                    '[Gis3D] Impossible de sauvegarder le projet après migration:',
                    error
                );
            }
        }
    }

    // ============================================================
    // ⬇️⬇️⬇️ FIN PARTIE 1/6 ⬇️⬇️⬇️
    // ⚠️ COLLEZ LA PARTIE 2/6 IMMÉDIATEMENT APRÈS CETTE LIGNE ⚠️
    // ============================================================
    // ============================================================
    // ⬇️⬇️⬇️ PARTIE 2/6 — SUITE DE gis3d.js ⬇️⬇️⬇️
    // ============================================================

    // ============================================================
    // INITIALISATION DE LA SCÈNE 3D
    // ============================================================

    function initScene() {

        const container =
            document.getElementById(
                CONFIG.containerId
            );

        if (!container) {

            console.warn(
                '[Gis3D] Conteneur 3D introuvable:',
                CONFIG.containerId
            );

            return false;
        }

        container.innerHTML = '';

        const width =
            container.clientWidth ||
            800;

        const height =
            container.clientHeight ||
            600;

        _scene =
            new THREE.Scene();

        _scene.background =
            new THREE.Color(
                0x111827
            );

        const aspect =
            width / height;

        _camera =
            new THREE.PerspectiveCamera(
                45,
                aspect,
                0.1,
                50000
            );

        _camera.position.set(
            30,
            20,
            30
        );

        _camera.lookAt(
            0,
            0,
            0
        );

        _renderer =
            new THREE.WebGLRenderer({
                antialias: true,
                powerPreference:
                    'high-performance'
            });

        _renderer.setSize(
            width,
            height
        );

        _renderer.setPixelRatio(
            Math.min(
                window.devicePixelRatio,
                2
            )
        );

        _renderer.shadowMap.enabled =
            true;

        _renderer.shadowMap.type =
            THREE.PCFSoftShadowMap;

        _renderer.toneMapping =
            THREE.ACESFilmicToneMapping;

        _renderer.toneMappingExposure =
            1.2;

        container.appendChild(
            _renderer.domElement
        );

        _controls =
            new THREE.OrbitControls(
                _camera,
                _renderer.domElement
            );

        _controls.enableDamping =
            true;

        _controls.dampingFactor =
            0.1;

        _controls.minDistance =
            1;

        _controls.maxDistance =
            5000;

        _controls.target.set(
            0,
            0,
            0
        );

        _controls.update();

        const ambientLight =
            new THREE.AmbientLight(
                0x446688,
                CONFIG.ambientLightIntensity
            );

        _scene.add(
            ambientLight
        );

        const dirLight =
            new THREE.DirectionalLight(
                0xffffff,
                CONFIG.directionalLightIntensity
            );

        dirLight.position.set(
            30,
            50,
            20
        );

        dirLight.castShadow =
            true;

        _scene.add(
            dirLight
        );

        const fillLight =
            new THREE.DirectionalLight(
                0x6688bb,
                0.6
            );

        fillLight.position.set(
            -30,
            20,
            -30
        );

        _scene.add(
            fillLight
        );

        const hemiLight =
            new THREE.HemisphereLight(
                0x4488bb,
                0x222244,
                0.8
            );

        _scene.add(
            hemiLight
        );

        _sceneGroup =
            new THREE.Group();

        _scene.add(
            _sceneGroup
        );

        const resizeObserver =
            new ResizeObserver(() => {

                if (
                    _renderer &&
                    _camera
                ) {

                    const w =
                        container.clientWidth ||
                        800;

                    const h =
                        container.clientHeight ||
                        600;

                    _renderer.setSize(
                        w,
                        h
                    );

                    _camera.aspect =
                        w / h;

                    _camera.updateProjectionMatrix();
                }
            });

        resizeObserver.observe(
            container
        );

        _isInitialized =
            true;

        startRenderLoop();

        _isReady = true;

        // === AJOUT POUR MINI-CARTE (avec retry géré dans initMiniMap) ===
        setTimeout(() => initMiniMap(), 500);
        // ==================================================================

        const callbacks = _readyCallbacks.splice(0);

        callbacks.forEach(
            callback => {

                try {

                    callback({
                        scene: _scene,
                        camera: _camera,
                        renderer: _renderer,
                        controls: _controls
                    });

                } catch (error) {

                    console.error(
                        '[Gis3D] Erreur callback ready:',
                        error
                    );
                }
            }
        );

        return true;
    }

    // ============================================================
    // ⬇️⬇️⬇️ FIN PARTIE 2/6 ⬇️⬇️⬇️
    // ⚠️ COLLEZ LA PARTIE 3/6 IMMÉDIATEMENT APRÈS CETTE LIGNE ⚠️
    // ============================================================
    // ============================================================
    // ⬇️⬇️⬇️ PARTIE 3/6 — SUITE DE gis3d.js ⬇️⬇️⬇️
    // ============================================================

    // ============================================================
    // INITIALISATION DE LA MINI-CARTE (avec retry)
    // ============================================================

    function initMiniMap(retryCount) {

        retryCount = retryCount || 0;

        if (typeof L === 'undefined') {

            console.warn(
                '[Gis3D] Leaflet non chargé, impossible d\'initialiser la mini‑carte.'
            );

            return;
        }

        // ⚠️ CORRECTIF : essayer 2 IDs possibles
        let container =
            document.getElementById(
                CONFIG.miniMapId
            );

        if (!container) {

            container =
                document.getElementById(
                    'miniMapContainer'
                );
        }

        // ⚠️ CORRECTIF : retry jusqu'à 5 fois si DOM pas prêt
        if (!container) {

            if (retryCount < 5) {

                console.debug(
                    `[Gis3D] Mini-carte introuvable, retry ${retryCount + 1}/5...`
                );

                setTimeout(
                    () => initMiniMap(retryCount + 1),
                    500
                );

                return;
            }

            console.warn(
                '[Gis3D] Conteneur mini‑carte introuvable après 5 tentatives.'
            );

            return;
        }

        // Éviter une double initialisation
        if (_miniMapInstance) {

            try {

                _miniMapInstance.invalidateSize();

                console.log(
                    '[Gis3D] Mini‑carte déjà initialisée, invalidée.'
                );

                return;

            } catch (e) {

                _miniMapInstance = null;
            }
        }

        // Nettoyer l'ancien contenu
        container.innerHTML = '';

        // Coordonnées de référence (depuis CoordSystem ou fallback)
        let refLat = 30.123456;
        let refLon = 8.123456;

        if (
            typeof CoordSystem !== 'undefined' &&
            CoordSystem.getReference
        ) {

            const ref =
                CoordSystem.getReference();

            if (
                ref &&
                ref.lat &&
                ref.lon
            ) {

                refLat = ref.lat;
                refLon = ref.lon;
            }
        }

        try {

            _miniMapInstance =
                L.map(container, {
                    zoomControl: false,
                    attributionControl: false,
                    fadeAnimation: false,
                    zoomAnimation: false,
                    markerZoomAnimation: false
                }).setView(
                    [refLat, refLon],
                    CONFIG.miniMapDefaultZoom || 10
                );

            L.tileLayer(
                'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                {
                    maxZoom: 19,
                    attribution: '© OSM'
                }
            ).addTo(_miniMapInstance);

            // Ajouter un contrôle de zoom réduit
            L.control.zoom({
                position: 'bottomright'
            }).addTo(_miniMapInstance);

            _miniMapInitialized = true;

            console.log(
                '[Gis3D] Mini‑carte initialisée avec succès.'
            );

        } catch (err) {

            console.error(
                '[Gis3D] Erreur lors de l\'initialisation de la mini‑carte :',
                err
            );

            _miniMapInstance = null;
            _miniMapInitialized = false;
        }
    }

    // ============================================================
    // EXTRACTION / VALIDATION DES COORDONNÉES
    // ============================================================

    function getEquipmentCoordinates(equipment) {

        const coords = [];

        const gps =
            equipment.gps ||
            equipment.coordinates ||
            {};

        if (Array.isArray(gps) && gps.length >= 2) {
            const arrayLat = safeNumber(gps[0], NaN);
            const arrayLon = safeNumber(gps[1], NaN);
            const arrayAlt = safeNumber(gps[2], 0);
            if (isFinite(arrayLat) && isFinite(arrayLon) &&
                isValidCoord(arrayLat, arrayLon) && !isZeroCoord(arrayLat, arrayLon)) {
                coords.push({ lat: arrayLat, lon: arrayLon, alt: arrayAlt });
                return coords;
            }
        }

        const lat =
            safeNumber(
                gps.latitude ??
                gps.lat ??
                equipment.latitude ??
                equipment.lat,
                NaN
            );

        const lon =
            safeNumber(
                gps.longitude ??
                gps.lon ??
                gps.lng ??
                equipment.longitude ??
                equipment.lon ??
                equipment.lng,
                NaN
            );

        const alt =
            safeNumber(
                gps.altitude ??
                gps.alt ??
                equipment.altitude ??
                equipment.alt ??
                0,
                0
            );

        if (
            isFinite(lat) &&
            isFinite(lon) &&
            isValidCoord(lat, lon) &&
            !isZeroCoord(lat, lon)
        ) {

            coords.push({
                lat,
                lon,
                alt
            });
        }

        if (
            Array.isArray(
                equipment.gpsPoints
            )
        ) {

            for (
                const p of equipment.gpsPoints
            ) {

                if (
                    Array.isArray(p) &&
                    p.length >= 2
                ) {

                    const pLat = safeNumber(p[0], NaN);
                    const pLon = safeNumber(p[1], NaN);
                    const pAlt = safeNumber(p[2], 0);

                    if (
                        isFinite(pLat) &&
                        isFinite(pLon) &&
                        isValidCoord(pLat, pLon) &&
                        !isZeroCoord(pLat, pLon)
                    ) {

                        coords.push({
                            lat: pLat,
                            lon: pLon,
                            alt: pAlt
                        });
                    }

                } else if (
                    typeof p === 'object' &&
                    p !== null
                ) {

                    const pLat =
                        safeNumber(
                            p.latitude ??
                            p.lat,
                            NaN
                        );

                    const pLon =
                        safeNumber(
                            p.longitude ??
                            p.lon,
                            NaN
                        );

                    const pAlt =
                        safeNumber(
                            p.altitude ??
                            p.alt ??
                            0,
                            0
                        );

                    if (
                        isFinite(pLat) &&
                        isFinite(pLon) &&
                        isValidCoord(pLat, pLon) &&
                        !isZeroCoord(pLat, pLon)
                    ) {

                        coords.push({
                            lat: pLat,
                            lon: pLon,
                            alt: pAlt
                        });
                    }
                }
            }
        }

        if (Array.isArray(gps)) {

            for (const p of gps) {

                if (
                    Array.isArray(p) &&
                    p.length >= 2
                ) {

                    const pLat = safeNumber(p[0], NaN);
                    const pLon = safeNumber(p[1], NaN);
                    const pAlt = safeNumber(p[2], 0);

                    if (
                        isFinite(pLat) &&
                        isFinite(pLon) &&
                        isValidCoord(pLat, pLon) &&
                        !isZeroCoord(pLat, pLon)
                    ) {

                        coords.push({
                            lat: pLat,
                            lon: pLon,
                            alt: pAlt
                        });
                    }

                } else if (
                    typeof p === 'object' &&
                    p !== null
                ) {

                    const pLat = safeNumber(
                        p.latitude ?? p.lat,
                        NaN
                    );

                    const pLon = safeNumber(
                        p.longitude ?? p.lon,
                        NaN
                    );

                    const pAlt = safeNumber(
                        p.altitude ?? p.alt ?? 0,
                        0
                    );

                    if (
                        isFinite(pLat) &&
                        isFinite(pLon) &&
                        isValidCoord(pLat, pLon) &&
                        !isZeroCoord(pLat, pLon)
                    ) {

                        coords.push({
                            lat: pLat,
                            lon: pLon,
                            alt: pAlt
                        });
                    }
                }
            }
        }

        return coords;
    }

    async function getValidEquipments(projectId) {

        let equipments = [];

        try {

            if (
                projectId &&
                projectId !== '__all__'
            ) {

                equipments =
                    await StorageManager
                        .loadEquipmentsForProject(
                            projectId,
                            true
                        );

            } else {

                const projects =
                    ProjectManager.getProjectsList();

                const allEquipments =
                    await Promise.all(
                        projects.map(
                            p => StorageManager
                                .loadEquipmentsForProject(
                                    p.id,
                                    true
                                )
                        )
                    );

                equipments =
                    allEquipments.flat();
            }

        } catch (error) {

            console.error(
                '[Gis3D] Erreur lecture équipements:',
                error
            );

            if (
                typeof ProjectManager !== 'undefined' &&
                ProjectManager.getState
            ) {

                const state =
                    ProjectManager.getState();

                equipments =
                    state.equipments || [];

                if (
                    projectId &&
                    projectId !== '__all__'
                ) {

                    equipments =
                        equipments.filter(
                            eq => eq.projectId === projectId
                        );
                }
            }
        }

        if (_systemFilter) {

            equipments =
                equipments.filter(
                    eq => !eq.systemId ||
                          eq.systemId === _systemFilter
                );
        }

        return equipments;
    }

    function getEquipmentsWithValidGPS(equipments) {

        const valid = [];
        const invalid = [];

        for (
            const equipment of equipments
        ) {

            const points =
                getEquipmentCoordinates(
                    equipment
                );

            if (points.length > 0) {

                valid.push(equipment);

            } else {

                invalid.push(equipment);

                console.warn(
                    `[Gis3D] Coordonnées GPS manquantes ou invalides pour ${equipment.tag || equipment.id || 'équipement inconnu'}`
                );
            }
        }

        return {
            valid,
            invalid
        };
    }

    // ============================================================
    // CONVERSION GPS → COORDONNÉES 3D
    // ============================================================

    function convertCoordinates(
        equipments,
        referenceProjectId
    ) {

        // Récupérer tous les points pour chaque équipement
        const allPoints = [];
        const equipmentPoints = {};

        for (
            const equipment of equipments
        ) {

            const points =
                getEquipmentCoordinates(
                    equipment
                );

            equipmentPoints[
                equipment.id
            ] = points;

            for (
                const p of points
            ) {

                allPoints.push({
                    ...p,
                    projectId: equipment.projectId
                });
            }
        }

        if (
            allPoints.length === 0
        ) {

            return {};
        }

        // Sélection des points pour le calcul du centre et de l'échelle
        let pointsForCenter = [];

        if (referenceProjectId) {

            pointsForCenter =
                allPoints.filter(
                    p => p.projectId === referenceProjectId
                );
        }

        // Si aucun point pour le centre, on prend tous les points
        if (pointsForCenter.length === 0) {

            pointsForCenter = allPoints;
        }

        // Calcul du centre et de l'échelle
        let sumLat = 0;
        let sumLon = 0;
        let sumAlt = 0;

        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLon = Infinity;
        let maxLon = -Infinity;

        for (
            const p of pointsForCenter
        ) {

            sumLat += p.lat;
            sumLon += p.lon;
            sumAlt += p.alt;

            if (p.lat < minLat) {
                minLat = p.lat;
            }

            if (p.lat > maxLat) {
                maxLat = p.lat;
            }

            if (p.lon < minLon) {
                minLon = p.lon;
            }

            if (p.lon > maxLon) {
                maxLon = p.lon;
            }
        }

        const centerLat =
            sumLat / pointsForCenter.length;

        const centerLon =
            sumLon / pointsForCenter.length;

        const centerAlt =
            sumAlt / pointsForCenter.length;

        const rangeLat =
            maxLat - minLat || 0.001;

        const rangeLon =
            maxLon - minLon || 0.001;

        const maxRange =
            Math.max(
                rangeLat,
                rangeLon
            );

        const targetSize =
            Math.min(
                Math.max(
                    maxRange * 100,
                    20
                ),
                80
            );

        const scale =
            targetSize / maxRange;

        // Conversion de tous les points avec ce centre/échelle
        const finalResult = {};

        for (
            const eqId in equipmentPoints
        ) {

            const pts =
                equipmentPoints[eqId];

            const converted = [];

            for (
                const p of pts
            ) {

                const x =
                    (p.lon - centerLon) * scale;

                const y =
                    (p.alt - centerAlt) * scale;

                const z =
                    (p.lat - centerLat) * scale;

                converted.push({
                    x,
                    y,
                    z
                });
            }

            finalResult[eqId] = converted;
        }

        return finalResult;
    }

    // ============================================================
    // ⬇️⬇️⬇️ FIN PARTIE 3/6 ⬇️⬇️⬇️
    // ⚠️ COLLEZ LA PARTIE 4/6 IMMÉDIATEMENT APRÈS CETTE LIGNE ⚠️
    // ============================================================
    // ============================================================
    // ⬇️⬇️⬇️ PARTIE 4/6 — SUITE DE gis3d.js ⬇️⬇️⬇️
    // ============================================================

    // ============================================================
    // CRÉATION D'UNE ÉTIQUETTE TEXTE
    // ============================================================

    function createTextLabel(
        text,
        position,
        color,
        tubeRadius = 1.5
    ) {

        const canvas =
            document.createElement(
                'canvas'
            );

        canvas.width = 768;
        canvas.height = 144;

        const ctx =
            canvas.getContext(
                '2d'
            );

        ctx.clearRect(
            0,
            0,
            canvas.width,
            canvas.height
        );

        const labelText =
            String(
                text ||
                'Équipement'
            );

        const fontSize = 52;

        ctx.font =
            `500 ${fontSize}px "Arial", "Helvetica Neue", sans-serif`;

        ctx.textAlign =
            'center';

        ctx.textBaseline =
            'middle';

        const metrics =
            ctx.measureText(
                labelText
            );

        const paddingX = 28;

        const boxWidth =
            Math.min(
                canvas.width - 24,
                Math.max(
                    220,
                    metrics.width +
                    paddingX * 2
                )
            );

        const boxHeight = 82;

        const x =
            (
                canvas.width -
                boxWidth
            ) / 2;

        const y =
            (
                canvas.height -
                boxHeight
            ) / 2;

        const radius = 16;

        ctx.save();

        ctx.shadowColor =
            'rgba(0, 0, 0, 0.65)';

        ctx.shadowBlur = 10;

        ctx.shadowOffsetY = 3;

        ctx.fillStyle =
            'rgba(248, 250, 252, 0.96)';

        ctx.beginPath();

        ctx.roundRect(
            x,
            y,
            boxWidth,
            boxHeight,
            radius
        );

        ctx.fill();

        ctx.restore();

        ctx.strokeStyle =
            'rgba(15, 23, 42, 0.95)';

        ctx.lineWidth = 4;

        ctx.beginPath();

        ctx.roundRect(
            x,
            y,
            boxWidth,
            boxHeight,
            radius
        );

        ctx.stroke();

        ctx.fillStyle =
            color ||
            '#0f172a';

        ctx.font =
            `600 ${fontSize}px "Arial", "Helvetica Neue", sans-serif`;

        ctx.fillText(
            labelText,
            canvas.width / 2,
            canvas.height / 2 + 1
        );

        const texture =
            new THREE.CanvasTexture(
                canvas
            );

        texture.colorSpace =
            THREE.SRGBColorSpace;

        texture.minFilter =
            THREE.LinearFilter;

        texture.magFilter =
            THREE.LinearFilter;

        texture.generateMipmaps =
            true;

        texture.needsUpdate =
            true;

        const material =
            new THREE.SpriteMaterial({
                map: texture,
                transparent: true,
                opacity: 1.0,
                depthTest: false,
                depthWrite: false,
                sizeAttenuation: true,
                toneMapped: false
            });

        const sprite =
            new THREE.Sprite(
                material
            );

        sprite.position.copy(
            position
        );

        const scaleX =
            Math.min(
                5.0,
                Math.max(
                    2.4,
                    tubeRadius * 3.2
                )
            );

        const scaleY =
            scaleX * 0.25;

        sprite.scale.set(
            scaleX,
            scaleY,
            1
        );

        sprite.renderOrder =
            10000;

        sprite.frustumCulled =
            false;

        return sprite;
    }

    // ============================================================
    // UTILITAIRE : EXTENSION DU PIPELINE ×3
    // ============================================================

    function extendPipelinePoints(
        points,
        factor = 3.0
    ) {

        if (
            !points ||
            points.length < 2
        ) {

            return points;
        }

        const validPoints = points.filter(p => 
            p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z)
        );

        if (validPoints.length < 2) return points;

        const source =
            validPoints.map(
                p =>
                    new THREE.Vector3(
                        p.x,
                        p.y,
                        p.z
                    )
            );

        const first =
            source[0];

        const last =
            source[
                source.length - 1
            ];

        const center =
            new THREE.Vector3()
                .addVectors(
                    first,
                    last
                )
                .multiplyScalar(
                    0.5
                );

        return source.map(
            p =>
                new THREE.Vector3(
                    center.x +
                        (
                            p.x -
                            center.x
                        ) * factor,

                    center.y +
                        (
                            p.y -
                            center.y
                        ) * factor,

                    center.z +
                        (
                            p.z -
                            center.z
                        ) * factor
                )
        );
    }

    // ============================================================
    // CRÉATION DU PIPELINE (CORRIGÉE : diamètre visuel basé sur le diamètre réel)
    // ============================================================

    function createPipeline(
        equipment,
        points
    ) {

        if (
            !points ||
            points.length < 2
        ) {

            console.warn(
                '[Gis3D] Pipeline sans suffisamment de points:',
                equipment?.tag ||
                equipment?.id
            );

            return null;
        }

        const validPoints = points.filter(p => isFinite(p.x) && isFinite(p.y) && isFinite(p.z));
        if (validPoints.length < 2) {
            console.warn('[Gis3D] Points invalides pour le pipeline:', equipment?.tag || equipment?.id);
            return null;
        }

        const group =
            new THREE.Group();

        group.name =
            `pipeline_${equipment.id}`;

        // ---- NOUVEAU CALCUL DU RAYON VISUEL ----
        // Récupération du diamètre réel en mètres (depuis les dimensions de l'équipement)
        const realDiameter = safeNumber(equipment.dimensions?.diametre_m, 0.3); // fallback 0.3 m
        // Application du facteur d'échelle visuel
        const visualRadius = (realDiameter / 2) * CONFIG.pipelineVisualRadiusScale;
        // Assurer un rayon minimal pour la visibilité
        const tubeRadius = Math.max(visualRadius, 0.02);

        const color =
            new THREE.Color(
                CONFIG.colors.pipeline
            );

        const curvePoints =
            extendPipelinePoints(
                validPoints,
                CONFIG.sizes
                    .pipelineLengthFactor
            );

        const curve =
            new THREE.CatmullRomCurve3(
                curvePoints
            );

        const tubeGeometry =
            new THREE.TubeGeometry(
                curve,
                Math.max(
                    96,
                    curvePoints.length * 24
                ),
                tubeRadius,
                24,
                false
            );

        const material =
            new THREE.MeshStandardMaterial({

                color: color,

                metalness: 0.72,

                roughness: 0.28,

                emissive:
                    new THREE.Color(
                        0x101820
                    ),

                emissiveIntensity: 0.12
            });

        const mesh =
            new THREE.Mesh(
                tubeGeometry,
                material
            );

        mesh.castShadow =
            true;

        mesh.receiveShadow =
            true;

        group.add(
            mesh
        );

        const midIndex =
            Math.floor(
                curvePoints.length / 2
            );

        const midPos =
            curvePoints[
                midIndex
            ] ||
            curvePoints[0];

        const defaultLabelPos =
            new THREE.Vector3(
                midPos.x,
                midPos.y +
                    tubeRadius +
                    0.15,
                midPos.z
            );

        const labelPos =
            getLabelPosition(
                equipment,
                defaultLabelPos,
                midPos
            );

        const label =
            createTextLabel(
                equipment.tag ||
                    'Pipeline',
                labelPos,
                '#0f172a',
                tubeRadius
            );

        group.add(
            label
        );

        group.userData = {
            equipmentId:
                equipment.id,

            type:
                equipment.type,

            tag:
                equipment.tag,

            projectId:
                equipment.projectId,

            pipelinePoints:
                curvePoints,

            // Stocker le rayon utilisé pour référence
            visualRadius: tubeRadius
        };

        return group;
    }

    // ============================================================
    // CRÉATION DU REDRESSEUR
    // ============================================================

    function createRectifier(
        equipment,
        point
    ) {

        const group =
            new THREE.Group();

        group.name =
            `rectifier_${equipment.id}`;

        const w =
            CONFIG.sizes
                .rectifierWidth;

        const h =
            CONFIG.sizes
                .rectifierHeight;

        const d =
            CONFIG.sizes
                .rectifierDepth;

        const boxGeometry =
            new THREE.BoxGeometry(
                w,
                h,
                d
            );

        const color =
            CONFIG.colors.rectifier;

        const material =
            new THREE.MeshStandardMaterial({

                color: color,

                metalness: 0.62,

                roughness: 0.34,

                emissive:
                    new THREE.Color(
                        0x330000
                    ),

                emissiveIntensity: 0.12
            });

        const box =
            new THREE.Mesh(
                boxGeometry,
                material
            );

        box.castShadow =
            true;

        box.receiveShadow =
            true;

        group.add(
            box
        );

        const defaultLabelPos =
            new THREE.Vector3(
                0,
                h / 2 +
                    0.10,
                0
            );

        const labelPos =
            getLabelPosition(
                equipment,
                defaultLabelPos,
                point
            );

        const label =
            createTextLabel(
                equipment.tag ||
                    'Rectifier',
                labelPos,
                '#0f172a',
                0.5
            );

        group.add(
            label
        );

        group.position.set(
            point.x,
            point.y,
            point.z
        );

        group.userData = {
            equipmentId:
                equipment.id,

            type:
                equipment.type,

            tag:
                equipment.tag,

            projectId:
                equipment.projectId
        };

        return group;
    }

    // ============================================================
    // ⬇️⬇️⬇️ FIN PARTIE 4/6 ⬇️⬇️⬇️
    // ⚠️ COLLEZ LA PARTIE 5/6 IMMÉDIATEMENT APRÈS CETTE LIGNE ⚠️
    // ============================================================
    // ============================================================
    // ⬇️⬇️⬇️ PARTIE 5/6 — SUITE DE gis3d.js ⬇️⬇️⬇️
    // ============================================================

    // ============================================================
    // CRÉATION DU GROUNDBED / PUITS ANODIQUE
    // ⚠️ CORRECTIF NaN : guard anti-NaN sur la profondeur visuelle
    // ============================================================

    function createGroundbed(equipment, points) {

        const group = new THREE.Group();

        group.name = `groundbed_${equipment.id}`;

        const totalDepth = Math.max(
            safeNumber(equipment.dimensions?.totalDepth, 20),
            1
        );

        // ⚠️ CORRECTIF NaN : échelle visuelle avec fallbacks robustes
        const visualScale = safeNumber(
            CONFIG.sizes.groundbedVisualDepthScale,
            0.5
        );

        const maxDepth = safeNumber(
            CONFIG.sizes.groundbedMaxDepth,
            20
        );

        const minDepth = safeNumber(
            CONFIG.sizes.groundbedMinDepth,
            0.3
        );

        let visualDepth = totalDepth * visualScale;

        if (!isFinite(visualDepth) || isNaN(visualDepth)) {

            visualDepth = 5;

            console.warn(
                `[Gis3D] Groundbed ${equipment.tag} : depth invalide, fallback à 5`
            );
        }

        const finalDepth = Math.min(
            Math.max(visualDepth, minDepth),
            maxDepth
        );

        // ⚠️ CORRECTIF : abandon si profondeur finale invalide
        if (!isFinite(finalDepth) || finalDepth <= 0 || isNaN(finalDepth)) {

            console.warn(
                `[Gis3D] Groundbed avec profondeur invalide, ignoré: ${equipment.tag}`
            );

            return null;
        }

        const anodeCount = Math.max(
            safeNumber(equipment.dimensions?.anodeCount, 8),
            1
        );

        const anodeLength = safeNumber(
            equipment.dimensions?.anodeLength,
            1.5
        );

        const radius = CONFIG.sizes.groundbedRadius;

        const wellGeo = new THREE.CylinderGeometry(
            radius,
            radius * 1.2,
            finalDepth,
            16,
            1,
            true
        );

        const wellMat = new THREE.MeshStandardMaterial({
            color: CONFIG.colors.groundbed,
            transparent: true,
            opacity: 0.12,
            side: THREE.DoubleSide,
            metalness: 0.18,
            roughness: 0.82,
            depthWrite: false
        });

        const well = new THREE.Mesh(
            wellGeo,
            wellMat
        );

        well.position.set(
            0,
            -finalDepth / 2,
            0
        );

        group.add(well);

        const spacing = (finalDepth * 0.7) / (anodeCount + 1);

        const anodeRadius = CONFIG.sizes.anodeRadius;

        for (
            let i = 0;
            i < Math.min(anodeCount, 20);
            i++
        ) {

            const y =
                -finalDepth * 0.15 -
                (i + 1) * spacing;

            const anodeGeo =
                new THREE.CylinderGeometry(
                    anodeRadius,
                    anodeRadius * 1.1,
                    anodeLength,
                    8
                );

            const anodeMat =
                new THREE.MeshStandardMaterial({
                    color: CONFIG.colors.anode,
                    emissive: new THREE.Color(0x3a2505),
                    emissiveIntensity: 0.35,
                    metalness: 0.55,
                    roughness: 0.32
                });

            const anode = new THREE.Mesh(
                anodeGeo,
                anodeMat
            );

            anode.position.set(0, y, 0);

            group.add(anode);
        }

        const centerPoint = points && points[0];

        if (centerPoint) {

            group.position.set(
                centerPoint.x,
                centerPoint.y,
                centerPoint.z
            );
        }

        const defaultLabelPos =
            new THREE.Vector3(0, 0.18, 0);

        const labelPos =
            getLabelPosition(
                equipment,
                defaultLabelPos,
                centerPoint
            );

        const label =
            createTextLabel(
                equipment.tag || 'Groundbed',
                labelPos,
                '#0f172a',
                0.5
            );

        group.add(label);

        group.userData = {
            equipmentId: equipment.id,
            type: equipment.type,
            tag: equipment.tag,
            projectId: equipment.projectId,
            totalDepth: finalDepth,
            anodeCount: anodeCount
        };

        return group;
    }

    // ============================================================
    // CRÉATION DE L'ANODE SACRIFICIELLE
    // ============================================================

    function createAnode(
        equipment,
        point
    ) {

        const group =
            new THREE.Group();

        group.name =
            `anode_${equipment.id}`;

        const radius =
            CONFIG.sizes
                .anodeRadius;

        const height = 0.5;

        const color =
            CONFIG.colors.anode;

        const geo =
            new THREE.CylinderGeometry(
                radius,
                radius * 1.2,
                height,
                8
            );

        const mat =
            new THREE.MeshStandardMaterial({

                color: color,

                emissive:
                    new THREE.Color(
                        0x3a2505
                    ),

                emissiveIntensity:
                    0.35,

                metalness: 0.55,

                roughness: 0.32
            });

        const mesh =
            new THREE.Mesh(
                geo,
                mat
            );

        mesh.position.set(
            0,
            0,
            0
        );

        group.add(
            mesh
        );

        const defaultLabelPos =
            new THREE.Vector3(
                0,
                height / 2 +
                    0.08,
                0
            );

        const labelPos =
            getLabelPosition(
                equipment,
                defaultLabelPos,
                point
            );

        const label =
            createTextLabel(
                equipment.tag ||
                    'Anode',
                labelPos,
                '#0f172a',
                0.3
            );

        group.add(
            label
        );

        group.position.set(
            point.x,
            point.y,
            point.z
        );

        group.userData = {
            equipmentId:
                equipment.id,

            type:
                equipment.type,

            tag:
                equipment.tag,

            projectId:
                equipment.projectId,

            // ⚠️ AJOUT : height dans userData pour getAnodeBottomPoint
            height: height
        };

        return group;
    }

    function createTank(equipment, point) {
        const group = new THREE.Group();
        group.name = `tank_${equipment.id}`;

        const dimensions = equipment.dimensions || {};
        let rawDiameter = safeNumber(dimensions.diametre_m, 15);
        if (rawDiameter > 0 && rawDiameter < 0.5) rawDiameter = rawDiameter * 1000;
        const diameter = Math.max(4.0, Math.min(rawDiameter, 50));

        let rawHeight = safeNumber(dimensions.hauteur_m, diameter * 0.5);
        if (rawHeight > 0 && rawHeight < 0.5) rawHeight = rawHeight * 1000;
        const height = Math.max(2.5, Math.min(rawHeight, 35));

        // Échelle visuelle harmonisée avec les pipelines (réduite de 5x)
        const visualScale = 0.05;
        const radius = Math.max(0.24, (diameter / 2) * visualScale);
        const visualHeight = Math.max(0.28, height * visualScale);

        const tankMaterial = new THREE.MeshStandardMaterial({
            color: 0xd97736,
            emissive: new THREE.Color(0x442208),
            emissiveIntensity: 0.35,
            metalness: 0.65,
            roughness: 0.35
        });
        const darkMaterial = new THREE.MeshStandardMaterial({
            color: 0x334155,
            emissive: new THREE.Color(0x0f172a),
            emissiveIntensity: 0.25,
            metalness: 0.55,
            roughness: 0.45
        });

        const shell = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, visualHeight, 32), tankMaterial);
        shell.position.y = visualHeight / 2;
        shell.castShadow = true;
        shell.receiveShadow = true;
        group.add(shell);

        const roof = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.98, radius * 0.98, 0.03, 32), darkMaterial);
        roof.position.y = visualHeight + 0.015;
        roof.castShadow = true;
        group.add(roof);

        const roofCenter = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.08, 10), darkMaterial);
        roofCenter.position.y = visualHeight + 0.055;
        group.add(roofCenter);

        const supportHeight = visualHeight + 0.04;
        for (let i = 0; i < 4; i++) {
            const angle = (Math.PI * 2 * i) / 4;
            const support = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, supportHeight, 8), darkMaterial);
            support.position.set(Math.cos(angle) * radius * 0.75, supportHeight / 2, Math.sin(angle) * radius * 0.75);
            group.add(support);
        }

        // L'étiquette flotte au-dessus du toit du réservoir pour ne pas masquer le corps 3D
        const labelPos = getLabelPosition(equipment, new THREE.Vector3(0, visualHeight + 0.25, 0), point);
        group.add(createTextLabel(equipment.tag || 'Tank', labelPos, '#0f172a', 0.12));
        group.position.set(point.x, point.y, point.z);
        group.userData = {
            equipmentId: equipment.id,
            type: equipment.type,
            tag: equipment.tag,
            projectId: equipment.projectId,
            objectKind: 'tank',
            dimensions: { diameter, height },
            visualRadius: radius,
            visualHeight: visualHeight,
            soilContactPoint: new THREE.Vector3(0, 0, 0)
        };
        return group;
    }

    function getTankCenterPoint(points) {
        if (!points || points.length === 0) return null;
        if (points.length === 1) return points[0];
        const center = points.reduce((sum, current) => ({
            x: sum.x + current.x,
            y: sum.y + current.y,
            z: sum.z + current.z
        }), { x: 0, y: 0, z: 0 });
        return {
            x: center.x / points.length,
            y: center.y / points.length,
            z: center.z / points.length
        };
    }

    // ============================================================
    // CRÉATION D'UN OBJET GÉNÉRIQUE
    // ============================================================

    function createGeneric(
        equipment,
        point
    ) {

        const group =
            new THREE.Group();

        group.name =
            `generic_${equipment.id}`;

        const size = 0.4;

        const color =
            CONFIG.colors.generic;

        const geo =
            new THREE.SphereGeometry(
                size * 0.01,
                8,
                8
            );

        const mat =
            new THREE.MeshStandardMaterial({

                color: color,

                emissive: color,

                emissiveIntensity: 0,

                metalness: 0.2,

                roughness: 0.7
            });

        const mesh =
            new THREE.Mesh(
                geo,
                mat
            );

        mesh.position.set(
            0,
            0,
            0
        );

        group.add(
            mesh
        );

        const defaultLabelPos =
            new THREE.Vector3(
                0,
                size * 0.01 +
                    0.10,
                0
            );

        const labelPos =
            getLabelPosition(
                equipment,
                defaultLabelPos,
                point
            );

        const label =
            createTextLabel(
                equipment.tag ||
                    'Équipement',
                labelPos,
                '#0f172a',
                0.3
            );

        group.add(
            label
        );

        group.position.set(
            point.x,
            point.y,
            point.z
        );

        group.userData = {
            equipmentId:
                equipment.id,

            type:
                equipment.type,

            tag:
                equipment.tag,

            projectId:
                equipment.projectId
        };

        return group;
    }

    // ============================================================
    // SOL AVEC GRILLE DISCRÈTE
    // ============================================================

    function createGroundPlane() {

        const group =
            new THREE.Group();

        group.name =
            'Ground';

        const groundSize =
            300;

        const geometry =
            new THREE.PlaneGeometry(
                groundSize,
                groundSize
            );

        const material =
            new THREE.MeshStandardMaterial({

                color:
                    0x151c28,

                transparent: true,

                opacity: 0.96,

                side:
                    THREE.DoubleSide,

                roughness: 0.94,

                metalness: 0.0
            });

        const plane =
            new THREE.Mesh(
                geometry,
                material
            );

        plane.rotation.x =
            -Math.PI / 2;

        plane.position.y =
            -1;

        plane.receiveShadow =
            true;

        group.add(
            plane
        );

        const gridHelper =
            new THREE.GridHelper(
                groundSize,
                40,
                0x64748b,
                0x334155
            );

        gridHelper.material.transparent =
            true;

        gridHelper.material.opacity =
            0.18;

        gridHelper.material.depthWrite =
            false;

        gridHelper.renderOrder =
            0;

        gridHelper.position.y =
            -0.9;

        group.add(
            gridHelper
        );

        return group;
    }

    // ============================================================
    // UTILITAIRE : DISTANCE ENTRE DEUX POINTS
    // ============================================================

    function distance3D(
        a,
        b
    ) {

        if (
            !a ||
            !b
        ) {

            return Infinity;
        }

        const dx =
            a.x - b.x;

        const dy =
            a.y - b.y;

        const dz =
            a.z - b.z;

        return Math.sqrt(
            dx * dx +
            dy * dy +
            dz * dz
        );
    }

    // ============================================================
    // POINT DU PIPELINE LE PLUS PROCHE DE L'ANODE
    // ============================================================

    function findNearestPipelinePoint(
        pipelinePoints,
        target
    ) {

        if (
            !pipelinePoints ||
            pipelinePoints.length === 0 ||
            !target
        ) {

            return null;
        }

        let nearest =
            pipelinePoints[0];

        let nearestDistance =
            distance3D(
                nearest,
                target
            );

        for (
            let i = 1;
            i < pipelinePoints.length;
            i++
        ) {

            const candidate =
                pipelinePoints[i];

            const d =
                distance3D(
                    candidate,
                    target
                );

            if (
                d <
                nearestDistance
            ) {

                nearest =
                    candidate;

                nearestDistance =
                    d;
            }
        }

        return nearest;
    }

    // ============================================================
    // POINT SUR LA SURFACE SUPÉRIEURE DU PIPELINE
    // ============================================================

    function getPipelineSurfacePoint(
        point,
        radius
    ) {

        if (!point) {

            return null;
        }

        return new THREE.Vector3(
            point.x,
            point.y +
                radius +
                0.12,
            point.z
        );
    }

    // ============================================================
    // POINT AU FOND DE L'ANODE SACRIFICIELLE
    // ============================================================

    function getAnodeBottomPoint(
        anodeObject
    ) {

        if (
            !anodeObject
        ) {

            return null;
        }

        const worldPosition =
            new THREE.Vector3();

        anodeObject
            .getWorldPosition(
                worldPosition
            );

        const height =
            safeNumber(
                anodeObject
                    .userData
                    ?.height,
                0.5
            );

        return new THREE.Vector3(
            worldPosition.x,
            worldPosition.y -
                height / 2,
            worldPosition.z
        );
    }

    function getElectronTexture() {
        if (_electronTexture) return _electronTexture;
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d');
        const gradient = context.createRadialGradient(32, 32, 4, 32, 32, 30);
        gradient.addColorStop(0, 'rgba(255, 255, 230, 1)');
        gradient.addColorStop(0.38, 'rgba(255, 235, 0, 1)');
        gradient.addColorStop(0.72, 'rgba(245, 158, 11, 0.78)');
        gradient.addColorStop(1, 'rgba(120, 53, 15, 0)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 64, 64);
        context.fillStyle = '#061521';
        context.font = '700 34px Arial, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText('-', 32, 31);
        _electronTexture = new THREE.CanvasTexture(canvas);
        _electronTexture.minFilter = THREE.LinearFilter;
        _electronTexture.magFilter = THREE.LinearFilter;
        _electronTexture.needsUpdate = true;
        return _electronTexture;
    }

    function resolveFluxIntensity() {
        try {
            const state = window.ProjectManager?.getState?.();
            const values = [
                state?.iccp?.current,
                state?.cp?.current,
                state?.groundbed?.results?.targetCurrent,
                state?.groundbed?.results?.current
            ].map(value => safeNumber(value, 0)).filter(value => value > 0);
            return values.length ? Math.max(...values) : 10;
        } catch (error) {
            return 10;
        }
    }

    // ============================================================
    // CRÉATION DU FLUX DE PARTICULES
    // PUITS ANODIQUE → SURFACE DU PIPELINE OU FOND DU TANK
    // ============================================================

    function createParticleFlux(
        pipelineObject,
        sourceObject,
        options = {}
    ) {

        if (
            !pipelineObject ||
            !sourceObject
        ) {

            return null;
        }

        const pipelinePoints =
            pipelineObject
                .userData
                ?.pipelinePoints;

        const sourcePosition =
            new THREE.Vector3();

        sourceObject
            .getWorldPosition(
                sourcePosition
            );

        let start;
        const isTank = pipelineObject.userData?.objectKind === 'tank';
        if (isTank) {
            start = new THREE.Vector3();
            const contactPoint = pipelineObject.userData.soilContactPoint || new THREE.Vector3();
            pipelineObject.localToWorld(start.copy(contactPoint));
        } else {
            if (!pipelinePoints || pipelinePoints.length === 0) return null;
            const nearestPipelinePoint = findNearestPipelinePoint(pipelinePoints, sourcePosition);
            if (!nearestPipelinePoint) return null;
            const pipeRadius = pipelineObject.userData?.visualRadius || 1.5;
            start = getPipelineSurfacePoint(nearestPipelinePoint, pipeRadius);
        }

        if (
            !start
        ) {

            return null;
        }

        const direction = new THREE.Vector3().subVectors(start, sourcePosition);

        const totalLength =
            direction.length();

        if (
            totalLength <
            0.01
        ) {

            return null;
        }

        direction.normalize();

        const reference =
            Math.abs(
                direction.y
            ) < 0.9
                ? new THREE.Vector3(
                    0,
                    1,
                    0
                )
                : new THREE.Vector3(
                    1,
                    0,
                    0
                );

        const lateral =
            new THREE.Vector3()
                .crossVectors(
                    direction,
                    reference
                )
                .normalize();

        const lateral2 =
            new THREE.Vector3()
                .crossVectors(
                    direction,
                    lateral
                )
                .normalize();

        const current = resolveFluxIntensity();
        const intensity = Math.min(3, Math.max(0.35, current / 10));
        const particleCount = Math.max(36, Math.min(420, Math.round(safeNumber(options.count, CONFIG.sizes.particleCount) * intensity)));

        const particleSize =
            safeNumber(
                options.size,
                CONFIG.sizes
                    .particleSize
            );

        const speed =
            safeNumber(
                options.speed,
                CONFIG.sizes
                    .particleSpeed
            );

        const jitter =
            safeNumber(
                options.jitter,
                CONFIG.sizes
                    .particleJitter
            );

        const group = new THREE.Group();

        group.name = isTank
            ? 'particleFlux_groundbed_to_tank_bottom'
            : 'particleFlux_groundbed_to_pipeline';

        group.renderOrder =
            8000;

        const curveMid = new THREE.Vector3().addVectors(sourcePosition, start).multiplyScalar(0.5)
            .addScaledVector(lateral, Math.min(1.8, totalLength * 0.12))
            .addScaledVector(lateral2, Math.min(0.8, totalLength * 0.05));
        const flowLinePoints = [sourcePosition.clone(), curveMid, start.clone()];

        const flowCurve =
            new THREE.CatmullRomCurve3(
                flowLinePoints
            );

        const flowGeometry = new THREE.TubeGeometry(flowCurve, 32, Math.max(0.012, particleSize * 0.08), 5, false);

        const flowMaterial =
            new THREE.MeshBasicMaterial({

                color:
                    CONFIG.sizes
                        .particleColor,

                transparent: true,

                opacity: 0.12,

                depthTest: false,

                depthWrite: false
            });

        const flowLine =
            new THREE.Mesh(
                flowGeometry,
                flowMaterial
            );

        flowLine.renderOrder =
            7999;

        group.add(
            flowLine
        );

        const positions = new Float32Array(particleCount * 3);
        const particles = [];
        const particleMaterial = new THREE.PointsMaterial({
            map: getElectronTexture(),
            color: CONFIG.sizes.particleColor,
            size: Math.max(0.22, particleSize * 2.8),
            transparent: true,
            opacity: Math.min(0.98, 0.68 + intensity * 0.1),
            depthTest: true,
            depthWrite: false,
            sizeAttenuation: true
        });
        const particleGeometry = new THREE.BufferGeometry();
        for (let i = 0; i < particleCount; i++) {
            const progress = i / particleCount;
            const offsetA = (Math.random() - 0.5) * jitter * (0.7 + Math.random() * 0.6);
            const offsetB = (Math.random() - 0.5) * jitter * (0.7 + Math.random() * 0.6);
            const point = flowCurve.getPointAt(progress).addScaledVector(lateral, offsetA).addScaledVector(lateral2, offsetB);
            positions[i * 3] = point.x;
            positions[i * 3 + 1] = point.y;
            positions[i * 3 + 2] = point.z;
            particles.push({ index: i, progress, speed: speed * (0.72 + Math.random() * 0.56), offsetA, offsetB, phase: Math.random() * Math.PI * 2 });
        }
        particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        particleGeometry.computeBoundingSphere();
        const particlePoints = new THREE.Points(particleGeometry, particleMaterial);
        particlePoints.frustumCulled = false;
        particlePoints.renderOrder = 8001;
        group.add(particlePoints);

        _sceneGroup.add(
            group
        );

        const flux = {
            group,
            particles,
            start:
                sourcePosition.clone(),
            end:
                start.clone(),
            direction: direction.clone(),
            curve: flowCurve,
            lateral:
                lateral.clone(),
            lateral2:
                lateral2.clone(),
            length:
                totalLength,
            speed,
            jitter,
            particleSize,
            particlePoints,
            particleGeometry,
            particleMaterial,
            current,
            intensity,
            flowLine
        };

        _particleFluxes.push(
            flux
        );

        console.log(
            `[Gis3D] Flux particulaire créé : PUITS ANODIQUE → ${isTank ? 'FOND DU TANK' : 'PIPELINE'}`,
            {
                longueur:
                    totalLength.toFixed(2),

                particules:
                    particleCount
            }
        );

        return flux;
    }

    // ============================================================
    // ANIMATION DU FLUX DE PARTICULES
    // ============================================================

    function updateParticleFluxes(
        deltaTime
    ) {

        if (
            !_particleFluxes ||
            _particleFluxes.length === 0
        ) {

            return;
        }

        const time =
            performance.now() *
            0.001;

        for (
            const flux of
            _particleFluxes
        ) {

            if (
                !flux ||
                !flux.particles
            ) {

                continue;
            }

            for (
                const particle of
                flux.particles
            ) {

                particle.progress +=
                    (
                        particle.speed *
                        deltaTime
                    ) /
                    Math.max(
                        flux.length,
                        0.01
                    );

                if (
                    particle.progress >
                    1
                ) {

                    particle.progress -=
                        1;
                }

                const progress =
                    particle.progress;

                const base = flux.curve
                    ? flux.curve.getPointAt(progress)
                    : new THREE.Vector3().copy(flux.start).addScaledVector(flux.direction, progress * flux.length);

                const wave =
                    Math.sin(
                        time * 2.2 +
                        particle.phase
                    ) *
                    flux.jitter *
                    0.35;

                const wave2 =
                    Math.cos(
                        time * 1.7 +
                        particle.phase
                    ) *
                    flux.jitter *
                    0.25;

                base.addScaledVector(
                    flux.lateral,
                    particle.offsetA +
                    wave
                );

                base.addScaledVector(
                    flux.lateral2,
                    particle.offsetB +
                    wave2
                );

                const position = flux.particlePoints.geometry.attributes.position;
                const index = particle.index * 3;
                position.array[index] = base.x;
                position.array[index + 1] = base.y;
                position.array[index + 2] = base.z;
            }
            if (flux.particlePoints) {
                flux.particlePoints.geometry.attributes.position.needsUpdate = true;
                flux.particleMaterial.opacity = Math.min(0.98, 0.68 + flux.intensity * 0.1 + Math.sin(time * 2) * 0.04);
            }
        }
    }

    // ============================================================
    // SUPPRESSION DES FLUX DE PARTICULES
    // ============================================================

    function clearParticleFluxes() {

        if (
            !_particleFluxes
        ) {

            return;
        }

        for (
            const flux of
            _particleFluxes
        ) {

            if (
                !flux ||
                !flux.group
            ) {

                continue;
            }

            if (
                _sceneGroup
            ) {

                _sceneGroup.remove(
                    flux.group
                );
            }

            flux.group.traverse(
                node => {

                    if (
                        node.geometry
                    ) {

                        node.geometry.dispose();
                    }

                    if (
                        node.material
                    ) {

                        const materials =
                            Array.isArray(
                                node.material
                            )
                                ? node.material
                                : [
                                    node.material
                                ];

                        materials.forEach(
                            material => {

                                material.dispose();
                            }
                        );
                    }
                }
            );
        }

        _particleFluxes =
            [];
    }

    // ============================================================
    // ⬇️⬇️⬇️ FIN PARTIE 5/6 ⬇️⬇️⬇️
    // ⚠️ COLLEZ LA PARTIE 6/6 IMMÉDIATEMENT APRÈS CETTE LIGNE ⚠️
    // ============================================================
    // ============================================================
    // ⬇️⬇️⬇️ PARTIE 6/6 — FINALE DE gis3d.js ⬇️⬇️⬇️
    // ============================================================

    // ============================================================
    // CRÉATION DES CONNEXIONS CP
    // ============================================================

    function createCPConnections(
        connectionData
    ) {

        if (
            !connectionData ||
            connectionData.length < 2
        ) {

            return;
        }

        const systems = {};

        for (
            const item of
            connectionData
        ) {

            const sysId =
                item.systemId ||
                'default';

            if (
                !systems[sysId]
            ) {

                systems[sysId] =
                    [];
            }

            systems[sysId].push(
                item
            );
        }

        for (
            const [
                sysId,
                items
            ]
            of Object.entries(
                systems
            )
        ) {

            const rectifier =
                items.find(
                    i =>
                        i.type ===
                        'rectifier'
                );

            const groundbeds =
                items.filter(
                    i =>
                        i.type ===
                        'groundbed'
                );

            const anodes =
                items.filter(
                    i =>
                        i.type ===
                        'anode'
                );

            if (
                rectifier &&
                groundbeds.length > 0
            ) {

                for (
                    const gb of
                    groundbeds
                ) {

                    const start =
                        new THREE.Vector3(
                            rectifier.position.x,
                            rectifier.position.y,
                            rectifier.position.z
                        );

                    const end =
                        new THREE.Vector3(
                            gb.position.x,
                            gb.position.y,
                            gb.position.z
                        );

                    const mid =
                        new THREE.Vector3()
                            .addVectors(
                                start,
                                end
                            )
                            .multiplyScalar(
                                0.5
                            );

                    mid.y +=
                        0.5;

                    const curve =
                        new THREE.QuadraticBezierCurve3(
                            start,
                            mid,
                            end
                        );

                    const points =
                        curve.getPoints(
                            20
                        );

                    const geometry =
                        new THREE
                            .BufferGeometry()
                            .setFromPoints(
                                points
                            );

                    const material =
                        new THREE
                            .LineBasicMaterial({

                                color:
                                    CONFIG
                                        .colors
                                        .cable,

                                transparent:
                                    true,

                                opacity:
                                    0.72,

                                linewidth:
                                    1,

                                depthTest:
                                    true
                            });

                    const line =
                        new THREE.Line(
                            geometry,
                            material
                        );

                    line.renderOrder =
                        5;

                    _sceneGroup.add(
                        line
                    );
                }
            }

            if (
                groundbeds.length >
                    0 &&
                anodes.length >
                    0
            ) {

                for (
                    const gb of
                    groundbeds
                ) {

                    for (
                        const anode of
                        anodes
                    ) {

                        const start =
                            new THREE.Vector3(
                                gb.position.x,
                                gb.position.y,
                                gb.position.z
                            );

                        const end =
                            new THREE.Vector3(
                                anode.position.x,
                                anode.position.y,
                                anode.position.z
                            );

                        const mid =
                            new THREE.Vector3()
                                .addVectors(
                                    start,
                                    end
                                )
                                .multiplyScalar(
                                    0.5
                                );

                        mid.y +=
                            0.3;

                        const curve =
                            new THREE
                                .QuadraticBezierCurve3(
                                    start,
                                    mid,
                                    end
                                );

                        const points =
                            curve.getPoints(
                                20
                            );

                        const geometry =
                            new THREE
                                .BufferGeometry()
                                .setFromPoints(
                                    points
                                );

                        const material =
                            new THREE
                                .LineBasicMaterial({

                                    color:
                                        CONFIG
                                            .colors
                                            .groundbed,

                                    transparent:
                                        true,

                                    opacity:
                                        0.58,

                                    depthTest:
                                        true
                                });

                        const line =
                            new THREE.Line(
                                geometry,
                                material
                            );

                        line.renderOrder =
                            5;

                        _sceneGroup.add(
                            line
                        );
                    }
                }
            }
        }
    }

    // ============================================================
    // RECHERCHE DES ÉQUIPEMENTS COMPATIBLES AVEC LE FLUX
    // ============================================================

    function findPipelineObjects() {

        const result = [];

        for (
            const id in _objects
        ) {

            const object =
                _objects[id];

            if (
                !object
            ) {

                continue;
            }

            const type =
                String(
                    object
                        .userData
                        ?.type ||
                    ''
                ).toLowerCase();

            if (type.includes('pipeline') || object.userData?.objectKind === 'tank') {

                result.push(
                    object
                );
            }
        }

        return result;
    }

    function findGroundbedObjects() {

        const result = [];

        for (
            const id in _objects
        ) {

            const object =
                _objects[id];

            if (
                !object
            ) {

                continue;
            }

            const type =
                String(
                    object
                        .userData
                        ?.type ||
                    ''
                ).toLowerCase();

            if (
                type === 'groundbed' ||
                type === 'puits_anodique' ||
                type === 'anodic_well'
            ) {

                result.push(
                    object
                );
            }
        }

        return result;
    }

    // ============================================================
    // ASSOCIATION PUITS ANODIQUES ↔ PIPELINES
    // ============================================================

    function createPipelineToAnodeFluxes() {

        clearParticleFluxes();

        const pipelines =
            findPipelineObjects();

        const groundbeds =
            findGroundbedObjects();

        if (
            pipelines.length === 0 ||
            groundbeds.length === 0
        ) {

            console.log(
                '[Gis3D] Aucun couple puits/structure disponible pour le flux particulaire.'
            );

            return;
        }

        let createdCount = 0;
        for (
            const groundbed of
            groundbeds
        ) {
            for (
                const pipeline of
            pipelines
            ) {

                const flux = createParticleFlux(
                    pipeline,
                    groundbed
                );
                if (flux) createdCount++;
            }
        }

        console.log('[Gis3D] Flux puits → structures créés :', createdCount);
    }

    // ============================================================
    // CHARGEMENT DES DONNÉES (CORRIGÉ - désactive le filtre système en mode tous projets)
    // ============================================================

    async function _loadDataInternal(projectId) {

        if (
            _isLoading
        ) {

            _pendingProjectId =
                projectId;

            return;
        }

        _isLoading =
            true;

        const currentVersion =
            ++_loadVersion;

        Gis3D.whenReady()
            .then(async () => {

                if (
                    currentVersion !==
                    _loadVersion
                ) {

                    _isLoading =
                        false;

                    if (
                        _pendingProjectId !==
                        null
                    ) {

                        const next =
                            _pendingProjectId;

                        _pendingProjectId =
                            null;

                        _loadDataInternal(
                            next
                        );
                    }

                    return;
                }

                try {

                    // --- CORRECTION : désactiver le filtre système en mode tous projets ---
                    if (projectId === '__all__') {
                        _systemFilter = null;
                    }

                    clearScene();

                    const equipments = await getValidEquipments(projectId);

                    if (
                        equipments.length ===
                        0
                    ) {

                        _isLoading =
                            false;

                        return;
                    }

                    const {
                        valid
                    } =
                        getEquipmentsWithValidGPS(
                            equipments
                        );

                    if (
                        valid.length ===
                        0
                    ) {

                        _isLoading =
                            false;

                        return;
                    }

                    // --- Détermination du projet de référence pour le centrage ---
                    let referenceProjectId = null;
                    if (projectId === '__all__') {
                        const projects = ProjectManager.getProjectsList();
                        if (projects && projects.length > 0) {
                            // On prend le premier projet comme référence
                            referenceProjectId = projects[0].id;
                        }
                    }

                    const coords =
                        convertCoordinates(
                            valid,
                            referenceProjectId
                        );

                    if (
                        Object.keys(
                            coords
                        ).length ===
                        0
                    ) {

                        _isLoading =
                            false;

                        return;
                    }

                    _sceneGroup.add(
                        createGroundPlane()
                    );

                    let objectCount =
                        0;

                    const connectionData =
                        [];

                    for (
                        const eq of
                        valid
                    ) {

                        const points =
                            coords[
                                eq.id
                            ];

                        if (
                            !points ||
                            points.length ===
                            0
                        ) {

                            continue;
                        }

                        let group =
                            null;

                        switch (
                            String(
                                eq.type ||
                                ''
                            ).toLowerCase()
                        ) {

                            case 'pipeline_enterre':

                            case 'pipeline_offshore':

                            case 'pipeline':

                                group =
                                    createPipeline(
                                        eq,
                                        points
                                    );

                                break;

                            case 'rectifier':

                            case 'redresseur':

                                group =
                                    createRectifier(
                                        eq,
                                        points[0]
                                    );

                                break;

                            case 'groundbed':

                            case 'puits_anodique':

                            case 'anodic_well':

                                group =
                                    createGroundbed(
                                        eq,
                                        points
                                    );

                                break;

                            case 'anode':

                            case 'anode_sacrificielle':

                            case 'sacrificial_anode':

                                group =
                                    createAnode(
                                        eq,
                                        points[0]
                                    );

                                break;

                            case 'reservoir_fond':

                            case 'reservoir_toit':

                            case 'ballon_souterrain':

                            case 'tank':

                            case 'reservoir':

                                group = createTank(eq, getTankCenterPoint(points));

                                break;

                            default:

                                group =
                                    createGeneric(
                                        eq,
                                        points[0]
                                    );

                                break;
                        }

                        if (
                            group
                        ) {

                            _sceneGroup.add(
                                group
                            );

                            _objects[
                                eq.id
                            ] =
                                group;

                            _objectMap.set(
                                eq.id,
                                group
                            );

                            objectCount++;

                            if (
                                eq.type ===
                                    'rectifier' ||
                                eq.type ===
                                    'redresseur' ||
                                eq.type ===
                                    'groundbed' ||
                                eq.type ===
                                    'puits_anodique' ||
                                eq.type ===
                                    'anode' ||
                                eq.type ===
                                    'anode_sacrificielle' ||
                                eq.type ===
                                    'sacrificial_anode'
                            ) {

                                connectionData
                                    .push({
                                        id:
                                            eq.id,

                                        type:
                                            eq.type,

                                        position:
                                            points[0],

                                        systemId:
                                            eq.systemId,

                                        projectId:
                                            eq.projectId
                                    });
                            }
                        }
                    }

                    if (
                        objectCount ===
                        0
                    ) {

                        _isLoading =
                            false;

                        return;
                    }

                    migrateLabelPositions(
                        valid,
                        _objects
                    );

                    createCPConnections(
                        connectionData
                    );

                    requestAnimationFrame(
                        () => {

                            createPipelineToAnodeFluxes();
                        }
                    );

                    setTimeout(
                        () =>
                            fitView(),
                        100
                    );

                    setTimeout(
                        () =>
                            fitView(),
                        400
                    );

                    document.dispatchEvent(
                        new CustomEvent(
                            'gis3d:loaded',
                            {
                                detail: {
                                    count:
                                        objectCount,

                                    projectId:
                                        projectId
                                }
                            }
                        )
                    );

                    _isLoading =
                        false;

                    if (
                        _pendingProjectId !==
                        null
                    ) {

                        const next =
                            _pendingProjectId;

                        _pendingProjectId =
                            null;

                        _loadDataInternal(
                            next
                        );
                    }

                } catch (
                    error
                ) {

                    console.error(
                        '[Gis3D] Erreur:',
                        error
                    );

                    _isLoading =
                        false;
                }
            });
    }

    // ============================================================
    // LOAD DATA AVEC DEBOUNCE
    // ============================================================

    const loadData =
        debounce(
            function(projectId) {

                let targetProjectId =
                    projectId;

                if (
                    projectId === 'all' ||
                    projectId ===
                        '__all__'
                ) {

                    targetProjectId =
                        '__all__';
                }

                if (
                    projectId ===
                    'proj001'
                ) {

                    targetProjectId =
                        'PROJ-001';
                }

                if (
                    projectId ===
                    'proj002'
                ) {

                    targetProjectId =
                        'PROJ-002';
                }

                _currentProjectId =
                    targetProjectId;

                _allProjectsMode =
                    targetProjectId ===
                    '__all__';

                _loadDataInternal(
                    targetProjectId
                );

            },
            CONFIG.LOAD_DEBOUNCE_MS
        );

    // ============================================================
    // CAMÉRA
    // ⚠️ CORRECTIF : guard renforcé sur Box3 (size ET center)
    // ============================================================

    function fitView() {

        if (
            !_sceneGroup ||
            !_camera ||
            !_controls
        ) {

            return;
        }

        _sceneGroup.updateMatrixWorld(
            true
        );

        const points = [];

        _objectMap.forEach((obj, id) => {
            if (obj.userData?.pipelinePoints && obj.userData.pipelinePoints.length > 0) {
                obj.userData.pipelinePoints.forEach(p => points.push(p));
            } else if (obj.position) {
                points.push(obj.position);
            }
        });

        let box = new THREE.Box3();

        if (points.length > 0) {
            try {
                box.setFromPoints(points);
            } catch (e) {
                console.warn('[Gis3D] fitView: erreur setFromPoints:', e.message);
            }
        } else {
            try {
                box.setFromObject(_sceneGroup);
            } catch (e) {
                console.warn('[Gis3D] fitView: erreur setFromObject:', e.message);
            }
        }

        const size =
            box.getSize(
                new THREE.Vector3()
            );

        const center =
            box.getCenter(
                new THREE.Vector3()
            );

        // ⚠️ CORRECTIF : guard renforcé sur size ET center
        if (
            size.length() <
                0.01 ||
            !isFinite(size.x) ||
            !isFinite(size.y) ||
            !isFinite(size.z) ||
            !isFinite(center.x) ||
            !isFinite(center.y) ||
            !isFinite(center.z)
        ) {

            _camera.position.set(
                20,
                15,
                20
            );

            _controls.target.set(
                0,
                0,
                0
            );

            _controls.update();

            return;
        }

        const maxDim =
            Math.max(
                size.x,
                size.y,
                size.z
            );

        const distance =
            Math.max(
                maxDim * 1.2,
                10
            );

        _camera.position.set(
            center.x +
                distance * 0.7,

            center.y +
                distance * 0.5,

            center.z +
                distance * 0.7
        );

        _controls.target.copy(
            center
        );

        _controls.update();
    }

    function resetView() {

        fitView();
    }

    // ============================================================
    // GESTION DES ÉQUIPEMENTS
    // ============================================================

    function addEquipment(
        equipment
    ) {

        if (
            !_sceneGroup
        ) {

            return;
        }

        loadData(
            _currentProjectId
        );
    }

    function removeEquipment(
        equipmentId
    ) {

        clearParticleFluxes();

        const obj =
            _objectMap.get(
                equipmentId
            );

        if (
            obj
        ) {

            _sceneGroup.remove(
                obj
            );

            _objectMap.delete(
                equipmentId
            );

            delete _objects[
                equipmentId
            ];

            requestAnimationFrame(
                () =>
                    createPipelineToAnodeFluxes()
            );

            fitView();
        }
    }

    function updateEquipment(
        equipment
    ) {

        removeEquipment(
            equipment.id
        );

        addEquipment(
            equipment
        );
    }

    // ============================================================
    // NETTOYAGE COMPLET DE LA SCÈNE
    // ============================================================

    function clearScene() {

        clearParticleFluxes();

        if (
            _sceneGroup
        ) {

            while (
                _sceneGroup.children
                    .length > 0
            ) {

                const child =
                    _sceneGroup
                        .children[0];

                _sceneGroup.remove(
                    child
                );

                child.traverse(
                    (
                        node
                    ) => {

                        if (
                            node.geometry
                        ) {

                            node.geometry
                                .dispose();
                        }

                        if (
                            node.material
                        ) {

                            const materials =
                                Array.isArray(
                                    node.material
                                )
                                    ? node.material
                                    : [
                                        node.material
                                    ];

                            materials.forEach(
                                material => {

                                    if (
                                        material.map
                                    ) {

                                        material.map
                                            .dispose();
                                    }

                                    material.dispose();
                                }
                            );
                        }
                    }
                );
            }
        }

        _objects = {};

        _objectMap.clear();

        _particleFluxes =
            [];
    }

    // ============================================================
    // RENDU
    // ============================================================

    function startRenderLoop() {

        if (
            _renderLoopId
        ) {

            return;
        }

        let lastTime =
            performance.now();

        function animate() {

            const now =
                performance.now();

            const deltaTime =
                Math.min(
                    (
                        now -
                        lastTime
                    ) /
                    1000,
                    0.05
                );

            lastTime =
                now;

            if (
                _controls
            ) {

                _controls.update();
            }

            updateParticleFluxes(
                deltaTime
            );

            if (
                _renderer &&
                _scene &&
                _camera
            ) {

                _renderer.render(
                    _scene,
                    _camera
                );
            }

            _renderLoopId =
                requestAnimationFrame(
                    animate
                );
        }

        animate();
    }

    function stopRenderLoop() {

        if (
            _renderLoopId
        ) {

            cancelAnimationFrame(
                _renderLoopId
            );

            _renderLoopId =
                null;
        }
    }

    // ============================================================
    // SOUS-SOL (désactivé dans cette version)
    // ============================================================

    function enableSubsurface(
        depth
    ) {

        console.warn(
            '[Gis3D] Sous-sol désactivé dans cette version pour garantir le rendu réaliste.'
        );
    }

    function disableSubsurface() {

        console.warn(
            '[Gis3D] Sous-sol désactivé.'
        );
    }

    function toggleSubsurface(
        depth
    ) {

        console.warn(
            '[Gis3D] Sous-sol désactivé.'
        );

        return false;
    }

    // ============================================================
    // DÉSACTIVATION DES MODULES CONCURRENTS
    // ⚠️ CORRECTIF : exécution unique via flag _concurrentModulesDisabled
    // ============================================================

    function disableConcurrentModules() {

        // ⚠️ CORRECTIF : n'exécuter qu'UNE SEULE FOIS
        if (
            _concurrentModulesDisabled
        ) {

            return;
        }

        _concurrentModulesDisabled =
            true;

        if (
            window.Simulation3D
        ) {

            try {

                window.Simulation3D
                    .stop();

            } catch (
                e
            ) {}

            try {

                window.Simulation3D
                    .clear();

            } catch (
                e
            ) {}
        }

        if (
            window.Subsurface
        ) {

            try {

                window.Subsurface
                    .disable();

            } catch (
                e
            ) {}
        }

        console.log(
            '[Gis3D] Modules concurrents désactivés (une seule fois).'
        );
    }

    // ============================================================
    // API PUBLIQUE
    // ============================================================

    const Gis3D = {

        // Version du module 3D (cycle de vie indépendant)
        VERSION: '15.6.0',

        init:
            function() {

                return _isInitialized
                    ? _isReady
                    : initScene();
            },

        whenReady:
            function() {

                return new Promise(
                    (
                        resolve
                    ) => {

                        if (
                            _isReady
                        ) {

                            resolve({
                                scene:
                                    _scene,

                                camera:
                                    _camera,

                                renderer:
                                    _renderer,

                                controls:
                                    _controls
                            });

                        } else {

                            _readyCallbacks
                                .push(
                                    resolve
                                );

                            if (
                                !_isInitialized
                            ) {

                                initScene();
                            }
                        }
                    }
                );
            },

        isReady:
            function() {

                return _isReady;
            },

        getScene:
            function() {

                return _scene;
            },

        getCamera:
            function() {

                return _camera;
            },

        getRenderer:
            function() {

                return _renderer;
            },

        getControls:
            function() {

                return _controls;
            },

        // ============================================================
        // AJOUT POUR MINI-CARTE
        // ============================================================
        getMiniMap: function() {
            if (!_miniMapInstance) {
                initMiniMap();
            }
            return _miniMapInstance;
        },

        updateMiniMapMarkers: function(equipments) {
            if (!_miniMapInstance) return;
            document.dispatchEvent(new CustomEvent('miniMapUpdateRequested', { detail: { equipments } }));
        },

        getConfig:
            function() {

                return CONFIG;
            },

        loadData:
            function(
                projectId
            ) {

                disableConcurrentModules();

                loadData(
                    projectId
                );
            },

        updateData:
            function() {

                loadData(
                    _currentProjectId
                );
            },

        addEquipment:
            function(
                equipment
            ) {

                addEquipment(
                    equipment
                );
            },

        removeEquipment:
            function(
                equipmentId
            ) {

                removeEquipment(
                    equipmentId
                );
            },

        updateEquipment:
            function(
                equipment
            ) {

                updateEquipment(
                    equipment
                );
            },

        clearScene:
            function() {

                clearScene();
            },

        resetView:
            function() {

                resetView();
            },

        startRenderLoop:
            function() {

                startRenderLoop();
            },

        stopRenderLoop:
            function() {

                stopRenderLoop();
            },

        enableSubsurface:
            function(
                depth
            ) {

                enableSubsurface(
                    depth
                );
            },

        disableSubsurface:
            function() {

                disableSubsurface();
            },

        toggleSubsurface:
            function(
                depth
            ) {

                return toggleSubsurface(
                    depth
                );
            },

        isSubsurfaceEnabled:
            function() {

                return false;
            },

        setSystemFilter:
            function(
                systemId
            ) {

                _systemFilter =
                    systemId;

                if (
                    _currentProjectId
                ) {

                    loadData(
                        _currentProjectId
                    );
                }
            },

        getObject:
            function(
                equipmentId
            ) {

                return _objectMap.get(
                    equipmentId
                );
            },

        getObjects:
            function() {

                return _objects;
            },

        getCurrentProjectId:
            function() {

                return _currentProjectId;
            },

        createParticleFluxes:
            function() {

                createPipelineToAnodeFluxes();
            },

        clearParticleFluxes:
            function() {

                clearParticleFluxes();
            },

        getParticleFluxes:
            function() {

                return _particleFluxes;
            }
    };

    // ============================================================
    // EXPOSITION
    // ============================================================

    window.Gis3D =
        Gis3D;

    // ============================================================
    // DOM READY
    // ============================================================

    document.addEventListener('DOMContentLoaded', function() {
        const module3d = document.getElementById('module-visualisation3d');
        if (module3d && module3d.classList.contains('active')) {
            setTimeout(() => {
                Gis3D.init();
                // === AJOUT : initialisation de la mini‑carte ===
                initMiniMap();
                // =============================================
                setTimeout(() => {
                    try {
                        const projectId = ProjectManager.getCurrentProjectId();
                        if (projectId) {
                            Gis3D.loadData(projectId);
                        }
                    } catch (error) {
                        console.warn('[Gis3D] ProjectManager indisponible au démarrage:', error);
                        Gis3D.loadData('__all__');
                    }
                }, 300);
            }, 300);
        }
    });

    // ============================================================
    // CHANGEMENT DE MODULE
    // ============================================================

    document.addEventListener(
        'moduleChanged',
        function(e) {

            if (
                e.detail?.moduleId ===
                'visualisation3d'
            ) {

                setTimeout(
                    () => {

                        Gis3D.init();

                        setTimeout(
                            () => {

                                try {

                                    Gis3D.loadData(
                                        ProjectManager
                                            .getCurrentProjectId() ||
                                        '__all__'
                                    );

                                } catch (
                                    error
                                ) {

                                    console.warn(
                                        '[Gis3D] Impossible de récupérer le projet courant:',
                                        error
                                    );

                                    Gis3D.loadData(
                                        '__all__'
                                    );
                                }

                            },
                            300
                        );

                    },
                    300
                );
            }
        }
    );

    // ============================================================
    // CHARGEMENT D'UN PROJET
    // ============================================================

    document.addEventListener(
        'projectLoaded',
        function(e) {

            const module3d =
                document.getElementById(
                    'module-visualisation3d'
                );

            if (
                module3d &&
                module3d.classList.contains(
                    'active'
                )
            ) {

                setTimeout(
                    () => {

                        Gis3D.init();

                        setTimeout(
                            () => {

                                Gis3D.loadData(
                                    e.detail
                                        ?.projectId
                                );

                            },
                            300
                        );

                    },
                    300
                );
            }
        }
    );

    // ============================================================
    // LOG FINAL
    // ============================================================

    console.log(
        '[Gis3D] Module visualisation 3D v15.6 chargé : correctifs NaN, mini-carte avec retry, disableConcurrentModules unique, fitView guard.'
    );

})();

// ============================================================
// FIN DE gis3d.js (VERSION 15.6 – TOUS CORRECTIFS APPLIQUÉS)
// ============================================================