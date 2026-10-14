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
            // Câbles DC du TR : positif (TR → puits anodique) vs
            // négatif (TR → structures protégées) — différenciation visuelle.
            cablePositive: 0x2e8b57, // vert
            cableNegative: 0xf97316, // orange (même teinte que le marqueur TR 2D)
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
            // Profondeur visuelle max du puits : valeur d'origine rétablie (90 → 20).
            // Un puits de ~20 unités monde reste lisible comme « profond » sans
            // exagération ni débordement du cadre de la scène.
            groundbedMaxDepth: 20,
            groundbedMinDepth: 0.3,

            pipelineScale: 1.0,
            pipelineLengthFactor: 1.0,

            // Rayon fixe conservé pour compatibilité, mais sera remplacé par le calcul dynamique
            forcedPipelineRadius: 1.5,
            markerRadius: 0.0,

            // Rayon visuel des câbles DC (unités monde)
            // 2026-10 : réduit de 50 % (0.05 → 0.025) pour un rendu plus fin.
            cableRadius: 0.025,

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
    let _lastCoordTransform = null;

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
    // PLAN DE SOL — distinction visuelle au-dessus / sous le sol
    // Surface horizontale semi-transparente à la ligne de sol (y = 0).
    // Sépare la vue aérienne du volume souterrain tout en laissant voir
    // le puits anodique et le flux d'électrons en transparence (effet
    // physique réaliste et pédagogique). Ajouté à _sceneGroup → libéré
    // automatiquement par clearScene(). Idempotent (anti-doublon).
    // ============================================================
    function _addGroundSurfacePlane() {
        if (!_sceneGroup) return;
        if (_sceneGroup.getObjectByName('GroundSurfacePlane')) return;

        const groundPlaneGeo = new THREE.PlaneGeometry(400, 400);
        const groundPlaneMat = new THREE.MeshBasicMaterial({
            color: 0x6b5a3e, // teinte terre/sable discrète
            transparent: true,
            opacity: 0.22, // transparence souterraine modérée
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const groundPlane = new THREE.Mesh(groundPlaneGeo, groundPlaneMat);
        groundPlane.rotation.x = -Math.PI / 2; // horizontal
        groundPlane.position.y = 0; // ligne de sol
        groundPlane.name = 'GroundSurfacePlane';
        groundPlane.renderOrder = -1; // arrière-plan (sous équipements/flux)
        _sceneGroup.add(groundPlane);

        // ── VOLUME SOUTERRAIN « FANTÔME » (X-Ray) ──
        // Grand volume translucide sous la ligne de sol : donne une brume
        // souterraine subtile (jamais un vide noir) afin que les équipements
        // enterrés ressortent par contraste. Matériau non éclairé (teinte
        // constante), opacité minimale + depthWrite false → n'occulte RIEN.
        if (!_sceneGroup.getObjectByName('UndergroundGhostVolume')) {
            const ghostW = 400;
            const ghostH = 30;
            const ghostGeo = new THREE.BoxGeometry(ghostW, ghostH, ghostW);
            const ghostMat = new THREE.MeshBasicMaterial({
                color: 0x33507a, // teinte bleue froide (brume souterraine)
                transparent: true,
                opacity: 0.08, // très faible : voit à travers, jamais opaque
                side: THREE.DoubleSide,
                depthWrite: false
            });
            const ghost = new THREE.Mesh(ghostGeo, ghostMat);
            ghost.position.y = -ghostH / 2; // de y=0 (sol) vers le bas
            ghost.name = 'UndergroundGhostVolume';
            ghost.renderOrder = -2; // juste derrière le plan de sol
            _sceneGroup.add(ghost);
        }
    }

    // ============================================================
    // PASSAGE GLOBAL « X-RAY » DES MATÉRIAUX
    // Parcourt la scène et garantit, pour CHAQUE élément (pipeline, câbles,
    // anodes, puits, plan de sol, drapeaux, etc.) :
    //   • side = DoubleSide  → désactive le backface culling (rien de caché
    //     selon l'angle de vue, y compris vue de dessous) ;
    //   • si transparent → depthWrite = false → pas d'écriture Z-buffer sur
    //     les surfaces translucides (X-ray, tri de profondeur auto Three.js).
    // Les sprites (étiquettes) sont exclus (déjà always-facing, non éclairés).
    // N'altère NI la géométrie, NI les couleurs, NI les positions.
    // ============================================================
    function _applyXRayRenderFlags() {
        if (!_sceneGroup) return;
        _sceneGroup.traverse((node) => {
            if (!node.isMesh) return;
            const materials = Array.isArray(node.material)
                ? node.material
                : [node.material];
            materials.forEach((mat) => {
                if (!mat) return;
                // Désactive le backface culling (visible depuis tout angle).
                if ('side' in mat) mat.side = THREE.DoubleSide;
                // Surfaces transparentes : pas d'écriture Z-buffer (X-ray).
                if (mat.transparent === true && 'depthWrite' in mat) {
                    mat.depthWrite = false;
                }
                mat.needsUpdate = true;
            });
        });
    }



    // ============================================================
    // OPTIM PERF (audit MAJEUR-4) : cache de géométries partagées
    // ============================================================
    // Plusieurs meshes 3D (redresseurs, soudures, puits anodiques…)
    // utilisent des géométries à paramètres CONSTANTS identiques
    // (ex: BoxGeometry du redresseur). Les recréer à chaque
    // chargement de projet gaspille de la mémoire GPU et allonge le
    // clearScene(). On mutualise donc ces géométries via un cache clé.
    //
    // SÉCURITÉ : une géométrie partagée est marquée userData._shared.
    // clearScene() NE dispose PAS ces géométries (sinon les meshes
    // suivants pointeraient vers une géométrie détruite). Seuls les
    // matériaux (propres à chaque mesh, modifiés par le passage X-Ray)
    // continuent d'être disposés. Aucun impact visuel : géométrie
    // identique, simplement réutilisée.
    const _geometryCache = new Map();
    function getSharedGeometry(key, factory) {
        if (_geometryCache.has(key)) {
            return _geometryCache.get(key);
        }
        const geo = factory();
        if (geo) {
            geo.userData = geo.userData || {};
            geo.userData._shared = true;
            _geometryCache.set(key, geo);
        }
        return geo;
    }

    // ============================================================
    // OPTIM PERF (audit MOYEN-6) : résolution de rendu adaptative
    // ============================================================
    // Détermine le devicePixelRatio maximal à utiliser pour le renderer,
    // selon les capacités détectées (mobile / petit écran / GPU intégré).
    // But : "render less" — rasteriser moins de pixels sans dégrader
    // l'expérience sur les appareils concernés. Aucun impact sur la
    // géométrie, les matériaux, les ombres ou la logique CP.
    let _adaptivePixelRatio = null;
    function _computeAdaptivePixelRatio() {
        if (_adaptivePixelRatio !== null) return _adaptivePixelRatio;

        const dpr = window.devicePixelRatio || 1;
        let isLowEnd = false;
        try {
            isLowEnd = window.matchMedia('(max-width: 768px)').matches;
            if (!isLowEnd) {
                // Sonde GPU (même heuristique que simulation3d.js)
                const probe = document.createElement('canvas');
                const gl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
                if (gl) {
                    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                    if (dbg) {
                        const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
                        const lowGPUs = ['Intel HD', 'Intel UHD', 'Intel Iris', 'Mali', 'Adreno', 'PowerVR'];
                        isLowEnd = lowGPUs.some(g => renderer && renderer.includes(g));
                    }
                }
            }
        } catch (e) { /* dégradation sûre : on considère haut de gamme */ }

        // Mobile / GPU faible -> 1.0 ; sinon plafond 1.5 (net sur écran HiDPI,
        // bien moins coûteux que 2.0).
        _adaptivePixelRatio = isLowEnd ? 1.0 : Math.min(dpr, 1.5);
        return _adaptivePixelRatio;
    }

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

        // OPTIM PERF (audit MOYEN-6) : résolution de rendu adaptée aux
        // capacités. Sur mobile ou GPU intégré faible, on plafonne le
        // devicePixelRatio à 1 (au lieu de 2) : jusqu'à 4x moins de pixels
        // à rasteriser par frame, sans impact perceptible sur ces écrans.
        // Sur desktop, on reste à un plafond raisonnable de 1.5.
        // Aucun changement des ombres, du lissage ou de la géométrie.
        _renderer.setPixelRatio(
            _computeAdaptivePixelRatio()
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

        // ── ÉCLAIRAGE SOUTERRAIN (X-Ray) ──
        // Les équipements enterrés (puits, anodes, câbles, pipelines) étaient
        // mal éclairés car toutes les lumières sont au-dessus du sol. On ajoute
        // un éclairage souterrain ADDITIF (ambiance + ponctuelles sous le sol)
        // pour qu'ils restent visibles et éclairés sous tout angle de caméra.
        // Ajouté à _scene (pas _sceneGroup) → persiste malgré clearScene().
        const undergroundAmbient =
            new THREE.AmbientLight(
                0x5b6b82,
                0.55
            );
        undergroundAmbient.name = 'UndergroundAmbient';
        _scene.add(
            undergroundAmbient
        );

        const undergroundPoint1 =
            new THREE.PointLight(
                0x9fc4ff,
                1.2,
                80,
                1.5
            );
        undergroundPoint1.position.set(
            0,
            -10,
            0
        );
        undergroundPoint1.name = 'UndergroundPoint1';
        _scene.add(
            undergroundPoint1
        );

        const undergroundPoint2 =
            new THREE.PointLight(
                0x9fc4ff,
                0.9,
                80,
                1.5
            );
        undergroundPoint2.position.set(
            20,
            -15,
            15
        );
        undergroundPoint2.name = 'UndergroundPoint2';
        _scene.add(
            undergroundPoint2
        );

        // Ponctuelles supplémentaires réparties (côtés / sous le sol) pour une
        // couverture omnidirectionnelle : aucun côté obscur en orbite libre ou
        // en vue de dessous. Additives, ajoutées à _scene (persistantes).
        const orbitFill1 =
            new THREE.PointLight(
                0xbcd6ff,
                0.8,
                120,
                1.5
            );
        orbitFill1.position.set(
            -35,
            -6,
            -25
        );
        orbitFill1.name = 'OrbitFill1';
        _scene.add(
            orbitFill1
        );

        const orbitFill2 =
            new THREE.PointLight(
                0xbcd6ff,
                0.7,
                120,
                1.5
            );
        orbitFill2.position.set(
            25,
            -20,
            -30
        );
        orbitFill2.name = 'OrbitFill2';
        _scene.add(
            orbitFill2
        );

        _sceneGroup =
            new THREE.Group();

        _scene.add(
            _sceneGroup
        );

        // Plan de sol (distinction au-dessus / sous le sol). Recréé ici à
        // l'init ET après chaque clearScene() dans _loadDataInternal.
        _addGroundSurfacePlane();

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
    // ALIGNEMENT TR-OPTIMAL SUR L'EMPRISE DU PIPELINE (conformité CP)
    // Doit rester identique à gisIntegration.js (computeTROptimalAlignedPosition).
    // ============================================================
    const _TR_ALIGN_TARGET_PIPELINE_TAG = 'EMK-14';
    const _TR_ALIGN_OFFSET_M = 30; // Décalage perpendiculaire visuel (mètres)
    const _EARTH_RADIUS_M = 6371000;
    const _DEG_TO_RAD = Math.PI / 180;
    const _RAD_TO_DEG = 180 / Math.PI;

    function _toLocalMeters(lat, lon, refLat) {
        const x = lon * _DEG_TO_RAD * _EARTH_RADIUS_M * Math.cos(refLat * _DEG_TO_RAD);
        const z = lat * _DEG_TO_RAD * _EARTH_RADIUS_M;
        return { x, z };
    }

    function _fromLocalMeters(x, z, refLat) {
        const lon = x / (_EARTH_RADIUS_M * Math.cos(refLat * _DEG_TO_RAD)) * _RAD_TO_DEG;
        const lat = z / _EARTH_RADIUS_M * _RAD_TO_DEG;
        return { lat, lon };
    }

    function _snapPointToPolyline(point, polyline, offsetM = 0) {
        if (!point || !Array.isArray(polyline) || polyline.length === 0) return null;
        if (!isFinite(point.lat) || !isFinite(point.lon)) return null;
        const valid = polyline.filter(p => p && isFinite(p.lat) && isFinite(p.lon));
        if (valid.length === 0) return null;
        const refLat = point.lat;
        const p = _toLocalMeters(point.lat, point.lon, refLat);
        if (valid.length === 1) return { lat: valid[0].lat, lon: valid[0].lon };
        let bestDistSq = Infinity;
        let bestProjX = 0, bestProjZ = 0, bestAbx = 0, bestAbz = 0, bestAbLen = 0;
        for (let i = 0; i < valid.length - 1; i++) {
            const a = _toLocalMeters(valid[i].lat, valid[i].lon, refLat);
            const b = _toLocalMeters(valid[i + 1].lat, valid[i + 1].lon, refLat);
            const abx = b.x - a.x, abz = b.z - a.z;
            const apx = p.x - a.x, apz = p.z - a.z;
            const abLenSq = abx * abx + abz * abz;
            let t = 0;
            if (abLenSq > 1e-9) {
                t = (apx * abx + apz * abz) / abLenSq;
                if (t < 0) t = 0;
                if (t > 1) t = 1;
            }
            const projX = a.x + abx * t;
            const projZ = a.z + abz * t;
            const dx = projX - p.x, dz = projZ - p.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestProjX = projX; bestProjZ = projZ;
                bestAbx = abx; bestAbz = abz; bestAbLen = Math.sqrt(abLenSq);
            }
        }
        let outX = bestProjX, outZ = bestProjZ;
        // Décalage perpendiculaire visuel : évite que le TR ne repose exactement
        // sur le tracé (« à cheval »). Appliqué du même côté que le point d'origine
        // (déplacement minimal). Cohérent avec gisIntegration.js.
        if (offsetM && bestAbLen > 1e-9) {
            const nx = -bestAbz / bestAbLen;
            const nz = bestAbx / bestAbLen;
            const vx = p.x - bestProjX, vz = p.z - bestProjZ;
            const side = (vx * nx + vz * nz) >= 0 ? 1 : -1;
            outX = bestProjX + nx * offsetM * side;
            outZ = bestProjZ + nz * offsetM * side;
        }
        return _fromLocalMeters(outX, outZ, refLat);
    }
    // Modifie sur place equipmentPoints[id] du TR-OPTIMAL : son point est
    // remplacé par la projection sur le tracé du pipeline cible (EMK-14),
    // ou du pipeline le plus proche si EMK-14 est absent. Cohérence 3D/2D.
    function _alignTROptimalOnPipeline(equipments, equipmentPoints, allPoints) {
        try {
            if (!Array.isArray(equipments) || !equipmentPoints) return;

            const tr = equipments.find(eq =>
                eq.type === 'rectifier' &&
                (String(eq.tag || '').toUpperCase().indexOf('TR-OPTIMAL') !== -1 ||
                 String(eq.tag || '').toUpperCase().indexOf('TR OPTIMAL') !== -1)
            );
            if (!tr) return;

            const trPts = equipmentPoints[tr.id];
            if (!trPts || trPts.length === 0) return;
            const trPoint = trPts[0];

            const pipelines = equipments.filter(eq =>
                eq.type === 'pipeline_enterre' || eq.type === 'pipeline_offshore'
            );
            if (pipelines.length === 0) return;

            let target = pipelines.find(eq =>
                String(eq.tag || '').toUpperCase().indexOf(
                    _TR_ALIGN_TARGET_PIPELINE_TAG.toUpperCase()
                ) !== -1
            );

            if (!target) {
                let bestDist = Infinity;
                for (const pl of pipelines) {
                    const plPts = equipmentPoints[pl.id];
                    if (!plPts || plPts.length === 0) continue;
                    const snapped = _snapPointToPolyline(trPoint, plPts);
                    if (!snapped) continue;
                    const refLat = trPoint.lat;
                    const a = _toLocalMeters(trPoint.lat, trPoint.lon, refLat);
                    const b = _toLocalMeters(snapped.lat, snapped.lon, refLat);
                    const d = (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);
                    if (d < bestDist) { bestDist = d; target = pl; }
                }
            }

            if (!target) return;
            const targetPts = equipmentPoints[target.id];
            if (!targetPts || targetPts.length === 0) return;

            const snapped = _snapPointToPolyline(trPoint, targetPts, _TR_ALIGN_OFFSET_M);
            if (!snapped) return;

            equipmentPoints[tr.id] = [{ lat: snapped.lat, lon: snapped.lon, alt: 0 }];
            // Met aussi à jour allPoints (utilisé pour centre/échelle) afin que
            // le centrage 3D reste cohérent avec la position snapée du TR.
            if (Array.isArray(allPoints)) {
                for (let i = 0; i < allPoints.length; i++) {
                    if (allPoints[i].projectId === tr.projectId &&
                        Math.abs(allPoints[i].lat - trPoint.lat) < 1e-9 &&
                        Math.abs(allPoints[i].lon - trPoint.lon) < 1e-9) {
                        allPoints[i].lat = snapped.lat;
                        allPoints[i].lon = snapped.lon;
                    }
                }
            }
            console.log(
                `[Gis3D] TR-OPTIMAL aligné sur l'emprise de ${target.tag || target.id} : ` +
                `(${trPoint.lat.toFixed(6)}, ${trPoint.lon.toFixed(6)}) -> ` +
                `(${snapped.lat.toFixed(6)}, ${snapped.lon.toFixed(6)})`
            );
        } catch (err) {
            console.warn('[Gis3D] Erreur _alignTROptimalOnPipeline:', err);
        }
    }

    // ============================================================
    // SÉPARATION VISUELLE DU TR-OPTIMAL (3D UNIQUEMENT)
    // Le tube du pipeline est tracé avec un rayon VISUEL (diamètre réel ×
    // pipelineVisualRadiusScale) exprimé en unités monde : après mise à
    // l'échelle de la scène, ce rayon est très souvent bien plus grand que
    // le décalage géographique (30 m) appliqué par _alignTROptimalOnPipeline.
    // Le marqueur du TR apparaît alors « confondu » avec le pipeline.
    // Après conversion GPS → monde 3D, on garantit donc une distance
    // minimale entre le centre du marqueur TR et l'axe de chaque pipeline :
    //   distance ≥ rayon du tube + demi-diagonale du marqueur + marge
    //   (marge ≥ 1 rayon de tube → interstice nettement visible).
    // Ajustement de rendu 3D uniquement : les coordonnées GPS stockées,
    // la cartographie 2D et l'optimisation électrique ne sont pas touchées.
    // ============================================================
    const _TR_VISUAL_MIN_GAP_FACTOR = 1.0; // marge de visibilité = facteur × rayon du tube (min 0.1 unité)

    // Point {x, z} d'une polyline monde (vue de dessus, plan XZ) le plus
    // proche de (px, pz) : projeté sur le segment le plus proche (t borné).
    function _closestOnWorldPolyline(px, pz, pts) {
        if (!Array.isArray(pts) || pts.length === 0) return null;

        if (pts.length === 1) {
            const dx = px - pts[0].x;
            const dz = pz - pts[0].z;
            return {
                x: pts[0].x,
                z: pts[0].z,
                distSq: dx * dx + dz * dz,
                abx: 0,
                abz: 0,
                abLen: 0
            };
        }

        let best = null;
        for (let i = 0; i < pts.length - 1; i++) {
            const ax = pts[i].x;
            const az = pts[i].z;
            const abx = pts[i + 1].x - ax;
            const abz = pts[i + 1].z - az;
            const apx = px - ax;
            const apz = pz - az;

            const abLenSq = abx * abx + abz * abz;
            let t = 0;
            if (abLenSq > 1e-12) {
                t = (apx * abx + apz * abz) / abLenSq;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
            }

            const cx = ax + abx * t;
            const cz = az + abz * t;
            const dx = px - cx;
            const dz = pz - cz;
            const distSq = dx * dx + dz * dz;

            if (!best || distSq < best.distSq) {
                best = {
                    x: cx,
                    z: cz,
                    distSq,
                    abx,
                    abz,
                    abLen: Math.sqrt(abLenSq)
                };
            }
        }
        return best;
    }

    // Garantit une séparation visuelle minimale (unités monde) entre le
    // marqueur du TR-OPTIMAL et l'axe des pipelines, après conversion.
    // Modifie uniquement les points 3D convertis (finalResult).
    function _enforceTRVisualSeparation(finalResult, equipments) {
        try {
            if (!finalResult || !Array.isArray(equipments)) return;

            const tr = equipments.find(eq =>
                eq.type === 'rectifier' &&
                (String(eq.tag || '').toUpperCase().indexOf('TR-OPTIMAL') !== -1 ||
                 String(eq.tag || '').toUpperCase().indexOf('TR OPTIMAL') !== -1)
            );
            if (!tr) return;

            const trPts = finalResult[tr.id];
            if (!trPts || trPts.length === 0) return;
            const trW = trPts[0];
            if (!trW || !isFinite(trW.x) || !isFinite(trW.z)) return;

            const pipelines = equipments.filter(eq =>
                eq.type === 'pipeline_enterre' || eq.type === 'pipeline_offshore'
            );
            if (pipelines.length === 0) return;

            // Demi-diagonale du marqueur (armoire rectangulaire) dans le plan XZ.
            const boxHalf = Math.sqrt(
                CONFIG.sizes.rectifierWidth * CONFIG.sizes.rectifierWidth +
                CONFIG.sizes.rectifierDepth * CONFIG.sizes.rectifierDepth
            ) / 2;

            const candidates = [];
            for (const pl of pipelines) {
                const plW = finalResult[pl.id];
                if (!plW || plW.length === 0) continue;
                const c = _closestOnWorldPolyline(trW.x, trW.z, plW);
                if (c) candidates.push({ pipeline: pl, pts: plW, initDistSq: c.distSq });
            }
            if (candidates.length === 0) return;

            // Du plus lointain au plus proche : la pipeline la plus proche
            // (celle du projet / EMK-14) est traitée en dernier afin que sa
            // contrainte de séparation soit celle qui reste satisfaite.
            candidates.sort((a, b) => b.initDistSq - a.initDistSq);

            let moved = false;
            for (const item of candidates) {
                const c = _closestOnWorldPolyline(trW.x, trW.z, item.pts);
                if (!c) continue;

                // Rayon visuel du tube : même formule que createPipeline()
                // (diamètre réel × pipelineVisualRadiusScale, repli 0.3 m).
                const realDiameter = safeNumber(item.pipeline?.dimensions?.diametre_m, 0.3);
                const tubeRadius = Math.max(
                    (realDiameter / 2) * CONFIG.pipelineVisualRadiusScale,
                    0.02
                );
                // Distance minimale axe du tube ↔ centre du marqueur :
                // rayon du tube + demi-diagonale du marqueur + marge visible.
                const clearance = Math.max(
                    tubeRadius * _TR_VISUAL_MIN_GAP_FACTOR,
                    0.1
                );
                const required = tubeRadius + boxHalf + clearance;

                if (c.distSq >= required * required) continue;

                let dx = trW.x - c.x;
                let dz = trW.z - c.z;
                let d = Math.sqrt(dx * dx + dz * dz);

                if (d < 1e-9) {
                    // TR pile sur l'axe : on pousse le long de la normale
                    // du segment (ou de l'axe X si le segment est un point).
                    if (c.abLen > 1e-12) {
                        dx = -c.abz / c.abLen;
                        dz = c.abx / c.abLen;
                    } else {
                        dx = 1;
                        dz = 0;
                    }
                } else {
                    dx /= d;
                    dz /= d;
                }

                // Côté inchangé (déplacement minimal), distance = required.
                trW.x = c.x + dx * required;
                trW.z = c.z + dz * required;
                // y (altitude apparente) inchangé.
                moved = true;
            }

            if (moved) {
                console.log(
                    `[Gis3D] Séparation visuelle du TR-OPTIMAL appliquée : ` +
                    `position monde (${trW.x.toFixed(3)}, ${trW.z.toFixed(3)})`
                );
            }
        } catch (err) {
            console.warn('[Gis3D] Erreur _enforceTRVisualSeparation:', err);
        }
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

        // ============================================================
        // CONFORMITÉ CP : aligner le TR-OPTIMAL sur l'emprise du pipeline
        // cible (EMK-14) — identique à la cartographie 2D (gisIntegration.js).
        // Corrige l'incohérence 3D/2D : le TR est projeté sur le tracé.
        // ============================================================
        _alignTROptimalOnPipeline(equipments, equipmentPoints, allPoints);

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

        // Sauvegarde de la transformation globale de référence pour les éléments ponctuels (zones critiques, etc.)
        _lastCoordTransform = {
            centerLon,
            centerLat,
            centerAlt,
            scale
        };

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

        // Séparation visuelle minimale du TR-OPTIMAL (3D uniquement) :
        // garantit un écart net marqueur ↔ tube une fois la mise à l'échelle
        // appliquée (le rayon visuel du tube peut être plus grand que le
        // décalage géographique de 30 m). Ne touche ni aux coordonnées GPS
        // ni au centre/échelle de la scène.
        _enforceTRVisualSeparation(finalResult, equipments);

        return finalResult;
    }

    // ============================================================
    // CONVERSION GPS -> MONDE 3D
    // ============================================================
    function gpsToWorld3D(lat, lon, alt = 0) {
        if (!_lastCoordTransform) return null;
        const { centerLon, centerLat, centerAlt, scale } = _lastCoordTransform;
        return new THREE.Vector3(
            (lon - centerLon) * scale,
            (alt - centerAlt) * scale,
            (lat - centerLat) * scale
        );
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
                    0.5,            // minimum abaissé (ancien: 2.4)
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
    // UTILITAIRE : NORMALISATION DES POINTS PIPELINE (factor = 1 = pas d'étirement)
    // CORRECTIF: L'ancien factor=3 étirait le pipeline mais pas les anodes,
    // causant un décalage visuel majeur en 3D. On conserve les vraies coords GPS.
    // ============================================================

    function extendPipelinePoints(
        points,
        factor = 1.0
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

        // factor = 1.0 : renvoie les points tels quels (coordonnées GPS converties fidèles)
        // Cela garantit que pipeline et anodes restent dans le même espace de coordonnées
        if (factor === 1.0) {
            return validPoints.map(
                p => new THREE.Vector3(p.x, p.y, p.z)
            );
        }

        const source =
            validPoints.map(
                p =>
                    new THREE.Vector3(
                        p.x,
                        p.y,
                        p.z
                    )
            );

        const first = source[0];
        const last  = source[source.length - 1];

        const center =
            new THREE.Vector3()
                .addVectors(first, last)
                .multiplyScalar(0.5);

        return source.map(
            p =>
                new THREE.Vector3(
                    center.x + (p.x - center.x) * factor,
                    center.y + (p.y - center.y) * factor,
                    center.z + (p.z - center.z) * factor
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

        // OPTIM PERF (audit MAJEUR-4) : géométrie du redresseur mutualisée
        // (params constants CONFIG.sizes). Réutilisée entre tous les
        // redresseurs et les chargements, sans dispose dans clearScene.
        const boxGeometry =
            getSharedGeometry(
                `box_rectifier_${w}_${h}_${d}`,
                () => new THREE.BoxGeometry(w, h, d)
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
            // Transparence souterraine MODÉRÉE (0.12 → 0.42) : le puits et son
            // lit d'anodes restent visibles à travers le sol, tout en gardant un
            // rendu clairement souterrain (effet physique réaliste et pédagogique).
            opacity: 0.42,
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
                    // Double-face : anode enterrée visible sous tout angle.
                    side: THREE.DoubleSide,
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
    // CRÉATION DE L'ANODE SACRIFICIELLE — PHYSIQUE CP RIGOUREUSE
    // Conforme DNV-RP-B401 / ISO 15589-1 / NACE SP0169
    // Pattern rotatif 4-positions → couverture 360° de la surface
    // ============================================================

    function createAnode(equipment, point, pipelineDir, anodeIndex) {

        const group = new THREE.Group();
        group.name = `anode_${equipment.id}`;

        // ── 1. Direction PERPENDICULAIRE au pipeline (dans le plan horizontal) ──
        // pipelineDir = vecteur tangent local au pipeline (normalisé)
        const pDir = (pipelineDir && pipelineDir.length() > 0.001)
            ? pipelineDir.clone().setY(0).normalize()
            : new THREE.Vector3(0, 0, 1);  // fallback axe Z

        // Perpendiculaire horizontale = rotation 90° autour axe Y
        const perpDir = new THREE.Vector3(-pDir.z, 0, pDir.x).normalize();

        // ── 2. Sélection du quadrant selon l'index (rotation 4-positions) ──
        const idx     = (typeof anodeIndex === 'number') ? anodeIndex : 0;
        const pattern = idx % 4;
        const D = 0.55;  // distance latérale anode-pipeline (m)

        let lateralSign, depthOffset;
        switch (pattern) {
            case 0: lateralSign = +1; depthOffset =  0.00; break; // DROITE  3h
            case 1: lateralSign = -1; depthOffset =  0.00; break; // GAUCHE  9h
            case 2: lateralSign = +1; depthOffset = -0.07; break; // BAS-DR  5h
            case 3: lateralSign = -1; depthOffset = -0.07; break; // BAS-GA  7h
        }

        // Vecteur offset en espace monde (perpendiculaire au pipeline)
        const offsetVec = perpDir.clone().multiplyScalar(lateralSign * D);

        // ── 3. Dimensions du lingot d'anode (type DNV) ──
        const anodeLength = 0.28;
        const anodeRadius = 0.04;
        const burialY = depthOffset - 0.05;   // légèrement enterrée

        // ── 4. Corps de l'anode (lingot horizontal teinté légèrement rouge/cuivre) ──
        const anodeGeo = new THREE.CylinderGeometry(
            anodeRadius, anodeRadius * 0.82, anodeLength, 10
        );
        const anodeMat = new THREE.MeshStandardMaterial({
            color:             new THREE.Color(0xb56565), // Teinte légèrement rouge/cuivrée pour différencier du pipeline
            emissive:          new THREE.Color(0x2a0808),
            emissiveIntensity: 0.12,
            metalness:         0.45,
            roughness:         0.70
        });
        const anodeMesh = new THREE.Mesh(anodeGeo, anodeMat);

        // Aligner le lingot PARALLÈLE au pipeline (rotation autour axe Z + orientation pipeline)
        const angle = Math.atan2(pDir.x, pDir.z);
        anodeMesh.rotation.set(0, angle, Math.PI / 2);
        anodeMesh.position.set(0, burialY, 0);
        group.add(anodeMesh);

        // ── 5. Câble de liaison anode → génératrice pipeline (cuivre) ──
        const cableLocalStart = new THREE.Vector3(0, burialY, 0);
        const cableLocalEnd   = new THREE.Vector3(-offsetVec.x, burialY * 0.3, -offsetVec.z);
        const cableMid        = new THREE.Vector3(
            (-offsetVec.x) * 0.5,
            burialY * 0.3 + 0.05,
            (-offsetVec.z) * 0.5
        );
        const cableCurve = new THREE.QuadraticBezierCurve3(cableLocalStart, cableMid, cableLocalEnd);
        const cableGeo   = new THREE.TubeGeometry(
            new THREE.CatmullRomCurve3(cableCurve.getPoints(14)), 14, 0.005, 6, false
        );
        const cableMat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(0xb87333), metalness: 0.82, roughness: 0.30,
            emissive: new THREE.Color(0x1a0800), emissiveIntensity: 0.10
        });
        group.add(new THREE.Mesh(cableGeo, cableMat));

        // ── 6. Point de soudure thermite sur la génératrice ──
        const weldMesh = new THREE.Mesh(
            // OPTIM PERF (audit MAJEUR-4) : sphère de soudure mutualisée
            // (params constants). Le matériau reste propre à chaque mesh.
            getSharedGeometry('sphere_weld_0.011_7_7', () => new THREE.SphereGeometry(0.011, 7, 7)),
            new THREE.MeshStandardMaterial({
                color: new THREE.Color(0xffd700), metalness: 0.92, roughness: 0.18,
                emissive: new THREE.Color(0x332200), emissiveIntensity: 0.25
            })
        );
        weldMesh.position.copy(cableLocalEnd);
        group.add(weldMesh);

        // ── 7. Étiquette discrète ──
        group.add(createTextLabel(
            equipment.tag || 'Anode',
            getLabelPosition(equipment, new THREE.Vector3(0, 0.09, 0), point),
            '#1e3a5f', 0.12
        ));

        // ── 8. Positionnement en espace monde (offset perpendiculaire au pipeline) ──
        group.position.set(
            point.x + offsetVec.x,
            point.y,
            point.z + offsetVec.z
        );

        group.userData = {
            equipmentId: equipment.id,
            type:        equipment.type,
            tag:         equipment.tag,
            projectId:   equipment.projectId,
            height:      anodeLength,
            burialDepth: burialY,
            anodeIndex:  idx,
            pattern:     ['DROITE(3h)', 'GAUCHE(9h)', 'BAS-DROITE(5h)', 'BAS-GAUCHE(7h)'][pattern]
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
    // CRÉATION DU DRAPEAU DE ZONE CRITIQUE (RENFORCEMENT ANODES)
    // ============================================================

    function createCriticalZoneMarker3D(zone, worldPos) {
        const group = new THREE.Group();
        const zoneId = zone.id || ('cz_' + Math.random().toString(36).substr(2, 6));
        group.name = `critical_zone_${zoneId}`;

        // 1. Mât vertical métallique (flagpole)
        const poleHeight = 1.6;
        const poleRadius = 0.016;
        const poleGeo = new THREE.CylinderGeometry(poleRadius, poleRadius, poleHeight, 10);
        const poleMat = new THREE.MeshStandardMaterial({
            color: 0x94a3b8,
            metalness: 0.85,
            roughness: 0.25
        });
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.y = poleHeight / 2;
        group.add(pole);

        // 2. Drapeau orange triangulaire (Orange flag #ea580c)
        const flagShape = new THREE.Shape();
        flagShape.moveTo(0, 0);
        flagShape.lineTo(0.42, -0.15);
        flagShape.lineTo(0, -0.30);
        flagShape.closePath();

        const flagGeo = new THREE.ShapeGeometry(flagShape);
        const flagMat = new THREE.MeshStandardMaterial({
            color: 0xea580c,
            emissive: 0x9a3412,
            emissiveIntensity: 0.55,
            side: THREE.DoubleSide,
            roughness: 0.35
        });
        const flagMesh = new THREE.Mesh(flagGeo, flagMat);
        flagMesh.position.set(0.015, poleHeight - 0.02, 0);
        group.add(flagMesh);

        // 3. Boule sommitale dorée
        const finialGeo = new THREE.SphereGeometry(0.035, 12, 12);
        const finialMat = new THREE.MeshStandardMaterial({
            color: 0xf59e0b,
            emissive: 0x78350f,
            emissiveIntensity: 0.6,
            metalness: 0.9,
            roughness: 0.15
        });
        const finial = new THREE.Mesh(finialGeo, finialMat);
        finial.position.y = poleHeight;
        group.add(finial);

        // 4. Disque / Anneau d'alerte orange au sol (Warning beacon ring)
        const ringGeo = new THREE.RingGeometry(0.12, 0.42, 32);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xea580c,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.70
        });
        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = -Math.PI / 2;
        ringMesh.position.y = 0.02;
        group.add(ringMesh);

        // 5. Étiquette 3D au dessus du drapeau
        const anodes = zone.anodesCount || Math.max(1, Math.ceil(safeNumber(zone.additionalCurrent, 0.5) / 0.3));
        const labelText = `🚩 ${zone.name || 'Zone Critique'} (+${safeNumber(zone.additionalCurrent, 0.5).toFixed(1)}A | ${anodes} anodes)`;
        const label = createTextLabel(
            labelText,
            new THREE.Vector3(0, poleHeight + 0.28, 0),
            '#c2410c',
            0.18
        );
        group.add(label);

        // 6. Positionnement dans l'espace monde
        group.position.set(worldPos.x, worldPos.y || 0, worldPos.z);
        group.userData = {
            id: zoneId,
            tag: zone.name,
            type: 'critical_zone',
            isCriticalZone: true,
            zoneData: zone
        };

        return group;
    }

    function renderCriticalZones3D(projectId, equipments) {
        try {
            const state = (typeof ProjectManager !== 'undefined' && ProjectManager.getState) ? ProjectManager.getState() : {};
            let reinforcementZones = [];
            const isAllProjects = (projectId === '__all__' || !projectId);

            if (isAllProjects) {
                if (state.iccp && state.iccp.reinforcementZones) {
                    reinforcementZones.push(...state.iccp.reinforcementZones);
                }
            } else {
                if (state.iccp && state.iccp.reinforcementZones) {
                    reinforcementZones.push(...state.iccp.reinforcementZones);
                }
            }

            if (!reinforcementZones || reinforcementZones.length === 0) return;

            let addedCount = 0;
            reinforcementZones.forEach(zone => {
                let lat = zone.lat;
                let lon = zone.lon;

                // Fallback de géolocalisation si pas de coordonnées directes
                if (lat === null || lat === undefined || lon === null || lon === undefined) {
                    if (zone.location && equipments && equipments.length > 0) {
                        const match = equipments.find(e => e.tag && e.tag.toLowerCase().includes(zone.location.toLowerCase()));
                        if (match) {
                            const c = getEquipmentCoordinates(match);
                            if (c && c.length > 0) { lat = c[0].lat; lon = c[0].lon; }
                            else if (c && c.lat !== undefined) { lat = c.lat; lon = c.lon; }
                        }
                    }
                }

                if (lat !== null && lat !== undefined && lon !== null && lon !== undefined) {
                    const worldPos = gpsToWorld3D(lat, lon, 0);
                    if (worldPos) {
                        const marker3D = createCriticalZoneMarker3D(zone, worldPos);
                        _sceneGroup.add(marker3D);
                        _objects['critical_zone_' + (zone.id || addedCount)] = marker3D;
                        _objectMap.set('critical_zone_' + (zone.id || addedCount), marker3D);
                        addedCount++;
                    }
                }
            });

            if (addedCount > 0) {
                console.log(`[Gis3D] ${addedCount} zone(s) critique(s) avec drapeaux d'alerte ajoutée(s) à la scène 3D.`);
            }
        } catch (e) {
            console.warn('[Gis3D] Erreur lors du rendu des zones critiques 3D:', e);
        }
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

        // ── CORRECTIF PHYSIQUE CP (flux d'électrons) ──
        // Le courant est émis par les ANODES situées au FOND du puits anodique
        // (sous la surface du sol), puis traverse le sol pour atteindre les
        // structures à protéger. La source du flux est donc la colonne anodique
        // en profondeur — PAS le sommet (surface) du puits.
        const gbType = String(
            sourceObject
                .userData
                ?.type || ''
        ).toLowerCase();
        if (
            gbType === 'groundbed' ||
            gbType === 'puits_anodique' ||
            gbType === 'anodic_well'
        ) {
            const FLUX_ANODE_SOURCE_FACTOR = 0.5; // centre de la colonne anodique (~ milieu du puits)
            // userData.totalDepth = profondeur VISUELLE réelle (finalDepth),
            // déjà clampée par createGroundbed → cohérence géométrie/flux.
            const wellDepth = Math.max(
                safeNumber(
                    sourceObject
                        .userData
                        ?.totalDepth,
                    20
                ),
                1
            );
            sourcePosition.y -= wellDepth * FLUX_ANODE_SOURCE_FACTOR;
        }

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

                // Visibilité du trajet de courant (0.12 → 0.45) : les liaisons
                // d'électrons deviennent nettes, en jaune, conformément à la
                // visualisation de référence.
                opacity: 0.45,

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
    // CÂBLES DC 3D — RENDU TUBE + ÉTIQUETTES (TR OPTIMAL)
    // ------------------------------------------------------------
    // Materialise les liaisons électriques du TR optimal :
    //   • positif  TR → puits anodique (groundbed)
    //   • négatifs TR → structures protégées (pipelines, réservoirs)
    // Les longueurs affichées proviennent EXCLUSIVEMENT de
    // CableLengthEngine (mêmes options que l'UI : marge 10 %, stratégie
    // 'worst') → cohérence stricte avec les estimations existantes.
    // Aucun calcul métier dupliqué, aucune modification 2D.
    // ============================================================

    /**
     * Trace un câble DC visible : tube le long d'une QuadraticBezier avec
     * un léger arc (« mou » du câble). Retourne le mesh (ou null).
     */
    function _drawCableLink(start, end, options) {
        if (!start || !end) return null;
        if (!isFinite(start.x) || !isFinite(start.y) || !isFinite(start.z) ||
            !isFinite(end.x) || !isFinite(end.y) || !isFinite(end.z)) return null;

        const opts = options || {};
        const color = isFinite(opts.color) ? opts.color : CONFIG.colors.cable;
        const lift = isFinite(opts.lift) ? opts.lift : 0.5;
        const radius = isFinite(opts.radius)
            ? opts.radius
            : Math.max(safeNumber(CONFIG.sizes.cableRadius, 0.025), 0.005);

        const s = new THREE.Vector3(start.x, start.y, start.z);
        const e = new THREE.Vector3(end.x, end.y, end.z);
        const mid = new THREE.Vector3().addVectors(s, e).multiplyScalar(0.5);
        mid.y += lift;

        const curve = new THREE.QuadraticBezierCurve3(s, mid, e);
        const geometry = new THREE.TubeGeometry(curve, 48, radius, 8, false);
        const material = new THREE.MeshStandardMaterial({
            color: color,
            metalness: 0.35,
            roughness: 0.5,
            emissive: new THREE.Color(color),
            emissiveIntensity: 0.25,
            transparent: true,
            opacity: 0.95,
            // Double-face : câble enterré visible sous tout angle de caméra.
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 5;

        if (_sceneGroup) _sceneGroup.add(mesh);
        return mesh;
    }

    /** Point médian surélevé d'un câble (position d'une étiquette). */
    function _cableMidPoint(a, b, lift) {
        return new THREE.Vector3(
            (a.x + b.x) / 2,
            (a.y + b.y) / 2 + (isFinite(lift) ? lift : 0.5) + 0.15,
            (a.z + b.z) / 2
        );
    }

    /**
     * Étiquette de longueur de câble (sprite canvas existant).
     * textColor (défaut '#0f172a') permet d'associer la couleur du texte
     * à celle du câble (vert POS / orange NEG).
     */
    function _addCableLabel(text, position, textColor) {
        try {
            const label = createTextLabel(
                text,
                position,
                textColor || '#0f172a',
                0.5
            );
            if (label && _sceneGroup) _sceneGroup.add(label);
        } catch (err) {
            console.warn('[Gis3D] Étiquette câble impossible:', err);
        }
    }

    /**
     * Longueurs de câbles via CableLengthEngine (lecture seule).
     * Sélection TR/GB/structures identique à computeFromProjectState()
     * avec priorité au tag TR-OPTIMAL. Retourne null si indisponible
     * (createTRCableLinks basculera alors en tracé géométrique sans
     * étiquette — aucun nombre inventé).
     */
    function _computeSceneCableLengths(valid) {
        try {
            if (typeof CableLengthEngine === 'undefined' ||
                typeof CableLengthEngine.computeCableLengths !== 'function') {
                return null;
            }
            if (!Array.isArray(valid) || valid.length === 0) return null;

            const trEq = valid.find(eq =>
                eq.type === 'rectifier' &&
                (String(eq.tag || '').toUpperCase().indexOf('TR-OPTIMAL') !== -1 ||
                 String(eq.tag || '').toUpperCase().indexOf('TR OPTIMAL') !== -1) &&
                getEquipmentCoordinates(eq).length > 0
            ) || valid.find(eq =>
                eq.type === 'rectifier' && getEquipmentCoordinates(eq).length > 0
            );
            if (!trEq) return null;

            const gbEq = valid.find(eq =>
                (eq.type === 'groundbed' || eq.type === 'puits_anodique') &&
                eq.projectId === trEq.projectId &&
                getEquipmentCoordinates(eq).length > 0
            );
            if (!gbEq) return null;

            const structures = valid.filter(eq => {
                if (eq.projectId !== trEq.projectId) return false;
                const t = String(eq.type || '').toLowerCase();
                return (t === 'pipeline_enterre' || t === 'pipeline_offshore' ||
                        t === 'reservoir_fond' || t === 'reservoir_toit' ||
                        t === 'tank' || t === 'reservoir') &&
                       getEquipmentCoordinates(eq).length > 0;
            });
            if (structures.length === 0) return null;

            const structData = structures.map(eq => ({
                id: eq.tag || eq.id,
                coordinates: getEquipmentCoordinates(eq),
                type: eq.type
            }));

            // Options identiques à UI.tryAutoComputeCableLength() et
            // ICCPOptimizationEngine (enrichWithCableLengths).
            return CableLengthEngine.computeCableLengths(
                getEquipmentCoordinates(trEq)[0],
                getEquipmentCoordinates(gbEq)[0],
                structData,
                { marginPercent: 10, negativeStrategy: 'worst' }
            );
        } catch (err) {
            console.warn('[Gis3D] _computeSceneCableLengths:', err);
            return null;
        }
    }

    /**
     * Câbles DC du TR optimal (après createCPConnections) :
     *  - TR → GB si createCPConnections ne l'a pas tracé (systemId
     *    divergents) → liaison garantie, aucun doublon ;
     *  - TR → chaque structure de negative.perPipeline, ancrée au
     *    nearestPoint exact du moteur (raccord réel sur le tracé).
     * Étiquettes = roundedM du moteur (cohérence UI / result cards).
     */
    function createTRCableLinks(valid, coords, cableLengths, drawnTRIds) {
        try {
            if (!Array.isArray(valid) || !coords) return;

            const trEq = valid.find(eq =>
                eq.type === 'rectifier' &&
                (String(eq.tag || '').toUpperCase().indexOf('TR-OPTIMAL') !== -1 ||
                 String(eq.tag || '').toUpperCase().indexOf('TR OPTIMAL') !== -1) &&
                coords[eq.id] && coords[eq.id].length > 0
            ) || valid.find(eq =>
                eq.type === 'rectifier' && coords[eq.id] && coords[eq.id].length > 0
            );
            if (!trEq) return;

            const trW = coords[trEq.id][0];
            const alreadyDrawn = (drawnTRIds instanceof Set) && drawnTRIds.has(trEq.id);

            // ── Câble positif TR → puits anodique ──
            const gbEq = valid.find(eq =>
                (eq.type === 'groundbed' || eq.type === 'puits_anodique') &&
                eq.projectId === trEq.projectId &&
                coords[eq.id] && coords[eq.id].length > 0
            );
            if (gbEq) {
                const gbW = coords[gbEq.id][0];
                if (!alreadyDrawn) {
                    // Câble POSITIF TR → puits anodique : vert.
                    _drawCableLink(trW, gbW, {
                        color: CONFIG.colors.cablePositive,
                        lift: 0.5
                    });
                }
                if (cableLengths && cableLengths.positive &&
                    isFinite(cableLengths.positive.roundedM)) {
                    _addCableLabel(
                        'POS TR→GB : ' + cableLengths.positive.roundedM + ' m',
                        _cableMidPoint(trW, gbW, 0.5),
                        '#166534' // vert foncé (texte lisible)
                    );
                }
            }

            // ── Câbles négatifs TR → structures protégées ──
            const perPipeline = (cableLengths && cableLengths.negative &&
                Array.isArray(cableLengths.negative.perPipeline))
                ? cableLengths.negative.perPipeline : null;

            if (perPipeline && perPipeline.length > 0) {
                // Liste blanche structures : JAMAIS d'anode sacrificielle
                // (renfort Critical Area) en cible d'un câble TR — conformité
                // CP : les anodes de renfort se soudent au pipeline uniquement.
                const STRUCTURE_TARGET_TYPES = [
                    'pipeline_enterre', 'pipeline_offshore',
                    'reservoir_fond', 'reservoir_toit', 'tank', 'reservoir'
                ];
                for (const item of perPipeline) {
                    const target = valid.find(eq =>
                        STRUCTURE_TARGET_TYPES.indexOf(String(eq.type || '').toLowerCase()) !== -1 &&
                        (eq.tag === item.id || eq.id === item.id) &&
                        coords[eq.id] && coords[eq.id].length > 0
                    );
                    if (!target) continue;
                    const pts = coords[target.id];

                    // Ancre = nearestPoint retenu par le moteur (sommet du
                    // tracé, sur le tube CatmullRom → raccord exact).
                    let anchor = null;
                    if (item.nearestPoint &&
                        isFinite(item.nearestPoint.lat) &&
                        isFinite(item.nearestPoint.lon)) {
                        anchor = gpsToWorld3D(item.nearestPoint.lat, item.nearestPoint.lon, 0);
                    }
                    if (!anchor || !isFinite(anchor.x) || !isFinite(anchor.z)) {
                        const c = _closestOnWorldPolyline(trW.x, trW.z, pts);
                        if (!c) continue;
                        anchor = new THREE.Vector3(c.x, pts[0].y || 0, c.z);
                    }

                    // Câble NÉGATIF TR → structure : orange.
                    _drawCableLink(trW, anchor, {
                        color: CONFIG.colors.cableNegative,
                        lift: 0.35
                    });

                    if (isFinite(item.roundedM)) {
                        _addCableLabel(
                            'NEG ' + (target.tag || target.id) + ' : ' + item.roundedM + ' m',
                            _cableMidPoint(trW, anchor, 0.35),
                            '#9a3412' // orange foncé (texte lisible)
                        );
                    }
                }
            } else {
                // Repli sans moteur : câbles géométriques (aucune longueur
                // affichée — pas de valeur inventée).
                for (const eq of valid) {
                    if (eq.projectId !== trEq.projectId) continue;
                    const t = String(eq.type || '').toLowerCase();
                    if (t !== 'pipeline_enterre' && t !== 'pipeline_offshore' &&
                        t !== 'reservoir_fond' && t !== 'reservoir_toit' &&
                        t !== 'tank' && t !== 'reservoir') continue;
                    const pts = coords[eq.id];
                    if (!pts || pts.length === 0) continue;
                    const c = _closestOnWorldPolyline(trW.x, trW.z, pts);
                    if (!c) continue;
                    _drawCableLink(
                        trW,
                        new THREE.Vector3(c.x, pts[0].y || 0, c.z),
                        // Repli = liaisons négatives TR → structures : orange.
                        { color: CONFIG.colors.cableNegative, lift: 0.35 }
                    );
                }
            }
        } catch (err) {
            console.warn('[Gis3D] createTRCableLinks:', err);
        }
    }

    // ============================================================
    // CRÉATION DES CONNEXIONS CP
    // ============================================================

    function createCPConnections(
        connectionData
    ) {

        // IDs des TR pour lesquels un câble TR→GB a été tracé : permet à
        // createTRCableLinks d'éviter tout doublon (zéro câble en double).
        const _drawnTRIds = new Set();

        if (
            !connectionData ||
            connectionData.length < 2
        ) {

            return _drawnTRIds;
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

            // NOTE CP : les anodes sacrificielles de renfort (zones Critical
            // Area Reinforcement, type 'anode') ne sont PAS raccordées ici.
            // Elles se soudent directement à la génératrice du pipeline
            // (liaison cuivre rendue par createAnode) — jamais au TR ni au
            // groundbed. Aucun câble TR/groundbed → anode, y compris via
            // connectionData (types 'anode' non collectés).

            if (
                rectifier &&
                groundbeds.length > 0
            ) {

                _drawnTRIds.add(
                    rectifier.id
                );

                for (
                    const gb of
                    groundbeds
                ) {

                    // Câble positif TR → puits anodique : tube visible vert
                    // (l'ancienne Line 1 px était quasi invisible).
                    _drawCableLink(
                        rectifier.position,
                        gb.position,
                        {
                            color: CONFIG.colors.cablePositive,
                            lift: 0.5
                        }
                    );
                }
            }

            // (bloc supprimé : câble groundbed → anode sacrificielle —
            // incohérent en CP, voir note ci-dessus)
        }

        return _drawnTRIds;
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

                    // Recrée le plan de sol (supprimé par clearScene) pour
                    // conserver la distinction au-dessus / sous le sol.
                    _addGroundSurfacePlane();

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

                    const connectionData = [];

                    console.log('[Gis3D-DIAG] valid equipments:', valid.length, valid.map(e=>e.type));
                    console.log('[Gis3D-DIAG] coords keys:', Object.keys(coords).length);

                    // ── Pré-calcul : directions locales des pipelines pour le placement réaliste des anodes ──
                    // Nécessaire pour calculer l'offset PERPENDICULAIRE au tracé réel du pipeline
                    // et maximiser la couverture du champ électrique sur toute la surface (360°)
                    const pipelineDirections = []; // [{point, dir}] pour interpolation
                    for (const eq of valid) {
                        const eqType = String(eq.type || '').toLowerCase();
                        if (eqType === 'pipeline_enterre' || eqType === 'pipeline_offshore' || eqType === 'pipeline') {
                            const pts = coords[eq.id];
                            if (pts && pts.length >= 2) {
                                for (let i = 0; i < pts.length - 1; i++) {
                                    const mid = new THREE.Vector3(
                                        (pts[i].x + pts[i+1].x) / 2,
                                        (pts[i].y + pts[i+1].y) / 2,
                                        (pts[i].z + pts[i+1].z) / 2
                                    );
                                    const dir = new THREE.Vector3(
                                        pts[i+1].x - pts[i].x,
                                        0,   // on ne veut que la composante horizontale
                                        pts[i+1].z - pts[i].z
                                    ).normalize();
                                    pipelineDirections.push({ point: mid, dir });
                                }
                            }
                        }
                    }

                    /**
                     * Retourne le vecteur direction du pipeline le plus proche d'un point donné.
                     * Utilisé pour calculer l'offset perpendiculaire physiquement correct.
                     */
                    function getPipelineDirAt(pos) {
                        if (pipelineDirections.length === 0) {
                            return new THREE.Vector3(1, 0, 0); // fallback : axe X
                        }
                        let minDist = Infinity;
                        let bestDir = pipelineDirections[0].dir;
                        for (const seg of pipelineDirections) {
                            const d = pos.distanceTo(seg.point);
                            if (d < minDist) { minDist = d; bestDir = seg.dir; }
                        }
                        return bestDir.clone();
                    }

                    let _anodeGlobalIndex = 0; // compteur global pour la rotation 4-positions


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

                                try {
                                    const anodePt = new THREE.Vector3(
                                        points[0].x,
                                        points[0].y,
                                        points[0].z
                                    );
                                    group =
                                        createAnode(
                                            eq,
                                            anodePt,
                                            getPipelineDirAt(anodePt),
                                            _anodeGlobalIndex++
                                        );
                                } catch (anodeErr) {
                                    console.warn('[Gis3D] createAnode error:', anodeErr);
                                    _anodeGlobalIndex++;
                                }

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
                                    'puits_anodique'
                                // NOTE CP : les anodes sacrificielles (renfort
                                // Critical Area) ne sont PAS collectées — aucun
                                // câble TR/groundbed vers ces anodes (elles se
                                // soudent au pipeline, cf. createAnode).
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

                    // Connexions CP par système : retourne l'ensemble des TR
                    // déjà raccordés à un groundbed (anti-doublon).
                    const drawnTRIds = createCPConnections(
                        connectionData
                    );

                    // Câbles DC du TR optimal : liaisons vers le puits
                    // anodique (si non déjà tracées) et vers chaque structure
                    // protégée, ancrées au nearestPoint du moteur.
                    // Longueurs = sorties CableLengthEngine (cohérence UI).
                    createTRCableLinks(
                        valid,
                        coords,
                        _computeSceneCableLengths(valid),
                        drawnTRIds
                    );

                    // Rendu des drapeaux orange de zones critiques (renfort par anodes sacrificielles)
                    renderCriticalZones3D(projectId, valid);

                    // Passage global X-Ray : double-face + depthWrite off sur
                    // transparents, pour que tous les éléments restent visibles
                    // et lisibles depuis n'importe quel angle de caméra.
                    _applyXRayRenderFlags();

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

                            // OPTIM PERF (audit MAJEUR-4) : ne PAS disposer les
                            // géométries partagées du cache (réutilisées par les
                            // prochains meshes). Seules les géométries propres au
                            // mesh sont libérées.
                            if (
                                !node.geometry.userData ||
                                !node.geometry.userData._shared
                            ) {

                                node.geometry
                                    .dispose();
                            }
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

        // OPTIM PERF (audit) : garde de visibilité du rendu 3D.
        // Le rendu WebGL n'a de sens que lorsque le module "Visualisation 3D"
        // est réellement affiché (.module.active → display:block). Hors de ce
        // module, la boucle requestAnimationFrame reste vivante (reprise
        // instantanée au retour) mais on SAUTE le travail GPU/CPU :
        // controls.update(), updateParticleFluxes() et renderer.render().
        // Aucun impact sur la logique métier CP (formules, calculs, données).
        function is3DModuleVisible() {
            const moduleEl = document.getElementById('module-visualisation3d');
            return !!(moduleEl && moduleEl.classList.contains('active'));
        }

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

            // OPTIM PERF (audit) : ne rendre que si le module 3D est visible.
            // L'onglet navigateur masqué met déjà rAF en pause nativement,
            // mais on garde une garde explicite (onglet caché / prévisualisation).
            if (
                !is3DModuleVisible() ||
                document.hidden
            ) {

                _renderLoopId =
                    requestAnimationFrame(
                        animate
                    );

                return;
            }

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