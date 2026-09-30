// ============================================================
// simulation3d.js – Simulation GPU avec shaders – OPTIMISÉE
// VERSION 8.7 – CORRECTION : start() avec retry quand particleData n'est pas encore prêt
//                Utilisation de Gis3D.getRenderer() pour la cohérence
// ============================================================

(function() {
    'use strict';

    // --- Configuration ---
    const CONFIG = {
        particleCount: 8000,
        trailLength: 10,
        flowSpeed: 0.4,
        particleSize: 0.15,
        colorStart: new THREE.Color(0x06b6d4),
        colorEnd: new THREE.Color(0x38bdf8),
        curveSegments: 30,
        noiseScale: 0.5,
        maxCurves: 8,
        mobileParticleCount: 2500,
        cacheSize: 50,
        updateThrottle: 100
    };

    // --- Variables ---
    let isRunning = false;
    let animationId = null;
    let particleSystem = null;
    let flowCurves = [];
    let particleData = null;
    let clock = new THREE.Clock();
    let _reloadTimeout = null;
    let _isMobile = false;
    let _isLowPerformance = false;
    let _sceneReady = false;
    let _scene = null;
    let _gis3dReady = false;
    let _renderer = null;

    // ⚠️ CORRECTIF : garde anti-réentrance pour start()
    let _startRetryCount = 0;
    const _maxStartRetries = 5;
    let _startRetryTimeout = null;

    // OPTIM : Cache des courbes
    let _cachedCurves = null;
    let _cachedProjectId = null;
    let _currentVersion = 0;
    let _sceneVersion = 0;
    let _frameSkip = 0;
    let _frameCount = 0;

    // OPTIM : Pool de particules pour réutilisation
    let _particlePool = {
        positions: null,
        colors: null,
        sizes: null,
        offsets: null
    };

    // ============================================================
    // Détection des capacités
    // ============================================================
    function detectCapabilities() {
        const isSmallScreen = window.matchMedia('(max-width: 768px)').matches;
        let isLowPerformance = false;
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (gl) {
                const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
                if (debugInfo) {
                    const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
                    const lowEndGPUs = ['Intel HD', 'Intel UHD', 'Intel Iris', 'Mali', 'Adreno', 'PowerVR'];
                    isLowPerformance = lowEndGPUs.some(gpu => renderer && renderer.includes(gpu));
                }
            }
        } catch (e) { /* ignore */ }
        _isMobile = isSmallScreen || isLowPerformance;
        _isLowPerformance = isLowPerformance;
        if (_isMobile) CONFIG.particleCount = CONFIG.mobileParticleCount;
    }
    detectCapabilities();

    // OPTIM : Debounce du redimensionnement
    let _resizeTimeout = null;
    window.addEventListener('resize', function() {
        clearTimeout(_resizeTimeout);
        _resizeTimeout = setTimeout(() => {
            const wasMobile = _isMobile;
            const isSmallScreen = window.matchMedia('(max-width: 768px)').matches;
            if (isSmallScreen !== wasMobile) {
                _isMobile = isSmallScreen;
                if (_isMobile) {
                    CONFIG.particleCount = CONFIG.mobileParticleCount;
                    if (isRunning) Simulation3D.reload();
                }
            }
        }, 200);
    });

    // ============================================================
    // Gestion de la scène via Gis3D.whenReady()
    // ============================================================
    function ensureScene() {
        if (_scene) return Promise.resolve(_scene);
        if (window.Gis3D && typeof window.Gis3D.whenReady === 'function') {
            return window.Gis3D.whenReady().then(({ scene, renderer }) => {
                _scene = scene;
                _gis3dReady = true;
                _sceneVersion++;
                if (renderer) {
                    _renderer = renderer;
                }
                return scene;
            }).catch((err) => {
                console.warn('[Simulation] Erreur attente Gis3D:', err);
                return null;
            });
        }
        if (window.threeScene) {
            _scene = window.threeScene;
            _gis3dReady = true;
            _sceneVersion++;
            return Promise.resolve(_scene);
        }
        return Promise.resolve(null);
    }

    function onSceneReady() {
        _sceneVersion++;
        if (isRunning) {
            Simulation3D.reload();
        }
    }

    // ============================================================
    // Génération des courbes (avec cache)
    // ============================================================
    function generateFlowCurves() {
        const projectId = ProjectManager.getCurrentProjectId();
        if (_cachedCurves && _cachedProjectId === projectId && _cachedCurves.length > 0) {
            return _cachedCurves;
        }

        const curves = [];
        try {
            const state = ProjectManager.getState();
            if (!projectId) {
                const defaultCurve = new THREE.CatmullRomCurve3([
                    new THREE.Vector3(-5, -1, 0),
                    new THREE.Vector3(0, -0.5, 2),
                    new THREE.Vector3(5, -0.2, 0),
                    new THREE.Vector3(10, 0, -2)
                ]);
                curves.push(defaultCurve);
                _cachedCurves = curves;
                _cachedProjectId = projectId;
                return curves;
            }

            const equipments = state.equipments.filter(eq => eq.projectId === projectId && eq.included !== false);
            let source = equipments.find(e => e.type === 'groundbed') || equipments.find(e => e.type === 'rectifier');
            let target = equipments.find(e => e.type === 'pipeline_enterre' || e.type === 'pipeline_offshore');

            if (!source || !target) {
                const defaultCurve = new THREE.CatmullRomCurve3([
                    new THREE.Vector3(-5, -1, 0),
                    new THREE.Vector3(0, -0.5, 2),
                    new THREE.Vector3(5, -0.2, 0),
                    new THREE.Vector3(10, 0, -2)
                ]);
                curves.push(defaultCurve);
                _cachedCurves = curves;
                _cachedProjectId = projectId;
                return curves;
            }

            const sourceObj = window.Gis3D?.objects?.[source.id];
            const targetObj = window.Gis3D?.objects?.[target.id];

            let startPos = new THREE.Vector3();
            let endPos = new THREE.Vector3();

            if (sourceObj && sourceObj.position) {
                startPos.copy(sourceObj.position);
                if (source.type === 'groundbed' && sourceObj.userData?.totalDepth) {
                    startPos.y -= sourceObj.userData.totalDepth / 2;
                }
            } else {
                startPos.set(0, -2, 0);
            }

            if (targetObj && targetObj.userData?.points && targetObj.userData.points.length > 0) {
                const pts = targetObj.userData.points;
                endPos.copy(pts[Math.floor(pts.length / 2)]);
                endPos.y += 0.3;
            } else if (targetObj && targetObj.position) {
                endPos.copy(targetObj.position);
                endPos.x += 2;
            } else {
                endPos.set(5, 0, 0);
            }

            const numCurves = Math.min(6, CONFIG.maxCurves);
            for (let i = 0; i < numCurves; i++) {
                const offset = (i / numCurves - 0.5) * 2;
                const points = [];
                const steps = 8;
                for (let j = 0; j <= steps; j++) {
                    const t = j / steps;
                    const pos = new THREE.Vector3().lerpVectors(startPos, endPos, t);
                    const spread = t * 2 * (1 - t) * 1.5;
                    pos.x += offset * spread * 0.5;
                    pos.z += (Math.random() - 0.5) * spread * 0.3;
                    pos.y += (Math.random() - 0.5) * spread * 0.2 - t * 0.5;
                    points.push(pos);
                }
                const curve = new THREE.CatmullRomCurve3(points);
                curves.push(curve);
            }

            const extraCurves = Math.min(4, CONFIG.maxCurves - curves.length);
            for (let i = 0; i < extraCurves; i++) {
                const pts = [];
                const startOffset = new THREE.Vector3(
                    (Math.random() - 0.5) * 1.5,
                    (Math.random() - 0.5) * 0.5,
                    (Math.random() - 0.5) * 1.5
                );
                const endOffset = new THREE.Vector3(
                    (Math.random() - 0.5) * 2,
                    (Math.random() - 0.5) * 0.5,
                    (Math.random() - 0.5) * 2
                );
                const s = startPos.clone().add(startOffset);
                const e = endPos.clone().add(endOffset);
                for (let j = 0; j <= 6; j++) {
                    const t = j / 6;
                    const pos = new THREE.Vector3().lerpVectors(s, e, t);
                    pos.x += (Math.random() - 0.5) * 0.5;
                    pos.z += (Math.random() - 0.5) * 0.5;
                    pts.push(pos);
                }
                const curve = new THREE.CatmullRomCurve3(pts);
                curves.push(curve);
            }
        } catch (e) {
            console.error('[Simulation] Erreur génération courbes:', e);
            const defaultCurve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(-5, -1, 0),
                new THREE.Vector3(0, -0.5, 2),
                new THREE.Vector3(5, -0.2, 0),
                new THREE.Vector3(10, 0, -2)
            ]);
            curves.push(defaultCurve);
        }

        if (curves.length === 0) {
            const defaultCurve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(-5, -1, 0),
                new THREE.Vector3(0, -0.5, 2),
                new THREE.Vector3(5, -0.2, 0),
                new THREE.Vector3(10, 0, -2)
            ]);
            curves.push(defaultCurve);
        }

        _cachedCurves = curves;
        _cachedProjectId = projectId;
        return curves;
    }

    function invalidateCurveCache() {
        _cachedCurves = null;
        _cachedProjectId = null;
    }

    const debouncedReload = function() {
        clearTimeout(window._simulationReloadTimeout);
        window._simulationReloadTimeout = setTimeout(() => {
            invalidateCurveCache();
            const module3d = document.getElementById('module-visualisation3d');
            if (module3d && module3d.classList.contains('active')) {
                Simulation3D.reload();
            }
        }, 300);
    };

    document.addEventListener('equipmentUpdated', debouncedReload);
    document.addEventListener('projectLoaded', function() {
        invalidateCurveCache();
        Simulation3D.reload();
    });

    // ============================================================
    // Initialisation des particules (OPTIMISÉE)
    // ============================================================
    function initParticles() {
        ensureScene().then(scene => {
            if (!scene) {
                console.warn('[Simulation] Scène non disponible, réessai plus tard.');
                setTimeout(initParticles, 500);
                return;
            }
            _scene = scene;
            _sceneReady = true;
            _gis3dReady = true;
            _sceneVersion++;

            // Récupérer le renderer
            let renderer = null;
            if (window.Gis3D && typeof window.Gis3D.getRenderer === 'function') {
                renderer = window.Gis3D.getRenderer();
            }
            if (!renderer && window.threeRenderer) {
                renderer = window.threeRenderer;
            }
            _renderer = renderer;

            flowCurves = generateFlowCurves();
            if (flowCurves.length === 0) {
                console.warn('[Simulation] Aucune courbe de flux générée.');
                return;
            }

            const particlesPerCurve = Math.floor(CONFIG.particleCount / flowCurves.length);
            const totalParticles = particlesPerCurve * flowCurves.length;

            let positions, colors, sizes, offsets;

            if (_particlePool.positions && _particlePool.positions.length === totalParticles * 3) {
                positions = _particlePool.positions;
                colors = _particlePool.colors;
                sizes = _particlePool.sizes;
                offsets = _particlePool.offsets;
            } else {
                positions = new Float32Array(totalParticles * 3);
                colors = new Float32Array(totalParticles * 3);
                sizes = new Float32Array(totalParticles);
                offsets = new Float32Array(totalParticles);
                _particlePool.positions = positions;
                _particlePool.colors = colors;
                _particlePool.sizes = sizes;
                _particlePool.offsets = offsets;
            }

            let idx = 0;
            flowCurves.forEach((curve) => {
                for (let i = 0; i < particlesPerCurve; i++) {
                    const t = i / particlesPerCurve;
                    const point = curve.getPoint(t);
                    positions[idx * 3] = point.x;
                    positions[idx * 3 + 1] = point.y;
                    positions[idx * 3 + 2] = point.z;
                    const color = CONFIG.colorStart.clone().lerp(CONFIG.colorEnd, t);
                    colors[idx * 3] = color.r;
                    colors[idx * 3 + 1] = color.g;
                    colors[idx * 3 + 2] = color.b;
                    sizes[idx] = CONFIG.particleSize * (0.5 + 0.5 * Math.sin(t * Math.PI));
                    offsets[idx] = t;
                    idx++;
                }
            });

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
            geometry.setAttribute('offset', new THREE.BufferAttribute(offsets, 1));

            let material;
            try {
                const pixelRatio = _renderer ? _renderer.getPixelRatio() : 1;
                material = new THREE.ShaderMaterial({
                    uniforms: {
                        uTime: { value: 0 },
                        uPixelRatio: { value: pixelRatio },
                        uFlowSpeed: { value: CONFIG.flowSpeed },
                        uAmplitude: { value: 0.3 }
                    },
                    vertexShader: `
                        precision highp float;
                        attribute float size;
                        attribute vec3 color;
                        attribute float offset;
                        uniform float uTime;
                        uniform float uPixelRatio;
                        uniform float uFlowSpeed;
                        uniform float uAmplitude;
                        varying vec3 vColor;
                        varying float vOffset;
                        void main() {
                            vColor = color;
                            vOffset = offset;
                            float t = mod(offset + uTime * uFlowSpeed * 0.08, 1.0);
                            float waveX = sin(t * 6.2832 * 2.0 + uTime * 0.5) * 0.15;
                            float waveZ = cos(t * 6.2832 * 2.0 + uTime * 0.3) * 0.15;
                            float waveY = sin(t * 6.2832 * 1.5 + uTime * 0.2) * 0.1;
                            vec3 pos = position + vec3(waveX, waveY, waveZ);
                            float pulse = 0.8 + 0.2 * sin(uTime * 0.3 + t * 6.2832 * 3.0);
                            float finalSize = size * pulse;
                            vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
                            gl_PointSize = finalSize * uPixelRatio * (200.0 / -mvPosition.z);
                            gl_PointSize = clamp(gl_PointSize, 1.0, 60.0);
                            gl_Position = projectionMatrix * mvPosition;
                        }
                    `,
                    fragmentShader: `
                        precision highp float;
                        varying vec3 vColor;
                        varying float vOffset;
                        void main() {
                            vec2 center = gl_PointCoord - vec2(0.5);
                            float dist = length(center);
                            if (dist > 0.5) discard;
                            float alpha = 1.0 - smoothstep(0.2, 0.5, dist);
                            float glow = exp(-dist * 8.0);
                            vec3 finalColor = vColor + vec3(0.3, 0.6, 1.0) * glow * 0.3;
                            float finalAlpha = alpha * (0.7 + 0.3 * sin(vOffset * 6.2832 * 2.0 + 1.0));
                            gl_FragColor = vec4(finalColor, finalAlpha * 0.85);
                        }
                    `,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false,
                    transparent: true
                });
            } catch (e) {
                console.warn('[Simulation] Fallback PointsMaterial:', e);
                material = new THREE.PointsMaterial({
                    color: 0x06b6d4,
                    size: 0.15,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false,
                    transparent: true,
                    opacity: 0.8,
                    sizeAttenuation: true
                });
            }

            if (particleSystem) {
                _scene.remove(particleSystem);
                if (particleSystem.geometry) particleSystem.geometry.dispose();
                if (particleSystem.material) {
                    if (Array.isArray(particleSystem.material)) {
                        particleSystem.material.forEach(m => m.dispose());
                    } else {
                        particleSystem.material.dispose();
                    }
                }
            }

            particleSystem = new THREE.Points(geometry, material);
            _scene.add(particleSystem);

            particleData = {
                curves: flowCurves,
                particlesPerCurve: particlesPerCurve,
                totalParticles: totalParticles,
                geometry: geometry,
                material: material,
                system: particleSystem,
                version: _sceneVersion
            };

            window._simulationData = particleData;
            console.log(`[Simulation] ${totalParticles} particules initialisées sur ${flowCurves.length} courbes (GPU).`);

            // ⚠️ CORRECTIF : reset du compteur de retry après succès
            _startRetryCount = 0;
        });
    }

    // --- Mise à jour CPU (throttlée) ---
    function updateParticles() {
        if (!particleData || !particleData.system) return;
        if (particleData.version !== _sceneVersion) {
            Simulation3D.reload();
            return;
        }
        _frameCount++;
        if (_frameCount % 2 !== 0) return;

        const time = clock.getElapsedTime();
        if (particleData.material.uniforms && particleData.material.uniforms.uTime) {
            particleData.material.uniforms.uTime.value = time;
        }
    }

    function animateParticles() {
        if (!isRunning) return;
        updateParticles();
        animationId = requestAnimationFrame(animateParticles);
    }

    // ============================================================
    // API Publique
    // ============================================================
    const Simulation3D = {
        start: function() {
            if (isRunning) return;

            // ⚠️ CORRECTIF : annuler tout retry en cours avant de démarrer
            if (_startRetryTimeout) {
                clearTimeout(_startRetryTimeout);
                _startRetryTimeout = null;
            }

            if (!particleData) {
                initParticles();

                // ⚠️ CORRECTIF PRINCIPAL : initParticles est async, attendre avant de démarrer
                if (!particleData) {
                    _startRetryCount++;
                    if (_startRetryCount > _maxStartRetries) {
                        console.warn(`[Simulation] Impossible de démarrer après ${_maxStartRetries} tentatives. Abandon.`);
                        _startRetryCount = 0;
                        return;
                    }
                    console.warn(`[Simulation] Initialisation en cours, retry ${_startRetryCount}/${_maxStartRetries} dans 800ms...`);
                    _startRetryTimeout = setTimeout(() => {
                        _startRetryTimeout = null;
                        if (particleData && !isRunning) {
                            Simulation3D.start();
                        } else if (!particleData) {
                            // Nouvelle tentative
                            Simulation3D.start();
                        }
                    }, 800);
                    return;
                }
            }

            isRunning = true;
            _startRetryCount = 0;

            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
            animateParticles();

            const btn = document.getElementById('btnToggleSimulation');
            if (btn) btn.innerHTML = '<i class="fas fa-pause"></i> Arrêter simulation';
            const status = document.getElementById('simStatus');
            if (status) status.textContent = 'Simulation en cours...';
        },

        stop: function() {
            if (!isRunning) return;
            isRunning = false;

            // ⚠️ CORRECTIF : annuler tout retry en cours
            if (_startRetryTimeout) {
                clearTimeout(_startRetryTimeout);
                _startRetryTimeout = null;
            }
            _startRetryCount = 0;

            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
            const btn = document.getElementById('btnToggleSimulation');
            if (btn) btn.innerHTML = '<i class="fas fa-play"></i> Démarrer simulation';
            const status = document.getElementById('simStatus');
            if (status) status.textContent = 'Simulation arrêtée';
        },

        toggle: function() {
            if (isRunning) this.stop();
            else this.start();
        },

        clear: function() {
            this.stop();
            if (particleData && particleData.system && _scene) {
                _scene.remove(particleData.system);
                if (particleData.geometry) particleData.geometry.dispose();
                if (particleData.material) {
                    if (Array.isArray(particleData.material)) {
                        particleData.material.forEach(m => m.dispose());
                    } else {
                        particleData.material.dispose();
                    }
                }
                particleData = null;
                particleSystem = null;
                _particlePool = { positions: null, colors: null, sizes: null, offsets: null };
            }
            window._simulationData = null;
            clock = new THREE.Clock();
            flowCurves = [];
            _sceneReady = false;
            _gis3dReady = false;
            _startRetryCount = 0;
        },

        reload: function() {
            if (_reloadTimeout) {
                clearTimeout(_reloadTimeout);
                _reloadTimeout = null;
            }
            _reloadTimeout = setTimeout(() => {
                const wasRunning = isRunning;
                this.clear();
                _cachedCurves = null;
                _cachedProjectId = null;
                _sceneVersion++;
                ensureScene().then(scene => {
                    if (scene) {
                        _scene = scene;
                        _sceneReady = true;
                        _gis3dReady = true;
                        initParticles();
                        if (wasRunning) this.start();
                    } else {
                        console.warn('[Simulation] Scène non disponible pour reload.');
                    }
                });
                _reloadTimeout = null;
            }, 300);
        },

        get isRunning() { return isRunning; },
        get particleData() { return particleData; },

        reset: function() {
            this.clear();
            _cachedCurves = null;
            _cachedProjectId = null;
            _sceneVersion++;
            initParticles();
            if (isRunning) this.start();
        },

        setParticleCount: function(count) {
            if (count > 0 && count !== CONFIG.particleCount) {
                CONFIG.particleCount = Math.min(count, 20000);
                const wasRunning = isRunning;
                this.clear();
                _cachedCurves = null;
                _cachedProjectId = null;
                _sceneVersion++;
                initParticles();
                if (wasRunning) this.start();
            }
        },

        invalidateCache: invalidateCurveCache,
        onSceneReady: onSceneReady
    };

    window.Simulation3D = Simulation3D;

    // --- Événements DOM ---
    document.addEventListener('DOMContentLoaded', function() {
        const btnToggle = document.getElementById('btnToggleSimulation');
        if (btnToggle) {
            btnToggle.addEventListener('click', function() {
                window.Simulation3D.toggle();
            });
        }

        const btnLoad = document.getElementById('btnLoad3D');
        if (btnLoad) {
            btnLoad.addEventListener('click', function() {
                if (window.Gis3D && typeof window.Gis3D.loadData === 'function') {
                    window.Gis3D.loadData();
                }
            });
        }

        const module3d = document.getElementById('module-visualisation3d');
        if (module3d && module3d.classList.contains('active')) {
            ensureScene().then(scene => {
                if (scene) {
                    _scene = scene;
                    _sceneReady = true;
                    _gis3dReady = true;
                    initParticles();
                } else {
                    if (window.Gis3D && typeof window.Gis3D.whenReady === 'function') {
                        window.Gis3D.whenReady().then(({ scene }) => {
                            _scene = scene;
                            _sceneReady = true;
                            _gis3dReady = true;
                            initParticles();
                        });
                    }
                }
            });
        }
    });

    window.reload = function() {
        if (window.Simulation3D && typeof window.Simulation3D.reload === 'function') {
            window.Simulation3D.reload();
        } else {
            console.warn('Simulation3D.reload non disponible');
        }
    };

    console.log('[Simulation] Module chargé (version corrigée – start() avec retry).');
})();